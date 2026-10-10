// Read-only lookups for session reports: titles, PR digests, review bodies.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { formatGhError, getOpenIssues } from "./cache.js";
import { gh } from "./gh.js";


// --- Session reports (observers only) ---

/** Each of `numbers` with its open issue's title, from the cycle's issue snapshot. Empty on a failed read. */
export function issueTitles(config: RepoConfig, numbers: ReadonlyArray<number>, logger: Logger): Record<number, string> {
  const out: Record<number, string> = {};
  try {
    for (const i of getOpenIssues(config.githubRepo, config.repoPath, logger)) {
      if (numbers.includes(i.number) && i.title) out[i.number] = i.title;
    }
  } catch (err) {
    logger.debug(`issueTitles failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/** A PR's title and diff stat, for a session summary. Null when it could not be read. */
export function readPrDigest(
  repo: string,
  pr: string | number,
  cwd: string,
  logger: Logger,
): { number: number; url: string; title: string; additions: number; deletions: number; changedFiles: number } | null {
  try {
    const out = gh(["pr", "view", String(pr), "--repo", repo, "--json", "number,url,title,additions,deletions,changedFiles"], cwd);
    const j = JSON.parse(out || "{}");
    return typeof j.number === "number" ? j : null;
  } catch (err) {
    logger.debug(`readPrDigest: gh pr view ${pr} failed: ${formatGhError(err).message}`);
    return null;
  }
}

/**
 * The body of the newest review posted on `pr` at or after `since` (ISO), the
 * one a review session just wrote. Null when there is none or the read failed.
 */
export function readLatestReviewBody(repo: string, pr: number, since: string, cwd: string, logger: Logger): string | null {
  try {
    const out = gh(["api", `repos/${repo}/pulls/${pr}/reviews?per_page=100`], cwd);
    const reviews = (JSON.parse(out || "[]") as Array<{ body?: string; submitted_at?: string }>)
      .filter((r) => (r.body ?? "").trim() && Date.parse(r.submitted_at ?? "") >= Date.parse(since));
    return reviews.length ? reviews[reviews.length - 1].body ?? null : null;
  } catch (err) {
    logger.debug(`readLatestReviewBody: PR #${pr} failed: ${formatGhError(err).message}`);
    return null;
  }
}

/**
 * How many CHANGES_REQUESTED reviews a PR has collected — the number of review
 * rounds it has been sent back on. Read from GitHub each time, never counted
 * locally. Null when it cannot be read.
 */
export function countChangesRequested(repo: string, pr: number, cwd: string, logger: Logger): number | null {
  try {
    const out = gh(["api", `repos/${repo}/pulls/${pr}/reviews?per_page=100`], cwd);
    return (JSON.parse(out || "[]") as Array<{ state?: string }>).filter((r) => r.state === "CHANGES_REQUESTED").length;
  } catch (err) {
    logger.debug(`countChangesRequested: PR #${pr} failed: ${formatGhError(err).message}`);
    return null;
  }
}
