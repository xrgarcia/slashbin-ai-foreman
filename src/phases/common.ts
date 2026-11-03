// Shared by the orchestrator and every phase: per-repo counters and holds,
// session-report builders, and the helpers that report a step (itemOf,
// notifyOnce, reportReviewOutcomes). Module state lives here, once.

import { spawnSync } from "node:child_process";
import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionPr, SessionReport, WorkItem } from "../adapters.js";
import { emit, advance, wantsSessionReports } from "../work-source.js";
import { reviewMove } from "../lifecycle.js";
import { parseReviewBody } from "../review-report.js";
import { type BranchDivergence } from "../reconciler.js";
import type { ReviewTrailer, UpstreamLimit } from "../session/protocol.js";
import type { Divergence } from "../divergence.js";
import { passingCheck, unblockedReason, type BlockFacts, type BlockKind } from "../unblock.js";
import { BackoffTracker } from "../backoff.js";
import { codeHost } from "../plugins/registry.js";
import type { ReviewOutcome } from "../code-host.js";
import type { ForemanRuntime } from "../runtime.js";

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
  rt: ForemanRuntime,
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
  for (const n of items) await emit(rt, { kind: "unblocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, logger);
  return true;
}

/**
 * Whether issue `n`'s body was edited after `sinceIso`. The body is the spec the
 * SRE verifies against, so a failure the spec caused is fixed by editing it, not
 * by new code. Undefined when GitHub cannot say: unknown never unblocks.
 */
export function issueEditedSince(repoConfig: RepoConfig, n: number, sinceIso: string): boolean | undefined {
  try {
    const at = codeHost().issueLastEditedAt(repoConfig, n);
    if (at === undefined) return undefined;
    if (at === null) return false;
    const since = Date.parse(sinceIso);
    return Number.isNaN(since) ? undefined : Date.parse(at) > since;
  } catch {
    return undefined;
  }
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

/** One line: why a diverged feature branch holds an item back. */
export function divergenceReason(block: Divergence): string {
  return `${block.featureBranch} diverged from ${block.baseBranch}, merge base ${block.mergeBase} — the EM rules which side wins and the Foreman carries it out`;
}

/** The comment each held-back issue gets, once per divergence episode. */
export function divergenceNotice(repoConfig: RepoConfig, block: Divergence): string {
  const { featureBranch: f, baseBranch: b } = block;
  return [
    "<!-- foreman:branch-diverged -->",
    `**The Foreman has stopped implementing on \`${repoConfig.githubRepo}\`: \`${f}\` has diverged from \`${b}\` (${block.ahead} ahead, ${block.behind} behind).**`,
    "",
    "This issue is approved and waiting. Building on a diverged branch would build an unknown tree, so which side wins is not the Foreman's call. The EM is asked for a ruling; the Foreman carries it out (resets or merges `" + f + "`, after saving the old head to a `backup/` ref) and resumes on the first cycle after the branch is reconciled. This is the only notice for this episode.",
    "",
    `Merge base: \`${block.mergeBase}\`. To reconcile by hand instead, for example:`,
    "",
    "```",
    `git fetch origin && git checkout ${f} && git merge origin/${b} && git push origin ${f}`,
    "```",
  ].join("\n");
}

/**
 * The waiting issues of `repoConfig` already told about the divergence with merge base `mergeBase`, read from
 * their records. An issue whose record cannot be read is left out of both lists: it is neither told nor assumed
 * told (the caller must not comment on it this pass).
 */
export async function toldAbout(rt: ForemanRuntime, repoConfig: RepoConfig, issues: readonly number[], mergeBase: string): Promise<{ told: number[]; fresh: number[] }> {
  const loaded = await rt.records.loadIssueRecords(repoConfig, issues);
  const told: number[] = [];
  const fresh: number[] = [];
  for (const [n, r] of loaded.records) (r.divergenceTold === mergeBase ? told : fresh).push(n);
  return { told, fresh };
}

/**
 * Announce a diverged feature branch once per episode (foreman#44). The first sighting in a process warns;
 * later cycles are debug. Each item still waiting gets one comment per episode, an item approved mid-episode
 * its own when it first appears; a new merge base is a new episode. Whom it told lives on each issue's record
 * (`divergenceTold`), saved BEFORE the comment so a crash between the two never posts it twice. Resolves with
 * the issues now told about this episode.
 */
export async function announceDivergence(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  waiting: number[],
  block: Divergence,
  logger: Logger,
  first: boolean,
): Promise<number[]> {
  const { told, fresh } = await toldAbout(rt, repoConfig, waiting, block.mergeBase);
  if (first) {
    logger.warn(
      `Implementation on ${repoConfig.name} stopped — ${divergenceReason(block)} (${block.ahead} ahead, ${block.behind} behind). Announcing on ${fresh.map((n) => `#${n}`).join(", ") || "no waiting issue"}; this is the only warning for this episode`,
    );
  } else {
    logger.debug(`Implementation on ${repoConfig.name} still stopped — ${divergenceReason(block)}`);
  }
  for (const n of fresh) {
    if (!(await rt.records.updateIssueRecord(repoConfig, n, (d) => { d.divergenceTold = block.mergeBase; }))) continue;
    try {
      codeHost().commentOnIssue(repoConfig, n, divergenceNotice(repoConfig, block));
      told.push(n);
    } catch (err) {
      // Not told after all: forget it, so the next cycle tries again.
      await rt.records.updateIssueRecord(repoConfig, n, (d) => { delete d.divergenceTold; });
      logger.warn(`Could not announce the divergence on #${n}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  return told;
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
  if (!wantsSessionReports()) return undefined;
  const goals = codeHost().issueTitles(repoConfig, issues, logger);
  return Object.keys(goals).length ? { goals } : undefined;
}

/** A PR's title and diff stat; `pr` is a number, a URL or a head branch. */
export function prReport(repoConfig: RepoConfig, pr: string | number, logger: Logger): SessionPr | undefined {
  return codeHost().readPrDigest(repoConfig.githubRepo, pr, repoConfig.repoPath, logger) ?? undefined;
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
  const body = codeHost().readLatestReviewBody(repoConfig.githubRepo, pr, new Date(since.getTime() - 60_000).toISOString(), repoConfig.repoPath, logger);
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

/**
 * Tell the observers the outcome a review agent wrote on GitHub itself. The
 * agent labels `pr approved` / `pr pending actions` directly, so no state
 * change passes through `advance` (it is an *observed* move); without this a live review card
 * ends its session back at "in review" until something else re-reads GitHub.
 * Issues still at `pr under review` carry no outcome and are left to the
 * reconcile, which reports its own.
 */
export async function reportReviewOutcomes(rt: ForemanRuntime, repoConfig: RepoConfig, issueNumbers: number[], logger: Logger): Promise<void> {
  for (const [n, outcome] of codeHost().readReviewOutcomes(repoConfig, issueNumbers, logger)) {
    await advance(rt, itemOf(repoConfig, n), reviewMove(workStateOf(outcome)), repoConfig, logger, { observed: true });
  }
}

/**
 * Tell observers each issue merged / was handed to promotion, once per issue.
 * Best-effort by construction (work-source.ts never rethrows an observer
 * error); with no observer registered this does nothing at all.
 */
export async function notifyOnce(
  rt: ForemanRuntime,
  kind: "merged" | "promoted",
  repoConfig: RepoConfig,
  issueNumbers: number[],
  logger: Logger,
): Promise<void> {
  for (const n of issueNumbers) {
    const key = `${kind}:${repoConfig.githubRepo}#${n}`;
    if (rt.memory.observerEventsSent.has(key)) continue;
    rt.memory.observerEventsSent.add(key);
    await emit(rt, { kind, item: itemOf(repoConfig, n) }, repoConfig, logger);
  }
}

// Agent runs in flight: each run's controller → its repo name. Repos progress
// CONCURRENTLY, so "the" in-flight run stopped being a single thing; a lone
// `abortController` would have tracked whichever repo started last and let a
// restart SIGKILL every other repo's half-built branch. Keyed by controller,
// not repo: a repo's lanes run side by side (see lanes.ts), so one repo can have
// a build, a review and a release in flight at once, and a repo key would let
// the first to finish erase the others from the shutdown drain.
/** Process-wide: the shutdown drain aborts every run in the process, whichever runtime started it. */
export const activeRuns = new Map<AbortController, string>();

// A PR sent back this many times is probably not converging: each round answers
// the last finding and the reviewer finds a new one in the answer. The retry cap
// above counts only FAILED revisions, so a spiral of successful ones was silent —
// slashbin_mcp_services PR 245 (2026-10-09) went six rounds, 3,286 lines, nobody
// told. At this count since the last EM scope ruling, revision stops and the card
// goes to the EM (src/phases/revise.ts); escalated once per PR per newest review.
// 3, not 4 (2026-10-14): jerky_service PR 148 took ~35 min a round and four
// rounds before a ruling — a fourth round is two hours spent before anyone rules.
export const REVIEW_ROUNDS_ALERT = 3;

export const STALL_CHECK_CYCLE_INTERVAL = 12;

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

/**
 * Whether the EM holds PR `pr`: one of its issues carries `github.blockedLabel`, so `phase` (review, QA
 * before the merge, revise) does not act on it until the label is lifted. Slashbin-console PR #1597 ran
 * three more QA FAILs and revises after its issue was labelled (foreman#167). Issues that cannot be read
 * pause it for this pass: an unknown hold is not a lifted one.
 */
export function pausedByBlockedLabel(rt: ForemanRuntime, repoConfig: RepoConfig, phase: string, pr: number, issueNumbers: ReadonlyArray<number>, logger: Logger): boolean {
  const key = `${phase}:${repoConfig.githubRepo}#${pr}`;
  let held: number[];
  try {
    held = codeHost().blockedAmong(repoConfig, issueNumbers, logger);
  } catch (err) {
    logger.debug(`PR #${pr}: ${phase} waits a pass, its issues' labels could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
  if (held.length === 0) {
    rt.memory.blockedPauseNoted.delete(key);
    return false;
  }
  if (!rt.memory.blockedPauseNoted.has(key)) {
    rt.memory.blockedPauseNoted.add(key);
    logger.info(`PR #${pr} paused: ${held.map((n) => `#${n}`).join(", ")} carries "${repoConfig.github.blockedLabel}" — no ${phase} until it is lifted`);
  }
  return true;
}

export interface CycleEvent {
  message: string;
  level: "info" | "warn" | "error";
}

