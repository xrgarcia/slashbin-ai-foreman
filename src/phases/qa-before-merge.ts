// QA before the merge (config.qaBeforeMerge, EM#923): development, code review, then QA, and only then
// the SRE. The Tech Lead has approved the PR without merging it (`review-pr --no-merge`); this phase
// runs `qa.mjs check --local` on that head. A PASS has the Tech Lead merge on its existing approval,
// and dev verification follows as ever. A FAIL goes back to the builder; the SRE never sees it.
// A run that gave no verdict holds the PR unmerged.

import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionEvent } from "../adapters.js";
import { emit, advance } from "../work-source.js";
import { HEAD_MOVED_HOLD, NOT_APPROVED_HOLD } from "../agent.js";
import { roleFor } from "../plugins/registry.js";
import { findQaPendingPr, getPRCheckVerdict, countCiBouncesSinceReview, bounceForRedCI } from "../github.js";
import { qaBeforeMergeApplies, realQaLocalDeps, runQaBeforeMerge, type QaDeps, type QaPreMergeDecision } from "../qa-report.js";
import { isToolingHold } from "./verify.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import { BackoffTracker, backoffSettings, formatWait } from "../backoff.js";
import { CycleEvent, activeRuns, itemOf, reviewFailureCount, reviewFailurePause, stoppedReason } from "./common.js";
import { settleReviewOutcome } from "./review.js";
import { resolve } from "node:path";

/**
 * What the pass did. `none`: no approved PR is waiting for QA, so the review phase carries on.
 * `handled`: QA ran, a merge was attempted, or a hold was placed. `waiting`: the PR is held or backing off;
 * the review phase must not offer it to the Tech Lead again.
 */
export type QaPhaseResult = "none" | "handled" | "waiting";

/** Per repo: the QA phase waiting after a tooling hold (backoff.agentUnavailable). */
export const qaDefer = new BackoffTracker();
/** Per PR head: the merge retry waiting after a PASS the Tech Lead could not merge yet (backoff.approvedUnmerged). */
export const qaMergeWait = new BackoffTracker();

/** The hold's text on the card: who is waited on, why, and when it retries. */
const holdWhy = (pr: number, reason: string, summary: string, wait: string): string =>
  `waiting on QA: it gave no verdict on PR #${pr} (${reason}${summary ? `: ${summary.slice(0, 200)}` : ""}) — nothing merges; ${wait}`;

export async function tryQaBeforeMerge(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[],
  deps?: QaDeps,
): Promise<QaPhaseResult> {
  if (!repoConfig.reviewEnabled || !qaBeforeMergeApplies(repoConfig, config)) return "none";
  if (isUpstreamBlocked("github")) return "none";
  const repoName = repoConfig.name;
  const qlog = logger.child({ cycle: cycleNumber, repo: repoName, phase: "qa" });

  const target = findQaPendingPr(repoConfig, repoConfig.reviewerLogin, qlog);
  if (!target) return "none";
  const { prNumber, issueNumbers, headSha } = target;
  const { repoFailure, agentUnavailable, maxCiBounces } = config.backoff;

  if (qaDefer.waiting(repoName)) return "waiting";
  if (qaMergeWait.waiting(`${repoConfig.githubRepo}#${prNumber}@${headSha}`)) return "waiting";
  const failures = reviewFailureCount.get(repoName) ?? 0;
  if (failures >= repoFailure.maxFailures) {
    if (reviewFailurePause.waiting(repoName)) return "waiting";
    reviewFailureCount.set(repoName, 0);
  }

  // Never boot a PR its own CI already rejects: CI red goes back to the builder like a review would.
  const checks = getPRCheckVerdict(repoConfig, prNumber, qlog);
  if (checks.state === "pending") {
    qlog.info(`PR #${prNumber} CI still running (${checks.pending.join(", ")}) — QA waits for it`);
    return "waiting";
  }
  if (checks.state === "failing") {
    const bounces = countCiBouncesSinceReview(repoConfig, prNumber, repoConfig.reviewerLogin, qlog);
    if (bounces >= maxCiBounces) {
      qlog.warn(`PR #${prNumber} CI still red after ${bounces} bounce(s) — QA does not run on a red head`);
      return "waiting";
    }
    bounceForRedCI(repoConfig, prNumber, checks);
    for (const n of issueNumbers) await advance(itemOf(repoConfig, n), "changesRequested", repoConfig, qlog);
    events?.push({ message: `${repoConfig.githubRepo} PR #${prNumber}: CI red after approval — sent back to the builder before QA`, level: "info" });
    return "handled";
  }

  const items = issueNumbers.map((n) => itemOf(repoConfig, n));
  const session: Omit<SessionEvent, "status"> = { phase: "review", repo: repoConfig.githubRepo, pr: prNumber, items, reviewer: "QA" };
  const qaSession: Omit<SessionEvent, "status"> = { phase: "qa", repo: repoConfig.githubRepo, pr: prNumber, items, reviewer: "QA", qaBeforeMerge: true };
  let ended: { status: "finished" | "failed"; detail: string } = { status: "failed", detail: "the QA step ended without a result" };
  const runAbort = new AbortController();
  activeRuns.set(runAbort, repoName);
  qlog.info(`QA before merge: ${repoName} PR #${prNumber} at ${headSha.slice(0, 7)}`);
  events?.push({ message: `QA checking ${repoConfig.githubRepo} PR #${prNumber} locally before the merge`, level: "info" });
  try {
    await emit({ kind: "session", session: { ...session, status: "started" } }, null, qlog);
    await emit({ kind: "session", session: { ...qaSession, status: "started" } }, null, qlog);
    const decision: QaPreMergeDecision = await runQaBeforeMerge(repoConfig.githubRepo, prNumber, headSha, deps ?? realQaLocalDeps(repoConfig, config, qlog), qlog);
    await emit({ kind: "session", session: { ...qaSession, status: decision.kind === "pass" ? "finished" : "failed", detail: decision.kind } }, null, qlog);

    if (decision.kind === "fail") {
      // A QA FAIL is a review round (reports.ts counts its report), so REVIEW_ROUNDS_ALERT bounds the loop.
      for (const n of issueNumbers) await advance(itemOf(repoConfig, n), "changesRequested", repoConfig, qlog);
      ended = { status: "finished", detail: `QA failed PR #${prNumber}; sent back to the builder` };
      events?.push({ message: `❌ ${repoConfig.githubRepo} PR #${prNumber}: QA failed it — sent back to the builder, the SRE does not see it`, level: "warn" });
      return "handled";
    }

    if (decision.kind === "hold") {
      // A checker that could not run charges nothing and retries after a wait; a real hold counts as a failed review.
      let wait: string;
      if (isToolingHold(decision.reason)) {
        wait = `retries automatically in ${formatWait(qaDefer.start(repoName, agentUnavailable))}`;
      } else {
        const n = failures + 1;
        reviewFailureCount.set(repoName, n);
        wait = n >= repoFailure.maxFailures
          ? `paused ${formatWait(reviewFailurePause.start(repoName, repoFailure))}, then retries`
          : `retries next cycle (${n}/${repoFailure.maxFailures})`;
      }
      const why = holdWhy(prNumber, decision.reason, decision.summary, wait);
      for (const n of issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, qlog);
      ended = { status: "failed", detail: why };
      qlog.warn(`${repoName}: ${why}`);
      events?.push({ message: `⏸️ ${repoConfig.githubRepo} PR #${prNumber}: ${why}`, level: "warn" });
      return "handled";
    }

    // PASS on this exact head: the Tech Lead merges THAT head on its existing approval (`--merge-approved <sha>`,
    // merge-only). A head pushed since, or no approval of that head, writes nothing and merges nothing.
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      ended = { status: "failed", detail: `QA passed PR #${prNumber}, but its head ${headSha} is not a full sha — not merging` };
      return "handled";
    }
    const transcriptPath = resolve(process.cwd(), "logs", "review", `${repoName}-cycle${cycleNumber}-${new Date().toISOString().replace(/[:.]/g, "-")}-merge.log`);
    const reviewer = roleFor("reviewer", config);
    const result = await (reviewer
      ? reviewer.reviewPr(repoConfig, config, prNumber, qlog, runAbort.signal, transcriptPath, undefined, false, headSha)
      : Promise.resolve({ fallback: true as const, reason: "no reviewer is enabled" }))
      .catch((e: unknown): { fallback: true; reason: string } => ({ fallback: true, reason: `Tech Lead launch threw: ${String(e)}` }));
    if ("fallback" in result) {
      const wait = formatWait(qaDefer.start(repoName, agentUnavailable));
      ended = { status: "failed", detail: `QA passed PR #${prNumber}; the Tech Lead could not take the merge (${result.reason}) — retried in ${wait}` };
      const why = `waiting on the Tech Lead: QA passed PR #${prNumber} but it could not take the merge (${result.reason}) — retries automatically in ${wait}`;
      for (const n of issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, qlog);
      return "handled";
    }
    const own = (result.trailers ?? []).find((t) => t.pr === prNumber);
    if (result.success && own?.hold === HEAD_MOVED_HOLD) {
      // The head moved after QA passed it: nothing merged, nothing charged. The card stays in review, and the
      // new head goes back through the Tech Lead and QA (findQaPendingPr sees no approval of it).
      reviewFailureCount.set(repoName, 0);
      ended = { status: "finished", detail: `QA passed ${headSha.slice(0, 7)} but PR #${prNumber} has a new head; it goes back to review` };
      events?.push({ message: `↩️ ${repoConfig.githubRepo} PR #${prNumber}: a new head was pushed after QA passed ${headSha.slice(0, 7)} — back to review, nothing merged`, level: "info" });
      return "handled";
    }
    if (result.success && own?.hold === NOT_APPROVED_HOLD) {
      const n = failures + 1;
      reviewFailureCount.set(repoName, n);
      const wait = n >= repoFailure.maxFailures
        ? `paused ${formatWait(reviewFailurePause.start(repoName, repoFailure))}, then retries`
        : `retries next cycle (${n}/${repoFailure.maxFailures})`;
      const why = `held: QA passed ${headSha.slice(0, 7)} on PR #${prNumber}, but the Tech Lead has no approval of that head — nothing merges; ${wait}`;
      for (const i of issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, i), reason: why }, repoConfig, qlog);
      ended = { status: "failed", detail: why };
      events?.push({ message: `⏸️ ${repoConfig.githubRepo} PR #${prNumber}: ${why}`, level: "warn" });
      return "handled";
    }
    if (!result.success) {
      reviewFailureCount.set(repoName, failures + 1);
      ended = { status: "failed", detail: result.error || "the merge run failed" };
      const why = stoppedReason(`Merge of PR #${prNumber} after QA`, result, false, `${failures + 1}/${repoFailure.maxFailures}`);
      for (const n of issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, qlog);
      events?.push({ message: `Merge after QA failed on ${repoConfig.githubRepo} PR #${prNumber}: ${result.error}`, level: "error" });
      return "handled";
    }
    reviewFailureCount.set(repoName, 0);
    reviewFailurePause.clear(repoName);
    const trailers = result.trailers ?? [];
    await settleReviewOutcome(repoConfig, config, issueNumbers, prNumber, trailers, qlog, events);
    if (trailers.some((t) => t.pr === prNumber && t.merged)) {
      ended = { status: "finished", detail: `QA passed PR #${prNumber}; merged` };
    } else {
      // Approved, QA passed, not merged (CI still running, GitHub refused): the next try waits one window.
      qaMergeWait.start(`${repoConfig.githubRepo}#${prNumber}@${headSha}`, backoffSettings().approvedUnmerged);
      ended = { status: "finished", detail: `QA passed PR #${prNumber}; the Tech Lead did not merge it yet (${result.statusLine || "no trailer detail"}) — retried after a wait` };
      events?.push({ message: `⏳ ${repoConfig.githubRepo} PR #${prNumber}: QA passed, merge not done yet — ${result.statusLine || "retrying"}`, level: "warn" });
    }
    return "handled";
  } finally {
    activeRuns.delete(runAbort);
    await emit({ kind: "session", session: { ...session, ...ended } }, null, qlog);
  }
}
