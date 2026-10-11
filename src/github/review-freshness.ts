// Whether a PR already has a current verdict from the configured reviewer.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { isGitHubStateEnabled, stateOpenPrs } from "../github-state.js";
import { issueCacheTtlMs } from "./cache.js";
import { gh } from "./gh.js";


/**
 * Whether a review counts as the configured reviewer's. With no `reviewerLogin`
 * configured, every author counts: the freshness guard then treats a verdict by
 * anyone as current, which can skip a review but can never loop one.
 */
export function byReviewer(review: { author?: { login?: string } }, reviewerLogin: string | undefined): boolean {
  return reviewerLogin === undefined || review.author?.login === reviewerLogin;
}

/**
 * True when the PR already has an APPROVED/CHANGES_REQUESTED review by
 * `reviewerLogin` submitted at or after the PR's latest commit (i.e. the current
 * head has already been reviewed). On any lookup failure returns false — we'd
 * rather (rarely) re-review than silently never review.
 */
/**
 * hasFreshReview answers, keyed by the PR's head commit and last-update time
 * from the fleet state. A new commit moves the head; a submitted review bumps
 * the PR's updatedAt — either one misses this cache. Without it, every idle
 * cycle re-read the reviews of every open feature PR waiting on a human.
 */
export const freshReviewCache = new Map<string, { key: string; fresh: boolean }>();

export function hasFreshReview(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
): boolean {
  let cacheKey: string | null = null;
  const id = `${config.githubRepo}#${prNumber}`;
  try {
    if (issueCacheTtlMs > 0 && isGitHubStateEnabled(config.githubRepo)) {
      const pr = stateOpenPrs(config.githubRepo).find((p) => p.number === prNumber);
      if (pr) {
        cacheKey = `${pr.headRefOid}@${pr.updatedAt}@${reviewerLogin ?? ""}`;
        const hit = freshReviewCache.get(id);
        if (hit && hit.key === cacheKey) return hit.fresh;
      }
    }
  } catch { /* state unavailable — read live */ }
  const fresh = readFreshReview(config, prNumber, reviewerLogin, logger);
  if (cacheKey && fresh !== null) freshReviewCache.set(id, { key: cacheKey, fresh });
  return fresh ?? false;
}

/** Null when the lookup failed — not cached, reads as "no fresh review". */
export function readFreshReview(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
): boolean | null {
  try {
    const json = gh([
      "pr", "view", String(prNumber),
      "--repo", config.githubRepo,
      "--json", "reviews,commits",
    ], config.repoPath);
    const data = JSON.parse(json || "{}") as {
      commits?: { committedDate?: string }[];
      reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
    };
    const commits = data.commits ?? [];
    const reviews = data.reviews ?? [];
    if (commits.length === 0) return false;

    const lastCommitMs = commits
      .map((c) => (c.committedDate ? new Date(c.committedDate).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);

    return reviews.some(
      (r) =>
        byReviewer(r, reviewerLogin) &&
        (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") &&
        !!r.submittedAt &&
        new Date(r.submittedAt).getTime() >= lastCommitMs,
    );
  } catch (err) {
    logger.debug(`hasFreshReview lookup failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * True when the reviewer's latest verdict on the PR is CHANGES_REQUESTED. Asked
 * only once the verdict is known to be current and not answered by a return to
 * review, so a true here means the verdict's label move never happened. Lookup
 * failure → false: the pre-existing skip, never a spurious revise.
 */
export function currentVerdictRequestsChanges(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
): boolean {
  try {
    const data = JSON.parse(gh(["pr", "view", String(prNumber), "--repo", config.githubRepo, "--json", "reviews"], config.repoPath) || "{}") as {
      reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
    };
    const verdicts = (data.reviews ?? [])
      .filter((r) => byReviewer(r, reviewerLogin) && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") && r.submittedAt)
      .sort((a, b) => new Date(a.submittedAt!).getTime() - new Date(b.submittedAt!).getTime());
    return verdicts[verdicts.length - 1]?.state === "CHANGES_REQUESTED";
  } catch (err) {
    logger.debug(`currentVerdictRequestsChanges lookup failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * When the reviewer's latest verdict on the PR is APPROVED, the time it was
 * submitted (ms); otherwise null. Lookup failure → null: the pre-existing skip.
 */
export function currentApprovalMs(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
): number | null {
  try {
    const data = JSON.parse(gh(["pr", "view", String(prNumber), "--repo", config.githubRepo, "--json", "reviews"], config.repoPath) || "{}") as {
      reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
    };
    const verdicts = (data.reviews ?? [])
      .filter((r) => byReviewer(r, reviewerLogin) && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") && r.submittedAt)
      .sort((a, b) => new Date(a.submittedAt!).getTime() - new Date(b.submittedAt!).getTime());
    const last = verdicts[verdicts.length - 1];
    return last?.state === "APPROVED" ? new Date(last.submittedAt!).getTime() : null;
  } catch (err) {
    logger.debug(`currentApprovalMs lookup failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * True when a linked issue was labelled `prUnderReview` AFTER the reviewer's
 * latest CHANGES_REQUESTED verdict — the reviser answered without a commit.
 *
 * Only a CHANGES_REQUESTED verdict qualifies: an APPROVED PR waiting on merge
 * is genuinely current. In normal flow CHANGES_REQUESTED moves the issues to
 * `prPendingActions`, which `findPRsNeedingReview` excludes, so this lookup
 * runs only in the stuck state it exists for. Lookup failure → false: the
 * pre-existing behaviour, never a spurious review.
 */
export function returnedToReviewSinceVerdict(
  config: RepoConfig,
  prNumber: number,
  issueNumbers: number[],
  reviewerLogin: string | undefined,
  logger: Logger,
): boolean {
  try {
    const data = JSON.parse(gh(["pr", "view", String(prNumber), "--repo", config.githubRepo, "--json", "reviews"], config.repoPath) || "{}") as {
      reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
    };
    const verdicts = (data.reviews ?? [])
      .filter((r) => byReviewer(r, reviewerLogin) && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") && r.submittedAt)
      .sort((a, b) => new Date(a.submittedAt!).getTime() - new Date(b.submittedAt!).getTime());
    const last = verdicts[verdicts.length - 1];
    if (!last || last.state !== "CHANGES_REQUESTED") return false;
    const verdictMs = new Date(last.submittedAt!).getTime();
    const label = config.lifecycleLabels.prUnderReview;
    for (const n of issueNumbers) {
      // One timestamp per line: --paginate emits one --jq result per page.
      const times = gh([
        "api", `repos/${config.githubRepo}/issues/${n}/events`, "--paginate",
        "--jq", `.[] | select(.event == "labeled" and .label.name == ${JSON.stringify(label)}) | .created_at`,
      ], config.repoPath).split("\n").filter(Boolean);
      if (times.some((t) => new Date(t).getTime() > verdictMs)) return true;
    }
    return false;
  } catch (err) {
    logger.debug(`returnedToReviewSinceVerdict lookup failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
