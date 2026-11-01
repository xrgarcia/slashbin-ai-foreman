import type { AgentConfig } from "./config.js";
import { configureClaudeTrust, trustManagedRepos } from "./claude-trust.js";
import { concurrencyWarning, loadConfig, releaseStageWarning } from "./config.js";
import type { Logger } from "./logger.js";
import { runLanePass, drainInFlight, requestShutdown } from "./orchestrator.js";
import { lanesFor, setSessionLimit } from "./lanes.js";
import { stageName } from "./stages.js";
import { join } from "node:path";
import { codeHost } from "./plugins/registry.js";
import { addObserver } from "./work-source.js";
import { stateDir } from "./state.js";
import { configureBackoff } from "./backoff.js";
import { configureUpstreamBackoff, isUpstreamBlocked, whenUpstreamClear, UpstreamBackoffError } from "./upstream-backoff.js";
import { configureGhUsage } from "./gh-usage.js";

export interface DaemonOptions {
  configPath?: string;
  repoFilter?: string;
  /** Called with each config a reload loads; not called when the reload fails. */
  onReload?: (config: AgentConfig) => void;
}

export interface DaemonHandle {
  stop(): Promise<void>;
}

export function startDaemon(config: AgentConfig, logger: Logger, options?: DaemonOptions): DaemonHandle {
  let cycleNumber = 0;
  let stopping = false;
  let sleepResolve: (() => void) | null = null;
  let activeConfig = config;

  // No Discord (owner, 2026-10-11: "GitHub and Paperclip are where Foreman should be
  // posting important messages"). What needs a person is a label and comment on the
  // issue, which also moves its Paperclip card; everything else is this log.

  // One open-issue snapshot per repo per cycle, instead of one GraphQL request
  // per discovery lookup. See the block comment above `getOpenIssues`.
  // Every back-off and retry limit, for the module-level code that takes no
  // config (gh retries, CI gate, stuck-merge scan, upstream windows).
  configureBackoff(config.backoff);

  // Every managed checkout trusted before the first session (src/claude-trust.ts);
  // again on each reload, and once more before every spawn.
  configureClaudeTrust({ enabled: config.trustManagedRepos });
  trustManagedRepos(config.repos, logger);

  const host = codeHost();
  host.configureIssueCache({
    ttlMs: config.issueCacheTtlMs,
    snapshotLimit: config.issueSnapshotLimit,
  });

  // Every repo's open issues and PRs from ONE bulk GraphQL query per refresh,
  // and only what changed since the last one. See the header of github-state.ts.
  host.configureState({
    repos: config.repos.map((r) => r.githubRepo),
    refreshMs: config.issueCacheTtlMs,
    issueLimit: config.issueSnapshotLimit,
    persistPath: join(stateDir(), ".github-state.json"),
    logger,
  });

  // The Foreman's own in-flight work, beside the GitHub view: every step the work
  // source reports lands in the same state file, and each one re-syncs that repo.
  addObserver({
    onEvent: async (event) => {
      switch (event.kind) {
        case "claim": return host.recordActivity(event.item.repo, event.item.issueNumber, "claimed");
        case "transition": return host.recordActivity(event.item.repo, event.item.issueNumber, String(event.to));
        case "prLink": return host.recordActivity(event.item.repo, event.item.issueNumber, "pr-linked", event.prUrl);
        case "blocked": return host.recordActivity(event.item.repo, event.item.issueNumber, "blocked");
        case "escalated": return host.recordActivity(event.item.repo, event.item.issueNumber, "needs-ruling");
        case "merged": return host.recordActivity(event.item.repo, event.item.issueNumber, "merged");
        case "promoted": return host.clearActivity(event.item.repo, event.item.issueNumber);
        default: return;
      }
    },
  });

  // One daemon-wide back-off per upstream (GitHub rate limit, Claude session
  // limit). Every transition is logged once — never per repo — and the Paperclip
  // mirror shows the pause from its `backoff` event.
  configureUpstreamBackoff({
    notify: (text) => logger.warn(text),
    logger,
  });

  // One info line per hour: spawned gh calls by quota bucket and subcommand.
  // statePoints: what the fleet state's bulk queries actually cost, as GitHub reported it.
  configureGhUsage({ intervalMs: 3_600_000, logger, extra: () => host.takeStateUsage() });

  // A TTL at or above the poll interval means a cycle can be served entirely
  // from the previous cycle's snapshot, so an externally-applied `approved`
  // waits an extra cycle. Legal, but almost never intended — say so.
  if (config.issueCacheTtlMs >= config.pollIntervalMs) {
    logger.warn(
      "issueCacheTtlMs >= pollIntervalMs — a cycle may reuse the previous cycle's issue snapshot, delaying pickup of externally-applied labels by one cycle",
      { issueCacheTtlMs: config.issueCacheTtlMs, pollIntervalMs: config.pollIntervalMs },
    );
  }

  // The default pipeline carries the release stage; without the Tech Lead and
  // the SRE it cannot run, and a silent skip would read as releases stalling.
  const releaseWarning = releaseStageWarning(config);
  if (releaseWarning) logger.warn(releaseWarning);
  const retired = concurrencyWarning(config);
  if (retired) logger.warn(retired);

  logger.info(config.profile ? `Config profile: ${config.profile}` : "Config profile: none (neutral defaults)");

  const repoNames = config.repos.map((r) => r.name).join(", ");
  const startLanes = lanesFor(config.stages);
  logger.info("Daemon starting", {
    repos: repoNames,
    repoCount: config.repos.length,
    pollInterval: `${config.pollIntervalMs / 1000}s`,
    // One loop per (repo, lane): each lane runs one item per repo at a time.
    lanes: startLanes.map((l) => `${l.name}[${l.stages.map(stageName).join(">")}]`).join(" "),
    laneLoops: startLanes.length * config.repos.length,
    maxConcurrentSessions: config.maxConcurrentSessions || "unbounded",
    issueCacheTtlMs: config.issueCacheTtlMs,
    // Requests/hour the discovery phases will now spend, so the budget is
    // visible in the log rather than something you have to rediscover.
    estDiscoveryGraphQlPerHour: Math.round(
      config.repos.length * (3600_000 / config.pollIntervalMs),
    ),
  });

  for (const repo of config.repos) {
    logger.info(`  repo: ${repo.name}`, {
      githubRepo: repo.githubRepo,
      repoPath: repo.repoPath,
      triggerLabel: repo.triggerLabel,
      baseBranch: repo.baseBranch,
      featureBranch: repo.featureBranch,
    });
  }

  /**
   * Hot-reload config from disk. Picks up new repos added to .ai-agent.json
   * without requiring a daemon restart. Logs changes when repos are added/removed.
   */
  function reloadConfig(): AgentConfig {
    try {
      let fresh = loadConfig(options?.configPath);

      // Apply repo filter if specified
      if (options?.repoFilter) {
        const match = fresh.repos.find((r) => r.name === options.repoFilter);
        if (match) {
          // allRepos keeps every managed repo so a dependent in another repo still resolves.
          fresh = { ...fresh, repos: [match], allRepos: fresh.repos };
        }
      }

      // Log repo changes
      const oldNames = new Set(activeConfig.repos.map((r) => r.name));
      const newNames = new Set(fresh.repos.map((r) => r.name));

      for (const name of newNames) {
        if (!oldNames.has(name)) {
          logger.info(`Config reload: added repo "${name}"`);
        }
      }
      for (const name of oldNames) {
        if (!newNames.has(name)) {
          logger.info(`Config reload: removed repo "${name}"`);
        }
      }

      host.setStateRepos(fresh.repos.map((r) => r.githubRepo));
      configureBackoff(fresh.backoff);
      configureClaudeTrust({ enabled: fresh.trustManagedRepos });
      trustManagedRepos(fresh.repos, logger);
      options?.onReload?.(fresh);
      return fresh;
    } catch (err) {
      logger.warn("Config reload failed, using previous config", {
        error: err instanceof Error ? err.message : String(err),
      });
      return activeConfig;
    }
  }

  // --- One independent loop per (repo, lane) -----------------------------
  //
  // Each lane of each repo polls, works and sleeps on its OWN schedule (see
  // src/lanes.ts). There is no barrier between repos — 2026-07-29 the fleet went
  // quiet for 24 minutes behind one slashbin-io-worker review — and now none
  // between the stages of one repo either: on 2026-10-14 jerky_service's
  // release PR #146 waited behind a 30-minute revision on the same repo.
  //
  // What bounds the work is the lane itself: one item per repo per lane. Stages
  // that change the repo's working clone share the repo's checkout lock, and
  // `maxConcurrentSessions` (off by default) can cap sessions fleet-wide.
  const laneLoops = new Map<string, { stop: () => void }>();
  const loopKey = (repoName: string, laneName: string): string => `${repoName}/${laneName}`;

  const startLaneLoop = (repoName: string, laneName: string): void => {
    let loopStopping = false;
    let wake: (() => void) | null = null;
    const key = loopKey(repoName, laneName);

    const run = async (): Promise<void> => {
      const repoLogger = logger.child({ repo: repoName, lane: laneName });
      while (!stopping && !loopStopping) {
        // GitHub is backing off: wait for the module's probe to clear it rather
        // than spin. Raced against `wake` so stop() still ends the loop at once.
        if (isUpstreamBlocked("github")) {
          await Promise.race([
            whenUpstreamClear("github"),
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
          ]);
          wake = null;
          continue;
        }

        // Re-resolve from the live config each pass so a hot-reloaded setting
        // (branches, budgets, reviewEnabled, stages) applies without a restart.
        // A repo dropped from the config, or a lane its stages no longer have,
        // ends its own loop.
        const repoConfig = activeConfig.repos.find((r) => r.name === repoName);
        const lanes = lanesFor(activeConfig.stages);
        const lane = lanes.find((l) => l.name === laneName);
        if (!repoConfig || !lane) {
          repoLogger.info(repoConfig ? "Lane no longer in the configured stages — stopping its loop" : "Repo no longer in config — stopping its loop");
          laneLoops.delete(key);
          return;
        }

        let didWork = false;
        try {
          // The first lane mirrors the board every pass, as the whole-repo pass
          // did; the others only after they changed something, so splitting a
          // repo into lanes does not multiply the idle snapshot rate.
          const result = await runLanePass(repoConfig, activeConfig, lane, logger, lanes[0].name === laneName ? "always" : "if-work");
          didWork = result.processed > 0;
          for (const event of result.events) logger[event.level](event.message);
        } catch (err) {
          // A pass cut short by the GitHub back-off is expected, and the back-off
          // module has already announced it once — no per-repo message.
          if (err instanceof UpstreamBackoffError) {
            repoLogger.debug("Lane pass cut short by the GitHub back-off", { error: err.message });
            continue;
          }
          // Never let one failure end the loop — that would take the lane off
          // the fleet for this service with no signal beyond silence.
          repoLogger.error("Lane pass failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Stop BEFORE the fast re-loop: a pass that did work used to go straight
        // round again even while the daemon was draining, and start new sessions.
        if (stopping || loopStopping) return;
        if (didWork) continue; // more to do — go straight round again

        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(() => {
            wake = null;
            resolve();
          }, activeConfig.pollIntervalMs);
        });
      }
    };

    laneLoops.set(key, {
      stop: () => {
        loopStopping = true;
        if (wake) {
          wake();
          wake = null;
        }
      },
    });

    void run();
  };

  // Supervisor: hot-reload config and reconcile the set of running loops.
  const supervisor = async (): Promise<void> => {
    while (!stopping) {
      cycleNumber++;
      activeConfig = reloadConfig();
      setSessionLimit(activeConfig.maxConcurrentSessions);

      const lanes = lanesFor(activeConfig.stages);
      const wanted = new Set<string>();
      for (const repo of activeConfig.repos) {
        for (const lane of lanes) {
          const key = loopKey(repo.name, lane.name);
          wanted.add(key);
          if (!laneLoops.has(key)) startLaneLoop(repo.name, lane.name);
        }
      }
      for (const [key, handle] of laneLoops) {
        if (!wanted.has(key)) handle.stop();
      }

      await new Promise<void>((resolve) => {
        sleepResolve = resolve;
        setTimeout(() => {
          sleepResolve = null;
          resolve();
        }, activeConfig.pollIntervalMs);
      });
    }
  };

  void supervisor();

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;

    logger.info("Shutting down...");
    requestShutdown();

    // Wake the supervisor and every repo loop so none sits out a poll interval
    // before noticing the shutdown.
    if (sleepResolve) {
      sleepResolve();
      sleepResolve = null;
    }
    for (const handle of laneLoops.values()) handle.stop();

    // If currently implementing, drain before aborting.
    //
    // This used to wait a flat 60s and then abort. That silently contradicted
    // the systemd unit, which sets TimeoutStopSec=1800 precisely so a restart
    // does NOT kill work mid-flight — systemd would wait 30 minutes while the
    // daemon gave up after one, SIGTERMing the `claude` child and leaving a
    // half-built branch behind. An implementation run is budgeted
    // maxDurationMs (30 min by default), so the drain window has to match that
    // budget, not undercut it by 30x.
    //
    // Override with AI_AGENT_SHUTDOWN_DRAIN_MS when you deliberately want a
    // fast, work-destroying stop.
    // maxDurationMs is resolved per-repo, not globally, so take the largest
    // budget any watched repo could be mid-way through.
    const longestRun = config.repos.reduce((m, r) => Math.max(m, r.maxDurationMs), 0);
    const drainMs =
      Number(process.env.AI_AGENT_SHUTDOWN_DRAIN_MS) ||
      Math.max(longestRun, config.reviewMaxDurationMs);
    // Every lane of every repo can be mid-run at once, so drain ALL of them —
    // the runs and the lane passes around them (see drainInFlight).
    await drainInFlight(drainMs, logger);

    logger.info("Shutdown complete");
  };

  return { stop };
}
