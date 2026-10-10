// Branch state: the post-implement self-check, remote heads, and branch-drift sync PRs.

import type { Logger } from "../logger.js";
import { findOpenPrs, formatGhError } from "./cache.js";
import { gh, ghAsTechLead, isBackoffRefusal } from "./gh.js";
import { DEFAULT_GITHUB_CONVENTIONS, fillTitle, signed, type GithubConventions } from "./conventions.js";
import { OpenPromotionPR } from "./promotion.js";


// --- Post-Implementation Self-Check ---

/**
 * After a PR is created, verify it has actual file changes.
 * Returns the count of changed files, or -1 if check fails.
 * Logs the changed files for traceability (Second Way).
 */
export function checkPRHasChanges(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger: Logger,
): number {
  try {
    const json = gh([
      "pr", "list",
      "--repo", repo,
      "--head", headBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "number,files",
      "--limit", "1",
    ], cwd);

    const prs = JSON.parse(json || "[]");
    if (prs.length === 0) return -1;

    const files: { path: string }[] = prs[0].files || [];
    if (files.length === 0) {
      logger.warn("PR has no file changes — implementation may have failed silently");
      return 0;
    }

    logger.info(`PR #${prs[0].number} modifies ${files.length} file(s): ${files.map((f: { path: string }) => f.path).join(", ")}`);
    return files.length;
  } catch (err) {
    logger.warn("checkPRHasChanges: gh pr list failed", { ...formatGhError(err) });
    return -1;
  }
}

/**
 * Read the current HEAD SHA of a remote branch via the GitHub API.
 * Returns null on lookup failure so callers can decide how to react —
 * a transient gh error should not be conflated with a real "branch unchanged"
 * signal.
 */
export function getRemoteBranchSha(
  repo: string,
  branch: string,
  cwd: string,
  logger: Logger,
): string | null {
  try {
    const sha = gh([
      "api",
      `repos/${repo}/branches/${encodeURIComponent(branch)}`,
      "--jq", ".commit.sha",
    ], cwd);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (err) {
    logger.warn("getRemoteBranchSha: gh api failed", { ...formatGhError(err), repo, branch });
    return null;
  }
}

// --- Branch Sync ---

export interface BranchDrift {
  developBehindMain: number;
  developAheadOfMain: number;
  /** Files differing between main and develop. Zero means merge-commit-only drift. */
  developAheadFiles: number;
}

/**
 * Check if develop has drifted behind main due to accumulated merge commits.
 * Returns the drift counts, or null if the check fails.
 */
export function checkBranchDrift(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  cwd: string,
  logger: Logger,
): BranchDrift | null {
  try {
    const json = gh([
      "api", `repos/${repo}/compare/${productionBranch}...${baseBranch}`,
      "--jq", '{"ahead": .ahead_by, "behind": .behind_by, "files": ((.files // []) | length)}',
    ], cwd);

    const result = JSON.parse(json);
    return {
      developAheadOfMain: result.ahead,
      developBehindMain: result.behind,
      // Changed files between main and develop. `ahead > 0 && files === 0` is the
      // NORMAL steady state, not a stall: the main -> develop sync PR leaves a
      // merge commit on develop that main does not have, carrying no file change.
      // Counting commits alone flags every repo, forever. GitHub truncates this
      // array on very large diffs but never empties it, so 0 really means 0.
      developAheadFiles: result.files ?? 0,
    };
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger.debug("Failed to check branch drift — GitHub back-off active");
      return null;
    }
    logger.error("Failed to check branch drift", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check if a sync PR (main → develop) already exists.
 */
export function findOpenSyncPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): OpenPromotionPR | null {
  try {
    const prs: OpenPromotionPR[] = findOpenPrs(repo, cwd, { base: baseBranch, head: productionBranch, limit: 1 });
    return prs.length > 0 ? prs[0] : null;
  } catch (err) {
    logger?.warn("findOpenSyncPR: gh pr list failed", { ...formatGhError(err) });
    return null;
  }
}

/**
 * Create a sync PR to merge main back into develop, then immediately
 * approve + merge it. Created and merged as slashbin-foreman (Foreman token),
 * approved as slasbhin-techlead to satisfy branch protection's "no
 * self-approval" rule.
 *
 * This eliminates the stale sync PR race condition where develop
 * advances between PR creation and external merge.
 */
export function createSyncPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  behindBy: number,
  cwd: string,
  logger?: Logger,
  conventions: GithubConventions = DEFAULT_GITHUB_CONVENTIONS,
): string | null {
  try {
    const result = gh([
      "pr", "create",
      "--repo", repo,
      "--base", baseBranch,
      "--head", productionBranch,
      "--title", fillTitle(conventions.syncTitle, { base: baseBranch, production: productionBranch }),
      "--body", signed(`## Branch Sync\n\nSync \`${baseBranch}\` with \`${productionBranch}\` to backfill ${behindBy} merge commit(s) from prior promotions. No code changes — only merge commit history alignment.`, conventions),
    ], cwd);

    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    const prUrl = match ? match[0] : null;

    if (!prUrl) return null;

    // Extract PR number from URL
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    if (!prNumberMatch) return prUrl;

    const prNumber = prNumberMatch[1];

    // Immediately approve + merge, both as the Tech Lead. The merge is what
    // triggers the dev deploy, and Railway holds any deploy merged by a GitHub
    // account with no linked workspace member for manual approval. The Foreman
    // coordinates and has no Railway account (Ray, 2026-10-10); merging as the
    // Foreman stalled every post-promotion dev deploy (jerky_skuvault_service#410).
    try {
      ghAsTechLead([
        "pr", "review", prNumber,
        "--repo", repo,
        "--approve",
        "--body", `Branch sync: head is \`${productionBranch}\`, so there is no new code to review.`,
      ], cwd);

      ghAsTechLead([
        "pr", "merge", prNumber,
        "--repo", repo,
        "--merge",
      ], cwd);

      logger?.info(`Sync PR #${prNumber} created and merged immediately`);
    } catch (mergeErr) {
      // Expected on any repo with required status checks: the merge is attempted
      // seconds after creation, while build/test/typecheck are still IN_PROGRESS,
      // so branch protection refuses it. Not fatal — `tryMergeSyncPR` retries on a
      // later cycle once the checks land. See its comment for why that retry is
      // load-bearing rather than cosmetic.
      logger?.warn(`Sync PR #${prNumber} created but immediate auto-merge failed (will retry next cycle): ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
    }

    return prUrl;
  } catch (err) {
    logger?.warn("createSyncPR: gh pr create failed", { ...formatGhError(err), repo, behindBy });
    return null;
  }
}

/**
 * Merge an already-open sync PR. Returns true only if it is merged afterwards.
 *
 * WHY THIS EXISTS (2026-07-30). `createSyncPR` approves and merges the instant it
 * creates the PR — seconds later, while required status checks are still
 * IN_PROGRESS. On any repo with branch protection that merge is refused. The old
 * code caught that, said "the PR still exists for manual merge", and moved on;
 * the caller then logged "Sync PR created and auto-merged" regardless, and on
 * every later cycle logged "Sync PR already open" and returned early WITHOUT ever
 * retrying. So the merge never happened, the log claimed it had, and the sync PR
 * stayed open forever.
 *
 * That is not cosmetic. `develop` stays behind `main`, which makes the next
 * promotion PR `BEHIND`, which branch protection refuses to merge. Observed on
 * `Slashbin-console#779`: open 2h48m across ~140 no-op cycles, blocking the
 * promotion of #782 until it was merged by hand. The same "created and
 * auto-merged" line had already been logged for #438, #559 and #783.
 *
 * Idempotent by construction: re-approving an approved PR and merging a merged
 * PR are both no-ops we treat as success, so retrying every cycle is safe.
 */
export function tryMergeSyncPR(
  repo: string,
  prNumber: number,
  cwd: string,
  logger?: Logger,
  productionBranch = "main",
): boolean {
  try {
    // Re-approve defensively: on the retry path the original approval is already
    // there, and gh treats a repeat approval as a no-op.
    try {
      ghAsTechLead([
        "pr", "review", String(prNumber),
        "--repo", repo,
        "--approve",
        "--body", `Branch sync: head is \`${productionBranch}\`, so there is no new code to review.`,
      ], cwd);
    } catch {
      // Already approved, or approval not required. Not a reason to skip the merge.
    }

    // As the Tech Lead, never the Foreman — see createSyncPR.
    ghAsTechLead([
      "pr", "merge", String(prNumber),
      "--repo", repo,
      "--merge",
    ], cwd);
    return true;
  } catch (err) {
    // Still blocked (checks pending, conflict, protection). Report at debug so a
    // normal cycle isn't noisy — the caller reports the durable state.
    logger?.debug(`Sync PR #${prNumber} not mergeable yet: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
