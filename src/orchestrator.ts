import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { SessionEvent, WorkItem } from "./adapters.js";
import {
  selectWork, claimWork, reportWorkState, reportWorkPrLink, reportWorkBlocked,
  notifyObserversMerged, notifyObserversPromoted, notifyObserversState,
  notifySession, notifyWaiting, notifyPromotionStall, notifyRelease,
} from "./work-source.js";
import { trackRelease } from "./release-tracker.js";
import {
  GitHubIssueConnector,
  discoveryBatch,
  hasPendingRevisions,
  findPendingRevisions,
  findPRsNeedingReview,
  getPRCheckVerdict,
  countCiBouncesSinceReview,
  bounceForRedCI,
  commentOnIssue,
  MAX_CI_BOUNCES,
  getReferencedIssuesFromOpenPR,
  findReadyForProdIssues,
  findOpenPromotionPR,
  getPrState,
  createPromotionPR,
  updatePromotionPR,
  checkBranchDrift,
  findOpenSyncPR,
  createSyncPR,
  buildDependencyBatchIssue,
  createDependencyBatchIssue,
  dependencyBatchBases,
  describeDependencyPR,
  findDependencyPRs,
  findOpenDependencyBatchIssue,
  tryMergeSyncPR,
  countBranchDiffFiles,
  isPrOpen,
  stripReadyForProdLabel,
  findOpenFeaturePR,
  type PendingRevisionInfo,
} from "./github.js";
import { implementApprovedIssues, revisePRFeedback, reviewOpenPRs, reviewViaTechLead, runCustomStage, type ImplementationResult, type RevisionResult } from "./agent.js";
import { dispatchStages, isCustomStage, type CustomStage, type StageResult } from "./stages.js";
import { isUpstreamBlocked, tryAcquire, reportClaudeResult } from "./upstream-backoff.js";
import { reconcileRepo, checkLocalBranchDivergence, fastForwardFeatureBranch, type BranchDivergence } from "./reconciler.js";
import {
  verifyPRExists,
  findStuckMergedIssues,
  findIssuesMergedToBase,
  planFailedReviewOutcome,
  findIssuesStillUnderReview,
  readReviewOutcomes,
  findRevokedEmGates,
  restoreEmGate,
  findOrphanedLifecycleIssues,
  type ReviewOutcome,
} from "./github.js";
import type { ReviewTrailer } from "./agent.js";
import { loadRepoState, saveRepoState, type BranchBlock } from "./state.js";
import { prepareReviewCheckout, releaseReviewCheckout } from "./review-checkout.js";

const MAX_RETRIES = 2;

/** The work item a repo-scoped issue number names. */
/** One line: why a diverged feature branch holds an item back. */
function divergenceReason(block: BranchBlock): string {
  return `${block.featureBranch} diverged from ${block.baseBranch} (${block.ahead} ahead, ${block.behind} behind) — a person must reconcile it`;
}

/** The comment each held-back issue gets, once per divergence episode. */
export function divergenceNotice(repoConfig: RepoConfig, block: BranchBlock): string {
  const { featureBranch: f, baseBranch: b } = block;
  return [
    "<!-- foreman:branch-diverged -->",
    `**The Foreman has stopped implementing on \`${repoConfig.githubRepo}\`: \`${f}\` has diverged from \`${b}\` (${block.ahead} ahead, ${block.behind} behind).**`,
    "",
    "This issue is approved and waiting. Building on a diverged branch would build an unknown tree, and the Foreman does not resolve divergence itself. It resumes on the first cycle after the branch is reconciled. This is the only notice for this episode.",
    "",
    "To reconcile, a person decides how — for example:",
    "",
    "```",
    `git fetch origin && git checkout ${f} && git merge origin/${b} && git push origin ${f}`,
    "```",
  ].join("\n");
}

/**
 * Record a diverged feature branch and announce it once per episode
 * (foreman#44). The first sighting warns; later cycles are debug. Each item
 * still waiting gets one comment per episode — an item approved mid-episode
 * gets its own when it first appears. A new merge base is a new episode.
 */
async function announceDivergence(
  repoConfig: RepoConfig,
  waiting: number[],
  divergence: BranchDivergence,
  logger: Logger,
): Promise<BranchBlock> {
  const state = loadRepoState(repoConfig.name);
  const prior = state.branchBlock;
  const mergeBase = divergence.mergeBase ?? "";
  const same = !!prior && prior.mergeBase === mergeBase
    && prior.featureBranch === repoConfig.featureBranch && prior.baseBranch === repoConfig.baseBranch;
  const block: BranchBlock = same
    ? { ...prior!, ahead: divergence.ahead ?? prior!.ahead, behind: divergence.behind ?? prior!.behind }
    : {
      featureBranch: repoConfig.featureBranch, baseBranch: repoConfig.baseBranch, mergeBase,
      ahead: divergence.ahead ?? 0, behind: divergence.behind ?? 0, since: new Date().toISOString(), announced: [],
    };
  const fresh = waiting.filter((n) => !block.announced.includes(n));
  if (!same) {
    logger.warn(
      `Implementation on ${repoConfig.name} stopped — ${divergenceReason(block)}. Announcing on ${fresh.map((n) => `#${n}`).join(", ") || "no waiting issue"}; this is the only warning for this episode`,
    );
  } else {
    logger.debug(`Implementation on ${repoConfig.name} still stopped — ${divergenceReason(block)}`);
  }
  for (const n of fresh) {
    try {
      commentOnIssue(repoConfig, n, divergenceNotice(repoConfig, block));
      block.announced.push(n);
    } catch (err) {
      // Not recorded as announced, so the next cycle tries again.
      logger.warn(`Could not announce the divergence on #${n}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  state.branchBlock = block;
  saveRepoState(repoConfig.name, state);
  return block;
}

function itemOf(repoConfig: RepoConfig, issueNumber: number): WorkItem {
  return { issueNumber, repo: repoConfig.githubRepo };
}

// Merged / promoted events already delivered to observers this process, keyed
// `<kind>:<owner/repo>#<n>`. Several paths can see the same merge (the review's
// own trailer, a failed-but-landed review, dead-zone detection on every later
// pass, the implement stage's already-merged sweep), and a promotion whose
// label strip failed is seen again next cycle. An observer gets each once.
const observerEventsSent = new Set<string>();

/**
 * Tell observers each issue merged / was handed to promotion, once per issue.
 * Best-effort by construction (work-source.ts never rethrows an observer
 * error); with no observer registered this does nothing at all.
 */
/**
 * Tell the observers the outcome a review agent wrote on GitHub itself. The
 * agent labels `pr approved` / `pr pending actions` directly, so no state
 * change passes through `reportWorkState`; without this a live review card
 * ends its session back at "in review" until something else re-reads GitHub.
 * Issues still at `pr under review` carry no outcome and are left to the
 * reconcile, which reports its own.
 */
async function reportReviewOutcomes(repoConfig: RepoConfig, issueNumbers: number[], logger: Logger): Promise<void> {
  for (const [n, outcome] of readReviewOutcomes(repoConfig, issueNumbers, logger)) {
    await notifyObserversState(itemOf(repoConfig, n), "inReview", outcome === "prApproved" ? "approved" : "changesRequested", repoConfig, logger);
  }
}

async function notifyObserversOnce(
  kind: "merged" | "promoted",
  repoConfig: RepoConfig,
  issueNumbers: number[],
  logger: Logger,
): Promise<void> {
  for (const n of issueNumbers) {
    const key = `${kind}:${repoConfig.githubRepo}#${n}`;
    if (observerEventsSent.has(key)) continue;
    observerEventsSent.add(key);
    if (kind === "merged") await notifyObserversMerged(itemOf(repoConfig, n), repoConfig, logger);
    else await notifyObserversPromoted(itemOf(repoConfig, n), repoConfig, logger);
  }
}

// Agent runs in flight, keyed by repo name. Repos progress CONCURRENTLY (one
// queue per service — see runCycle), so "the" in-flight run stopped being a
// single thing; a lone `abortController` would have tracked whichever repo
// started last and let a restart SIGKILL every other repo's half-built branch.
// One entry per repo, at most — a repo's own phases stay strictly sequential
// because they share one git working clone.
const activeRuns = new Map<string, AbortController>();

// Per-repo consecutive batch failure count with cooldown
const failureCount = new Map<string, number>();
const failureHitMaxAt = new Map<string, number>(); // cycle when max was hit
const revisionFailureCount = new Map<string, number>();
// Repos whose revision retries are exhausted AND already escalated. Without this
// the cap was reached silently: the count hit MAX_RETRIES, every later cycle took
// the `debug` skip branch, and the stuck PR sat there with nobody told. The set is
// cleared the moment a revision succeeds or the pending feedback clears, so a repo
// that recovers escalates again if it breaks again.
const revisionEscalated = new Set<string>();
// Consecutive revisions that pushed nothing BY DECLARATION, per repo.
//
// A declared no-commit is a valid answer, so it returns to `pr under review`
// and gets re-reviewed. But if the reviewer then asks for the same change
// again, the pair will ping-pong forever at no cost to either side and with
// nothing changing. One is an answer; two in a row is a disagreement, and a
// disagreement between two agents is a human's call.
//
// Cleared whenever a revision actually pushes, or the pending feedback clears.
const consecutiveNoCommit = new Map<string, number>();
const MAX_CONSECUTIVE_NO_COMMIT = 1;
const reviewFailureCount = new Map<string, number>();
const reviewFailureHitMaxAt = new Map<string, number>();

// Last cycle on which each repo checked whether an empty ready-for-prod set is
// actually a stall. Rate-limits one compare API call per repo; see tryPromotion.
const lastStallCheckCycle = new Map<string, number>();
const STALL_CHECK_CYCLE_INTERVAL = 12;

/** Per-repo set of issue numbers already alerted as dead-zoned, so a STANDING
 *  condition alerts once instead of every reconcile cycle. Cleared per-issue when
 *  the issue leaves the dead-zone, so a genuine re-entry alerts again. */
const deadZoneAlerted = new Map<string, Set<number>>();

/** Per-repo set of issue numbers we already attempted to auto-recover, so a
 *  repo whose verification is INDETERMINATE (unmapped service, verifier crash)
 *  does not re-spend a multi-minute deploy poll on every cycle, forever. */
const deadZoneRecoveryAttempted = new Map<string, Set<number>>();

/** Ceiling on one dead-zone re-verification. The verifier polls a Railway
 *  deployment, so minutes are normal and hanging forever is not. */
const RECOVERY_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

const FAILURE_COOLDOWN_CYCLES = 3; // retry after this many idle cycles
const lastFailureReason = new Map<string, string>(); // per-repo last failure for retry context

/**
 * Repair one dead-zoned issue by re-running the post-merge verification the
 * failed review never completed, then labeling from ITS verdict.
 *
 * This is not a rubber stamp, which is the objection that kept the dead zone
 * detection-only. The verdict comes from the verifier — a real deploy poll and
 * healthcheck against the merged commit — not from the agent that dropped the
 * ball, and not from the mere fact that a merge happened. `pr approved` on PASS
 * is precisely the state a healthy review would have left behind; `pr pending
 * actions` on FAIL routes it to the revise phase, which is what a post-merge
 * FAIL is supposed to do. A FAIL is still a HOLD — it just becomes a hold the
 * pipeline knows about instead of an issue nobody is looking at.
 *
 * `ready for prod release` is never applied here: that label is the EM outcome
 * gate's signature and stays a human act.
 *
 * Returns the verdict, or "indeterminate" when we could not get a trustworthy
 * answer — an unmapped repo (the verifier exits 2 for a service it has no
 * Railway mapping for), a verifier crash, or a timeout. Indeterminate changes
 * NOTHING: the issue stays dead-zoned and alerted, which is strictly better
 * than guessing at a lifecycle from a verification that never ran.
 */
function recoverDeadZonedIssue(
  repoConfig: RepoConfig,
  config: AgentConfig,
  issueNumber: number,
  prNumber: number,
  logger: Logger,
): "pass" | "fail" | "indeterminate" {
  if (!config.emRepoPath) {
    logger.debug("Dead-zone recovery skipped — emRepoPath not configured");
    return "indeterminate";
  }

  logger.info(
    `Dead-zone recovery: re-running post-merge verification for #${issueNumber} (PR #${prNumber})`,
  );

  const run = spawnSync(
    "npm",
    [
      "run", "verify", "--",
      "--repo", repoConfig.name,
      "--pr", String(prNumber),
      "--issue", String(issueNumber),
      "--env", "development",
    ],
    {
      cwd: config.emRepoPath,
      encoding: "utf-8",
      timeout: RECOVERY_VERIFY_TIMEOUT_MS,
      env: process.env,
    },
  );

  if (run.error || run.signal) {
    logger.warn(
      `Dead-zone recovery INDETERMINATE for #${issueNumber} — verifier did not complete (${run.signal ? `signal ${run.signal}` : run.error?.message}); leaving the issue as-is`,
    );
    return "indeterminate";
  }

  // The verifier's contract: 0 = all checks pass, 1 = a check failed,
  // 2 = crash or invalid arguments (including a repo it has no service mapping
  // for). Only 0 and 1 are verdicts; 2 is an absence of one.
  if (run.status === 0) return "pass";
  if (run.status === 1) return "fail";

  logger.warn(
    `Dead-zone recovery INDETERMINATE for #${issueNumber} — verifier exited ${run.status} (no verdict; repo may have no service mapping): ${(run.stderr || "").split("\n")[0]}`,
  );
  return "indeterminate";
}

/**
 * The lifecycle state a review run's own trailer implies for the issues its PR
 * closed, or null when the trailer does not warrant a write. Returned as a
 * `LifecycleLabels` key, so the configured name is looked up at the write and
 * `readyForProd` is not even expressible here.
 *
 * Null is the important half. The reconciler exists to repair a MISSING write,
 * never to invent one, so anything the trailer does not say plainly is left for a
 * human — an unmerged PR (the issue is legitimately still under review), or a
 * self-contradictory report like `verdict=REQUEST_CHANGES merged=yes`.
 *
 * `deploy=NA` is a PASS, not an absence: it is what a repo with nothing to deploy
 * (docs, CLI, npm package) is instructed to emit.
 */
export function labelFromTrailer(t: ReviewTrailer): ReviewOutcome | null {
  if (!t.merged) return null;
  if (t.verdict !== "APPROVE") return null;
  if (/^(FAIL|FAILURE|FAILED)$/.test(t.deploy)) return "prPendingActions";
  if (/^(SUCCESS|OK|PASS|PASSED|NA|N\/A|NONE)$/.test(t.deploy)) return "prApproved";
  return null;
}

/**
 * Set the outcome label the review run reported, for issues it merged but left at
 * `pr under review`.
 *
 * This is the fix for the pipeline's oldest silent failure: the merge was done by
 * code while the RECORD of it was left to an agent to remember to write, so ~23%
 * of merges (12 of 53 over 2026-07-29 → 08-04) stranded their issue in a state no
 * phase reads. The outcome was never actually unknown — it arrived in a
 * machine-readable trailer the Foreman already parsed and logged. This spends it.
 *
 * Four independent conditions gate every write, so the reconciler cannot invent
 * state or overrule anyone:
 *   1. the issue is STILL at `pr under review` with no outcome label — a run that
 *      labeled correctly never reaches this code, so healthy behavior is unchanged;
 *   2. a merged PR provably closed that issue, via the same STRICT predicate the
 *      promotion path uses (`findIssuesMergedToBase` — a bare "related to #N"
 *      never counts);
 *   3. that PR has a trailer from THIS run whose fields are unambiguous;
 *   4. the reviewer did not declare a deliberate hold.
 *
 * It never applies `ready for prod release`: that label authorizes production and
 * stays the EM outcome-gate's signature (separation of duties, 2026-07-27).
 *
 * Returns the issues still stuck after reconciliation — the genuine dead zone.
 */
async function reconcileReviewOutcomeLabels(
  repoConfig: RepoConfig,
  stuck: number[],
  trailers: ReviewTrailer[],
  logger: Logger,
  events?: CycleEvent[],
): Promise<number[]> {
  const merged = findIssuesMergedToBase(repoConfig, stuck, logger);
  const byIssue = new Map(merged.map((m) => [m.issueNumber, m]));
  const unresolved: number[] = [];
  let held: { issue: number; reason: string; pr: number }[] = [];

  for (const issueNumber of stuck) {
    const ref = byIssue.get(issueNumber);
    if (!ref) {
      // Could not tie this issue to a merged PR. That is EITHER "its PR is still
      // open, so `pr under review` is correct" OR "the lookup failed" —
      // findIssuesMergedToBase returns [] for both. Report it rather than pick:
      // treating a failed lookup as "nothing to fix" is the same silent-skip that
      // let this whole class of bug run for months. Unresolved keeps the existing
      // dead-zone warning, which is exactly what fired here before this function
      // existed, so this is never noisier than the behavior it replaced.
      unresolved.push(issueNumber);
      continue;
    }
    const trailer = trailers.find((t) => t.pr === ref.prNumber);
    if (!trailer) {
      unresolved.push(issueNumber);
      continue;
    }
    if (trailer.hold) {
      held.push({ issue: issueNumber, reason: trailer.hold, pr: ref.prNumber });
      continue;
    }
    const outcome = labelFromTrailer(trailer);
    if (!outcome) {
      logger.warn(
        `Not reconciling #${issueNumber}: PR #${ref.prNumber}'s trailer is ambiguous (verdict=${trailer.verdict} merged=${trailer.merged} deploy=${trailer.deploy}) — leaving it for a human`,
      );
      unresolved.push(issueNumber);
      continue;
    }
    const to = outcome === "prApproved" ? "approved" : "changesRequested";
    if (await reportWorkState(itemOf(repoConfig, issueNumber), "inReview", to, repoConfig, logger)) {
      events?.push({
        message: `${repoConfig.githubRepo} #${issueNumber} — review merged PR #${ref.prNumber} without labeling; reconciled to "${repoConfig.lifecycleLabels[outcome]}" from its own trailer`,
        level: outcome === "prApproved" ? "info" : "warn",
      });
    } else {
      unresolved.push(issueNumber);
    }
  }

  // Persist declared holds so neither this reconciler nor the dead-zone recovery
  // overwrites a deliberate decision on a later cycle or after a restart. The
  // in-memory skip sets would not survive either.
  if (held.length > 0) {
    const state = loadRepoState(repoConfig.name);
    if (!state.held) state.held = {};
    const at = new Date().toISOString();
    for (const h of held) {
      state.held[h.issue] = { heldAt: at, prNumber: h.pr, reason: h.reason };
      logger.info(
        `#${h.issue} held by the reviewer (PR #${h.pr}): ${h.reason} — leaving "${repoConfig.lifecycleLabels.prUnderReview}" in place, not re-verifying`,
      );
      events?.push({
        message: `⏸️ ${repoConfig.githubRepo} #${h.issue} held by review: ${h.reason} (PR #${h.pr} merged; label intentionally withheld)`,
        level: "info",
      });
    }
    saveRepoState(repoConfig.name, state);
  }

  return unresolved;
}

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

export interface CycleEvent {
  message: string;
  level: "info" | "warn" | "error";
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
 * The reconcile stage: orphaned commits, rejected branches, and the three dead
 * zones. Returns how many items it processed. Never throws — each half catches
 * its own failure, as it did when this was inline Phase 0.
 */
async function runReconcileStage(
  repoConfig: RepoConfig,
  config: AgentConfig,
  base: Logger,
  events: CycleEvent[],
): Promise<number> {
  let processed = 0;
  const reconLogger = base.child({ phase: "reconcile" });
  try {
    const result = reconcileRepo(repoConfig, reconLogger);
    if (result.reconciled) {
      // reconcileRepo opened a PR for orphaned commits; report its linked items
      // as in review so the Review phase's gate sees it. Immediately after the
      // PR is verified, as when the reconciler wrote the label itself.
      for (const n of result.issueNumbers) {
        const item = itemOf(repoConfig, n);
        if (result.prUrl) await reportWorkPrLink(item, result.prUrl, repoConfig, reconLogger);
        await reportWorkState(item, "new", "inReview", repoConfig, reconLogger);
      }
      reconLogger.info(
        `Reconciled ${result.commitCount} orphaned commit(s) — PR created: ${result.prUrl}`,
        { issues: result.issueNumbers },
      );
      events.push({ message: `Reconciled ${repoConfig.githubRepo} — ${result.commitCount} orphaned commit(s), PR: ${result.prUrl}`, level: "info" });
      processed++;
    }

    // A rejected branch is a STANDING condition, not an event: the commits sit
    // ahead of base every cycle until someone reverts them. Alert ONCE per head
    // SHA — same discipline as the dead-zone alerts below, for the same reason
    // (a per-cycle repeat is indistinguishable from noise and gets muted).
    //
    // Deliberately detection-only. The cure is to revert the rejected diff off the
    // shared branch, and that is a destructive push to a branch other work rides
    // on — on a protected branch it is not even possible (HTTP 422). Doing it
    // automatically could discard legitimate unmerged work, so the Foreman reports
    // and a human decides. See slashbin-ai-foreman#24.
    for (const r of result.rejected ?? []) {
      const state = loadRepoState(repoConfig.name);
      const alreadyAlerted = (state.rejectedBranches ?? {})[r.branch];
      if (alreadyAlerted === r.headSha) continue;

      const issues = r.issueNumbers.length > 0
        ? ` (issues ${r.issueNumbers.map((n) => `#${n}`).join(", ")})`
        : "";
      reconLogger.warn(
        `${r.branch} carries ${r.commitCount} rejected commit(s) — PR #${r.prNumber} was closed unmerged ` +
        `and nothing has changed since. Reconciliation is blocked until the diff is reverted off the branch.`,
        { branch: r.branch, headSha: r.headSha, rejectedPR: r.prUrl },
      );
      events.push({
        message:
          `⚠️ ${repoConfig.githubRepo} — \`${r.branch}\` still carries the ${r.commitCount} commit(s) from ` +
          `PR #${r.prNumber}, which was closed unmerged${issues}. The Foreman will NOT recreate that PR. ` +
          `Revert the diff off \`${r.branch}\`, or those commits ride along in the next PR from this branch. ${r.prUrl}`,
        level: "warn",
      });

      const fresh = loadRepoState(repoConfig.name);
      fresh.rejectedBranches = { ...(fresh.rejectedBranches ?? {}), [r.branch]: r.headSha };
      saveRepoState(repoConfig.name, fresh);
    }
  } catch (err) {
    reconLogger.error("Reconciliation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Surface dead-zoned issues: PR merged to develop but the issue is still
  // `pr under review` (post-merge verify failed and no phase recovers it).
  // Detection only — the EM re-verifies and advances/flags by hand.
  //
  // ALERT ONCE per (repo, issue). The dead-zone is a STANDING condition, not an
  // event: it persists every cycle until the EM clears it, so re-emitting each
  // reconcile pass floods Discord with the identical line (~every 2 min) and
  // trains the reader to ignore the channel — the alarm defeats itself.
  // Observed 2026-07-19 on Slashbin-console#661 (Ray: "i keep seeing this
  // messages"). The warning fires on transition INTO the dead-zone; the entry
  // clears when the issue leaves it, so a genuine re-entry alerts again.
  try {
    const stuck = findStuckMergedIssues(repoConfig, reconLogger);
    const seen = deadZoneAlerted.get(repoConfig.name) ?? new Set<number>();
    const tried = deadZoneRecoveryAttempted.get(repoConfig.name) ?? new Set<number>();
    const current = new Set(stuck.map((s) => s.issueNumber));

    // Issues whose reviewer DECLARED a hold are not dead — they are waiting on
    // purpose. Auto-recovery would re-verify and label them anyway, replacing a
    // human-grade judgment ("this criterion is not observable until 03:00Z") with
    // an automated verdict. Surface them, never overwrite them.
    const repoState = loadRepoState(repoConfig.name);
    const heldIssues = repoState.held ?? {};
    const labels = repoConfig.lifecycleLabels;

    for (const s of stuck) {
      // Its PR merged — whatever happens to the label next.
      await notifyObserversOnce("merged", repoConfig, [s.issueNumber], reconLogger);
      const hold = heldIssues[s.issueNumber];
      if (hold) {
        if (!seen.has(s.issueNumber)) {
          seen.add(s.issueNumber);
          reconLogger.info(
            `Issue #${s.issueNumber} is HELD by its review (PR #${s.prNumber}, since ${hold.heldAt}): ${hold.reason} — not auto-recovering`,
          );
          events.push({
            message: `⏸️ ${repoConfig.githubRepo} #${s.issueNumber} held by review since ${hold.heldAt.slice(0, 16)}: ${hold.reason}. EM: resolve when the criterion can be checked.`,
            level: "info",
          });
        }
        continue;
      }
      // --- Recovery first, alert only if it could not be repaired ----------
      // Attempt once per (repo, issue). A second attempt only repeats whatever
      // made the first indeterminate, at the cost of another deploy poll.
      if (!tried.has(s.issueNumber)) {
        tried.add(s.issueNumber);
        const verdict = recoverDeadZonedIssue(
          repoConfig,
          config,
          s.issueNumber,
          s.prNumber,
          reconLogger,
        );
        if (verdict !== "indeterminate" && await reportWorkState(
          itemOf(repoConfig, s.issueNumber), "unknown", verdict === "pass" ? "approved" : "changesRequested",
          repoConfig, reconLogger,
        )) {
          const label = labels[verdict === "pass" ? "prApproved" : "prPendingActions"];
          events.push({
            message: `${repoConfig.githubRepo} #${s.issueNumber} dead-zone auto-recovered: re-verification ${verdict.toUpperCase()} → labeled "${label}" (PR #${s.prNumber} was merged with the issue left unadvanced)`,
            level: verdict === "pass" ? "info" : "warn",
          });
          seen.delete(s.issueNumber);
          current.delete(s.issueNumber);
          processed++;
          continue; // repaired — no dead-zone alert needed
        }
      }

      if (seen.has(s.issueNumber)) continue; // already alerted; still stuck
      seen.add(s.issueNumber);
      reconLogger.warn(
        `Dead-zoned issue #${s.issueNumber}: PR #${s.prNumber} merged to ${repoConfig.baseBranch} but the issue never advanced to "${labels.prApproved}", and re-verification produced no verdict`,
        { prUrl: s.prUrl, mergedAt: s.mergedAt },
      );
      events.push({
        message: `⚠️ ${repoConfig.githubRepo} #${s.issueNumber} dead-zoned: PR #${s.prNumber} merged but the issue never advanced to "${labels.prApproved}", and auto re-verification could not produce a verdict. EM: verify by hand (npm run verify -- --repo ${repoConfig.name} --pr ${s.prNumber} --env development), then advance to "${labels.readyForProd}" or flag "${labels.prPendingActions}".`,
        level: "warn",
      });
    }
    // Drop cleared issues so a real re-entry alerts again — and so a repaired
    // issue that genuinely re-enters the dead zone later can be retried.
    for (const n of [...seen]) if (!current.has(n)) seen.delete(n);
    for (const n of [...tried]) if (!current.has(n)) tried.delete(n);
    deadZoneAlerted.set(repoConfig.name, seen);
    deadZoneRecoveryAttempted.set(repoConfig.name, tried);

    // --- Third dead zone: a lifecycle label whose work NEVER LANDED ----------
    // `pr under review` / `pr pending actions` with no open PR covering the
    // issue AND nothing merged. The PR was closed unmerged, or an implement run
    // wrote the label and died before opening one.
    //
    // This is the invisible one. `GitHubIssueConnector.selectWork` skips any issue carrying
    // a lifecycle label, `tryReview` needs an open PR, `findPendingRevisions`
    // needs an open PR and returns null at DEBUG level when there is none — so
    // the issue keeps its `approved` label, is owned by no phase, and produces
    // no log line anybody reads. It stops existing as far as the pipeline is
    // concerned, with nothing to indicate it ever stopped.
    //
    // Recovery is the inverse of the merged case: nothing exists to verify, so
    // return it to the queue. Safe precisely BECAUSE nothing merged —
    // re-implementing cannot duplicate work that was never done.
    for (const num of findOrphanedLifecycleIssues(repoConfig, reconLogger)) {
      if (await reportWorkState(itemOf(repoConfig, num), "unknown", "queued", repoConfig, reconLogger)) {
        events.push({
          message: `${repoConfig.githubRepo} #${num} released back to the implement queue — it carried a lifecycle label but no PR covers it and nothing merged, so the work never landed.`,
          level: "warn",
        });
        processed++;
      }
    }

    // A hold ends when the issue leaves the dead zone (someone set the label or
    // closed it). Prune, or the record outlives the condition and would suppress
    // recovery on a genuine re-entry months later.
    const stale = Object.keys(heldIssues).map(Number).filter((n) => !current.has(n));
    if (stale.length > 0) {
      const fresh = loadRepoState(repoConfig.name);
      if (fresh.held) {
        for (const n of stale) delete fresh.held[n];
        saveRepoState(repoConfig.name, fresh);
        reconLogger.debug(`Cleared ${stale.length} resolved hold(s): #${stale.join(", #")}`);
      }
    }
  } catch (err) {
    reconLogger.debug(
      `Dead-zone detection failed for ${repoConfig.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return processed;
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
    const spawnsClaude = isCustomStage(stage) || stage.type === "review" || stage.type === "revise" || stage.type === "implement";
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

      // --- Revise PRs with pending review feedback ---
      case "revise": {
        const revisionInfo = await tryRevision(repoConfig, base, cycleNumber, events);
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

  return { processed, lastImplementation, events };
}

/**
 * A custom stage's last verdict per repo, keyed `<repo>\0<stage id>`, with the
 * feature-branch head it was reached on. A verdict stands until that head moves:
 * the pass loop polls every minute, and re-running the same skill on the same
 * code each time would spend a session per poll to learn nothing new. In memory
 * only — a restart re-runs each stage once.
 */
const customStageVerdicts = new Map<string, { headSha: string; outcome: "ok" | "blocked" | "failed"; reason?: string }>();

/**
 * Run one custom stage for one repo: a single Claude session on the stage's
 * skill (runCustomStage), against the open feature PR. Nothing in flight → `ok`
 * with no session, so a pass with no open PR reaches the stages after it.
 *
 * Goes through the same gates as the other Claude phases: the upstream
 * back-off (`tryAcquire` / `reportClaudeResult`), the per-repo abort
 * controller, and the shutdown check in the dispatch loop. A run the upstream
 * refused is `blocked` without a verdict (not remembered, retried next pass).
 */
async function tryCustomStage(
  repoConfig: RepoConfig,
  stage: CustomStage,
  logger: Logger,
  events: CycleEvent[],
): Promise<StageResult & { ran: boolean }> {
  const stageLogger = logger.child({ phase: `stage:${stage.id}` });
  if (isUpstreamBlocked("github") || isUpstreamBlocked("claude")) {
    return { outcome: "blocked", reason: "upstream back-off", ran: false };
  }

  let pr: ReturnType<typeof findOpenFeaturePR>;
  try {
    pr = findOpenFeaturePR(repoConfig);
  } catch (err) {
    // Could not look is not "nothing to check": hold the later stages this pass.
    return { outcome: "blocked", reason: `work in flight unreadable: ${err instanceof Error ? err.message : String(err)}`, ran: false };
  }
  if (!pr) return { outcome: "ok", ran: false };

  const key = `${repoConfig.name}\0${stage.id}`;
  const prior = customStageVerdicts.get(key);
  if (prior && prior.headSha === pr.headSha) {
    return { outcome: prior.outcome, reason: prior.reason, ran: false };
  }

  if (!tryAcquire("claude")) return { outcome: "blocked", reason: "upstream back-off", ran: false };
  const runAbort = new AbortController();
  activeRuns.set(repoConfig.name, runAbort);
  try {
    const result = await runCustomStage(
      repoConfig, stage,
      { prNumber: pr.number, issueNumbers: pr.issueNumbers, headSha: pr.headSha },
      stageLogger, runAbort.signal,
    ).catch(reportLaunchThrew);
    reportClaudeResult(!!result.upstreamLimit, result.upstreamLimit?.reason, result.upstreamLimit?.resetAtMs);
    if (result.upstreamLimit) return { outcome: "blocked", reason: result.upstreamLimit.reason, ran: false };

    const outcome = result.verdict === "pass" ? "ok" : result.verdict;
    customStageVerdicts.set(key, { headSha: pr.headSha, outcome, reason: result.reason });
    const where = `${repoConfig.githubRepo} PR #${pr.number}`;
    if (outcome === "ok") {
      stageLogger.info(`Stage "${stage.id}" passed on ${where}`);
      events.push({ message: `Stage "${stage.id}" passed on ${where}`, level: "info" });
    } else {
      stageLogger.warn(`Stage "${stage.id}" ${outcome} on ${where}: ${result.reason ?? "no reason given"} — later stages held until ${repoConfig.featureBranch} moves`);
      events.push({
        message: `${outcome === "blocked" ? "⛔" : "⚠️"} Stage "${stage.id}" ${outcome} on ${where}: ${result.reason ?? "no reason given"}. Later stages are held for this repo until \`${repoConfig.featureBranch}\` moves.`,
        level: outcome === "blocked" ? "warn" : "error",
      });
    }
    return { outcome, reason: result.reason, ran: true };
  } finally {
    activeRuns.delete(repoConfig.name);
  }
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

/**
 * Classify a recorded skip reason as transient + currently-resolved. Returns
 * true only when (a) the reason matches a known transient pattern AND (b) the
 * underlying precondition can be re-checked from this host AND (c) the check
 * confirms the precondition no longer holds. Returning false is safe — the
 * back-off continues normally.
 *
 * Known transient patterns:
 * - "diverged from origin/<branch>" — local working clone ahead/behind origin;
 *   resolved when both are 0. The skill emits this when `git pull origin
 *   features` fails on a divergent branch state, typically caused by an EM
 *   session leaving polluted refs in the shared clone (see
 *   feedback_em_clone_stay_on_main). An EM manual reconcile
 *   (`git branch -f features origin/features`) clears the cause but cannot
 *   reach into the daemon's skip cache; this recheck lets the orchestrator
 *   notice the cause is gone and admit on the next cycle instead of waiting
 *   out the full 30-min back-off.
 *
 * - "an open PR #N holds the feature branch" (foreman#50) — the session will not
 *   push a second issue onto a branch another PR owns. Cleared once #N is no
 *   longer open. The most common skip in the state file: Slashbin-console #1205
 *   sat out its window 16+ minutes after #1204 merged, Slashbin-io-docs #412 33.
 *
 * Add new transient patterns here as they are identified. Durable reasons
 * (issue-body says "investigation only", "no immediate code change") MUST
 * stay caught by the default `return false` — those don't go away on retry.
 * Unknown stays deny: a PR the snapshot cannot vouch for keeps the back-off.
 */
function isResolvedTransientSkip(
  reason: string,
  repoConfig: RepoConfig,
  logger: Logger,
): boolean {
  const divergenceMatch = reason.match(/diverged from origin\/(\S+?)\b/i);
  if (divergenceMatch) {
    const branch = divergenceMatch[1];
    const div = checkLocalBranchDivergence(repoConfig.repoPath, branch, logger);
    return div !== null && div.ahead === 0 && div.behind === 0;
  }
  const prNumber = prBlockingSkip(reason);
  if (prNumber !== null) {
    return isPrOpen(repoConfig.githubRepo, prNumber, repoConfig.repoPath) === false;
  }
  return false;
}

/**
 * The PR a skip reason says is holding the branch, or null. The reason is the
 * agent's own words, so match the shapes it uses — "occupied by open PR #N",
 * "open features→develop PR #N … must merge or close" — and require the word
 * that makes the PR the BLOCKER, so a reason that merely cites a PR is not read
 * as one. Exported for tests.
 */
export function prBlockingSkip(reason: string): number | null {
  const m = reason.match(/\b(?:occupied|held|blocked)\b[^.;]*?\bPR #(\d+)/i)
    ?? reason.match(/\bopen\b[^.;#]*?\bPR #(\d+)/i)
    ?? reason.match(/\bPR #(\d+)\b[^.;]*?\b(?:must merge|is (?:still )?open|still open)/i);
  return m ? Number(m[1]) : null;
}

/** Hard ceiling on the escalating skip back-off — 24h. Beyond this the retry rate
 *  is already negligible, and we still want an eventual re-check in case the
 *  world changed (issue body edited, dependency landed). */
const SKIP_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Escalating back-off window for the Nth consecutive skip of one issue:
 * base * 2^(N-1), capped (30m → 1h → 2h → 4h → … → 24h at the default base).
 *
 * A FIXED snooze is not a back-off: it never gives up, so an issue that can never
 * become actionable costs one full Claude session every window, forever
 * (slashbin-ai-foreman#32). Escalating bounds the cost of ANY repeating skip —
 * investigation-only issues, blocked-on-external, and merged-work alike.
 *
 * skipCount is optional in persisted state (pre-#32 files) — absent reads as the
 * first skip, i.e. exactly the original single-window behavior.
 */
function backoffWindowFor(skipCount: number | undefined, baseMs: number): number {
  const n = Math.max(1, skipCount ?? 1);
  const exp = Math.min(n - 1, 10); // 2^10 * 30m ≫ cap; guards against overflow
  return Math.min(baseMs * 2 ** exp, SKIP_BACKOFF_MAX_MS);
}

/**
 * A Claude launch that threw is reported as a non-limit result, so a half-open
 * probe is never left out forever. Every launch that returns is reported by its
 * phase directly after the call, ahead of every return.
 */
function reportLaunchThrew(err: unknown): never {
  reportClaudeResult(false);
  throw err;
}

async function tryBatchImplementation(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[]
): Promise<ImplementationResult | null> {
  const repoName = repoConfig.name;
  const skipBackoffMs = config.skipBackoffMs;
  const repoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "implement" });

  // Claude is backing off (or its one half-open probe is already out): no
  // per-repo events — the back-off module has already said so, once.
  if (isUpstreamBlocked("claude")) return null;

  // Check if this repo has exceeded batch failure retries
  const failures = failureCount.get(repoName) ?? 0;
  if (failures >= MAX_RETRIES) {
    const hitAt = failureHitMaxAt.get(repoName) ?? cycleNumber;
    const cyclesSinceMax = cycleNumber - hitAt;
    if (cyclesSinceMax < FAILURE_COOLDOWN_CYCLES) {
      repoLogger.debug(`Skipping ${repoName} — ${failures} consecutive failures, cooldown ${cyclesSinceMax}/${FAILURE_COOLDOWN_CYCLES} cycles`);
      return null;
    }
    // Cooldown expired — reset and retry
    repoLogger.info(`Failure cooldown expired for ${repoName} — resetting and retrying`);
    failureCount.set(repoName, 0);
    failureHitMaxAt.delete(repoName);
  }

  // Gate: are there approved issues to implement? The work source offers
  // every eligible item, uncapped. Two lists are cut from that offer:
  //   - `handOff` — the offer less the state filters below. This is what a
  //     skill is told to build. Uncapped, because a skill chooses by priority
  //     across all of it: capping would hide an S1 behind three older issues.
  //   - `actionableIssues` — the Foreman's own discovery batch (ascending,
  //     capped at MAX_BATCH_SIZE), cut from `handOff` AFTER the filters, so a
  //     backed-off or already-implemented issue never holds a batch slot.
  //     Cutting first and filtering after starved the queue: three backed-off
  //     issues filled the cap every cycle and the rest of the offer was never
  //     reached (Slashbin-console#1154, 2026-10-01). Everything the
  //     Foreman does per issue keeps using it: the run gate, the inline
  //     prompt, a batch-wide skip, the labeling fallback.
  const offered = (await selectWork(repoConfig, config, repoLogger)).map((w) => w.issueNumber);
  let handOff = offered;
  if (offered.length === 0) {
    // Nothing offered, so nothing waits: observers clear this repo's waits.
    await notifyWaiting(repoConfig.githubRepo, [], repoLogger);
    // Reset failure count when there's no work (issues were resolved externally)
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  // Filter out issues already tracked as implemented in persistent state.
  // This prevents infinite loops where the Foreman re-implements the same
  // issues because the work source's PR check didn't match.
  const repoState = loadRepoState(repoName);

  // Self-heal the `implemented` cache (slashbin-ai-foreman #16/#18/#540 family).
  //
  // Invariant: `implemented[N]` must mean "a PR that delivers N exists".
  // `selectWork` already authoritatively returns only approved
  // issues with NO linked PR (open or merged) — it is the same check the
  // orchestrator trusts to decide what to implement. So any N that is BOTH
  // still in the offer (no delivering PR per the live check) AND in
  // `repoState.implemented` is a stale, dead-zoned entry: a prior run recorded
  // it without producing a delivering PR (PR creation failed, or its commit
  // rode a foreign PR on the shared `features` branch). Left alone it is
  // skipped forever with no recovery. The live no-linked-PR signal wins over
  // the stale cache: prune so the issue is re-implemented this cycle.
  //
  // This cannot reintroduce the re-implement loop the cache guards against:
  // that loop is "PR exists but the linkage check missed it" — here the same
  // linkage check (selectWork) reports NO PR, so there is nothing to
  // loop on; true loops remain bounded by failureCount/cooldown + skip back-off.
  // Additive only — no state shape / .ai-agent.json / branch-model change.
  const staleImplemented = repoState.implemented.filter((n) => handOff.includes(n));
  if (staleImplemented.length > 0) {
    repoLogger.warn(
      `Self-heal: pruning ${staleImplemented.length} stale 'implemented' entr${staleImplemented.length === 1 ? "y" : "ies"} with no delivering PR — re-implementable: ${staleImplemented.map((n) => `#${n}`).join(", ")}`,
    );
    const healed = loadRepoState(repoName);
    healed.implemented = healed.implemented.filter((n) => !staleImplemented.includes(n));
    saveRepoState(repoName, healed);
    repoState.implemented = healed.implemented;
  }

  const alreadyImplemented = new Set(repoState.implemented);
  handOff = handOff.filter((n) => !alreadyImplemented.has(n));
  if (handOff.length === 0) {
    await notifyWaiting(repoConfig.githubRepo, [], repoLogger);
    repoLogger.info(`All actionable issues already implemented (state filter) — skipping`);
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  // Filter out issues the agent recently chose to skip (investigation-only,
  // blocked-on-external-verification, etc.). Back off for SKIP_BACKOFF_MS so
  // we don't burn an agent run every cycle correctly doing nothing.
  // Skipped entries are cleared automatically when the issue is re-implemented
  // (success path) or when the back-off expires.
  //
  // Reason-aware recheck: some skip reasons describe a TRANSIENT precondition
  // (e.g., "local features branch diverged from origin/features") that an EM
  // session can manually resolve mid-back-off. Before honoring the back-off,
  // re-run the precondition check; if it now passes, admit the issue and clear
  // the stale skip entry. This prevents the cache from pinning a dead-zone
  // 30 minutes past an already-applied manual reconcile.
  const skippedMap = repoState.skipped ?? {};
  const now = Date.now();
  const stillBackedOff: { n: number; reason: string }[] = [];
  const resolvedTransient: { n: number; reason: string }[] = [];
  handOff = handOff.filter((n) => {
    const entry = skippedMap[n];
    if (!entry) return true;
    const age = now - new Date(entry.lastSkippedAt).getTime();
    if (Number.isNaN(age) || age >= backoffWindowFor(entry.skipCount, skipBackoffMs)) return true;
    if (isResolvedTransientSkip(entry.reason, repoConfig, repoLogger)) {
      resolvedTransient.push({ n, reason: entry.reason });
      return true;
    }
    stillBackedOff.push({ n, reason: entry.reason });
    return false;
  });
  if (resolvedTransient.length > 0) {
    repoLogger.info(
      `Cleared ${resolvedTransient.length} resolved-transient skip entr${resolvedTransient.length === 1 ? "y" : "ies"}: ${resolvedTransient.map(({ n }) => `#${n}`).join(", ")}`,
    );
    const healed = loadRepoState(repoName);
    healed.skipped = healed.skipped ?? {};
    for (const { n } of resolvedTransient) delete healed.skipped[n];
    saveRepoState(repoName, healed);
    repoState.skipped = healed.skipped;
  }
  if (stillBackedOff.length > 0) {
    // Promoted DEBUG → INFO so silent skip-cache filtering is visible in the
    // journal (otherwise the pipeline appears stalled while the cache holds it).
    repoLogger.info(
      `Backing off ${stillBackedOff.length} previously-skipped issue(s): ${stillBackedOff.map(({ n, reason }) => `#${n} (${reason.split("\n")[0].slice(0, 100)})`).join("; ")}`,
    );
  }
  // The repo's whole waiting set, every cycle that reaches here: an issue that
  // drops out of it has stopped waiting, which is how an observer clears it.
  // A recorded branch divergence holds everything else back too (foreman#44).
  const waitingSet = (block: BranchBlock | undefined) => [
    ...stillBackedOff.map(({ n, reason }) => ({ item: itemOf(repoConfig, n), reason: reason.split("\n")[0], skipped: true })),
    ...(block ? handOff.map((n) => ({ item: itemOf(repoConfig, n), reason: divergenceReason(block) })) : []),
  ];
  await notifyWaiting(repoConfig.githubRepo, waitingSet(repoState.branchBlock), repoLogger);
  const actionableIssues = discoveryBatch(repoConfig, handOff, repoLogger);
  if (actionableIssues.length === 0) {
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }
  if (handOff.length > actionableIssues.length) {
    repoLogger.info(`Handing the skill ${handOff.length} work item(s) to choose from: ${handOff.map((n) => `#${n}`).join(", ")}`);
  }

  // Emit event: issues picked up
  events?.push({ message: `Picked up ${actionableIssues.length} issue(s) on ${repoConfig.githubRepo}: ${actionableIssues.map(n => `#${n}`).join(", ")}`, level: "info" });

  // Gate: if there's a PR awaiting revision (`pr pending actions`), skip implementation.
  // The revision phase (Phase 1) handles these — running implementation would just
  // re-detect the same committed issues and loop without making progress.
  if (hasPendingRevisions(repoConfig, repoLogger)) {
    repoLogger.debug(`Skipping ${repoName} implementation — PR awaiting revision`);
    return null;
  }

  // Note: we do NOT gate on an open feature PR. The features branch accumulates
  // commits and an open PR auto-updates to include new commits. The skill handles
  // idempotency — it skips issues already committed on features. If no open PR
  // exists, the skill creates one. If one exists, new commits are added to it.

  // Bring `features` up to `develop` before the session builds on it.
  //
  // The implement skill's Phase 0 only pulls `features` — nothing has ever
  // merged the base branch in. Dependabot lands on the base, so without this
  // the session builds and boots a tree missing every bump since the last
  // feature merge. Fast-forward only: an in-flight feature PR (features ahead)
  // is the normal state and is left alone, and a true divergence is reported
  // rather than resolved. See fastForwardFeatureBranch for the full rationale.
  const divergence: BranchDivergence = {};
  const ffOutcome = fastForwardFeatureBranch(repoConfig, repoLogger, divergence);
  if (ffOutcome === "diverged") {
    const block = await announceDivergence(repoConfig, handOff, divergence, repoLogger);
    await notifyWaiting(repoConfig.githubRepo, waitingSet(block), repoLogger);
    return null;
  }
  // "unknown" proves nothing either way, so a recorded block stands.
  if (ffOutcome !== "unknown" && repoState.branchBlock) {
    const cleared = loadRepoState(repoName);
    delete cleared.branchBlock;
    saveRepoState(repoName, cleared);
    repoState.branchBlock = undefined;
    repoLogger.info(
      `${repoConfig.featureBranch} is reconciled with ${repoConfig.baseBranch} — implementation on ${repoName} resumes`,
    );
    await notifyWaiting(repoConfig.githubRepo, waitingSet(undefined), repoLogger);
  }

  // Invoke the skill — one Claude session implements all approved issues
  if (!tryAcquire("claude")) return null;
  const runAbort = new AbortController();
  activeRuns.set(repoName, runAbort);
  repoLogger.info(`Triggering batch implementation for ${repoName}`);
  const session: Omit<SessionEvent, "status"> = {
    phase: "implement", repo: repoConfig.githubRepo, items: actionableIssues.map((n) => itemOf(repoConfig, n)),
  };
  // How the session ended, for observers; anything that leaves without setting it threw.
  let ended: { status: "finished" | "failed"; detail: string } = { status: "failed", detail: "the session ended without a result" };

  try {
    // Tell the source the Foreman is starting on its batch, before the session.
    for (const n of actionableIssues) await claimWork(itemOf(repoConfig, n), repoConfig, repoLogger);
    await notifySession({ ...session, status: "started" }, repoLogger);

    const priorFailure = lastFailureReason.get(repoName) || null;
    const result = await implementApprovedIssues(repoConfig, repoLogger, runAbort.signal, priorFailure, actionableIssues, handOff)
      .catch(reportLaunchThrew);
    reportClaudeResult(!!result.upstreamLimit, result.upstreamLimit?.reason, result.upstreamLimit?.resetAtMs);
    ended = result.success
      ? { status: "finished", detail: result.prUrl ? `PR ${result.prUrl}` : "commits added to the open PR" }
      : result.skipped
        ? { status: "finished", detail: `skipped: ${result.skipReason ?? "no reason given"}` }
        : { status: "failed", detail: result.upstreamLimit ? `upstream limit: ${result.upstreamLimit.reason}` : result.error || "unknown" };

    if (result.success) {
      failureCount.set(repoName, 0);
      lastFailureReason.delete(repoName);
      failureHitMaxAt.delete(repoName);

      // Filter to only issues the implementation skill actually addressed in
      // the resulting PR. The canonical implement-approved-issues skill picks
      // ONE issue per invocation, AND it picks from the entire approved set
      // (priority + smaller-scope-first), not necessarily from the Foreman's
      // discovery batch. So the labeling-eligible set is the broader
      // "all-approved-and-actionable" set — not just `actionableIssues`
      // (which is also PR-uncovered + capped at MAX_BATCH_SIZE).
      //
      // Three cases for the intersection of `referencedAll ∩ allActionable`:
      //   1. matched.length > 0 → label the matched subset.
      //   2. referencedAll === null (gh lookup failed) → conservative
      //      fallback: label the discovery batch (`actionableIssues`), since
      //      we can't tell what shipped. Over-labeling is recoverable (EM
      //      cleanup); under-labeling stalls.
      //   3. matched.length === 0 (parser succeeded, found zero matches in
      //      the broader actionable set) → SKIP labeling + state-update
      //      entirely. The open PR exists but doesn't reference any
      //      currently-actionable approved issue. Labeling discovery-batch
      //      issues here would create self-locked issues (state filter sees
      //      them as `implemented`, no real PR to revise), requiring manual
      //      EM cleanup every cycle. (slashbin-ai-foreman#16)
      //
      // Widening to allActionable (vs just actionableIssues) is the
      // slashbin-ai-foreman#18 fix: if the skill picked an out-of-batch
      // approved issue, the resulting PR still gets correctly labeled.
      const referencedAll = getReferencedIssuesFromOpenPR(
        repoConfig.githubRepo,
        repoConfig.featureBranch,
        repoConfig.baseBranch,
        repoConfig.repoPath,
        repoLogger,
      );
      const allActionable = (await new GitHubIssueConnector().selectEligible(repoConfig, repoLogger)).map((w) => w.issueNumber);
      const labelingCandidates = Array.from(new Set([...actionableIssues, ...allActionable]));
      const matched = referencedAll
        ? labelingCandidates.filter((n) => referencedAll.includes(n))
        : null;

      if (matched !== null && matched.length === 0) {
        // Case 3: empty intersection — skip labeling + state-update, log
        // warning, exit cleanly. Next cycle re-discovers and retries.
        repoLogger.warn(
          `Open PR found but its body/title/commits do not reference any actionable approved issue (discovery batch: #${actionableIssues.join(", #")}; broader set: #${labelingCandidates.join(", #")}) — skipping label + state update so the next cycle can retry. Investigate the skill's PR formatting if this recurs.`,
        );
        return null;
      }

      const issuesActuallyImplemented =
        matched && matched.length > 0 ? matched : actionableIssues;
      if (matched && matched.length > 0) {
        const fromBatch = matched.filter((n) => actionableIssues.includes(n));
        const fromBroader = matched.filter((n) => !actionableIssues.includes(n));
        const dropped = actionableIssues.filter((n) => !matched.includes(n));
        if (fromBroader.length > 0) {
          repoLogger.info(
            `Skill implemented ${matched.length} issue(s) — ${fromBatch.length} from discovery batch, ${fromBroader.length} from broader actionable set (skill priority differs from Foreman batch order)`,
            { implemented: matched, fromBatch, fromBroader, deferred: dropped },
          );
        } else if (matched.length < actionableIssues.length) {
          repoLogger.info(
            `Skill implemented ${matched.length}/${actionableIssues.length} discovered issues — labeling only the implemented set`,
            { implemented: matched, deferred: dropped },
          );
        }
      } else if (referencedAll === null) {
        repoLogger.warn(
          `getReferencedIssuesFromOpenPR returned null (lookup failed) — labeling full discovery batch as conservative fallback (#${actionableIssues.join(", #")})`,
        );
      }

      // Persist implemented issue numbers to prevent re-implementation loops
      const updatedState = loadRepoState(repoName);
      for (const issueNum of issuesActuallyImplemented) {
        if (!updatedState.implemented.includes(issueNum)) {
          updatedState.implemented.push(issueNum);
        }
        // Clear any prior skip record — if it's now implemented, the prior
        // "blocked on investigation" state is resolved.
        if (updatedState.skipped) delete updatedState.skipped[issueNum];
      }
      saveRepoState(repoName, updatedState);

      // Report each implemented item in review (on GitHub: the `prUnderReview`
      // label) so the EM knows the PR is ready. One item at a time, in order.
      for (const n of issuesActuallyImplemented) {
        const item = itemOf(repoConfig, n);
        if (result.prUrl) await reportWorkPrLink(item, result.prUrl, repoConfig, repoLogger);
        await reportWorkState(item, "new", "inReview", repoConfig, repoLogger);
      }

      repoLogger.info(`Batch implementation succeeded — tracked ${issuesActuallyImplemented.map(n => `#${n}`).join(", ")} in state`, { prUrl: result.prUrl });
      events?.push({ message: `Feature PR on ${repoConfig.githubRepo}: ${result.prUrl || "(commits added to existing PR)"}`, level: "info" });
    } else if (result.skipped) {
      // Deliberate no-op by the agent (e.g., issue body says "investigate first").
      // Record per-issue skip timestamps so the back-off filter at the top of
      // this function suppresses retries for SKIP_BACKOFF_MS.
      // Do NOT increment failureCount — this isn't an error.
      const updatedState = loadRepoState(repoName);
      if (!updatedState.skipped) updatedState.skipped = {};
      let skippedSet = result.skippedIssues && result.skippedIssues.length > 0
        ? result.skippedIssues
        : actionableIssues;
      const reason = result.skipReason ?? "no reason given";

      // --- Case 4 (slashbin-ai-foreman#32): the work is ALREADY MERGED ---------
      // A skip is only worth retrying if a retry could ever succeed. When the
      // agent declines because the work is already on `baseBranch`, retrying is
      // futile BY DEFINITION — the commits exist; no future cycle will produce a
      // PR for them. Yet the issue keeps `approved` with no lifecycle label, so
      // it stays "actionable" and we burn a full Claude session every back-off
      // window, forever (observed: 7+ hours across two repos, 2026-07-13).
      //
      // Give the lifecycle its missing EXIT: strip the trigger label and advance
      // to `ready for prod release`, permanently removing the issue from the
      // actionable set and handing the EM the signal it already expects. Forward
      // progress then no longer depends on a human closing the issue promptly.
      //
      // Safe because findIssuesMergedToBase() uses the STRICT predicate: only a
      // merged PR that says it CLOSED the issue counts (never a "related to #N").
      // On any lookup failure it advances nothing — we under-advance by design.
      const alreadyMerged = findIssuesMergedToBase(repoConfig, skippedSet, repoLogger);
      if (alreadyMerged.length > 0) {
        const mergedNums = alreadyMerged.map((m) => m.issueNumber);
        await notifyObserversOnce("merged", repoConfig, mergedNums, repoLogger);
        for (const n of mergedNums) {
          await reportWorkState(itemOf(repoConfig, n), "new", "approved", repoConfig, repoLogger);
        }
        repoLogger.info(
          `Advanced ${mergedNums.length} already-merged issue(s) to '${repoConfig.lifecycleLabels.prApproved}': ${alreadyMerged.map((m) => `#${m.issueNumber} (merged in PR #${m.prNumber})`).join(", ")}`,
        );
        events?.push({
          message: `Advanced ${mergedNums.length} already-merged issue(s) on ${repoConfig.githubRepo} to '${repoConfig.lifecycleLabels.prApproved}': ${mergedNums.map((n) => `#${n}`).join(", ")}`,
          level: "info",
        });
        // They're out of the actionable set now — no skip record needed, and a
        // stale one would linger in state forever.
        for (const n of mergedNums) delete updatedState.skipped[n];
        skippedSet = skippedSet.filter((n) => !mergedNums.includes(n));
      }
      // ------------------------------------------------------------------------

      const stamp = new Date().toISOString();
      for (const issueNum of skippedSet) {
        // Escalating per-issue back-off: a fixed snooze never gives up, so a
        // permanently-unactionable issue costs an agent session every window,
        // indefinitely. Count the consecutive skips; the filter at the top of
        // this function widens the window geometrically off this count.
        const priorCount = updatedState.skipped[issueNum]?.skipCount ?? 0;
        updatedState.skipped[issueNum] = {
          lastSkippedAt: stamp,
          reason,
          skipCount: priorCount + 1,
        };
      }
      saveRepoState(repoName, updatedState);
      // The agent declined these; the source hears why. On GitHub this writes
      // nothing — the agent posts its own skip comment.
      for (const n of skippedSet) await reportWorkBlocked(itemOf(repoConfig, n), reason, repoConfig, repoLogger);
      // Reset the failure counter — an explicit skip is not a failure.
      failureCount.set(repoName, 0);
      lastFailureReason.delete(repoName);
      failureHitMaxAt.delete(repoName);
      repoLogger.info(`Batch implementation skipped by agent: ${reason} (issues: ${skippedSet.map(n => `#${n}`).join(", ")})`);
      events?.push({ message: `Implementation skipped on ${repoConfig.githubRepo}: ${reason}`, level: "info" });
    } else {
      // An upstream limit refused the run (or a swallowed GitHub back-off made
      // it look failed) — not a defect, so it charges no retry.
      if (result.upstreamLimit || isUpstreamBlocked("github")) return null;
      const newCount = (failureCount.get(repoName) ?? 0) + 1;
      failureCount.set(repoName, newCount);
      if (newCount >= MAX_RETRIES) {
        failureHitMaxAt.set(repoName, cycleNumber);
      }
      lastFailureReason.set(repoName, result.error || "unknown");
      repoLogger.warn(`Batch implementation failed (${newCount}/${MAX_RETRIES}): ${result.error}`);
      events?.push({ message: `Implementation failed on ${repoConfig.githubRepo}: ${result.error}`, level: "error" });
    }

    return result;
  } finally {
    activeRuns.delete(repoName);
    await notifySession({ ...session, ...ended }, repoLogger);
  }
}

async function tryRevision(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number,
  events: CycleEvent[],
): Promise<PendingRevisionInfo | null> {
  const repoName = repoConfig.name;
  const revLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "revision" });

  if (isUpstreamBlocked("claude")) return null;

  const failures = revisionFailureCount.get(repoName) ?? 0;

  // Gate: are there issues with pending review feedback + an open feature PR?
  //
  // This runs BEFORE the exhausted-retries skip, on purpose. The reset below is
  // the only way an exhausted counter clears short of a daemon restart, and it
  // used to sit after the skip — unreachable once the cap was hit. Slashbin-io-docs
  // PR #411 (2026-10-01) failed revision twice on the account's session limit,
  // exhausted, and then deadlocked the whole repo: revision skipped forever, and
  // implement is gated on "no pending revision", so #412 could not build either.
  // Clearing `pr pending actions` for one pass now resets it, as the comment on
  // `revisionEscalated` always claimed.
  const pending = findPendingRevisions(repoConfig, revLogger);
  if (!pending) {
    if (failures > 0) revisionFailureCount.set(repoName, 0);
    revisionEscalated.delete(repoName);
    consecutiveNoCommit.delete(repoName);
    return null;
  }

  // Check if this repo has exceeded revision failure retries
  if (failures >= MAX_RETRIES) {
    revLogger.debug(`Skipping ${repoName} revision — ${failures} consecutive failures`);
    return null;
  }

  // Invoke the revision skill with specific PR and issue context
  if (!tryAcquire("claude")) return null;
  const runAbort = new AbortController();
  activeRuns.set(repoName, runAbort);
  revLogger.info(`Triggering PR revision for ${repoName} — PR #${pending.pr.number}, issues: ${pending.issueNumbers.map(n => `#${n}`).join(", ")}`);
  const session: Omit<SessionEvent, "status"> = {
    phase: "revise", repo: repoConfig.githubRepo, pr: pending.pr.number,
    items: pending.issueNumbers.map((n) => itemOf(repoConfig, n)),
  };
  let ended: { status: "finished" | "failed"; detail: string } = { status: "failed", detail: "the session ended without a result" };

  try {
    await notifySession({ ...session, status: "started" }, revLogger);
    const result = await revisePRFeedback(
      repoConfig, revLogger, runAbort.signal,
      pending.pr.number, pending.issueNumbers,
    ).catch(reportLaunchThrew);
    reportClaudeResult(!!result.upstreamLimit, result.upstreamLimit?.reason, result.upstreamLimit?.resetAtMs);
    ended = result.success
      ? { status: "finished", detail: result.noCommit ? `no commit: ${result.noCommitReason ?? "branch already correct"}` : "changes pushed, back to review" }
      : { status: "failed", detail: result.upstreamLimit ? `upstream limit: ${result.upstreamLimit.reason}` : result.error || "unknown" };

    if (result.success) {
      revisionFailureCount.set(repoName, 0);
      revisionEscalated.delete(repoName);

      if (result.noCommit) {
        const seen = (consecutiveNoCommit.get(repoName) ?? 0) + 1;
        consecutiveNoCommit.set(repoName, seen);

        // Second one in a row: the reviewer keeps asking and the reviser keeps
        // answering "already correct". Neither is going to move. Stop, and say
        // who is stuck on what — a ping-pong nobody is told about looks exactly
        // like an idle queue.
        if (seen > MAX_CONSECUTIVE_NO_COMMIT) {
          const issues = pending.issueNumbers.map((n) => `#${n}`).join(", ");
          revLogger.error(
            `PR #${pending.pr.number} has answered ${seen} review rounds in a row with no commit — ` +
            `the reviewer and the reviser disagree and neither will move. Not re-labelling.`,
            { pr: pending.pr.number, issues: pending.issueNumbers, reason: result.noCommitReason },
          );
          events.push({
            message:
              `🛑 ${repoConfig.githubRepo} — PR #${pending.pr.number} answered ${seen} review rounds with no code change` +
              `${issues ? ` (issues ${issues})` : ""}. The reviewer asks, the reviser says the branch is already correct. ` +
              `EM: rule on it. Last reason: ${result.noCommitReason ?? "not given"}`,
            level: "error",
          });
          return null;
        }

        revLogger.info(
          `PR #${pending.pr.number} revision made no commit by declaration — returning it to review: ${result.noCommitReason}`,
        );
      } else {
        consecutiveNoCommit.delete(repoName);
      }

      // Transition issue labels: `prPendingActions` → `prUnderReview`
      // The orchestrator owns this because the skill runs in the service repo
      // and may not have the right context to find the issue labels.
      for (const n of pending.issueNumbers) {
        await reportWorkState(itemOf(repoConfig, n), "changesRequested", "inReview", repoConfig, revLogger);
      }

      revLogger.info("PR revision succeeded");
      return pending;
    } else {
      // An upstream limit refused the run — not a defect, so it charges no retry.
      if (result.upstreamLimit || isUpstreamBlocked("github")) return null;
      const newCount = failures + 1;
      revisionFailureCount.set(repoName, newCount);
      revLogger.warn(`PR revision failed (${newCount}/${MAX_RETRIES}): ${result.error}`);

      // Retries exhausted. This is the end of the automated road for this PR: every
      // later cycle takes the skip branch above and does nothing. Say so out loud,
      // once, with the PR and the reason — a stuck PR that nobody is told about is
      // only discovered by someone thinking to look.
      if (newCount >= MAX_RETRIES && !revisionEscalated.has(repoName)) {
        revisionEscalated.add(repoName);
        const issues = pending.issueNumbers.map((n) => `#${n}`).join(", ");
        revLogger.error(
          `Revision retries exhausted on PR #${pending.pr.number} — no further attempts will be made ` +
          `until the feedback clears or a revision succeeds.`,
          { pr: pending.pr.number, issues: pending.issueNumbers, lastError: result.error },
        );
        events.push({
          message:
            `🛑 ${repoConfig.githubRepo} — PR #${pending.pr.number} failed revision ${newCount}x and the Foreman has ` +
            `STOPPED retrying it${issues ? ` (issues ${issues})` : ""}. It needs a human. Last failure: ${result.error ?? "unknown"}`,
          level: "error",
        });
        const blocked = `Revision retries exhausted on PR #${pending.pr.number}: ${result.error ?? "unknown"}`;
        for (const n of pending.issueNumbers) {
          await reportWorkBlocked(itemOf(repoConfig, n), blocked, repoConfig, revLogger);
        }
      }
    }

    return null;
  } finally {
    activeRuns.delete(repoName);
    await notifySession({ ...session, ...ended }, revLogger);
  }
}

/**
 * Review phase: invoke the EM /review-all-prs skill, scoped to one repo, when it
 * has an open feature PR awaiting review (`pr under review`, no current EM review).
 *
 * Unlike implement/revise, the orchestrator does NOT transition labels afterward —
 * the skill owns its own merges and label transitions at full fidelity. We just
 * gate, trigger, log, and back off on failure. Every run's full interaction is
 * written to logs/review/<repo>-cycle<N>-<ts>.log for debugging.
 *
 * Returns true when a review run was triggered (regardless of verdict).
 */
async function tryReview(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[],
): Promise<boolean> {
  if (!repoConfig.reviewEnabled) return false;

  const repoName = repoConfig.name;
  const reviewLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "review" });

  if (isUpstreamBlocked("claude")) return false;

  // Failure back-off with cooldown (mirrors the implement phase).
  const failures = reviewFailureCount.get(repoName) ?? 0;
  if (failures >= MAX_RETRIES) {
    const hitAt = reviewFailureHitMaxAt.get(repoName) ?? cycleNumber;
    const cyclesSinceMax = cycleNumber - hitAt;
    if (cyclesSinceMax < FAILURE_COOLDOWN_CYCLES) {
      reviewLogger.debug(`Skipping ${repoName} review — ${failures} consecutive failures, cooldown ${cyclesSinceMax}/${FAILURE_COOLDOWN_CYCLES}`);
      return false;
    }
    reviewLogger.info(`Review failure cooldown expired for ${repoName} — resetting and retrying`);
    reviewFailureCount.set(repoName, 0);
    reviewFailureHitMaxAt.delete(repoName);
  }

  // Gate: is there an open feature PR awaiting EM review?
  const candidate = findPRsNeedingReview(repoConfig, repoConfig.reviewerLogin, reviewLogger);
  if (!candidate) {
    if (failures > 0) reviewFailureCount.set(repoName, 0);
    return false;
  }
  // Orphan adoption: the implement report never landed for these. Report them
  // in review now, before anything else touches the PR.
  for (const n of candidate.adopted) {
    await reportWorkState(itemOf(repoConfig, n), "new", "inReview", repoConfig, reviewLogger);
  }

  // CI gate: never spend a review session on a PR its own CI already rejects.
  const checks = getPRCheckVerdict(repoConfig, candidate.prNumber, reviewLogger);
  if (checks.state === "pending") {
    reviewLogger.info(`PR #${candidate.prNumber} CI still running (${checks.pending.join(", ")}) — review waits for it`);
    return false;
  }
  if (checks.state === "failing") {
    const bounces = countCiBouncesSinceReview(repoConfig, candidate.prNumber, repoConfig.reviewerLogin, reviewLogger);
    if (bounces < MAX_CI_BOUNCES) {
      const names = checks.failing.map((f) => f.name).join(", ");
      bounceForRedCI(repoConfig, candidate.prNumber, checks);
      for (const n of candidate.issueNumbers) {
        await reportWorkState(itemOf(repoConfig, n), "inReview", "changesRequested", repoConfig, reviewLogger);
      }
      reviewLogger.info(`PR #${candidate.prNumber} CI red (${names}) — sent back to revise without a review (bounce ${bounces + 1}/${MAX_CI_BOUNCES})`);
      events?.push({ message: `${repoConfig.githubRepo} PR #${candidate.prNumber}: CI red (${names}) — sent back to the builder before review`, level: "info" });
      return true;
    }
    reviewLogger.warn(`PR #${candidate.prNumber} CI still red after ${bounces} bounce(s) — reviewing anyway so a reviewer sees it`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const transcriptPath = resolve(process.cwd(), "logs", "review", `${repoName}-cycle${cycleNumber}-${ts}.log`);

  // Mark when this run starts. Any removal of the EM outcome-gate label after
  // this instant is the run's doing — whether the gate existed beforehand or was
  // signed while the run was in flight. The second case is the common one,
  // because the EM signs dev acceptance during the minutes a review takes, and
  // it is precisely the case a pre-run snapshot cannot see.
  const reviewStartedAt = new Date().toISOString();

  // Claim the launch (the one half-open probe, when Claude is recovering)
  // before any checkout work or "Reviewing" event.
  if (!tryAcquire("claude")) return false;

  // The session reads the code from here rather than cloning one for itself.
  // Prepared before the run so it is warm on arrival; see review-checkout.ts
  // for why an unmanaged clone per review took the whole box down.
  const checkoutPath = prepareReviewCheckout(config, repoConfig, reviewLogger);

  const runAbort = new AbortController();
  activeRuns.set(repoName, runAbort);
  reviewLogger.info(`Triggering review for ${repoName} — PR #${candidate.prNumber} (issues: ${candidate.issueNumbers.map(n => `#${n}`).join(", ")}), transcript: ${transcriptPath}`);
  events?.push({ message: `Reviewing ${repoConfig.githubRepo} PR #${candidate.prNumber} (issues: ${candidate.issueNumbers.map(n => `#${n}`).join(", ")})`, level: "info" });
  const session: Omit<SessionEvent, "status"> = {
    phase: "review", repo: repoConfig.githubRepo, pr: candidate.prNumber,
    items: candidate.issueNumbers.map((n) => itemOf(repoConfig, n)),
  };
  let ended: { status: "finished" | "failed"; detail: string } = { status: "failed", detail: "the session ended without a result" };

  try {
    await notifySession({ ...session, status: "started", reviewer: config.techLeadPath ? "Tech Lead" : "Claude" }, reviewLogger);
    // EM#427: the Tech Lead (Codex) takes the review first when configured; on
    // its "wrote nothing" exit the Claude review below runs exactly as before.
    const viaTechLead = config.techLeadPath
      ? await reviewViaTechLead(repoConfig, config, candidate.prNumber, reviewLogger, runAbort.signal, transcriptPath)
          .catch((e: unknown): { fallback: true; reason: string } => ({ fallback: true, reason: `Tech Lead launch threw: ${String(e)}` }))
      : { fallback: true as const, reason: "not configured" };
    if (config.techLeadPath && "fallback" in viaTechLead) {
      await notifySession({ ...session, status: "handoff", reviewer: "Claude", detail: viaTechLead.reason }, reviewLogger);
    }
    const result = "fallback" in viaTechLead
      ? await reviewOpenPRs(
          repoConfig, config, reviewLogger, runAbort.signal, transcriptPath,
          `PR #${candidate.prNumber} on ${repoConfig.githubRepo}`,
        ).catch(reportLaunchThrew)
      : viaTechLead;
    reportClaudeResult(!!result.upstreamLimit, result.upstreamLimit?.reason, result.upstreamLimit?.resetAtMs);

    if (result.success) {
      reviewFailureCount.set(repoName, 0);
      reviewFailureHitMaxAt.delete(repoName);
      reviewLogger.info(`Review run completed for ${repoName}`);

      // --- Post-condition check ------------------------------------------
      // The trailer is the agent's CLAIM about what it did. The labels are the
      // STATE. Verify the claim against the state before believing it: a run
      // that says `merged=yes` must have left the issue somewhere other than
      // `pr under review`, because that is where the next phase reads from.
      //
      // Checked only for PRs the run claims to have merged — an unmerged PR is
      // SUPPOSED to still be `pr under review`, so including those would flag
      // every REQUEST_CHANGES round as an orphan.
      //
      // This catches the case the trailer gate cannot: a run that emits a
      // well-formed trailer but never actually moved the labels. Detection
      // only; the repair runs in Phase 0 on the next pass (≈1 cycle later),
      // where it can re-verify first. Alerting here rather than waiting for the
      // dead-zone sweep skips that path's 15-minute grace window, so a broken
      // run surfaces in the same cycle that produced it.
      await reportReviewOutcomes(repoConfig, candidate.issueNumbers, reviewLogger);
      const trailers = result.trailers ?? [];
      const mergedPrs = trailers.filter((t) => t.merged).map((t) => t.pr);
      if (mergedPrs.includes(candidate.prNumber)) {
        await notifyObserversOnce("merged", repoConfig, candidate.issueNumbers, reviewLogger);
      }
      if (mergedPrs.length > 0) {
        const stuck = findIssuesStillUnderReview(repoConfig, candidate.issueNumbers, reviewLogger);
        if (stuck.length > 0) {
          reviewLogger.warn(
            `Review post-condition: PR(s) #${mergedPrs.join(", #")} reported merged, but issue(s) #${stuck.join(", #")} are still "${repoConfig.lifecycleLabels.prUnderReview}" — the run merged without completing the label transition`,
            { mergedPrs, stuckIssues: stuck },
          );

          // Set the label from the run's own trailer. The verdict is not missing
          // — it is right here, already parsed. Waiting a cycle to re-derive it
          // from a fresh deploy poll was spending minutes to recompute an answer
          // we were holding.
          const unresolved = config.reviewLabelReconcile
            ? await reconcileReviewOutcomeLabels(repoConfig, stuck, trailers, reviewLogger, events)
            : stuck;

          if (!config.reviewLabelReconcile && stuck.length > 0) {
            reviewLogger.info("Label reconciliation disabled (reviewLabelReconcile=false) — leaving the dead zone for recovery");
          }

          if (unresolved.length > 0) {
            reviewLogger.error(
              `Review post-condition UNRESOLVED on ${repoName}: issue(s) #${unresolved.join(", #")} could not be reconciled from the run's trailers — dead-zone recovery will re-verify`,
              { mergedPrs, unresolved },
            );
            events?.push({
              message: `⚠️ ${repoConfig.githubRepo} — review merged PR #${mergedPrs.join(", #")} but left issue(s) #${unresolved.join(", #")} at "${repoConfig.lifecycleLabels.prUnderReview}" and the trailer could not settle it. Dead-zone recovery will re-verify next cycle.`,
              level: "warn",
            });
          }
        }
      }

      // Prefer the structured per-PR status (includes deploy SUCCESS/FAILURE);
      // fall back to the summary's first line when no trailer was emitted.
      const outcome = result.statusLine
        ? result.statusLine
        : (result.summary || "review completed").split("\n")[0].slice(0, 240);
      const prefix = result.statusLine ? "" : `PR #${candidate.prNumber} — `;
      ended = { status: "finished", detail: outcome };
      events?.push({ message: `Reviewed ${repoConfig.githubRepo} — ${prefix}${outcome}`, level: "info" });
      return true;
    }

    // --- The run failed. Did it fail before or AFTER doing the work? --------
    // Ask GitHub, not the trailer: a run killed at the wall may never have
    // emitted one. `planFailedReviewOutcome` holds the rule and the incident
    // behind it (#41).
    const mergedRefs = findIssuesMergedToBase(repoConfig, candidate.issueNumbers, reviewLogger);
    const plan = planFailedReviewOutcome(
      mergedRefs,
      findIssuesStillUnderReview(repoConfig, candidate.issueNumbers, reviewLogger),
    );

    ended = { status: "failed", detail: result.upstreamLimit ? `upstream limit: ${result.upstreamLimit.reason}` : result.error || "unknown" };
    if (plan.workLanded) {
      ended = { status: "finished", detail: `merged PR #${plan.mergedPrs.join(", #")}, then the run ended: ${result.error}` };
      await notifyObserversOnce("merged", repoConfig, [...new Set(mergedRefs.map((m) => m.issueNumber))], reviewLogger);
      await reportReviewOutcomes(repoConfig, candidate.issueNumbers, reviewLogger);
      reviewLogger.warn(
        `Review run on ${repoName} ended with "${result.error}" AFTER merging PR #${plan.mergedPrs.join(", #")} — ` +
        `the work landed and the run outlived it. Reconciling labels now rather than leaving the dead zone.`,
        { mergedPrs: plan.mergedPrs, toReconcile: plan.toReconcile },
      );

      const unresolved = plan.toReconcile.length > 0 && config.reviewLabelReconcile
        ? await reconcileReviewOutcomeLabels(repoConfig, plan.toReconcile, result.trailers ?? [], reviewLogger, events)
        : plan.toReconcile;

      if (unresolved.length > 0) {
        reviewLogger.error(
          `Review post-condition UNRESOLVED on ${repoName} after a failed run: issue(s) #${unresolved.join(", #")} ` +
          `— dead-zone recovery will re-verify`,
          { mergedPrs: plan.mergedPrs, unresolved },
        );
      }

      // Reset rather than increment: the next cycle would find the PR merged and
      // nothing to review, so charging a failure only walks the repo toward its
      // backoff for work that succeeded.
      reviewFailureCount.set(repoName, 0);
      reviewFailureHitMaxAt.delete(repoName);
      events?.push({
        message: `⚠️ ${repoConfig.githubRepo} — review of PR #${plan.mergedPrs.join(", #")} merged, then ran past its budget (${result.error}). Labels reconciled; not counted as a failed review.`,
        level: "warn",
      });
      return true;
    }

    // An upstream limit refused the run — not a defect, so it charges no retry.
    // After the reconciliation above, so a review that merged and then hit the
    // limit still settles its labels.
    if (result.upstreamLimit || isUpstreamBlocked("github")) return false;
    const newCount = failures + 1;
    reviewFailureCount.set(repoName, newCount);
    if (newCount >= MAX_RETRIES) reviewFailureHitMaxAt.set(repoName, cycleNumber);
    reviewLogger.warn(`Review failed (${newCount}/${MAX_RETRIES}) on PR #${candidate.prNumber}, not merged: ${result.error}`);
    events?.push({ message: `Review failed on ${repoConfig.githubRepo} PR #${candidate.prNumber}: ${result.error}`, level: "error" });
    return false;
  } finally {
    activeRuns.delete(repoName);
    await notifySession({ ...session, ...ended }, reviewLogger);

    // Hand the checkout back if nothing else is queued for this repo. In
    // `finally` for the same reason as the label repair below: a run that threw
    // or was killed still leaves the directory behind, and that is precisely the
    // case that accumulated 140 of them.
    //
    // Queued = work that would bring a session straight back here: approved
    // issues waiting to be built, plus any PR still awaiting review. Counted
    // AFTER the run, so a review that just merged the last PR sees an empty
    // queue and releases, while a repo mid-batch keeps its node_modules.
    if (checkoutPath) {
      try {
        const stillApproved = (await new GitHubIssueConnector().selectEligible(repoConfig, reviewLogger)).length;
        const stillToReview = findPRsNeedingReview(repoConfig, repoConfig.reviewerLogin, reviewLogger) ? 1 : 0;
        releaseReviewCheckout(config, repoConfig, stillApproved + stillToReview, reviewLogger);
      } catch (err) {
        // Never let bookkeeping fail the phase. The nightly sweep is the backstop.
        reviewLogger.debug(`Checkout release check skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Undo any revocation of the EM outcome-gate. In `finally` on purpose: a run
    // that threw or was aborted may still have written labels before it died.
    //
    // `stripReadyForProd` removes this label legitimately once a promotion PR
    // takes ownership. When one is open the label is SUPPOSED to be gone, and
    // restoring it would fight the promotion path — so that case is checked
    // before any write, and only when something actually looks revoked.
    const revoked = findRevokedEmGates(
      repoConfig, candidate.issueNumbers, reviewStartedAt, reviewLogger,
    );
    const promotionOwnsIt = revoked.length > 0 &&
      !!findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, reviewLogger);
    if (promotionOwnsIt) {
      reviewLogger.info(
        `"${repoConfig.lifecycleLabels.readyForProd}" left removed on #${revoked.join(", #")} — an open promotion PR owns it now.`,
      );
    }
    const restored = promotionOwnsIt ? [] : restoreEmGate(repoConfig, revoked, reviewLogger);
    if (restored.length > 0) {
      events?.push({
        message: `⚠️ ${repoConfig.githubRepo} — the review run removed "${repoConfig.lifecycleLabels.readyForProd}" from issue(s) ${restored.map((n) => `#${n}`).join(", ")}; restored. Promotion would otherwise have stalled silently.`,
        level: "warn",
      });
    }
  }
}

function trySyncDrift(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): boolean {
  const syncLogger = logger.child({ cycle: cycleNumber, repo: repoConfig.name, phase: "sync" });

  const drift = checkBranchDrift(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, syncLogger);
  if (!drift || drift.developBehindMain === 0) return false;

  // An already-open sync PR is a RETRY, not a no-op. The merge attempted at
  // creation runs while required checks are still IN_PROGRESS and is refused, so
  // "already open" is the normal state a few seconds later — and returning early
  // here meant it was never merged at all. `develop` then stays behind `main`,
  // the next promotion PR goes BEHIND, and branch protection refuses it.
  // (Slashbin-console#779: open 2h48m over ~140 no-op cycles, blocking #782.)
  const existing = findOpenSyncPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, syncLogger);
  if (existing) {
    if (tryMergeSyncPR(repoConfig.githubRepo, existing.number, repoConfig.repoPath, syncLogger)) {
      syncLogger.info(`Sync PR merged on retry — #${existing.number}: ${existing.url}`);
      return true;
    }
    syncLogger.info(`Sync PR open, not yet mergeable — #${existing.number}: ${existing.url}`);
    return false;
  }

  syncLogger.info(`${repoConfig.baseBranch} is ${drift.developBehindMain} commit(s) behind ${repoConfig.productionBranch} — creating sync PR`);
  const syncUrl = createSyncPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, drift.developBehindMain, repoConfig.repoPath, syncLogger);
  if (syncUrl) {
    // Say what actually happened. This line used to assert "created and
    // auto-merged" unconditionally, which was false whenever branch protection
    // refused the create-time merge — i.e. on every protected repo.
    syncLogger.info(`Sync PR created — ${syncUrl} (merge retried each cycle until checks pass)`);
    return true;
  }
  syncLogger.warn("Failed to create sync PR");
  return false;
}

/**
 * File ONE issue covering every open Dependabot PR on either working branch.
 *
 * **Idempotent by construction: at most one open batch issue per repo.** Not by
 * remembering what was filed — this runs every cycle across twenty repos and any
 * state it kept in memory would be lost on the next restart, which is how a
 * filing loop becomes twenty issues an hour. The check is a title-prefix match
 * against the open-issue snapshot the cycle already fetched, so it is correct
 * after a restart, correct if someone closes the issue by hand, and free.
 *
 * A PR that appears while a batch issue is open is not filed separately; it is
 * picked up by the next batch once the current one closes. Bounded noise beats
 * complete coverage here — the alternative is editing an issue body an agent may
 * already be working from, which the issue-authoring rules forbid outright.
 *
 * Returns the new issue number, or null when there was nothing to file.
 */
function tryFileDependencyBatchIssue(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number,
): number | null {
  const depLogger = logger.child({ cycle: cycleNumber, repo: repoConfig.name, phase: "dependencies" });
  const bases = dependencyBatchBases(repoConfig.featureBranch, repoConfig.baseBranch, repoConfig.productionBranch);
  if (bases.length === 0) return null;
  const featureBranch = repoConfig.featureBranch || bases[0];

  const prs = findDependencyPRs(repoConfig.githubRepo, repoConfig.repoPath, bases, depLogger);
  if (prs.length === 0) return null;

  const existing = findOpenDependencyBatchIssue(repoConfig.githubRepo, repoConfig.repoPath, depLogger);
  if (existing) {
    depLogger.debug(
      `${prs.length} dependency PR(s) on ${bases.join("/")}; batch issue #${existing.number} is already open`,
    );
    return null;
  }

  const changes = prs.map((p) => describeDependencyPR(p.number, p.title));
  const { title, body } = buildDependencyBatchIssue(featureBranch, changes);
  const number = createDependencyBatchIssue(
    repoConfig.githubRepo, repoConfig.repoPath, title, body,
    repoConfig.dependencyPreApproved ? repoConfig.triggerLabel : null, depLogger,
  );
  if (number === null) return null;

  const majors = changes.filter((c) => c.major).length;
  depLogger.info(
    `Filed dependency batch issue #${number} for ${prs.length} PR(s) on ${bases.join("/")}` +
    (majors > 0 ? ` — ${majors} major` : "") +
    (repoConfig.dependencyPreApproved
      ? ` — filed with "${repoConfig.triggerLabel}", queued to build`
      : ` — awaiting "${repoConfig.triggerLabel}"`),
  );
  return number;
}

async function tryPromotion(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): Promise<"promoted" | "synced" | null> {
  const repoName = repoConfig.name;
  const promoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "promote" });

  // Main-only repos (like docs) don't have develop → main promotion
  if (repoConfig.baseBranch === repoConfig.productionBranch && repoConfig.featureBranch === repoConfig.productionBranch) {
    return null;
  }

  // Follow the release PR from open to merged, so the items it carries show as
  // waiting on it and then as done (Slashbin-console#1185 sat "in progress"
  // behind release PR #1206). Before the ready-for-prod read: a release PR
  // stays open, and merges, after its issues have lost that label.
  await trackRelease({
    repo: repoConfig.githubRepo,
    productionBranch: repoConfig.productionBranch,
    saved: loadRepoState(repoName).release,
    findOpenRelease: () =>
      findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, promoLogger),
    releaseState: (pr) => getPrState(repoConfig.githubRepo, pr, repoConfig.repoPath, promoLogger),
    save: (v) => {
      const st = loadRepoState(repoName);
      if (v) st.release = v;
      else delete st.release;
      saveRepoState(repoName, st);
    },
    emit: (event) => notifyRelease(event, promoLogger),
  });

  const issues = findReadyForProdIssues(
    repoConfig.githubRepo, repoConfig.repoPath, repoConfig.lifecycleLabels, promoLogger,
  );
  if (issues.length === 0) {
    // "Nothing ready to promote" and "the gate was revoked and promotion is
    // stalled" produce the identical empty set and the identical silence. They
    // are distinguishable by one fact: whether `develop` is carrying merged work
    // that never reached `main`. Say so when it is.
    //
    // Rate-limited because it costs a compare API call and the discovery budget
    // is repos x cycles/hour (see docs on the GitHub API budget) — a stall lasts
    // cycles, so hourly is early enough to catch it and cheap enough to keep.
    const last = lastStallCheckCycle.get(repoName) ?? -Infinity;
    if (cycleNumber - last >= STALL_CHECK_CYCLE_INTERVAL) {
      lastStallCheckCycle.set(repoName, cycleNumber);
      const drift = checkBranchDrift(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, promoLogger);
      // Gate on CHANGED FILES, never on commit count. Every repo sits 1 commit
      // ahead in the steady state — the main -> develop sync PR's merge commit,
      // which carries no file change. Warning on `ahead > 0` fires on every repo
      // on every check, forever, and a warning that is always on is not a signal.
      if (drift && drift.developAheadFiles > 0) {
        promoLogger.warn(
          `${repoName}: ${repoConfig.baseBranch} carries ${drift.developAheadFiles} changed file(s) not on ${repoConfig.productionBranch} ` +
          `(${drift.developAheadOfMain} commit(s) ahead) but no issue carries "${repoConfig.lifecycleLabels.readyForProd}" — ` +
          `promotion is STALLED, not idle. Either the EM gate has not been signed yet, or it was signed and revoked.`,
          { developAheadOfMain: drift.developAheadOfMain, developAheadFiles: drift.developAheadFiles },
        );
        await notifyPromotionStall(
          repoConfig.githubRepo,
          `${repoConfig.baseBranch} carries ${drift.developAheadFiles} changed file(s) not on ${repoConfig.productionBranch}; ` +
          `no issue carries "${repoConfig.lifecycleLabels.readyForProd}"`,
          promoLogger,
        );
      } else if (drift) {
        await notifyPromotionStall(repoConfig.githubRepo, null, promoLogger);
      }
    }
    return null;
  }

  // Issues are ready, so promotion is moving, not stalled.
  await notifyPromotionStall(repoConfig.githubRepo, null, promoLogger);
  promoLogger.info(`Found ${issues.length} issue(s) ready for prod release`);

  // Check if a promotion PR already exists
  const existingPR = findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, promoLogger);
  if (existingPR) {
    // Check if the PR body is missing any current ready-for-prod issues
    const listedIssues = new Set(
      (existingPR.body.match(/#(\d+)/g) || []).map((m) => parseInt(m.slice(1), 10))
    );
    const missingIssues = issues.filter((i) => !listedIssues.has(i.number));

    if (missingIssues.length > 0) {
      const updated = updatePromotionPR(
        repoConfig.githubRepo, existingPR.number, issues, repoConfig.repoPath
      );
      if (updated) {
        promoLogger.info(
          `Updated promotion PR #${existingPR.number} — added ${missingIssues.length} issue(s): ${missingIssues.map((i) => `#${i.number}`).join(", ")}`
        );
      } else {
        promoLogger.error(
          `Failed to update promotion PR #${existingPR.number} — ${missingIssues.length} dev-verified issue(s) are BLOCKED from production and no promotion PR reflects them. This is not cosmetic: the promote phase found the work and could not act on it.`
        );
      }
    } else {
      promoLogger.info(`Promotion PR #${existingPR.number} already includes all ${issues.length} issue(s)`);
    }
    return null;
  }

  // Guard: confirm develop actually has file changes main is missing before
  // creating the promotion PR. develop can be "ahead" of main by 1+ commits
  // purely from sync merge commits (main → develop) that carry no file diff.
  // In that case an issue still labeled `ready for prod release` (because the
  // EM verification script hasn't stripped it yet) would trigger a phantom
  // no-op promotion PR — the ping-pong bug.
  const diffFiles = countBranchDiffFiles(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, promoLogger);
  if (diffFiles === 0) {
    // TERMINAL EXIT for the promote lifecycle (slashbin-ai-foreman#32, promote variant).
    //
    // develop has ZERO file changes vs main, so every ready-for-prod issue's work
    // is ALREADY in main — it was promoted, and there is nothing left to promote.
    // Retrying is futile by construction; no future cycle can produce a diff.
    //
    // This used to just log "labels will clear on next verify cycle" and return.
    // They never cleared: stripReadyForProdLabel() is only reachable on the
    // promotion-PR-created path below, so an already-promoted issue kept the label
    // forever and this phase re-checked it EVERY cycle, indefinitely. Observed on
    // jerky_security_testing #110/#115/#117/#118/#122 — stuck from 2026-07-01 for
    // two weeks, burning a promote check every poll, while their fixes had shipped
    // to main (and deployed) on day one. The "likely a race" comment was a wrong
    // assumption that made a permanent stuck state read as self-healing.
    //
    // Safe: `ready for prod release` is only applied after the feature PR merges to
    // develop, so develop-content == main-content ⇒ that work IS in main. Strip the
    // label to remove them from the promote set. We do NOT close them — the EM still
    // owns outcome verification; an open issue with no lifecycle label is inert
    // (the Foreman won't re-pick it) and stays visible for that close.
    promoLogger.warn(
      `Already promoted — ${issues.length} issue(s) still labeled '${repoConfig.lifecycleLabels.readyForProd}' but ${repoConfig.baseBranch} has 0 file changes vs ${repoConfig.productionBranch}, ` +
      `so their work is already in ${repoConfig.productionBranch}: ${issues.map((i) => `#${i.number}`).join(", ")}. ` +
      `Stripping the label (nothing left to promote). They remain open for EM outcome-verification + close.`,
    );
    stripReadyForProdLabel(
      repoConfig.githubRepo,
      issues.map((i) => i.number),
      repoConfig.repoPath,
      repoConfig.lifecycleLabels,
      promoLogger,
    );
    // Confirmed in main: the promotion these issues were waiting for happened.
    await notifyObserversOnce("promoted", repoConfig, issues.map((i) => i.number), promoLogger);
    await notifyRelease({
      repo: repoConfig.githubRepo,
      state: "merged",
      issues: issues.map((i) => itemOf(repoConfig, i.number)),
      productionBranch: repoConfig.productionBranch,
    }, promoLogger);
    return null;
  }
  if (diffFiles < 0) {
    promoLogger.warn("Could not compute branch diff — proceeding with promotion PR creation (best effort)");
  }

  const prUrl = createPromotionPR(
    repoConfig.githubRepo,
    repoConfig.productionBranch,
    repoConfig.baseBranch,
    issues,
    repoConfig.repoPath,
    promoLogger,
  );

  if (prUrl) {
    promoLogger.info(`Promotion PR created: ${prUrl}`, {
      issues: issues.map((i) => i.number),
    });
    // Strip the `ready for prod release` label now that the promotion PR
    // owns these issues. Prevents the Foreman from treating the same issues
    // as still-to-promote on its next cycle (which races with the EM
    // verification script that normally strips labels at close time).
    stripReadyForProdLabel(
      repoConfig.githubRepo,
      issues.map((i) => i.number),
      repoConfig.repoPath,
      repoConfig.lifecycleLabels,
      promoLogger,
    );
    await notifyObserversOnce("promoted", repoConfig, issues.map((i) => i.number), promoLogger);
    return "promoted";
  } else {
    promoLogger.warn("Failed to create promotion PR");
    return null;
  }
}
