// The review phase: hand an open PR to the Tech Lead, apply its outcome.

import { resolve } from "node:path";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionEvent, SessionReport } from "../adapters.js";
import { emit, advance, hasObservers } from "../work-source.js";
import { GitHubIssueConnector } from "../github-work-source.js";
import {
  findPRsNeedingReview,
  getPRCheckVerdict,
  countCiBouncesSinceReview,
  bounceForRedCI,
  findOpenPromotionPR,
} from "../github.js";
import { reviewViaTechLead } from "../agent.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import { BackoffTracker, formatWait } from "../backoff.js";
import {
  findIssuesMergedToBase,
  planFailedReviewOutcome,
  findIssuesStillUnderReview,
  findRevokedEmGates,
  restoreEmGate,
} from "../github.js";
import { prepareReviewCheckout, releaseReviewCheckout } from "../review-checkout.js";
import {
  CycleEvent,
  activeRuns,
  itemOf,
  notifyOnce,
  reportReviewOutcomes,
  reviewFailureCount,
  reviewFailurePause,
  reviewReport,
  stoppedReason,
} from "./common.js";
import { reconcileReviewOutcomeLabels } from "./reconcile.js";

/** Per repo: the review waiting after the Tech Lead could not take a PR (backoff.agentUnavailable). */
export const reviewDefer = new BackoffTracker();

export async function tryReview(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[],
): Promise<boolean> {
  if (!repoConfig.reviewEnabled) return false;

  const repoName = repoConfig.name;
  const reviewLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "review" });

  // The Tech Lead is the only reviewer, on Codex (Ray, 2026-10-10). There is no
  // Claude review and no EM-account review: without a Tech Lead nothing reviews,
  // and when it could not take a PR the repo waits (backoff.agentUnavailable).
  if (!config.techLeadPath) {
    reviewLogger.warn("review skipped: techLeadPath is not configured, and the Tech Lead is the only reviewer");
    return false;
  }
  if (reviewDefer.waiting(repoName)) return false;
  const { repoFailure, agentUnavailable, maxCiBounces } = config.backoff;

  // Failure pause (mirrors the implement phase): longer each time it trips.
  const failures = reviewFailureCount.get(repoName) ?? 0;
  if (failures >= repoFailure.maxFailures) {
    if (reviewFailurePause.waiting(repoName)) {
      reviewLogger.debug(`Skipping ${repoName} review — ${failures} consecutive failures, paused (pause ${reviewFailurePause.count(repoName)})`);
      return false;
    }
    reviewLogger.info(`Review failure pause over for ${repoName} — retrying`);
    reviewFailureCount.set(repoName, 0);
  }

  // Gate: is there an open feature PR awaiting EM review?
  const candidate = findPRsNeedingReview(repoConfig, repoConfig.reviewerLogin, reviewLogger);
  if (!candidate) {
    if (failures > 0) reviewFailureCount.set(repoName, 0);
    return false;
  }
  // Stranded behind a verdict: the review already ran and asked for changes;
  // only its label move is missing. Make it, so the revise phase picks them up.
  if (candidate.stranded) {
    for (const n of candidate.issueNumbers) {
      await advance(itemOf(repoConfig, n), "changesRequested", repoConfig, reviewLogger);
    }
    events?.push({ message: `${repoConfig.githubRepo} — PR #${candidate.prNumber} had a current changes-requested review its labels never followed; sent #${candidate.issueNumbers.join(", #")} to revise.`, level: "warn" });
    return false;
  }
  // Orphan adoption: the implement report never landed for these. Report them
  // in review now, before anything else touches the PR.
  for (const n of candidate.adopted) {
    await advance(itemOf(repoConfig, n), "implemented", repoConfig, reviewLogger);
  }

  // CI gate: never spend a review session on a PR its own CI already rejects.
  const checks = getPRCheckVerdict(repoConfig, candidate.prNumber, reviewLogger);
  if (checks.state === "pending") {
    reviewLogger.info(`PR #${candidate.prNumber} CI still running (${checks.pending.join(", ")}) — review waits for it`);
    return false;
  }
  if (checks.state === "failing") {
    const bounces = countCiBouncesSinceReview(repoConfig, candidate.prNumber, repoConfig.reviewerLogin, reviewLogger);
    if (bounces < maxCiBounces) {
      const names = checks.failing.map((f) => f.name).join(", ");
      bounceForRedCI(repoConfig, candidate.prNumber, checks);
      for (const n of candidate.issueNumbers) {
        await advance(itemOf(repoConfig, n), "changesRequested", repoConfig, reviewLogger);
      }
      reviewLogger.info(`PR #${candidate.prNumber} CI red (${names}) — sent back to revise without a review (bounce ${bounces + 1}/${maxCiBounces})`);
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
  let report: SessionReport | undefined;
  const reviewSince = new Date();
  const reviewer = "Tech Lead";

  try {
    await emit({ kind: "session", session: { ...session, status: "started", reviewer } }, null, reviewLogger);
    // EM#427: the Tech Lead is the reviewer, on Codex only. Its "wrote nothing"
    // exit (Codex unavailable) is a wait, never a hand-off (Ray, 2026-10-10): no
    // failure is charged and the repo asks again after a backoff.agentUnavailable wait.
    const result = await reviewViaTechLead(repoConfig, config, candidate.prNumber, reviewLogger, runAbort.signal, transcriptPath)
      .catch((e: unknown): { fallback: true; reason: string } => ({ fallback: true, reason: `Tech Lead launch threw: ${String(e)}` }));
    if ("fallback" in result) {
      const wait = formatWait(reviewDefer.start(repoName, agentUnavailable));
      ended = { status: "failed", detail: `Tech Lead could not take it (${result.reason}) — retried in ${wait}` };
      reviewLogger.info(`PR #${candidate.prNumber}: Tech Lead could not take it (${result.reason}) — no review this pass, retry in ${wait}`);
      return false;
    }
    reviewDefer.clear(repoName);
    if (hasObservers()) {
      report = reviewReport(repoConfig, candidate.prNumber, result.trailers ?? [], result.summary, reviewSince, reviewLogger);
    }

    if (result.success) {
      reviewFailureCount.set(repoName, 0);
      reviewFailurePause.clear(repoName);
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
        await notifyOnce("merged", repoConfig, candidate.issueNumbers, reviewLogger);
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
            ? await reconcileReviewOutcomeLabels(repoConfig, stuck, trailers, reviewLogger, events, Boolean(config.srePath))
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
      await notifyOnce("merged", repoConfig, [...new Set(mergedRefs.map((m) => m.issueNumber))], reviewLogger);
      await reportReviewOutcomes(repoConfig, candidate.issueNumbers, reviewLogger);
      reviewLogger.warn(
        `Review run on ${repoName} ended with "${result.error}" AFTER merging PR #${plan.mergedPrs.join(", #")} — ` +
        `the work landed and the run outlived it. Reconciling labels now rather than leaving the dead zone.`,
        { mergedPrs: plan.mergedPrs, toReconcile: plan.toReconcile },
      );

      const unresolved = plan.toReconcile.length > 0 && config.reviewLabelReconcile
        ? await reconcileReviewOutcomeLabels(repoConfig, plan.toReconcile, result.trailers ?? [], reviewLogger, events, Boolean(config.srePath))
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
      reviewFailurePause.clear(repoName);
      events?.push({
        message: `⚠️ ${repoConfig.githubRepo} — review of PR #${plan.mergedPrs.join(", #")} merged, then ran past its budget (${result.error}). Labels reconciled; not counted as a failed review.`,
        level: "warn",
      });
      return true;
    }

    // An upstream limit refused the run — not a defect, so it charges no retry.
    // After the reconciliation above, so a review that merged and then hit the
    // limit still settles its labels. The card still goes to Blocked.
    if (result.upstreamLimit || isUpstreamBlocked("github")) {
      const why = stoppedReason(`Review of PR #${candidate.prNumber}`, result, isUpstreamBlocked("github"));
      for (const n of candidate.issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, reviewLogger);
      return false;
    }
    const newCount = failures + 1;
    reviewFailureCount.set(repoName, newCount);
    if (newCount < repoFailure.maxFailures) {
      const why = stoppedReason(`Review of PR #${candidate.prNumber}`, result, false, `${newCount}/${repoFailure.maxFailures}`);
      for (const n of candidate.issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, reviewLogger);
    } else {
      const pause = reviewFailurePause.start(repoName, repoFailure);
      const why = `review of PR #${candidate.prNumber} failed ${newCount}× — paused ${formatWait(pause)}: ${result.error}`;
      for (const n of candidate.issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, reviewLogger);
    }
    reviewLogger.warn(`Review failed (${newCount}/${repoFailure.maxFailures}) on PR #${candidate.prNumber}, not merged: ${result.error}`);
    events?.push({ message: `Review failed on ${repoConfig.githubRepo} PR #${candidate.prNumber}: ${result.error}`, level: "error" });
    return false;
  } finally {
    activeRuns.delete(repoName);
    await emit({ kind: "session", session: { ...session, ...ended, reviewer, ...(report ? { report } : {}) } }, null, reviewLogger);

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

