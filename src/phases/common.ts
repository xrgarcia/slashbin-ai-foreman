// Shared by the orchestrator and every phase: per-repo counters and holds,
// session-report builders, and the helpers that report a step (itemOf,
// notifyOnce, reportReviewOutcomes). Module state lives here, once.

import { spawnSync } from "node:child_process";
import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionPr, SessionReport, WorkItem } from "../adapters.js";
import { emit, advance, hasObservers } from "../work-source.js";
import { reviewMove } from "../lifecycle.js";
import { parseReviewBody } from "../review-report.js";
import { commentOnIssue, issueTitles, readPrDigest, readLatestReviewBody } from "../github.js";
import { type BranchDivergence } from "../reconciler.js";
import { readReviewOutcomes, type ReviewOutcome } from "../github.js";
import type { ReviewTrailer, UpstreamLimit } from "../agent.js";
import { loadRepoState, saveRepoState, type BranchBlock } from "../state.js";
import { passingCheck, unblockedReason, type BlockFacts, type BlockKind } from "../unblock.js";

/**
 * Why a run stopped, worded for the card. Every stop — the first failure, a
 * Claude usage limit, a GitHub rate limit — moves the card to Blocked so the
 * board shows it the moment it happens, not after retries run out. The next
 * attempt's session start moves the card back out on its own.
 */
export function stoppedReason(what: string, result: { error?: string; upstreamLimit?: UpstreamLimit }, githubBlocked: boolean, attempt?: string): string {
  if (result.upstreamLimit) {
    const at = result.upstreamLimit.resetAtMs
      ? ` — resumes after ${new Date(result.upstreamLimit.resetAtMs).toISOString().slice(11, 16)}Z`
      : " — resumes when the limit lifts";
    return `${what} stopped: Claude usage limit (${result.upstreamLimit.reason})${at}`;
  }
  if (githubBlocked) return `${what} stopped: GitHub rate limit — resumes when it lifts`;
  return `${what} failed${attempt ? ` (${attempt})` : ""}: ${result.error || "unknown"} — retrying next cycle`;
}

/**
 * Run the unblock checks for one kind of block (src/unblock.ts). On a pass,
 * move each item's card back out of Blocked and log which check released it;
 * the caller clears its own state. Returns whether the block was resolved.
 */
export async function releaseIfResolved(
  kind: BlockKind,
  facts: BlockFacts,
  items: readonly number[],
  repoConfig: RepoConfig,
  logger: Logger,
): Promise<boolean> {
  const check = passingCheck(kind, facts);
  if (!check) return false;
  const why = unblockedReason(check);
  logger.info(`${kind} block on ${items.map((n) => `#${n}`).join(", ") || repoConfig.name} resolved — ${why}`);
  for (const n of items) await emit({ kind: "unblocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, logger);
  return true;
}

/**
 * Whether `origin/<base>` gained a commit after `sinceIso`, read from the local
 * clone without fetching. Undefined when git cannot say: unknown never unblocks.
 */
export function baseAdvancedSince(repoConfig: RepoConfig, sinceIso: string): boolean | undefined {
  const r = spawnSync("git", ["log", "-1", "--format=%cI", `origin/${repoConfig.baseBranch}`], { cwd: repoConfig.repoPath, encoding: "utf8" });
  const at = Date.parse((r.stdout ?? "").trim());
  const since = Date.parse(sinceIso);
  if (r.status !== 0 || Number.isNaN(at) || Number.isNaN(since)) return undefined;
  return at > since;
}

export const MAX_RETRIES = 2;

/** The work item a repo-scoped issue number names. */
/** One line: why a diverged feature branch holds an item back. */
export function divergenceReason(block: BranchBlock): string {
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
export async function announceDivergence(
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

export function itemOf(repoConfig: RepoConfig, issueNumber: number): WorkItem {
  return { issueNumber, repo: repoConfig.githubRepo };
}

// --- Session reports (Foreman issue 74) ---
// What an observer summarises a session from, gathered only when one is
// registered: each read is a GitHub call, and nothing else uses them. Every
// helper is best-effort and never throws — a missing report is a shorter
// comment, never a failed session.

/** The items' goals (their issue titles), for a session's start. */
export function startReport(repoConfig: RepoConfig, issues: ReadonlyArray<number>, logger: Logger): SessionReport | undefined {
  if (!hasObservers()) return undefined;
  const goals = issueTitles(repoConfig, issues, logger);
  return Object.keys(goals).length ? { goals } : undefined;
}

/** A PR's title and diff stat; `pr` is a number, a URL or a head branch. */
export function prReport(repoConfig: RepoConfig, pr: string | number, logger: Logger): SessionPr | undefined {
  return readPrDigest(repoConfig.githubRepo, pr, repoConfig.repoPath, logger) ?? undefined;
}

/** A finished review: its trailer for `pr`, and the review body it posted since `since`. */
export function reviewReport(
  repoConfig: RepoConfig, pr: number, trailers: ReadonlyArray<ReviewTrailer>, summary: string | undefined,
  since: Date, logger: Logger,
): SessionReport {
  const digest = prReport(repoConfig, pr, logger);
  const t = trailers.find((x) => x.pr === pr);
  if (!t) return { ...(digest ? { pr: digest } : {}), ...(summary ? { text: summary } : {}) };
  // A minute's slack for clock skew between this host and GitHub.
  const body = readLatestReviewBody(repoConfig.githubRepo, pr, new Date(since.getTime() - 60_000).toISOString(), repoConfig.repoPath, logger);
  const parsed = parseReviewBody(body ?? summary);
  return {
    ...(digest ? { pr: digest } : {}),
    review: {
      verdict: t.verdict, merged: t.merged, deploy: t.deploy,
      ...(t.hold ? { hold: t.hold } : {}),
      ...(parsed.summary ? { summary: parsed.summary } : {}),
      findings: body ? parsed.findings : [],
    },
  };
}

// Merged / promoted events already delivered to observers this process, keyed
// `<kind>:<owner/repo>#<n>`. Several paths can see the same merge (the review's
// own trailer, a failed-but-landed review, dead-zone detection on every later
// pass, the implement stage's already-merged sweep), and a promotion whose
// label strip failed is seen again next cycle. An observer gets each once.
export const observerEventsSent = new Set<string>();

/**
 * Tell the observers the outcome a review agent wrote on GitHub itself. The
 * agent labels `pr approved` / `pr pending actions` directly, so no state
 * change passes through `advance` (it is an *observed* move); without this a live review card
 * ends its session back at "in review" until something else re-reads GitHub.
 * Issues still at `pr under review` carry no outcome and are left to the
 * reconcile, which reports its own.
 */
export async function reportReviewOutcomes(repoConfig: RepoConfig, issueNumbers: number[], logger: Logger): Promise<void> {
  for (const [n, outcome] of readReviewOutcomes(repoConfig, issueNumbers, logger)) {
    await advance(itemOf(repoConfig, n), reviewMove(workStateOf(outcome)), repoConfig, logger, { observed: true });
  }
}

/**
 * Tell observers each issue merged / was handed to promotion, once per issue.
 * Best-effort by construction (work-source.ts never rethrows an observer
 * error); with no observer registered this does nothing at all.
 */
export async function notifyOnce(
  kind: "merged" | "promoted",
  repoConfig: RepoConfig,
  issueNumbers: number[],
  logger: Logger,
): Promise<void> {
  for (const n of issueNumbers) {
    const key = `${kind}:${repoConfig.githubRepo}#${n}`;
    if (observerEventsSent.has(key)) continue;
    observerEventsSent.add(key);
    await emit({ kind, item: itemOf(repoConfig, n) }, repoConfig, logger);
  }
}

// Agent runs in flight, keyed by repo name. Repos progress CONCURRENTLY (one
// queue per service — see runCycle), so "the" in-flight run stopped being a
// single thing; a lone `abortController` would have tracked whichever repo
// started last and let a restart SIGKILL every other repo's half-built branch.
// One entry per repo, at most — a repo's own phases stay strictly sequential
// because they share one git working clone.
export const activeRuns = new Map<string, AbortController>();

// Per-repo consecutive batch failure count with cooldown
export const failureCount = new Map<string, number>();
export const failureHitMaxAt = new Map<string, number>(); // cycle when max was hit
export const revisionFailureCount = new Map<string, number>();
// Repos whose revision retries are exhausted AND already escalated. Without this
// the cap was reached silently: the count hit MAX_RETRIES, every later cycle took
// the `debug` skip branch, and the stuck PR sat there with nobody told. The set is
// cleared the moment a revision succeeds or the pending feedback clears, so a repo
// that recovers escalates again if it breaks again.
export const revisionEscalated = new Set<string>();
// Consecutive revisions that pushed nothing BY DECLARATION, per repo.
//
// A declared no-commit is a valid answer, so it returns to `pr under review`
// and gets re-reviewed. But if the reviewer then asks for the same change
// again, the pair will ping-pong forever at no cost to either side and with
// nothing changing. One is an answer; two in a row is a disagreement, and a
// disagreement between two agents is a human's call.
//
// Cleared whenever a revision actually pushes, or the pending feedback clears.
export const consecutiveNoCommit = new Map<string, number>();
// The PR head SHA revision stopped on (retries exhausted, or a no-commit
// stalemate), per repo. A different head later means someone pushed to the PR
// out of band: the `revision-*` unblock check (src/unblock.ts) resumes on it.
export const revisionStoppedHead = new Map<string, string>();
export const MAX_CONSECUTIVE_NO_COMMIT = 1;
// A PR sent back this many times is probably not converging: each round answers
// the last finding and the reviewer finds a new one in the answer. The retry cap
// above counts only FAILED revisions, so a spiral of successful ones was silent —
// slashbin_mcp_services PR 245 (2026-10-09) went six rounds, 3,286 lines, nobody
// told. This only alerts; the revision still runs. Once per PR per daemon life.
export const REVIEW_ROUNDS_ALERT = 4;
export const reviewRoundsAlerted = new Set<string>();
export const reviewFailureCount = new Map<string, number>();
export const reviewFailureHitMaxAt = new Map<string, number>();

// Last cycle on which each repo checked whether an empty ready-for-prod set is
// actually a stall. Rate-limits one compare API call per repo; see tryPromotion.
export const lastStallCheckCycle = new Map<string, number>();
export const STALL_CHECK_CYCLE_INTERVAL = 12;

/** Per-repo set of issue numbers already alerted as dead-zoned, so a STANDING
 *  condition alerts once instead of every reconcile cycle. Cleared per-issue when
 *  the issue leaves the dead-zone, so a genuine re-entry alerts again. */
export const deadZoneAlerted = new Map<string, Set<number>>();

/** Per-repo set of issue numbers we already attempted to auto-recover, so a
 *  repo whose verification is INDETERMINATE (unmapped service, verifier crash)
 *  does not re-spend a multi-minute deploy poll on every cycle, forever. */
export const deadZoneRecoveryAttempted = new Map<string, Set<number>>();

/** Ceiling on one dead-zone re-verification. The verifier polls a Railway
 *  deployment, so minutes are normal and hanging forever is not. */
export const RECOVERY_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

export const FAILURE_COOLDOWN_CYCLES = 3; // retry after this many idle cycles
export const lastFailureReason = new Map<string, string>(); // per-repo last failure for retry context

/**
 * Per repo, the issues held behind an open feature PR and that PR's number.
 * Observers hear "queued" once per hold, not once per cycle.
 */
export const queuedBehind = new Map<string, Map<number, number>>();

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
 *
 * With a verify stage configured (`verifyStage`, EM#440) a passing merge is
 * `prMerged`, never `prApproved`: approval is the verifier's to give, and a
 * reviewer's own deploy check does not stand in for it.
 */
export function labelFromTrailer(t: ReviewTrailer, verifyStage = false): ReviewOutcome | null {
  if (!t.merged) return null;
  if (t.verdict !== "APPROVE") return null;
  if (/^(FAIL|FAILURE|FAILED)$/.test(t.deploy)) return "prPendingActions";
  if (/^(SUCCESS|OK|PASS|PASSED|NA|N\/A|NONE)$/.test(t.deploy)) return verifyStage ? "prMerged" : "prApproved";
  return null;
}

/** The work state a review outcome reports. */
export function workStateOf(outcome: ReviewOutcome): "approved" | "merged" | "changesRequested" {
  return outcome === "prApproved" ? "approved" : outcome === "prMerged" ? "merged" : "changesRequested";
}

export interface CycleEvent {
  message: string;
  level: "info" | "warn" | "error";
}

