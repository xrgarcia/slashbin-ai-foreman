// The feature PR: does it exist, which issues it references, and a failed review's plan.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { isGitHubStateEnabled } from "../github-state.js";
import { findOpenPrs, formatGhError, ghKeyed, issueCacheTtlMs, knownOpenPr, openPrVersion } from "./cache.js";
import { extractImplementedIssues, type PrCommit } from "./discovery.js";


// --- PR Verification ---

export function verifyPRExists(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): boolean {
  try {
    const prs = findOpenPrs(repo, cwd, { head: headBranch, base: baseBranch, limit: 1 });
    return prs.length > 0;
  } catch (err) {
    logger?.warn("verifyPRExists: gh pr list failed", { ...formatGhError(err), repo, headBranch, baseBranch });
    return false;
  }
}

/**
 * Read the open feature PR's body + title + commit messages and extract every
 * issue number referenced via standard GitHub keywords ("Related to #N",
 * "Closes #N", "Fixes #N", "Resolves #N", "Refs #N", "See #N"). Used by the
 * orchestrator to know which subset of `actionableIssues` the implementation
 * skill actually addressed — under the canonical one-issue-per-invocation
 * skill (jerky_data_receiver#43 and friends), the skill picks one issue from a
 * batch but the orchestrator must NOT label the unpicked issues as
 * `pr under review`, or they get stuck waiting forever for revision activity.
 *
 * Returns the parsed issue numbers (deduped). On lookup or parse failure
 * returns null so callers can fall back to existing behavior rather than
 * silently dropping issues from the label transition.
 */
export function getReferencedIssuesFromOpenPR(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): number[] | null {
  try {
    // A new commit moves the head and an edited title/body bumps updatedAt, so
    // the PR's version from the fleet state is a safe key for what it implements.
    const json = ghKeyed(`refs:${repo}:${headBranch}:${baseBranch}`, () => openPrVersion(repo, headBranch, baseBranch), [
      "pr", "list",
      "--repo", repo,
      "--head", headBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "number,title,body,commits",
      "--limit", "1",
    ], cwd);
    const prs = JSON.parse(json || "[]");
    if (prs.length === 0) return null;
    const pr = prs[0];

    // Count an issue as referenced only if the PR IMPLEMENTS it (close/relate
    // keyword anywhere, or `(#N)` in the title / a commit headline) — never a
    // bare `(#N)` mention in the free-text body. A schema PR whose body said
    // "the forthcoming handler (#2) will..." otherwise falsely marked #2
    // implemented, orphaning it. (slashbin-ai-foreman#28)
    const commits = (pr.commits || []) as PrCommit[];
    return extractImplementedIssues({
      title: pr.title || "",
      body: pr.body || "",
      commits,
    });
  } catch (err) {
    logger?.warn("getReferencedIssuesFromOpenPR: gh pr list failed", { ...formatGhError(err), repo, headBranch, baseBranch });
    return null;
  }
}


/**
 * The work in flight a custom stage runs against: the open feature → base PR,
 * its head, and the issues it implements (same reading as
 * getReferencedIssuesFromOpenPR). `null` when no such PR is open. Throws when
 * the lookup itself fails — a stage that gates must not read "could not look"
 * as "nothing to check".
 */
export function findOpenFeaturePR(
  config: RepoConfig,
): { number: number; headSha: string; issueNumbers: number[] } | null {
  // Fleet state on: no open feature PR in it means nothing to check — at most
  // one refresh late, which only defers a stage, never skips one for good.
  // A thrown refresh propagates: the caller holds the later stages on it.
  if (issueCacheTtlMs > 0 && isGitHubStateEnabled(config.githubRepo)
    && !knownOpenPr(config.githubRepo, config.featureBranch, config.baseBranch)) {
    return null;
  }
  const json = ghKeyed(`feature:${config.githubRepo}`, () => openPrVersion(config.githubRepo, config.featureBranch, config.baseBranch), [
    "pr", "list",
    "--repo", config.githubRepo,
    "--head", config.featureBranch,
    "--base", config.baseBranch,
    "--state", "open",
    "--json", "number,title,body,commits,headRefOid",
    "--limit", "1",
  ], config.repoPath);
  const prs = JSON.parse(json || "[]") as Array<{
    number: number; title?: string; body?: string; headRefOid?: string;
    commits?: PrCommit[];
  }>;
  if (prs.length === 0) return null;
  const pr = prs[0];
  const commits = pr.commits || [];
  return {
    number: pr.number,
    headSha: pr.headRefOid || "",
    issueNumbers: extractImplementedIssues({
      title: pr.title || "",
      body: pr.body || "",
      commits,
    }),
  };
}

/**
 * Decide, with no I/O, what a FAILED review run actually earned.
 *
 * Split out from `tryReview` for the same reason as `planEmGateRestore`: the
 * rule is the part worth pinning, and the `gh` calls around it are not.
 *
 * A review run that dies is not automatically a review that achieved nothing.
 * On 2026-09-22 one merged `jerky_skuvault_service#362`, verified it, then spent
 * its remaining 52 minutes polling a backfill that needed longer than the budget
 * it was never told about. The wall-clock kill reported `Review failed (1/2):
 * timed out`, skipped every post-condition check — they all lived inside the
 * success branch — and left the issue dead-zoned for 55 minutes. The merge had
 * already happened; the retry had nothing to retry. Issue #41.
 *
 * So the question is not "did the process exit cleanly" but "did the work land":
 *
 *  - Nothing merged → a plain failure. Charge the retry, exactly as before.
 *  - Something merged → the work landed and the run outlived it. Reconcile the
 *    labels this cycle instead of waiting for the dead-zone sweep, and do NOT
 *    charge a retry: the next cycle would find the PR merged and no work to do.
 *
 * `stillUnderReview` is asked for separately because a run can merge AND label
 * correctly before dying — in which case there is nothing left to reconcile and
 * only the retry accounting changes.
 */
export interface FailedReviewPlan {
  /** True when at least one of the run's issues reached the base branch. */
  workLanded: boolean;
  /** PRs the run merged, deduped, ascending. */
  mergedPrs: number[];
  /** Merged issues still sitting at `pr under review` — the labels to repair. */
  toReconcile: number[];
  /** Whether this run counts against the review retry/backoff counter. */
  chargeRetry: boolean;
}

export function planFailedReviewOutcome(
  mergedRefs: { issueNumber: number; prNumber: number }[],
  stillUnderReview: number[],
): FailedReviewPlan {
  if (mergedRefs.length === 0) {
    return { workLanded: false, mergedPrs: [], toReconcile: [], chargeRetry: true };
  }

  const mergedIssues = new Set(mergedRefs.map((m) => m.issueNumber));
  return {
    workLanded: true,
    mergedPrs: [...new Set(mergedRefs.map((m) => m.prNumber))].sort((a, b) => a - b),
    // Only issues we can actually tie to a merge. An issue still under review
    // whose PR never merged is CORRECTLY under review, and relabeling it would
    // be the same overreach the dead-zone guard exists to prevent.
    toReconcile: stillUnderReview.filter((n) => mergedIssues.has(n)),
    chargeRetry: false,
  };
}
