// The revise phase: address review feedback on an open PR.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionEvent, SessionReport } from "../adapters.js";
import { emit, advance, hasObservers } from "../work-source.js";
import { findPendingRevisions, countChangesRequested, type PendingRevisionInfo } from "../github.js";
import { revisePRFeedback } from "../agent.js";
import { isUpstreamBlocked, tryAcquire, reportClaudeResult } from "../upstream-backoff.js";
import { type BlockKind } from "../unblock.js";
import {
  CycleEvent,
  MAX_CONSECUTIVE_NO_COMMIT,
  MAX_RETRIES,
  REVIEW_ROUNDS_ALERT,
  activeRuns,
  consecutiveNoCommit,
  itemOf,
  prReport,
  releaseIfResolved,
  reviewRoundsAlerted,
  revisionEscalated,
  revisionFailureCount,
  revisionStoppedHead,
  stoppedReason,
} from "./common.js";
import { reportLaunchThrew } from "./implement.js";

export async function tryRevision(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number,
  events: CycleEvent[],
): Promise<PendingRevisionInfo | null> {
  const repoName = repoConfig.name;
  const revLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "revision" });

  if (isUpstreamBlocked("claude")) return null;

  let failures = revisionFailureCount.get(repoName) ?? 0;

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
    revisionStoppedHead.delete(repoName);
    return null;
  }

  // A stopped revision resumes when someone pushes to the PR out of band.
  const stoppedAt = revisionStoppedHead.get(repoName);
  if (stoppedAt !== undefined) {
    const head = pending.pr.headRefOid;
    const kind: BlockKind = failures >= MAX_RETRIES ? "revision-exhausted" : "revision-stalemate";
    if (await releaseIfResolved(kind, { prHeadMoved: head ? head !== stoppedAt : undefined }, pending.issueNumbers, repoConfig, revLogger)) {
      revisionStoppedHead.delete(repoName);
      revisionFailureCount.set(repoName, 0);
      revisionEscalated.delete(repoName);
      consecutiveNoCommit.delete(repoName);
      failures = 0;
    }
  }

  // Check if this repo has exceeded revision failure retries
  if (failures >= MAX_RETRIES) {
    revLogger.debug(`Skipping ${repoName} revision — ${failures} consecutive failures`);
    return null;
  }

  // A no-commit stalemate already escalated: the card is Blocked and the EM must
  // rule. Re-running the reviser only re-answers the same review — it launched a
  // paid session on 17 straight cycles for slashbin-io-worker PR #694
  // (2026-10-03). Clears with the pending feedback, like the retry cap above.
  if ((consecutiveNoCommit.get(repoName) ?? 0) > MAX_CONSECUTIVE_NO_COMMIT) {
    revLogger.debug(`Skipping ${repoName} revision — PR #${pending.pr.number} is in a no-commit stalemate awaiting the EM`);
    return null;
  }

  const roundsKey = `${repoConfig.githubRepo}#${pending.pr.number}`;
  if (!reviewRoundsAlerted.has(roundsKey)) {
    const rounds = countChangesRequested(repoConfig.githubRepo, pending.pr.number, repoConfig.repoPath, revLogger);
    if (rounds !== null && rounds >= REVIEW_ROUNDS_ALERT) {
      reviewRoundsAlerted.add(roundsKey);
      revLogger.warn(`PR #${pending.pr.number} has been sent back ${rounds} times — revising again, but it may not be converging`);
      events.push({
        message:
          `⚠️ ${repoConfig.githubRepo} — PR #${pending.pr.number} has had ${rounds} CHANGES_REQUESTED reviews and is being revised again. ` +
          `If each round's finding sits in the last round's fix, it is not converging. EM: rule on scope.`,
        level: "warn",
      });
    }
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
  let report: SessionReport | undefined;

  try {
    await emit({ kind: "session", session: { ...session, status: "started" } }, null, revLogger);
    const result = await revisePRFeedback(
      repoConfig, revLogger, runAbort.signal,
      pending.pr.number, pending.issueNumbers,
    ).catch(reportLaunchThrew);
    reportClaudeResult(!!result.upstreamLimit, result.upstreamLimit?.reason, result.upstreamLimit?.resetAtMs);
    ended = result.success
      ? { status: "finished", detail: result.noCommit ? `no commit: ${result.noCommitReason ?? "branch already correct"}` : "changes pushed, back to review" }
      : { status: "failed", detail: result.upstreamLimit ? `upstream limit: ${result.upstreamLimit.reason}` : result.error || "unknown" };
    if (hasObservers() && result.success) {
      const pr = prReport(repoConfig, pending.pr.number, revLogger);
      report = { ...(result.summary ? { text: result.summary } : {}), ...(pr ? { pr } : {}) };
    }

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
          // Stopped for a person: the board must say so, not leave it "in review".
          if (pending.pr.headRefOid) revisionStoppedHead.set(repoName, pending.pr.headRefOid);
          const why = `reviewer and reviser disagree on PR #${pending.pr.number} after ${seen} no-commit rounds — EM to rule, or push to the PR and the Foreman resumes. Last reason: ${result.noCommitReason ?? "not given"}`;
          for (const n of pending.issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, revLogger);
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
        await advance(itemOf(repoConfig, n), "revised", repoConfig, revLogger);
      }

      revLogger.info("PR revision succeeded");
      return pending;
    } else {
      // An upstream limit refused the run — not a defect, so it charges no retry.
      // The card still goes to Blocked: the work has stopped, and the board says why.
      if (result.upstreamLimit || isUpstreamBlocked("github")) {
        const why = stoppedReason(`Revision of PR #${pending.pr.number}`, result, isUpstreamBlocked("github"));
        for (const n of pending.issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, revLogger);
        return null;
      }
      const newCount = failures + 1;
      revisionFailureCount.set(repoName, newCount);
      revLogger.warn(`PR revision failed (${newCount}/${MAX_RETRIES}): ${result.error}`);
      if (newCount < MAX_RETRIES) {
        const why = stoppedReason(`Revision of PR #${pending.pr.number}`, result, false, `${newCount}/${MAX_RETRIES}`);
        for (const n of pending.issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, revLogger);
      }

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
        if (pending.pr.headRefOid) revisionStoppedHead.set(repoName, pending.pr.headRefOid);
        const blocked = `Revision retries exhausted on PR #${pending.pr.number}: ${result.error ?? "unknown"} — push to the PR and the Foreman resumes`;
        for (const n of pending.issueNumbers) {
          await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: blocked }, repoConfig, revLogger);
        }
      }
    }

    return null;
  } finally {
    activeRuns.delete(repoName);
    await emit({ kind: "session", session: { ...session, ...ended, ...(report ? { report } : {}) } }, null, revLogger);
  }
}

