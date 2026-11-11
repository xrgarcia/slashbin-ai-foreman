// The review phase: hand an open PR to the Tech Lead, apply its outcome.

import type { ReviewFallback } from "../plugins/contract.js";
import { resolve } from "node:path";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionEvent, SessionReport } from "../adapters.js";
import { emit, advance, wantsSessionReports, workSourceFor } from "../work-source.js";
import type { ReviewTrailer } from "../session/protocol.js";
import { roleFor } from "../plugins/registry.js";
import { REVIEW_MILESTONES, ReviewProgressRelay } from "../review-progress.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import { BackoffTracker, formatWait } from "../backoff.js";
import { prepareReviewCheckout, releaseReviewCheckout } from "../review-checkout.js";
import { CycleEvent, activeRuns, itemOf, notifyOnce, pausedByBlockedLabel, reportReviewOutcomes, reviewReport, stoppedReason } from "./common.js";
import { reconcileReviewOutcomeLabels } from "./reconcile.js";
import { tryQaBeforeMerge } from "./qa-before-merge.js";
import { qaBeforeMergeApplies } from "../qa-report.js";
import { MAX_REVIEW_ATTEMPTS_PER_HEAD } from "../step-attempts.js";
import { rulingAnswersStalemate } from "../no-commit-streak.js";
import { codeHost } from "../plugins/registry.js";
import type { ForemanRuntime } from "../runtime.js";

export async function tryReview(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[],
): Promise<boolean> {
  // QA before the merge (config.qaBeforeMerge): the Tech Lead approves without merging, QA runs on the
  // approved head, and only a PASS merges. An approved PR waiting on QA is QA's, never offered to the
  // Tech Lead again; and the QA that follows an approval runs in the same pass.
  const qaPre = repoConfig.reviewEnabled ? await qaBeforeMergeApplies(repoConfig, config) : false;
  if (qaPre === "unknown") {
    // QA could not say whether it covers this repo (its registry is unavailable): reviewing could merge a PR
    // QA must check first, so nothing is reviewed or merged until it answers. Nothing is charged.
    logger.warn(`Review of ${repoConfig.name} waits: QA could not say whether it covers the repo (coverage unknown)`);
    return false;
  }
  const qaFirst = qaPre && repoConfig.reviewEnabled && !rt.memory.reviewDefer.waiting(repoConfig.name);
  if (qaFirst) {
    const waiting = await tryQaBeforeMerge(rt, repoConfig, config, logger, cycleNumber, events);
    if (waiting === "handled") return true;
    if (waiting === "waiting") return false;
  }
  const reviewed = await reviewPass(rt, repoConfig, config, logger, cycleNumber, events, qaFirst);
  if (reviewed && qaFirst) await tryQaBeforeMerge(rt, repoConfig, config, logger, cycleNumber, events);
  return reviewed;
}

async function reviewPass(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events: CycleEvent[] | undefined,
  noMerge: boolean,
): Promise<boolean> {
  if (!repoConfig.reviewEnabled) return false;

  const repoName = repoConfig.name;
  const reviewLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "review" });

  // The reviewer is a plugin (EM#1150): the Tech Lead, on Codex (Ray, 2026-10-10).
  // With none enabled the PR is left for a person to review and merge; once it
  // merges, reconcile advances its issue (settleHumanMerge). When the reviewer
  // could not take a PR the repo waits (backoff.agentUnavailable).
  const agent = roleFor("reviewer", config);
  if (!agent) {
    const open = await codeHost().findPRsNeedingReview(repoConfig, repoConfig.reviewerLogin, reviewLogger);
    const key = open ? `${repoName}#${open.prNumber}` : "";
    if (open && !rt.memory.leftForHuman.has(key)) {
      rt.memory.leftForHuman.add(key);
      reviewLogger.info(`PR #${open.prNumber} left for a person to review and merge: no reviewer is enabled; its issue advances once it merges`);
    }
    return false;
  }
  if (rt.memory.reviewDefer.waiting(repoName)) return false;
  const { repoFailure, agentUnavailable, maxCiBounces } = config.backoff;

  // Failure pause (mirrors the implement phase): longer each time it trips.
  const failures = rt.memory.reviewFailureCount.get(repoName) ?? 0;
  if (failures >= repoFailure.maxFailures) {
    if (rt.memory.reviewFailurePause.waiting(repoName)) {
      reviewLogger.debug(`Skipping ${repoName} review — ${failures} consecutive failures, paused (pause ${rt.memory.reviewFailurePause.count(repoName)})`);
      return false;
    }
    reviewLogger.info(`Review failure pause over for ${repoName} — retrying`);
    rt.memory.reviewFailureCount.set(repoName, 0);
  }

  // Gate: is there an open feature PR awaiting EM review?
  const candidate = await codeHost().findPRsNeedingReview(repoConfig, repoConfig.reviewerLogin, reviewLogger);
  if (!candidate) {
    if (failures > 0) rt.memory.reviewFailureCount.set(repoName, 0);
    return false;
  }
  // The EM's `blocked` label on the PR's issue pauses review (docs/em-coordination.md §1).
  if (await pausedByBlockedLabel(rt, repoConfig, "review", candidate.prNumber, candidate.issueNumbers, reviewLogger)) return false;
  // Stranded behind a verdict: the review already ran and asked for changes;
  // only its label move is missing. Make it, so the revise phase picks them up.
  if (candidate.stranded) {
    for (const n of candidate.issueNumbers) {
      await advance(rt, itemOf(repoConfig, n), "changesRequested", repoConfig, reviewLogger);
    }
    events?.push({ message: `${repoConfig.githubRepo} — PR #${candidate.prNumber} had a current changes-requested review its labels never followed; sent #${candidate.issueNumbers.join(", #")} to revise.`, level: "warn" });
    return false;
  }
  // Orphan adoption: the implement report never landed for these. Report them
  // in review now, before anything else touches the PR.
  for (const n of candidate.adopted) {
    await advance(rt, itemOf(repoConfig, n), "implemented", repoConfig, reviewLogger);
  }

  // CI gate: never spend a review session on a PR its own CI already rejects.
  const checks = await codeHost().getPRCheckVerdict(repoConfig, candidate.prNumber, reviewLogger);
  if (checks.state === "pending") {
    reviewLogger.info(`PR #${candidate.prNumber} CI still running (${checks.pending.join(", ")}) — review waits for it`);
    return false;
  }
  if (checks.state === "failing") {
    const bounces = await codeHost().countCiBouncesSinceReview(repoConfig, candidate.prNumber, repoConfig.reviewerLogin, reviewLogger);
    if (bounces < maxCiBounces) {
      const names = checks.failing.map((f) => f.name).join(", ");
      await codeHost().bounceForRedCI(repoConfig, candidate.prNumber, checks);
      for (const n of candidate.issueNumbers) {
        await advance(rt, itemOf(repoConfig, n), "changesRequested", repoConfig, reviewLogger);
      }
      reviewLogger.info(`PR #${candidate.prNumber} CI red (${names}) — sent back to revise without a review (bounce ${bounces + 1}/${maxCiBounces})`);
      events?.push({ message: `${repoConfig.githubRepo} PR #${candidate.prNumber}: CI red (${names}) — sent back to the builder before review`, level: "info" });
      return true;
    }
    reviewLogger.warn(`PR #${candidate.prNumber} CI still red after ${bounces} bounce(s) — reviewing anyway so a reviewer sees it`);
  }

  // The candidate came from a snapshot that can be a refresh old; a PR merged or closed since is not
  // reviewed (foreman#180). Unknown (GitHub cannot say) waits a pass rather than spend a review.
  const prState = await codeHost().readPrState(repoConfig, candidate.prNumber, reviewLogger);
  // A read that fails throws and fails the pass (EM#1244 f5); it is never a state.
  if (prState !== "OPEN") {
    codeHost().forgetOpenPrs(repoConfig.githubRepo);
    reviewLogger.info(`PR #${candidate.prNumber} is already ${prState.toLowerCase()} — no review started; the snapshot is dropped`);
    return false;
  }

  // The input this review acts on is the PR's head. A read that fails throws and fails the pass (EM#1244 f5).
  const head = await codeHost().readPrHeadSha(repoConfig, candidate.prNumber, reviewLogger);

  // An empty diff is not reviewable: the Tech Lead refuses to review nothing, so every pass would pick the PR
  // up again and fail the same way, and revise (which reads an EM scope ruling) would never run (foreman#110).
  // Route it to revise instead, saying why on the PR once per head; revise's no-commit streak then bounds the
  // round trip and hands a stalemate to the EM, whose ruling resumes it.
  if (candidate.issueNumbers.length > 0) {
    const changed = await codeHost().prChangedFiles(repoConfig.githubRepo, candidate.prNumber, repoConfig.repoPath, reviewLogger);
    if (changed.length === 0) {
      const mark = `<!-- foreman-empty-diff sha=${head} -->`;
      if (!await codeHost().hasCommentContaining(repoConfig, candidate.prNumber, mark)) {
        await codeHost().commentOnPr(repoConfig, candidate.prNumber,
          `${mark}\nThis PR changes no files against \`${repoConfig.baseBranch}\` at \`${head.slice(0, 12)}\`, so there is nothing to review. ` +
          `Sent back to revise: read the newest \`**EM scope ruling\` on this PR and either land what it asks for, ` +
          `or say why nothing can land. A revision that leaves the diff empty pushes nothing and stops, and the EM rules.`);
      }
      for (const n of candidate.issueNumbers) await advance(rt, itemOf(repoConfig, n), "changesRequested", repoConfig, reviewLogger);
      reviewLogger.info(`PR #${candidate.prNumber} has an empty diff at ${head.slice(0, 12)} — sent to revise, no review spent`);
      events?.push({ message: `${repoConfig.githubRepo} PR #${candidate.prNumber}: empty diff — sent to revise instead of review`, level: "warn" });
      return true;
    }
  }

  // No step runs twice on the same input (src/step-attempts.ts): a review of this head is admitted a bounded number
  // of times, recorded before it starts. A PR that has used them all is held for the EM, never offered again;
  // a push (new head) or an EM scope ruling posted after the last attempt resumes it.
  const admission = await rt.attempts.admit(repoConfig, candidate.prNumber, "review", head, MAX_REVIEW_ATTEMPTS_PER_HEAD,
    async (since) => rulingAnswersStalemate((await codeHost().readRulingState(repoConfig.githubRepo, candidate.prNumber, repoConfig.repoPath, reviewLogger)).rulingAt, since));
  if (admission.status === "unavailable") {
    reviewLogger.info(`PR #${candidate.prNumber}: its review attempts cannot be recorded in the work source — no review this pass`);
    return false;
  }
  if (admission.status === "held") {
    if (admission.first) {
      const issues = candidate.issueNumbers.map((n) => `#${n}`).join(", ");
      const ask = `PR #${candidate.prNumber} was reviewed ${admission.count} times at the same head (${head.slice(0, 12)}) with no change in between. ` +
        `Review is held. EM: run /rule-on-scope ${repoConfig.githubRepo} ${candidate.prNumber}${issues ? ` (issues ${issues})` : ""}, or push to the PR; either resumes it.`;
      reviewLogger.warn(`${ask}`);
      events?.push({ message: `\u26a0\ufe0f ${repoConfig.githubRepo} \u2014 ${ask}`, level: "warn" });
      for (const n of candidate.issueNumbers) await emit(rt, { kind: "escalated", item: itemOf(repoConfig, n), reason: ask, stuck: "needs-ruling" }, repoConfig, reviewLogger);
    } else {
      reviewLogger.debug(`PR #${candidate.prNumber} review is held for the EM: ${admission.count} attempts at head ${head.slice(0, 12)}`);
    }
    return false;
  }
  const refund = () => rt.attempts.refund(repoConfig, candidate.prNumber, "review", head);

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
  const checkoutPath = await prepareReviewCheckout(config, repoConfig, reviewLogger);

  const runAbort = new AbortController();
  activeRuns.set(runAbort, repoName);
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
  // The Tech Lead's milestones (reading, depth check, final check), relayed to
  // the cards as it reaches each stage — at most one comment per stage, since
  // Paperclip cannot edit one (review-progress.ts). Off the build path, never
  // fatal: emit queues for observers and swallows their errors.
  const progress = new ReviewProgressRelay((milestones) =>
    wantsSessionReports() ? emit(rt, { kind: "reviewProgress", repo: repoConfig.githubRepo, pr: candidate.prNumber, items: session.items, milestones }, null, reviewLogger) : undefined);
  const onProgress = (m: Parameters<ReviewProgressRelay["push"]>[0]) => {
    reviewLogger.info(`Tech Lead PR #${candidate.prNumber}: ${REVIEW_MILESTONES[m.milestone]}${m.detail ? ` — ${m.detail}` : ""}`);
    progress.push(m);
  };

  try {
    await emit(rt, { kind: "session", session: { ...session, status: "started", reviewer } }, null, reviewLogger);
    // The reviewer's "wrote nothing" exit (its engine unavailable) is a wait,
    // never a hand-off: no failure is charged and the repo asks again after a backoff.agentUnavailable wait.
    const result = await agent.reviewPr(repoConfig, config, candidate.prNumber, reviewLogger, runAbort.signal, transcriptPath, onProgress, noMerge)
      .catch((e: unknown): ReviewFallback => ({ fallback: true, reason: `Tech Lead launch threw: ${String(e)}` }));
    if ("fallback" in result) {
      const wait = formatWait(rt.memory.reviewDefer.start(repoName, agentUnavailable));
      ended = { status: "failed", detail: `Tech Lead could not take it (${result.reason}) — retried in ${wait}` };
      reviewLogger.info(`PR #${candidate.prNumber}: Tech Lead could not take it (${result.reason}) — no review this pass, retry in ${wait}`);
      // An unavailable work source is a silent tooling defer: the card is not moved to Blocked, so a blip
      // that clears on the next pass leaves no stale hold behind (foreman#180).
      // Neither it nor the wait below reviewed anything: the attempt is given back.
      await refund();
      if (result.unavailable) return false;
      // A wait is a Blocked card that says what clears it; the next review session moves it on.
      const why = `waiting on the Tech Lead: it could not take PR #${candidate.prNumber} (${result.reason}) — the review retries automatically in ${wait}`;
      for (const n of candidate.issueNumbers) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why, at: "inReview" }, repoConfig, reviewLogger);
      return false;
    }
    rt.memory.reviewDefer.clear(repoName);
    if (wantsSessionReports()) {
      report = await reviewReport(repoConfig, candidate.prNumber, result.trailers ?? [], result.summary, reviewSince, reviewLogger);
    }

    if (result.success) {
      rt.memory.reviewFailureCount.set(repoName, 0);
      rt.memory.reviewFailurePause.clear(repoName);
      reviewLogger.info(`Review run completed for ${repoName}`);

      await settleReviewOutcome(rt, repoConfig, config, candidate.issueNumbers, candidate.prNumber, result.trailers ?? [], reviewLogger, events);

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
    const mergedRefs = await codeHost().findIssuesMergedToBase(repoConfig, candidate.issueNumbers, reviewLogger);
    const plan = codeHost().planFailedReviewOutcome(
      mergedRefs,
      await codeHost().findIssuesStillUnderReview(repoConfig, candidate.issueNumbers, reviewLogger),
    );

    ended = { status: "failed", detail: result.upstreamLimit ? `upstream limit: ${result.upstreamLimit.reason}` : result.error || "unknown" };
    if (plan.workLanded) {
      ended = { status: "finished", detail: `merged PR #${plan.mergedPrs.join(", #")}, then the run ended: ${result.error}` };
      await notifyOnce(rt, "merged", repoConfig, [...new Set(mergedRefs.map((m) => m.issueNumber))], reviewLogger);
      await reportReviewOutcomes(rt, repoConfig, candidate.issueNumbers, reviewLogger);
      reviewLogger.warn(
        `Review run on ${repoName} ended with "${result.error}" AFTER merging PR #${plan.mergedPrs.join(", #")} — ` +
        `the work landed and the run outlived it. Reconciling labels now rather than leaving the dead zone.`,
        { mergedPrs: plan.mergedPrs, toReconcile: plan.toReconcile },
      );

      const unresolved = plan.toReconcile.length > 0 && config.reviewLabelReconcile
        ? await reconcileReviewOutcomeLabels(rt, repoConfig, plan.toReconcile, result.trailers ?? [], reviewLogger, events, roleFor("verifier", config) !== undefined)
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
      rt.memory.reviewFailureCount.set(repoName, 0);
      rt.memory.reviewFailurePause.clear(repoName);
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
      await refund(); // a limit refused the run: nothing was reviewed
      const why = stoppedReason(`Review of PR #${candidate.prNumber}`, result, isUpstreamBlocked("github"));
      for (const n of candidate.issueNumbers) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why, at: "inReview" }, repoConfig, reviewLogger);
      return false;
    }
    const newCount = failures + 1;
    rt.memory.reviewFailureCount.set(repoName, newCount);
    if (newCount < repoFailure.maxFailures) {
      const why = stoppedReason(`Review of PR #${candidate.prNumber}`, result, false, `${newCount}/${repoFailure.maxFailures}`);
      for (const n of candidate.issueNumbers) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why, at: "inReview" }, repoConfig, reviewLogger);
    } else {
      const pause = rt.memory.reviewFailurePause.start(repoName, repoFailure);
      const why = `review of PR #${candidate.prNumber} failed ${newCount}× — paused ${formatWait(pause)}: ${result.error}`;
      for (const n of candidate.issueNumbers) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why, at: "inReview" }, repoConfig, reviewLogger);
    }
    reviewLogger.warn(`Review failed (${newCount}/${repoFailure.maxFailures}) on PR #${candidate.prNumber}, not merged: ${result.error}`);
    events?.push({ message: `Review failed on ${repoConfig.githubRepo} PR #${candidate.prNumber}: ${result.error}`, level: "error" });
    return false;
  } finally {
    activeRuns.delete(runAbort);
    // The end comment carries the whole checklist, so a stage post still
    // settling is dropped rather than sent after it.
    progress.close();
    const milestones = progress.milestones;
    if (milestones.length > 0) report = { ...(report ?? {}), milestones };
    await emit(rt, { kind: "session", session: { ...session, ...ended, reviewer, ...(report ? { report } : {}) } }, null, reviewLogger);

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
        const stillApproved = (await workSourceFor(repoConfig).selectEligible?.(repoConfig, reviewLogger) ?? []).length;
        const stillToReview = await codeHost().findPRsNeedingReview(repoConfig, repoConfig.reviewerLogin, reviewLogger) ? 1 : 0;
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
    const revoked = await codeHost().findRevokedEmGates(
      repoConfig, candidate.issueNumbers, reviewStartedAt, reviewLogger,
    );
    const promotionOwnsIt = revoked.length > 0 &&
      !!await codeHost().findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, reviewLogger);
    if (promotionOwnsIt) {
      reviewLogger.info(
        `"${repoConfig.lifecycleLabels.readyForProd}" left removed on #${revoked.join(", #")} — an open promotion PR owns it now.`,
      );
    }
    const restored = promotionOwnsIt ? [] : await codeHost().restoreEmGate(repoConfig, revoked, reviewLogger);
    if (restored.length > 0) {
      events?.push({
        message: `⚠️ ${repoConfig.githubRepo} — the review run removed "${repoConfig.lifecycleLabels.readyForProd}" from issue(s) ${restored.map((n) => `#${n}`).join(", ")}; restored. Promotion would otherwise have stalled silently.`,
        level: "warn",
      });
    }
  }
}

/**
 * What the review phase does with a run's trailers once the Tech Lead has finished: move the cards the
 * labels say moved, tell observers of a merge, and settle any issue a merging run left at `pr under
 * review`. Shared by the review run and by the merge QA's PASS hands the Tech Lead (qa-before-merge.ts).
 */
export async function settleReviewOutcome(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  issueNumbers: number[],
  prNumber: number,
  trailers: ReviewTrailer[],
  logger: Logger,
  events?: CycleEvent[],
): Promise<void> {
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
  await reportReviewOutcomes(rt, repoConfig, issueNumbers, logger);
  const mergedPrs = trailers.filter((t) => t.merged).map((t) => t.pr);
  if (mergedPrs.includes(prNumber)) {
    await notifyOnce(rt, "merged", repoConfig, issueNumbers, logger);
  }
  if (mergedPrs.length > 0) {
    const stuck = await codeHost().findIssuesStillUnderReview(repoConfig, issueNumbers, logger);
    if (stuck.length > 0) {
      logger.warn(
        `Review post-condition: PR(s) #${mergedPrs.join(", #")} reported merged, but issue(s) #${stuck.join(", #")} are still "${repoConfig.lifecycleLabels.prUnderReview}" — the run merged without completing the label transition`,
        { mergedPrs, stuckIssues: stuck },
      );

      // Set the label from the run's own trailer. The verdict is not missing
      // — it is right here, already parsed. Waiting a cycle to re-derive it
      // from a fresh deploy poll was spending minutes to recompute an answer
      // we were holding.
      const unresolved = config.reviewLabelReconcile
        ? await reconcileReviewOutcomeLabels(rt, repoConfig, stuck, trailers, logger, events, roleFor("verifier", config) !== undefined)
        : stuck;

      if (!config.reviewLabelReconcile && stuck.length > 0) {
        logger.info("Label reconciliation disabled (reviewLabelReconcile=false) — leaving the dead zone for recovery");
      }

      if (unresolved.length > 0) {
        logger.error(
          `Review post-condition UNRESOLVED on ${repoConfig.name}: issue(s) #${unresolved.join(", #")} could not be reconciled from the run's trailers — dead-zone recovery will re-verify`,
          { mergedPrs, unresolved },
        );
        events?.push({
          message: `⚠️ ${repoConfig.githubRepo} — review merged PR #${mergedPrs.join(", #")} but left issue(s) #${unresolved.join(", #")} at "${repoConfig.lifecycleLabels.prUnderReview}" and the trailer could not settle it. Dead-zone recovery will re-verify next cycle.`,
          level: "warn",
        });
      }
    }
  }
}
