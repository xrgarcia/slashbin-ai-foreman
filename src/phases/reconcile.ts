// The reconcile phase: orphaned commits, rejected branches, the dead zones,
// and label reconciliation from review trailers.

import { spawnSync } from "node:child_process";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { emit, advance } from "../work-source.js";
import { reviewMove } from "../lifecycle.js";
import { reconcileRepo } from "../reconciler.js";
import { findStuckMergedIssues, findIssuesMergedToBase, findOrphanedLifecycleIssues } from "../github.js";
import type { ReviewTrailer } from "../agent.js";
import { loadRepoState, saveRepoState } from "../state.js";
import {
  CycleEvent,
  RECOVERY_VERIFY_TIMEOUT_MS,
  deadZoneAlerted,
  deadZoneRecoveryAttempted,
  itemOf,
  labelFromTrailer,
  notifyOnce,
  workStateOf,
} from "./common.js";

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
export function recoverDeadZonedIssue(
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
export async function reconcileReviewOutcomeLabels(
  repoConfig: RepoConfig,
  stuck: number[],
  trailers: ReviewTrailer[],
  logger: Logger,
  events?: CycleEvent[],
  verifyStage = false,
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
    const outcome = labelFromTrailer(trailer, verifyStage);
    if (!outcome) {
      logger.warn(
        `Not reconciling #${issueNumber}: PR #${ref.prNumber}'s trailer is ambiguous (verdict=${trailer.verdict} merged=${trailer.merged} deploy=${trailer.deploy}) — leaving it for a human`,
      );
      unresolved.push(issueNumber);
      continue;
    }
    const to = workStateOf(outcome);
    if (await advance(itemOf(repoConfig, issueNumber), reviewMove(to), repoConfig, logger)) {
      events?.push({
        message: `${repoConfig.githubRepo} #${issueNumber} — review merged PR #${ref.prNumber} without labeling; reconciled to "${repoConfig.lifecycleLabels[outcome]}" from its own trailer`,
        level: outcome === "prPendingActions" ? "warn" : "info",
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

/**
 * The reconcile stage: orphaned commits, rejected branches, and the three dead
 * zones. Returns how many items it processed. Never throws — each half catches
 * its own failure, as it did when this was inline Phase 0.
 */
export async function runReconcileStage(
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
        if (result.prUrl) await emit({ kind: "prLink", item, prUrl: result.prUrl }, repoConfig, reconLogger);
        await advance(item, "implemented", repoConfig, reconLogger);
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
      await notifyOnce("merged", repoConfig, [s.issueNumber], reconLogger);
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
      // With a verify stage, a deploy-only re-check must never write `pr approved`
      // (EM#441: four issues were approved on 2026-10-01 with no acceptance
      // evidence). Hand the issue to the verify stage instead; it runs the full
      // dev verification and owns the move to `pr approved`.
      if (config.srePath && !tried.has(s.issueNumber)) {
        tried.add(s.issueNumber);
        if (await advance(itemOf(repoConfig, s.issueNumber), "recoverMerged", repoConfig, reconLogger)) {
          events.push({
            message: `${repoConfig.githubRepo} #${s.issueNumber} dead-zone: PR #${s.prNumber} merged with the issue left unadvanced → labeled "${labels.prMerged}" for dev verification`,
            level: "info",
          });
          seen.delete(s.issueNumber);
          current.delete(s.issueNumber);
          processed++;
          continue;
        }
      }
      if (!tried.has(s.issueNumber)) {
        tried.add(s.issueNumber);
        const verdict = recoverDeadZonedIssue(
          repoConfig,
          config,
          s.issueNumber,
          s.prNumber,
          reconLogger,
        );
        if (verdict !== "indeterminate" && await advance(
          itemOf(repoConfig, s.issueNumber), verdict === "pass" ? "recoverPassed" : "recoverFailed",
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
      if (await advance(itemOf(repoConfig, num), "release", repoConfig, reconLogger)) {
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

