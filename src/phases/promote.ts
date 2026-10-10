// Promotion: branch-drift sync PRs, dependency batches, and the release PR.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { emit } from "../work-source.js";
import { trackRelease } from "../release-tracker.js";
import {
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
  stripReadyForProdLabel,
} from "../github.js";
import { loadRepoState, saveRepoState } from "../state.js";
import { STALL_CHECK_CYCLE_INTERVAL, itemOf, lastStallCheckCycle, notifyOnce } from "./common.js";

export function trySyncDrift(
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
    if (tryMergeSyncPR(repoConfig.githubRepo, existing.number, repoConfig.repoPath, syncLogger, repoConfig.productionBranch)) {
      syncLogger.info(`Sync PR merged on retry — #${existing.number}: ${existing.url}`);
      return true;
    }
    syncLogger.info(`Sync PR open, not yet mergeable — #${existing.number}: ${existing.url}`);
    return false;
  }

  syncLogger.info(`${repoConfig.baseBranch} is ${drift.developBehindMain} commit(s) behind ${repoConfig.productionBranch} — creating sync PR`);
  const syncUrl = createSyncPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, drift.developBehindMain, repoConfig.repoPath, syncLogger, repoConfig.github);
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
export function tryFileDependencyBatchIssue(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number,
): number | null {
  const depLogger = logger.child({ cycle: cycleNumber, repo: repoConfig.name, phase: "dependencies" });
  const bases = dependencyBatchBases(repoConfig.featureBranch, repoConfig.baseBranch, repoConfig.productionBranch);
  if (bases.length === 0) return null;
  const featureBranch = repoConfig.featureBranch || bases[0];

  const prs = findDependencyPRs(repoConfig.githubRepo, repoConfig.repoPath, bases, depLogger, repoConfig.github);
  if (prs.length === 0) return null;

  const existing = findOpenDependencyBatchIssue(repoConfig.githubRepo, repoConfig.repoPath, depLogger, repoConfig.github);
  if (existing) {
    depLogger.debug(
      `${prs.length} dependency PR(s) on ${bases.join("/")}; batch issue #${existing.number} is already open`,
    );
    return null;
  }

  const changes = prs.map((p) => describeDependencyPR(p.number, p.title));
  const { title, body } = buildDependencyBatchIssue(featureBranch, changes, repoConfig.github, repoConfig.baseBranch);
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

export async function tryPromotion(
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
    emit: async (release) => { await emit({ kind: "release", release }, null, promoLogger); },
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
        await emit({
          kind: "promotionStall",
          repo: repoConfig.githubRepo,
          detail: `${repoConfig.baseBranch} carries ${drift.developAheadFiles} changed file(s) not on ${repoConfig.productionBranch}; ` +
            `no issue carries "${repoConfig.lifecycleLabels.readyForProd}"`,
        }, null, promoLogger);
      } else if (drift) {
        await emit({ kind: "promotionStall", repo: repoConfig.githubRepo, detail: null }, null, promoLogger);
      }
    }
    return null;
  }

  // Issues are ready, so promotion is moving, not stalled.
  await emit({ kind: "promotionStall", repo: repoConfig.githubRepo, detail: null }, null, promoLogger);
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
        repoConfig.githubRepo, existingPR.number, issues, repoConfig.repoPath, repoConfig.github,
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
    await notifyOnce("promoted", repoConfig, issues.map((i) => i.number), promoLogger);
    await emit({ kind: "release", release: {
      repo: repoConfig.githubRepo,
      state: "merged",
      issues: issues.map((i) => itemOf(repoConfig, i.number)),
      productionBranch: repoConfig.productionBranch,
    } }, null, promoLogger);
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
    repoConfig.github,
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
    await notifyOnce("promoted", repoConfig, issues.map((i) => i.number), promoLogger);
    return "promoted";
  } else {
    promoLogger.warn("Failed to create promotion PR");
    return null;
  }
}

