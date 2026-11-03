// The feature PR: does it exist, which issues it references, and a failed review's plan.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { fleetState } from "../github-state.js";
import { findOpenForemanPrs, findOpenPrs, formatGhError, ghKeyed, reads, knownOpenForemanPr, openPrVersion } from "./cache.js";
import { extractImplementedIssues, type PrCommit } from "./discovery.js";
import type { FailedReviewPlan } from "../code-host.js";
export type { FailedReviewPlan } from "../code-host.js";


// --- PR Verification ---

export function verifyPRExists(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): boolean {
  // A failed read throws (EM#1244 f5): "could not look" is never "there is no PR".
  return findOpenPrs(repo, cwd, { head: headBranch, base: baseBranch, limit: 1 }).length > 0;
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
 * Returns the parsed issue numbers (deduped), or null when there is no open
 * PR. A failed lookup throws (EM#1244 f5): it is never "no PR" and never a
 * licence to label the whole batch.
 */
export function getReferencedIssuesFromOpenPR(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): number[] | null {
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
}


/**
 * The work in flight a custom stage and the implement gate run against: the open
 * Foreman-owned PR into the base branch (a per-issue `<branchPrefix>N-slug` head, or the
 * legacy shared featureBranch), its head branch and sha, and the issues it implements (same
 * reading as getReferencedIssuesFromOpenPR). `null` when no such PR is open. With `prefer`,
 * a PR whose head is among those branches wins over another Foreman PR. Throws when the
 * lookup itself fails — a stage that gates must not read "could not look" as "nothing to
 * check". A human-named head is never returned (foreman-branch.ts).
 */
export function findOpenFeaturePR(
  config: RepoConfig,
  prefer?: readonly string[],
): { number: number; headSha: string; headBranch: string; issueNumbers: number[] } | null {
  // Fleet state on: no open Foreman PR in it means nothing to check — at most
  // one refresh late, which only defers a stage, never skips one for good.
  // A thrown refresh propagates: the caller holds the later stages on it.
  if (reads.ttlMs > 0 && fleetState.isEnabled(config.githubRepo) && !knownOpenForemanPr(config)) return null;
  const owned = findOpenForemanPrs(config);
  const mine = owned.find((p) => prefer?.includes(p.headRefName)) ?? owned[0];
  if (!mine) return null;
  const json = ghKeyed(`feature:${config.githubRepo}:${mine.headRefName}`, () => openPrVersion(config.githubRepo, mine.headRefName, config.baseBranch), [
    "pr", "view", String(mine.number),
    "--repo", config.githubRepo,
    "--json", "number,title,body,commits,headRefOid,headRefName",
  ], config.repoPath);
  const pr = JSON.parse(json || "{}") as {
    number?: number; title?: string; body?: string; headRefOid?: string; headRefName?: string;
    commits?: PrCommit[];
  };
  if (pr.number === undefined) return null;
  return {
    number: pr.number,
    headSha: pr.headRefOid || "",
    headBranch: pr.headRefName || mine.headRefName,
    issueNumbers: extractImplementedIssues({
      title: pr.title || "",
      body: pr.body || "",
      commits: pr.commits || [],
    }),
  };
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
