import type { AgentConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { runCycle, getAbortController } from "./orchestrator.js";

export interface DaemonOptions {
  configPath?: string;
  repoFilter?: string;
}

export interface DaemonHandle {
  stop(): Promise<void>;
}

export function startDaemon(config: AgentConfig, logger: Logger, options?: DaemonOptions): DaemonHandle {
  let cycleNumber = 0;
  let stopping = false;
  let sleepResolve: (() => void) | null = null;
  let activeConfig = config;

  const repoNames = config.repos.map((r) => r.name).join(", ");
  logger.info("Daemon starting", {
    repos: repoNames,
    repoCount: config.repos.length,
    pollInterval: `${config.pollIntervalMs / 1000}s`,
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
          fresh = { ...fresh, repos: [match] };
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

      return fresh;
    } catch (err) {
      logger.warn("Config reload failed, using previous config", {
        error: err instanceof Error ? err.message : String(err),
      });
      return activeConfig;
    }
  }

  // Continuous loop: run cycles back-to-back when there's work, sleep only when idle
  const loop = async () => {
    while (!stopping) {
      cycleNumber++;

      // Hot-reload config each cycle to pick up new repos
      activeConfig = reloadConfig();

      try {
        const { didWork } = await runCycle(activeConfig, logger, cycleNumber);

        // If cycle did work, immediately run the next cycle (no sleep)
        if (didWork) continue;
      } catch (err) {
        logger.error("Unexpected error in cycle", {
          cycle: cycleNumber,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // No work found — sleep until next poll interval (or until stopped)
      if (!stopping) {
        await new Promise<void>((resolve) => {
          sleepResolve = resolve;
          setTimeout(() => {
            sleepResolve = null;
            resolve();
          }, activeConfig.pollIntervalMs);
        });
      }
    }
  };

  // Start the loop (fire and forget — the loop manages its own lifecycle)
  loop();

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;

    logger.info("Shutting down...");

    // Wake from sleep if idle
    if (sleepResolve) {
      sleepResolve();
      sleepResolve = null;
    }

    // If currently implementing, abort with timeout
    const ac = getAbortController();
    if (ac) {
      logger.info("Waiting for in-progress implementation to finish (60s timeout)...");
      const deadline = Date.now() + 60_000;
      while (getAbortController() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (getAbortController()) {
        logger.warn("Aborting in-progress implementation");
        ac.abort();
      }
    }

    logger.info("Shutdown complete");
  };

  return { stop };
}
