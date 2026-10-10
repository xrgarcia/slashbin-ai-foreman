import type { AgentConfig, RepoConfig } from "./config.js";
import { configureBackoff } from "./backoff.js";
import type { Logger } from "./logger.js";
import { publishSnapshot, hasObservers } from "./work-source.js";
import { type ImplementationResult } from "./agent.js";
import { dispatchStages, isCustomStage, type StageResult } from "./stages.js";
import { CycleEvent, activeRuns, failureCount, revisionFailureCount } from "./phases/common.js";
import { tryCustomStage } from "./phases/custom.js";
import { tryBatchImplementation } from "./phases/implement.js";
import { tryFileDependencyBatchIssue, tryPromotion, trySyncDrift } from "./phases/promote.js";
import { runReconcileStage } from "./phases/reconcile.js";
import { tryReview } from "./phases/review.js";
import { tryRevision } from "./phases/revise.js";
import { tryVerify } from "./phases/verify.js";

// The phases live in src/phases/; these are the parts of them the daemon, the
// CLI and the tests reach through the orchestrator.
export { stoppedReason, divergenceNotice, labelFromTrailer, workStateOf, type CycleEvent } from "./phases/common.js";
export { prBlockingSkip } from "./phases/implement.js";
export { verifyHoldPlan, pickVerifyTarget } from "./phases/verify.js";

export interface OrchestratorState {
  implementing: string | null;
  /** Every repo with an agent run in flight. `implementing` is the first of
   *  these, kept for callers that predate concurrency. */
  implementingRepos: string[];
  repos: Record<string, { failures: number; revisionFailures: number }>;
}

export function getState(config: AgentConfig): OrchestratorState {
  const repos: OrchestratorState["repos"] = {};
  for (const repo of config.repos) {
    repos[repo.name] = {
      failures: failureCount.get(repo.name) ?? 0,
      revisionFailures: revisionFailureCount.get(repo.name) ?? 0,
    };
  }
  const implementingRepos = [...activeRuns.keys()];
  return { implementing: implementingRepos[0] ?? null, implementingRepos, repos };
}

/** Back-compat: a single controller for callers written before concurrency.
 *  Prefer `getActiveRunCount()` + `abortAllRuns()` — with several repos in
 *  flight this returns an arbitrary one, and aborting it drains nothing else. */
export function getAbortController(): AbortController | null {
  for (const ac of activeRuns.values()) return ac;
  return null;
}

/** How many agent runs are in flight right now, across all repos. */
export function getActiveRunCount(): number {
  return activeRuns.size;
}

/** Repos currently running an agent, for shutdown logging. */
export function getActiveRunRepos(): string[] {
  return [...activeRuns.keys()];
}

/**
 * Set once a shutdown starts. Every phase that would spawn a NEW session checks
 * it first, so a draining daemon finishes what is running and starts nothing.
 *
 * Without it the drain never converged: on 2026-09-29 a restart asked to stop at
 * 15:53, and at 16:21 a repo whose review had just finished went straight on to
 * start an implement session in the same pass — work begun inside the drain
 * window and then cut off when the window elapsed, leaving a half-built branch.
 */
let shutdownRequested = false;
export function requestShutdown(): void {
  shutdownRequested = true;
}
export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

/** Abort every in-flight run. Only for a shutdown whose drain window elapsed —
 *  this destroys work in progress. */
export function abortAllRuns(): void {
  for (const ac of activeRuns.values()) ac.abort();
}

export interface CycleResult {
  didWork: boolean;
  lastImplementation: ImplementationResult | null;
  events: CycleEvent[];
}

/** Per-repo cycle counter. The fleet-wide `cycle=N` alone became unreadable the
 *  moment repos ran concurrently — twenty repos interleaving under one number
 *  gives no way to follow a single service's progress, and an unreadable log is
 *  how a stalled queue hides. Every line now carries both: `cycle` (fleet) and
 *  `repoCycle` (this service's own pass count). */
const repoCycleCounter = new Map<string, number>();

export interface RepoCycleResult {
  processed: number;
  lastImplementation: ImplementationResult | null;
  events: CycleEvent[];
}

/**
 * Fleet-wide slot limiter. Each repo drives its OWN loop (see startDaemon), so
 * nothing else bounds how many agent sessions exist at once — twenty repos
 * waking together would be twenty concurrent Claude sessions and twenty streams
 * of GitHub calls. Slots are held for the whole of a repo's pass and released
 * even when the pass throws, so one crashing repo cannot leak the fleet's
 * capacity away one slot at a time.
 */
let slotLimit = 3;
let slotsInUse = 0;
const slotWaiters: Array<() => void> = [];

export function setConcurrencyLimit(limit: number): void {
  slotLimit = Math.max(1, limit);
  // A raised limit must wake anyone already queued, or a config reload that
  // increases capacity would have no effect until the next natural release.
  while (slotsInUse < slotLimit && slotWaiters.length > 0) {
    const wake = slotWaiters.shift();
    if (wake) {
      slotsInUse++;
      wake();
    }
  }
}

async function acquireSlot(): Promise<void> {
  if (slotsInUse < slotLimit) {
    slotsInUse++;
    return;
  }
  await new Promise<void>((resolve) => slotWaiters.push(resolve));
}

function releaseSlot(): void {
  const wake = slotWaiters.shift();
  if (wake) {
    wake(); // hand the slot straight to the next waiter; count stays put
    return;
  }
  slotsInUse = Math.max(0, slotsInUse - 1);
}

/** Repos waiting for a slot right now — surfaced so a queue that stops moving
 *  is visible rather than looking like an idle fleet. */
export function getQueuedRepoCount(): number {
  return slotWaiters.length;
}

/**
 * Run one pass for one repo, holding a fleet concurrency slot for its duration.
 * This is what a per-repo loop calls.
 */
export async function runRepoPass(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
): Promise<RepoCycleResult> {
  await acquireSlot();
  try {
    return await runRepoCycle(repoConfig, config, logger, 0);
  } finally {
    releaseSlot();
  }
}

/**
 * One full pass over ONE repo: the configured `stages`, in order. By default
 * reconcile -> review -> revise -> implement -> branch-sync -> dependabot ->
 * promote; a config may drop, reorder, or add custom skill stages.
 *
 * Phase order within a repo is load-bearing, and the default keeps it. Review
 * runs before implement so it only acts on PRs labeled in a PRIOR pass (a PR
 * created by this pass waits for the next one, avoiding a same-cycle
 * GitHub-consistency race). Promote runs last so it sees labels this pass just
 * set. A config that reorders the built-ins gives those guarantees up.
 *
 * A stage that returns `blocked` or `failed` ends the pass: no later stage runs
 * for this repo until the next pass. Only custom stages return those (see
 * StageOutcome) — the built-ins keep their own failure counters, as before.
 *
 * What changed is that this is now the unit of concurrency. Repos no longer
 * queue behind each other: a 30-minute build on one service used to block the
 * other nineteen, because the old shape was six sequential loops over all
 * repos and every phase awaited each one in turn.
 */
async function runRepoCycle(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
): Promise<RepoCycleResult> {
  const events: CycleEvent[] = [];
  let processed = 0;
  let lastImplementation: ImplementationResult | null = null;

  const repoCycle = (repoCycleCounter.get(repoConfig.name) ?? 0) + 1;
  repoCycleCounter.set(repoConfig.name, repoCycle);
  // The phase helpers use the cycle number for per-repo failure cooldowns
  // ("retry after N idle cycles"), so they must count THIS repo's passes. With
  // independent per-repo loops a fleet-wide counter no longer maps to a repo's
  // own turns, and a cooldown measured in someone else's cycles is arbitrary.
  cycleNumber = repoCycle;
  const base = logger.child({ cycle: cycleNumber, repoCycle, repo: repoConfig.name });

  // The stages run in the configured order (default: reconcile, review, revise,
  // implement, branch-sync, dependabot, promote — see BUILTIN_STAGES). Each
  // built-in below is the phase that used to be called here by name, unchanged.
  const dispatched = await dispatchStages(config.stages, async (stage): Promise<StageResult> => {
    // Review, revise, implement and custom stages each spawn a Claude session.
    // None may START once a shutdown is under way — see `shutdownRequested`.
    // The pass ends there, as it did when the phases were inline.
    const spawnsClaude = isCustomStage(stage) || stage.type === "review" || stage.type === "verify" || stage.type === "revise" || stage.type === "implement";
    if (spawnsClaude && shutdownRequested) return { outcome: "stop", reason: "shutdown requested" };

    if (isCustomStage(stage)) {
      const r = await tryCustomStage(repoConfig, stage, base, events);
      if (r.ran) processed++;
      return r;
    }

    switch (stage.type) {
      // --- Reconcile orphaned commits (features ahead of develop with no PR) and dead zones ---
      case "reconcile":
        processed += await runReconcileStage(repoConfig, config, base, events);
        break;

      // --- Review open feature PRs (invokes the configured review skill). The
      //    outcome-label reconcile (reviewLabelReconcile) runs inside tryReview. ---
      case "review":
        if (await tryReview(repoConfig, config, base, cycleNumber, events)) processed++;
        break;

      // --- Dev-verify PRs the reviewer merged (`pr merged` → `pr approved`).
      //    A no-op unless srePath is configured (EM#440). ---
      case "verify":
        if (await tryVerify(repoConfig, config, base, cycleNumber, events)) processed++;
        break;

      // --- Revise PRs with pending review feedback ---
      case "revise": {
        const revisionInfo = await tryRevision(repoConfig, config, base, cycleNumber, events);
        if (revisionInfo) {
          events.push({ message: `Revised ${repoConfig.githubRepo} PR #${revisionInfo.pr.number} (issues: ${revisionInfo.issueNumbers.map(n => `#${n}`).join(", ")})`, level: "info" });
          processed++;
        }
        break;
      }

      // --- Implement approved issues (one batch per repo) ---
      case "implement": {
        const implResult = await tryBatchImplementation(repoConfig, config, base, cycleNumber, events);
        if (implResult) {
          processed++;
          lastImplementation = implResult;
        }
        break;
      }

      // --- Reconcile branch drift (main → develop) for any repo with
      //    post-promotion merge commits. Runs independently of promotion work so
      //    drift is cleared even when no ready-for-prod issues exist. ---
      case "branch-sync":
        if (!(repoConfig.baseBranch === repoConfig.productionBranch && repoConfig.featureBranch === repoConfig.productionBranch)) {
          if (trySyncDrift(repoConfig, base, cycleNumber)) {
            events.push({ message: `Branch sync on ${repoConfig.githubRepo} (${repoConfig.productionBranch} → ${repoConfig.baseBranch}) — merged`, level: "info" });
            processed++;
          }
        }
        break;

      // --- File ONE issue for the Dependabot PRs aimed at the feature
      //    branch. Nothing in the pipeline merges those (see findDependencyPRs), so without this
      //    they accumulate with no path forward at all. The issue puts them through
      //    the implement session — which builds, boots the app and smoke-tests it —
      //    instead of a CI rollup that only ever proved the code compiles. Filed
      //    pre-approved on a repo that opts in (dependencyPreApproved), so it enters
      //    the queue with no human step; bare everywhere else. ---
      case "dependabot":
        if (repoConfig.baseBranch !== repoConfig.productionBranch) {
          const filed = tryFileDependencyBatchIssue(repoConfig, base, cycleNumber);
          if (filed) {
            events.push({
              message: repoConfig.dependencyPreApproved
                ? `${repoConfig.githubRepo}: filed dependency batch issue #${filed}, pre-approved — queued to build`
                : `${repoConfig.githubRepo}: filed dependency batch issue #${filed} — needs \`${repoConfig.triggerLabel}\` to build`,
              level: "info",
            });
            processed++;
          }
        }
        break;

      // --- Create promotion PRs for repos with ready-for-prod issues. Never
      //    applies the ready-for-prod label itself (separation of duties). ---
      case "promote": {
        const promotionResult = await tryPromotion(repoConfig, base, cycleNumber);
        if (promotionResult === "promoted") {
          events.push({ message: `Promotion PR created on ${repoConfig.githubRepo} (${repoConfig.baseBranch} → ${repoConfig.productionBranch})`, level: "info" });
          processed++;
        } else if (promotionResult === "synced") {
          events.push({ message: `Branch sync on ${repoConfig.githubRepo} (${repoConfig.productionBranch} → ${repoConfig.baseBranch}) — merged, promotion will follow`, level: "info" });
          processed++;
        }
        break;
      }
    }
    return { outcome: "ok" };
  });

  if (dispatched.stoppedAt && dispatched.stoppedAt.outcome !== "stop") {
    const { stage, outcome, reason } = dispatched.stoppedAt;
    base.debug(`Pass stopped at stage "${stage}" (${outcome}${reason ? `: ${reason}` : ""}) — later stages skipped this pass`);
  }

  // Observers mirror GitHub's labels as they stand after the pass. Events move
  // a card only when the Foreman acts on that issue, so a card it never acts on
  // again (blocked by an old skip, then advanced by a label heal) stayed wrong
  // for good: jerky_service #73 sat in Blocked at `pr merged` (2026-10-05).
  if (hasObservers()) {
    try {
      await publishSnapshot(repoConfig, base);
    } catch (err) {
      base.debug(`Board snapshot skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { processed, lastImplementation, events };
}

/**
 * One fleet pass: every repo runs its own pipeline, several at a time.
 *
 * The cap is about SPEND, not safety. Concurrent repos are safe on their own —
 * each has its own git working clone, so two of them can never touch the same
 * checkout, and a repo's phases stay sequential within `runRepoCycle`. What a
 * high cap actually buys you is N simultaneous Claude sessions (each up to 100
 * turns) and N times the GitHub API traffic, on an API that already returns
 * intermittent TLS timeouts at one.
 *
 * Set `maxConcurrentRepos` in .ai-agent.json or AI_AGENT_MAX_CONCURRENT_REPOS.
 */
export async function runCycle(
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number
): Promise<CycleResult> {
  const cycleLogger = logger.child({ cycle: cycleNumber, phase: "poll" });
  // `--once` and programmatic callers start here, not in the daemon.
  configureBackoff(config.backoff);

  let totalProcessed = 0;
  let lastResult: ImplementationResult | null = null;
  const events: CycleEvent[] = [];

  const limit = Math.max(1, Math.min(config.maxConcurrentRepos, config.repos.length));
  const queue = [...config.repos];

  if (limit > 1) {
    cycleLogger.debug(`Running ${config.repos.length} repo(s), up to ${limit} concurrently`);
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const repoConfig = queue.shift();
      if (!repoConfig) return;
      try {
        const result = await runRepoCycle(repoConfig, config, logger, cycleNumber);
        totalProcessed += result.processed;
        events.push(...result.events);
        if (result.lastImplementation) lastResult = result.lastImplementation;
      } catch (err) {
        // One repo's pipeline must never take the fleet pass down with it —
        // that would be the serial failure mode reintroduced through the back
        // door, with every other repo starved by an unrelated crash.
        logger.child({ cycle: cycleNumber, repo: repoConfig.name }).error("Repo cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));

  if (totalProcessed === 0) {
    cycleLogger.info("No work across all repos");
  } else {
    cycleLogger.info(`Cycle complete — processed ${totalProcessed} item(s)`);
  }

  return { didWork: totalProcessed > 0, lastImplementation: lastResult, events };
}
