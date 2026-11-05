// The revise phase: address review feedback on an open PR.

import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionEvent, SessionReport } from "../adapters.js";
import { emit, advance, wantsSessionReports } from "../work-source.js";
import { revisePRFeedback } from "./revise-workflow.js";
import { latestQaFailLines, qaBeforeMergeApplies } from "../qa-report.js";
import { isUpstreamBlocked, tryAcquire, reportRunResult } from "../upstream-backoff.js";
import { runnerName } from "../refusal.js";
import { type BlockKind } from "../unblock.js";
import { MAX_CONSECUTIVE_NO_COMMIT, noCommitCount, isUnconfirmed, stalemateHead } from "../no-commit-streak.js";
import { CycleEvent, REVIEW_ROUNDS_ALERT, activeRuns, itemOf, pausedByBlockedLabel, prReport, releaseIfResolved, stoppedReason } from "./common.js";
import { reportLaunchThrew } from "./implement.js";
import { codeHost } from "../plugins/registry.js";
import type { PendingRevisionInfo } from "../code-host.js";
import { isForemanOwnedHead } from "../foreman-branch.js";
import type { ForemanRuntime } from "../runtime.js";

export async function tryRevision(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events: CycleEvent[],
): Promise<PendingRevisionInfo | null> {
  const repoName = repoConfig.name;
  const revLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "revision" });

  if (isUpstreamBlocked(runnerName())) return null;

  let failures = rt.memory.revisionFailureCount.get(repoName) ?? 0;
  // Failed revisions before the PR is escalated to a person (backoff.repoFailure).
  const { maxFailures } = config.backoff.repoFailure;

  // Gate: are there issues with pending review feedback + an open feature PR?
  //
  // This runs BEFORE the exhausted-retries skip, on purpose. The reset below is
  // the only way an exhausted counter clears short of a daemon restart, and it
  // used to sit after the skip — unreachable once the cap was hit. Slashbin-io-docs
  // PR #411 (2026-10-01) failed revision twice on the account's session limit,
  // exhausted, and then deadlocked the whole repo: revision skipped forever, and
  // implement is gated on "no pending revision", so #412 could not build either.
  // Clearing `pr pending actions` for one pass now resets it, as the comment on
  // `rt.memory.revisionEscalated` always claimed.
  const pending = codeHost().findPendingRevisions(repoConfig, revLogger);
  if (!pending) {
    if (failures > 0) rt.memory.revisionFailureCount.set(repoName, 0);
    rt.memory.revisionEscalated.delete(repoName);
    rt.memory.revisionStoppedHead.delete(repoName);
    await forgetClosedPrStreaks(rt, repoConfig, revLogger);
    return null;
  }
  const prNumber = pending.pr.number;
  // Push target = the PR's own head, and only when it is Foreman-owned. A human-named head is never revised.
  const headBranch = pending.pr.headRefName;
  if (!headBranch || !isForemanOwnedHead(repoConfig, headBranch)) {
    revLogger.debug(`Skipping ${repoName} revision — PR #${prNumber} head "${headBranch}" is not Foreman-owned`);
    return null;
  }

  // The EM's `blocked` label on the PR's issue pauses revise (docs/em-coordination.md §1).
  if (pausedByBlockedLabel(rt, repoConfig, "revise", prNumber, pending.issueNumbers, revLogger)) return null;

  // The head the no-commit streak is keyed on. An unreadable head throws and fails the pass (EM#1244 f5).
  const head = pending.pr.headRefOid ?? codeHost().readPrHeadSha(repoConfig, prNumber, revLogger);

  // A stopped revision resumes when someone pushes to the PR out of band.
  // Read once, up front: a streak that cannot be read is not "no streak", and a paid session is not started on a guess.
  const read = await rt.streaks.read(repoConfig, prNumber);
  if (!read.ok) {
    revLogger.info(`Skipping ${repoName} revision — PR #${prNumber}'s no-commit record cannot be read from the work source`);
    return null;
  }
  let streak = read.streak;
  const stoppedAt = rt.memory.revisionStoppedHead.get(repoName) ?? stalemateHead(streak);
  if (stoppedAt !== undefined) {
    const kind: BlockKind = failures >= maxFailures ? "revision-exhausted" : "revision-stalemate";
    if (await releaseIfResolved(rt, kind, { prHeadMoved: head ? head !== stoppedAt : undefined }, pending.issueNumbers, repoConfig, revLogger)) {
      rt.memory.revisionStoppedHead.delete(repoName);
      rt.memory.revisionFailureCount.set(repoName, 0);
      rt.memory.revisionEscalated.delete(repoName);
      if (streak && await rt.streaks.clear(repoConfig, prNumber)) streak = undefined;
      failures = 0;
    }
  }

  // Check if this repo has exceeded revision failure retries
  if (failures >= maxFailures) {
    revLogger.debug(`Skipping ${repoName} revision — ${failures} consecutive failures`);
    return null;
  }

  // A no-commit stalemate already escalated: the card is Blocked and the EM must
  // rule. Re-running the reviser only re-answers the same review — it launched a
  // paid session on 17 straight cycles for slashbin-io-worker PR #694
  // (2026-10-03). Clears when the head moves or the PR closes (foreman#167).
  if (noCommitCount(streak, head) > MAX_CONSECUTIVE_NO_COMMIT) {
    revLogger.debug(`Skipping ${repoName} revision — PR #${prNumber} is in a no-commit stalemate awaiting the EM`);
    return null;
  }

  // A PR that is not converging waits for the EM's scope ruling instead of
  // being revised again. Rounds count from the last ruling posted on the PR
  // (a comment opening "**EM scope ruling"), so posting one resumes revision
  // on the next cycle. The Tech Lead can ask for a ruling sooner by marking
  // its review (TECH_LEAD_ESCALATE_MARKER). jerky_service PR #125 went 13
  // rounds (2026-10-13) because each fix answered the last finding and the
  // spec question underneath reached no one who owned the spec.
  const ruling = codeHost().readRulingState(repoConfig.githubRepo, pending.pr.number, repoConfig.repoPath, revLogger);
  if (ruling.roundsSinceRuling >= REVIEW_ROUNDS_ALERT || ruling.escalateRequested) {
    const roundsKey = `${repoConfig.githubRepo}#${pending.pr.number}@${ruling.latestReviewId ?? "none"}`;
    if (!rt.memory.reviewRoundsAlerted.has(roundsKey)) {
      rt.memory.reviewRoundsAlerted.add(roundsKey);
      const why = ruling.escalateRequested
        ? `the Tech Lead flagged a spec question on PR #${pending.pr.number}`
        : `PR #${pending.pr.number} has been sent back ${ruling.roundsSinceRuling} times${ruling.rulingAt ? " since the last ruling" : ""}`;
      const ask =
        `${why}. Revision is paused. EM: run /rule-on-scope ${repoConfig.githubRepo} ${pending.pr.number} ` +
        `(issues ${pending.issueNumbers.map((n) => `#${n}`).join(", ")}); a PR comment opening "**EM scope ruling" resumes it.`;
      revLogger.warn(`${why} — revision paused for an EM scope ruling`);
      events.push({ message: `⚠️ ${repoConfig.githubRepo} — ${ask}`, level: "warn" });
      for (const n of pending.issueNumbers) await emit(rt, { kind: "escalated", item: itemOf(repoConfig, n), reason: ask, stuck: "needs-ruling" }, repoConfig, revLogger);
    } else {
      revLogger.debug(`Skipping ${repoName} revision — PR #${pending.pr.number} awaits an EM scope ruling`);
    }
    return null;
  }

  // Admission. The branch sha is read FIRST: a read that fails throws here, before anything is written, so the pass
  // fails closed with nothing to take back (an outage that blocks reads also blocks the write that would undo a
  // save). Then an in-flight marker is saved for this head, and a marker that cannot be saved admits no session.
  // The marker is not a round; a round counts only when the session completed and a successful read after it shows
  // the head unchanged (below). A marker left by a pass that failed after this is of unknown outcome: neither
  // counted nor consumed, and the next admission replaces it, so at most one is ever outstanding per PR.
  const prior = streak;
  const beforeSha = codeHost().getRemoteBranchSha(repoConfig.githubRepo, headBranch, repoConfig.repoPath, revLogger);
  if (isUnconfirmed(prior, head)) {
    // An earlier attempt on this head has no confirming read, and this pass could read the branch: settle it
    // (neither counted nor consumed) and pay for nothing this pass. One unconfirmed attempt per head, then a free pass.
    if (!await rt.streaks.resolveUnconfirmed(repoConfig, prNumber, head, prior)) revLogger.warn(`Skipping ${repoName} revision — PR #${prNumber}'s unconfirmed attempt cannot be settled in the work source`);
    return null;
  }
  if (!await rt.streaks.admitRevision(repoConfig, prNumber, head, prior)) {
    revLogger.warn(`Skipping ${repoName} revision — PR #${prNumber}'s revision marker cannot be saved to the work source`);
    return null;
  }
  // Invoke the revision skill with specific PR and issue context
  if (!tryAcquire(runnerName())) return null;
  const runAbort = new AbortController();
  activeRuns.set(runAbort, repoName);
  rt.builds.started(repoName);
  revLogger.info(`Triggering PR revision for ${repoName} — PR #${pending.pr.number}, issues: ${pending.issueNumbers.map(n => `#${n}`).join(", ")}`);
  const session: Omit<SessionEvent, "status"> = {
    phase: "revise", repo: repoConfig.githubRepo, pr: pending.pr.number,
    items: pending.issueNumbers.map((n) => itemOf(repoConfig, n)),
  };
  let ended: { status: "finished" | "failed"; detail: string } = { status: "failed", detail: "the session ended without a result" };
  let report: SessionReport | undefined;

  try {
    // A read that fails (the branch sha after the session, the QA lines) throws out of here: the pass fails closed,
    // the marker saved at admission stays as it is (outcome unknown), and nothing is written to take back.
    await emit(rt, { kind: "session", session: { ...session, status: "started" } }, null, revLogger);
    // QA before the merge: its FAIL is a PR comment, not a review, so the session is handed its failing lines.
    const qaFeedback = qaBeforeMergeApplies(repoConfig, config) ? await latestQaFailLines(repoConfig, pending.pr.number, revLogger) : undefined;
    const result = await revisePRFeedback(
      rt.trust, repoConfig, revLogger, runAbort.signal,
      pending.pr.number, pending.issueNumbers, qaFeedback, beforeSha, headBranch,
    ).catch(reportLaunchThrew);
    reportRunResult(runnerName(), !!result.upstreamLimit, result.upstreamLimit?.reason, result.upstreamLimit?.resetAtMs);
    ended = result.success
      ? { status: "finished", detail: result.noCommit ? `no commit: ${result.noCommitReason ?? "branch already correct"}` : "changes pushed, back to review" }
      : { status: "failed", detail: result.upstreamLimit ? `upstream limit: ${result.upstreamLimit.reason}` : result.error || "unknown" };
    if (wantsSessionReports() && result.success) {
      const pr = prReport(repoConfig, pending.pr.number, revLogger);
      report = { ...(result.summary ? { text: result.summary } : {}), ...(pr ? { pr } : {}) };
    }

    if (result.success) {
      rt.memory.revisionFailureCount.set(repoName, 0);
      rt.memory.revisionEscalated.delete(repoName);

      if (result.noCommit) {
        // The session completed and the read after it showed the head unchanged: the round counts now. A count that
        // cannot be saved leaves the marker and the issue where they are (unconfirmed), to be answered on a later pass.
        const seen = await rt.streaks.record(repoConfig, prNumber, head, prior);
        if (seen === null) {
          revLogger.warn(`PR #${pending.pr.number}'s no-commit round could not be saved to the work source — not advancing it; the next pass answers it`);
          return null;
        }

        // Second one on this head: the reviewer (or QA) keeps asking and the reviser
        // keeps answering "already correct". Neither is going to move. Stop, and say
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
          // The streak records the head it stopped on; a push to the PR resumes it.
          const why = `reviewer and reviser disagree on PR #${pending.pr.number} after ${seen} no-commit rounds — EM to rule, or push to the PR and the Foreman resumes. Last reason: ${result.noCommitReason ?? "not given"}`;
          for (const n of pending.issueNumbers) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why, stuck: "revision-stalemate" }, repoConfig, revLogger);
          return null;
        }

        revLogger.info(
          `PR #${pending.pr.number} revision made no commit by declaration — returning it to review: ${result.noCommitReason}`,
        );
      } else {
        // It committed: the marker admitted above was not a no-commit round.
        await rt.streaks.clear(repoConfig, prNumber);
      }

      // Transition issue labels: `prPendingActions` → `prUnderReview`
      // The orchestrator owns this because the skill runs in the service repo
      // and may not have the right context to find the issue labels.
      for (const n of pending.issueNumbers) {
        await advance(rt, itemOf(repoConfig, n), "revised", repoConfig, revLogger);
      }

      revLogger.info("PR revision succeeded");
      return pending;
    } else {
      // The session did not answer: the marker admitted above stays, and is not a round.
      // An upstream limit refused the run — not a defect, so it charges no retry.
      // The card still goes to Blocked: the work has stopped, and the board says why.
      if (result.upstreamLimit || isUpstreamBlocked("github")) {
        const why = stoppedReason(`Revision of PR #${pending.pr.number}`, result, isUpstreamBlocked("github"));
        for (const n of pending.issueNumbers) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, revLogger);
        return null;
      }
      const newCount = failures + 1;
      rt.memory.revisionFailureCount.set(repoName, newCount);
      revLogger.warn(`PR revision failed (${newCount}/${maxFailures}): ${result.error}`);
      if (newCount < maxFailures) {
        const why = stoppedReason(`Revision of PR #${pending.pr.number}`, result, false, `${newCount}/${maxFailures}`);
        for (const n of pending.issueNumbers) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, revLogger);
      }

      // Retries exhausted. This is the end of the automated road for this PR: every
      // later cycle takes the skip branch above and does nothing. Say so out loud,
      // once, with the PR and the reason — a stuck PR that nobody is told about is
      // only discovered by someone thinking to look.
      if (newCount >= maxFailures && !rt.memory.revisionEscalated.has(repoName)) {
        rt.memory.revisionEscalated.add(repoName);
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
        if (pending.pr.headRefOid) rt.memory.revisionStoppedHead.set(repoName, pending.pr.headRefOid);
        const blocked = `Revision retries exhausted on PR #${pending.pr.number}: ${result.error ?? "unknown"} — push to the PR and the Foreman resumes`;
        for (const n of pending.issueNumbers) {
          await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: blocked, stuck: "revision-exhausted" }, repoConfig, revLogger);
        }
      }
    }

    return null;
  } finally {
    activeRuns.delete(runAbort);
    rt.builds.ended(repoName);
    await emit(rt, { kind: "session", session: { ...session, ...ended, ...(report ? { report } : {}) } }, null, revLogger);
  }
}

/** A closed or merged PR's no-commit streak is over: forget every one whose PR is no longer open. */
async function forgetClosedPrStreaks(rt: ForemanRuntime, repoConfig: RepoConfig, logger: Logger): Promise<void> {
  for (const pr of rt.streaks.prsWithStreak(repoConfig)) {
    const open = codeHost().isPrOpen(repoConfig.githubRepo, pr, repoConfig.repoPath);
    if (open === false) await rt.streaks.clear(repoConfig, pr);
    else if (open === null) logger.debug(`PR #${pr}: no-commit streak kept, GitHub could not say whether it is open`);
  }
}
