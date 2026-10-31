import { releaseStageReady, type AgentConfig, type RepoConfig } from "./config.js";
import { configureBackoff } from "./backoff.js";
import type { Logger } from "./logger.js";
import { publishSnapshot, hasObservers, workSourceFor } from "./work-source.js";
import { pruneClosedHolds } from "./closed-holds.js";
import { type ImplementationResult } from "./agent.js";
import { dispatchStages, hasStage, isCustomStage, type StageEntry, type StageResult } from "./stages.js";
import { getQueuedSessionCount, lanesFor, setSessionLimit, stageNeedsCheckout, stageSpawnsSession, withCheckoutLock, withLaneLock, withSessionSlot, type Lane } from "./lanes.js";
import { CycleEvent, activeRuns, failureCount, revisionFailureCount } from "./phases/common.js";
import { tryCustomStage } from "./phases/custom.js";
import { tryBatchImplementation } from "./phases/implement.js";
import { tryFileDependencyBatchIssue, tryPromotion, trySyncDrift } from "./phases/promote.js";
import { runReconcileStage } from "./phases/reconcile.js";
import { tryRelease } from "./phases/release.js";
import { tryUnstick } from "./phases/unstick.js";
import { tryReview } from "./phases/review.js";
import { tryRevision } from "./phases/revise.js";
import { tryVerify } from "./phases/verify.js";
import { onboardRepo } from "./onboarding.js";

// The phases live in src/phases/; these are the parts of them the daemon, the
// CLI and the tests reach through the orchestrator.
export { stoppedReason, divergenceNotice, labelFromTrailer, workStateOf, type CycleEvent } from "./phases/common.js";
export { prBlockingSkip } from "./phases/implement.js";
export { verifyHoldPlan, pickVerifyTarget, devVerifyHolding, visualDecisionHolder, followUpsOf, followUpsToBuild, evidenceLinks } from "./phases/verify.js";

export interface OrchestratorState {
  implementing: string | null;
  /** Every repo with an agent run in flight. `implementing` is the first of
   *  these, kept for callers that predate concurrency. */
  implementingRepos: string[];
  /** Lane passes in flight, as `repo/lane` (see lanes.ts). */
  activeLanes: string[];
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
  const implementingRepos = getActiveRunRepos();
  return { implementing: implementingRepos[0] ?? null, implementingRepos, activeLanes: getActiveLanePasses(), repos };
}

/** Back-compat: a single controller for callers written before concurrency.
 *  Prefer `getActiveRunCount()` + `abortAllRuns()` — with several runs in
 *  flight this returns an arbitrary one, and aborting it drains nothing else. */
export function getAbortController(): AbortController | null {
  for (const ac of activeRuns.keys()) return ac;
  return null;
}

/** How many agent runs are in flight right now, across all repos and lanes. */
export function getActiveRunCount(): number {
  return activeRuns.size;
}

/** Repos currently running an agent (each once), for shutdown logging. */
export function getActiveRunRepos(): string[] {
  return [...new Set(activeRuns.values())];
}

/**
 * Lane passes in flight, `repo/lane`. The shutdown drain waits on these as well
 * as on `activeRuns`: a run covers only its subprocess, and the release lane
 * still records the merge, tags and comments AFTER the SRE's deploy returns. A
 * drain that ended with the subprocess would stop the daemon between a deploy
 * and its record — and the next start would not know the deploy happened.
 */
const lanePassesInFlight = new Map<string, number>();
export function getActiveLanePasses(): string[] {
  return [...lanePassesInFlight.keys()];
}
export function getActiveLanePassCount(): number {
  return lanePassesInFlight.size;
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
  for (const ac of activeRuns.keys()) ac.abort();
}

const inFlight = (): number => activeRuns.size + lanePassesInFlight.size;

/**
 * Wait for every run AND every lane pass in flight to finish, up to `drainMs`;
 * then abort what is left and give the lane passes `settleMs` to record what
 * they were doing. Call after requestShutdown(), which keeps any new session
 * from starting. Returns true when everything finished on its own.
 *
 * Waiting on lane passes, not only on runs, is what keeps a release whole: the
 * SRE's deploy is a run, but the merge, tag and verdict the release lane records
 * after it are not.
 */
export async function drainInFlight(drainMs: number, logger: Logger, pollMs = 1000, settleMs = 30_000): Promise<boolean> {
  if (inFlight() === 0) return true;
  logger.info(
    `Waiting for ${activeRuns.size} run(s) and ${lanePassesInFlight.size} lane pass(es) to finish (${Math.round(drainMs / 1000)}s timeout)...`,
    { repos: getActiveRunRepos(), lanes: getActiveLanePasses(), queuedSessions: getQueuedSessionCount() },
  );
  const deadline = Date.now() + drainMs;
  while (inFlight() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (inFlight() === 0) return true;
  logger.warn("Drain window elapsed — aborting in-progress run(s)", { repos: getActiveRunRepos(), lanes: getActiveLanePasses() });
  abortAllRuns();
  const settle = Date.now() + settleMs;
  while (lanePassesInFlight.size > 0 && Date.now() < settle) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

export interface CycleResult {
  didWork: boolean;
  lastImplementation: ImplementationResult | null;
  events: CycleEvent[];
}

/** Pass counter per (repo, lane). The fleet-wide `cycle=N` alone became
 *  unreadable the moment repos ran concurrently, so every line carries
 *  `repo`, `lane` and `repoCycle` — that lane's own pass count on that repo. */
const laneCycleCounter = new Map<string, number>();

export interface RepoCycleResult {
  processed: number;
  lastImplementation: ImplementationResult | null;
  events: CycleEvent[];
}

/** When a lane pass mirrors the board: every pass, only after work, or never. */
export type SnapshotPolicy = "always" | "if-work" | "never";

/**
 * One pass of ONE lane on ONE repo — what each of the daemon's (repo, lane)
 * loops calls. At most one pass per (repo, lane) runs at a time; a second
 * caller waits for the first (withLaneLock).
 */
export async function runLanePass(
  repoConfig: RepoConfig,
  config: AgentConfig,
  lane: Lane,
  logger: Logger,
  snapshot: SnapshotPolicy = "always",
): Promise<RepoCycleResult> {
  // No lane runs on a repo before it is onboarded: its labels exist (onboarding.ts).
  if (config.onboarding && !(await onboardRepo(repoConfig, logger))) return { processed: 0, lastImplementation: null, events: [] };
  const key = `${repoConfig.name}/${lane.name}`;
  lanePassesInFlight.set(key, (lanePassesInFlight.get(key) ?? 0) + 1);
  try {
    return await withLaneLock(repoConfig.name, lane.name, () => runLaneCycle(repoConfig, config, lane, logger, snapshot));
  } finally {
    const n = (lanePassesInFlight.get(key) ?? 1) - 1;
    if (n > 0) lanePassesInFlight.set(key, n);
    else lanePassesInFlight.delete(key);
  }
}

/**
 * One pass over every lane of ONE repo, the lanes side by side. For `--once`
 * and the tests; the daemon drives each lane on its own loop instead.
 */
export async function runRepoPass(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
): Promise<RepoCycleResult> {
  const results = await Promise.all(
    lanesFor(config.stages).map((lane) => runLanePass(repoConfig, config, lane, logger, "never")),
  );
  await publishBoard(repoConfig, logger.child({ repo: repoConfig.name }));
  return {
    processed: results.reduce((n, r) => n + r.processed, 0),
    lastImplementation: results.find((r) => r.lastImplementation)?.lastImplementation ?? null,
    events: results.flatMap((r) => r.events),
  };
}

// Observers mirror GitHub's labels as they stand after a pass. Events move a
// card only when the Foreman acts on that issue, so a card it never acts on
// again (blocked by an old skip, then advanced by a label heal) stayed wrong
// for good: jerky_service #73 sat in Blocked at `pr merged` (2026-10-05).
async function publishBoard(repoConfig: RepoConfig, log: Logger): Promise<void> {
  // A closed issue holds nothing: its skip, hold and failure entries go, observers or not.
  try {
    await pruneClosedHolds(repoConfig, workSourceFor(repoConfig), log);
  } catch (err) {
    log.debug(`Closed-issue holds not cleared: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!hasObservers()) return;
  try {
    await publishSnapshot(repoConfig, log);
  } catch (err) {
    log.debug(`Board snapshot skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * One pass of one lane: the lane's stages, in configured order (lanes.ts). By
 * default the lanes are reconcile, review, verify, release (promote → release),
 * build (revise → implement), branch-sync and dependabot, and every one of them
 * runs on its own loop — a 30-minute build no longer holds the same repo's
 * release, verify or review behind it.
 *
 * Order across lanes is no longer a guarantee, and nothing relied on it beyond
 * pickup latency: each stage reads GitHub's labels as they stand, so review
 * acting on a PR the build lane just opened, or promote seeing a label review
 * just set, now happens one poll later or sooner, never wrongly.
 *
 * A stage that returns `blocked` or `failed` ends the LANE's pass: no later
 * stage of this lane runs for this repo until its next pass. Only custom stages
 * return those (see StageOutcome) — the built-ins keep their own counters.
 *
 * Stages that change the repo's working clone hold its checkout lock while they
 * run (stageNeedsCheckout), so reconcile, revise, implement and custom stages of
 * one repo never overlap; everything else runs alongside them.
 */
async function runLaneCycle(
  repoConfig: RepoConfig,
  config: AgentConfig,
  lane: Lane,
  logger: Logger,
  snapshot: SnapshotPolicy,
): Promise<RepoCycleResult> {
  const events: CycleEvent[] = [];
  let processed = 0;
  let lastImplementation: ImplementationResult | null = null;

  const counterKey = `${repoConfig.name}/${lane.name}`;
  const repoCycle = (laneCycleCounter.get(counterKey) ?? 0) + 1;
  laneCycleCounter.set(counterKey, repoCycle);
  // The phase helpers use the cycle number for per-repo failure cooldowns
  // ("retry after N idle cycles"), so it counts THIS lane's passes on this repo:
  // each of those maps belongs to exactly one lane, and a cooldown measured in
  // another lane's passes would run at that lane's pace, not this one's.
  const cycleNumber = repoCycle;
  const base = logger.child({ cycle: cycleNumber, repoCycle, repo: repoConfig.name, lane: lane.name });

  const dispatched = await dispatchStages(lane.stages, async (stage): Promise<StageResult> => {
    // Session stages (review, verify, revise, implement, release, custom) may
    // not START once a shutdown is under way — see `shutdownRequested`. The
    // release lane's deploy must never be cut off half-way; the drain waits for
    // every lane pass already running.
    if (stageSpawnsSession(stage) && shutdownRequested) return { outcome: "stop", reason: "shutdown requested" };
    const run = () => runStage(stage, repoConfig, config, base, cycleNumber, events);
    // Lock first, then the session slot: a stage waiting for the checkout never
    // holds a slot another repo could use.
    const withSlot = stageSpawnsSession(stage) ? () => withSessionSlot(run) : run;
    const r = stageNeedsCheckout(stage) ? await withCheckoutLock(repoConfig.name, withSlot) : await withSlot();
    processed += r.processed;
    if (r.lastImplementation) lastImplementation = r.lastImplementation;
    return r.result;
  });

  if (dispatched.stoppedAt && dispatched.stoppedAt.outcome !== "stop") {
    const { stage, outcome, reason } = dispatched.stoppedAt;
    base.debug(`Lane pass stopped at stage "${stage}" (${outcome}${reason ? `: ${reason}` : ""}) — later stages of the ${lane.name} lane skipped this pass`);
  }

  if (snapshot === "always" || (snapshot === "if-work" && processed > 0)) await publishBoard(repoConfig, base);

  return { processed, lastImplementation, events };
}

interface StageRun {
  result: StageResult;
  processed: number;
  lastImplementation?: ImplementationResult;
}

/** Run one stage. Each built-in is the phase that used to be called by name, unchanged. */
async function runStage(
  stage: StageEntry,
  repoConfig: RepoConfig,
  config: AgentConfig,
  base: Logger,
  cycleNumber: number,
  events: CycleEvent[],
): Promise<StageRun> {
  let processed = 0;
  let lastImplementation: ImplementationResult | undefined;
  // A shutdown can begin while this stage waited for the checkout or a slot.
  if (stageSpawnsSession(stage) && shutdownRequested) return { result: { outcome: "stop", reason: "shutdown requested" }, processed };

  if (isCustomStage(stage)) {
    const r = await tryCustomStage(repoConfig, stage, base, events);
    if (r.ran) processed++;
    return { result: r, processed };
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
    //    applies the ready-for-prod label itself (separation of duties). No
    //    Discord message (owner direction, 2026-10-10): the release PR and
    //    the issue labels are the record. ---
    case "promote": {
      const releaseActive = hasStage(config.stages, "release") && releaseStageReady(config);
      const promotionResult = await tryPromotion(repoConfig, base, cycleNumber, releaseActive);
      if (promotionResult === "promoted" || promotionResult === "synced") processed++;
      break;
    }

    // --- Release the release PR (EM#578): Tech Lead approval, SRE deploy,
    //    tag, prod verification, close or hold, soak. No Discord message on
    //    any outcome; a no-op without srePath and techLeadPath. ---
    case "release":
      if (await tryRelease(repoConfig, config, base, cycleNumber)) processed++;
      break;

    // --- Ask the EM to unstick stuck work (foreman#103): holds, escalations,
    //    divergence and the release gate. Needs emRepoPath; independent of
    //    Paperclip. Never clears a block. ---
    case "unstick":
      processed += await tryUnstick(repoConfig, config, base, cycleNumber);
      break;
  }
  return { result: { outcome: "ok" }, processed, lastImplementation };
}

/**
 * One fleet pass (`--once`): every repo's lanes once, all side by side — the
 * same shape the daemon runs continuously. `maxConcurrentSessions`, when set,
 * still caps the sessions.
 */
export async function runCycle(
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number
): Promise<CycleResult> {
  const cycleLogger = logger.child({ cycle: cycleNumber, phase: "poll" });
  // `--once` and programmatic callers start here, not in the daemon.
  configureBackoff(config.backoff);
  setSessionLimit(config.maxConcurrentSessions);

  let totalProcessed = 0;
  let lastResult: ImplementationResult | null = null;
  const events: CycleEvent[] = [];

  await Promise.all(config.repos.map(async (repoConfig) => {
    try {
      const result = await runRepoPass(repoConfig, config, logger);
      totalProcessed += result.processed;
      events.push(...result.events);
      if (result.lastImplementation) lastResult = result.lastImplementation;
    } catch (err) {
      // One repo's pipeline must never take the fleet pass down with it.
      logger.child({ cycle: cycleNumber, repo: repoConfig.name }).error("Repo cycle failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }));

  if (totalProcessed === 0) {
    cycleLogger.info("No work across all repos");
  } else {
    cycleLogger.info(`Cycle complete — processed ${totalProcessed} item(s)`);
  }

  return { didWork: totalProcessed > 0, lastImplementation: lastResult, events };
}
