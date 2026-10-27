// The CI gate in front of review: read the checks, bounce a red PR to revise.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { gh } from "./gh.js";
import { byReviewer } from "./review-freshness.js";
import { backoffSettings } from "../backoff.js";


// --- CI gate in front of review ---------------------------------------------
//
// A review is a full EM session (median 13 min). Spending one on a PR whose own
// CI is red buys a REQUEST_CHANGES that says "CI is red" — the builder could have
// learned that for free. So the review phase reads the PR's checks first:
// red → straight back to revise with the failing checks named, still running →
// wait a pass, green or no CI at all → review as before.

/** One entry of `gh pr view --json statusCheckRollup`: a CheckRun or a StatusContext. */
export interface CheckRollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export interface CheckVerdict {
  /** `none` = the repo runs no CI on this PR; review proceeds exactly as before. */
  state: "none" | "pending" | "passing" | "failing";
  failing: { name: string; url?: string }[];
  pending: string[];
}

export const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
export const PENDING_STATES = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED", "EXPECTED"]);

/**
 * Reduce a check rollup to one verdict. Pure, so it is tested without GitHub.
 *
 * The rollup can carry the same check name more than once (a push run and a
 * pull_request run, or a re-run after a flake). A name counts as failing only
 * when NO entry of that name succeeded — a re-run that went green clears it.
 * CANCELLED, SKIPPED and NEUTRAL are not failures: a superseded run is cancelled,
 * and path-filtered jobs skip.
 */
export function summarizeCheckRollup(rollup: CheckRollupEntry[]): CheckVerdict {
  if (rollup.length === 0) return { state: "none", failing: [], pending: [] };

  const byName = new Map<string, CheckRollupEntry[]>();
  for (const e of rollup) {
    const name = e.name ?? e.context ?? "(unnamed check)";
    byName.set(name, [...(byName.get(name) ?? []), e]);
  }

  const failing: { name: string; url?: string }[] = [];
  const pending: string[] = [];
  for (const [name, entries] of byName) {
    const outcome = (e: CheckRollupEntry): string =>
      (e.__typename === "StatusContext" ? e.state : e.status === "COMPLETED" ? e.conclusion : e.status ?? e.state) ?? "";
    if (entries.some((e) => outcome(e) === "SUCCESS")) continue;
    if (entries.some((e) => PENDING_STATES.has(outcome(e)))) {
      pending.push(name);
      continue;
    }
    const red = entries.find((e) => FAILING_CONCLUSIONS.has(outcome(e)));
    if (red) failing.push({ name, url: red.detailsUrl ?? red.targetUrl });
  }

  if (pending.length > 0) return { state: "pending", failing, pending };
  if (failing.length > 0) return { state: "failing", failing, pending };
  return { state: "passing", failing, pending };
}

/** Read the PR's checks. A lookup failure answers `none`, i.e. review as before. */
export function getPRCheckVerdict(config: RepoConfig, prNumber: number, logger: Logger): CheckVerdict {
  try {
    const raw = gh([
      "pr", "view", String(prNumber),
      "--repo", config.githubRepo,
      "--json", "statusCheckRollup",
    ], config.repoPath);
    const data = JSON.parse(raw || "{}") as { statusCheckRollup?: CheckRollupEntry[] };
    return summarizeCheckRollup(data.statusCheckRollup ?? []);
  } catch (err) {
    logger.warn(`${config.name}: could not read checks on PR #${prNumber} — reviewing without the CI gate: ${err instanceof Error ? err.message : String(err)}`);
    return { state: "none", failing: [], pending: [] };
  }
}

/** Marker on every CI-gate bounce comment; counted to cap the bounce loop. */
export const CI_GATE_MARKER = "<!-- foreman-ci-gate -->";

/** Consecutive bounces allowed before the PR goes to review anyway. A check the
 *  builder cannot turn green (a broken workflow, a red base branch) must still
 *  reach a reviewer instead of cycling builder sessions forever. */

/**
 * How many CI-gate bounces this PR has had since the reviewer last reviewed it.
 * A reviewer verdict resets the count: it means the PR reached review.
 */
export function countCiBouncesSinceReview(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
): number {
  try {
    const raw = gh([
      "pr", "view", String(prNumber),
      "--repo", config.githubRepo,
      "--json", "comments,reviews",
    ], config.repoPath);
    const data = JSON.parse(raw || "{}") as {
      comments?: { body?: string; createdAt?: string }[];
      reviews?: { author?: { login?: string }; submittedAt?: string }[];
    };
    const lastReviewMs = (data.reviews ?? [])
      .filter((r) => byReviewer(r, reviewerLogin) && r.submittedAt)
      .map((r) => new Date(r.submittedAt as string).getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    return (data.comments ?? []).filter(
      (c) => c.body?.includes(CI_GATE_MARKER) && c.createdAt && new Date(c.createdAt).getTime() > lastReviewMs,
    ).length;
  } catch (err) {
    logger.debug(`countCiBouncesSinceReview failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    // Unknown count → treat as capped, so a lookup failure can never start a loop.
    return backoffSettings().maxCiBounces;
  }
}

/** The bounce comment the revise skill reads. */
export function ciBounceComment(verdict: CheckVerdict): string {
  const lines = verdict.failing.map((f) => `- **${f.name}**${f.url ? ` — ${f.url}` : ""}`);
  return [
    CI_GATE_MARKER,
    "**CI is red — sent back before review.** The review was not run; a reviewer would have blocked on this first.",
    "",
    "Failing checks:",
    ...lines,
    "",
    "Reproduce each one locally, fix the code (never the test), push, and the PR returns to review once CI is green.",
  ].join("\n");
}

/**
 * Send a red-CI PR back to revise: comment the failing checks on the PR. The
 * caller then reports each linked work item `inReview → changesRequested`
 * through its work source (on GitHub: `pr under review` → `pr pending actions`,
 * the label the revise phase picks up). The comment is PR-level and stays here.
 */
export function bounceForRedCI(
  config: RepoConfig,
  prNumber: number,
  verdict: CheckVerdict,
): void {
  gh([
    "pr", "comment", String(prNumber),
    "--repo", config.githubRepo,
    "--body", ciBounceComment(verdict),
  ], config.repoPath);
}

/**
 * Comment on a work item's issue. Used for announcements that belong to the
 * code host rather than the work source — a diverged feature branch (foreman#44)
 * is a git fact, so it is said on GitHub whatever source supplied the work.
 */
export function commentOnIssue(config: RepoConfig, issueNumber: number, body: string): void {
  gh([
    "issue", "comment", String(issueNumber),
    "--repo", config.githubRepo,
    "--body", body,
  ], config.repoPath);
}
