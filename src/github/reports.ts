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


// --- Scope rulings (revise) ---

/** A PR comment that opens with this is the EM's scope ruling: review rounds count afresh from it. */
export const EM_RULING_PATTERN = /^\s*\*\*EM scope ruling/;
/** A CHANGES_REQUESTED review whose body carries this says the finding is the spec's, not the code's. */
export const TECH_LEAD_ESCALATE_MARKER = "<!-- tech-lead:escalate";

export type ReviewFact = { id: number; state: string; at: string; escalate: boolean };
export type CommentFact = { at: string; head: string };
/** Where a PR stands against its last EM scope ruling. */
export type RulingState = {
  /** CHANGES_REQUESTED reviews submitted after the last ruling (all of them when there is none). */
  roundsSinceRuling: number;
  /** The newest review's id, null when there is none: an escalation is made once per id. */
  latestReviewId: number | null;
  /** The newest review asks for changes, came after the last ruling, and carries the Tech Lead's escalate marker. */
  escalateRequested: boolean;
  /** When the last ruling was posted, null when there is none. */
  rulingAt: string | null;
};

/** Pure: a PR's reviews and comments → its ruling state. */
export function rulingState(reviews: ReadonlyArray<ReviewFact>, comments: ReadonlyArray<CommentFact>): RulingState {
  const rulings = comments.filter((c) => EM_RULING_PATTERN.test(c.head)).map((c) => c.at).sort();
  const rulingAt = rulings.length ? rulings[rulings.length - 1]! : null;
  const after = reviews.filter((r) => r.at && (rulingAt === null || r.at > rulingAt));
  const latest = [...reviews].filter((r) => r.at).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id)).pop();
  return {
    roundsSinceRuling: after.filter((r) => r.state === "CHANGES_REQUESTED").length,
    latestReviewId: latest?.id ?? null,
    escalateRequested: !!latest && latest.state === "CHANGES_REQUESTED" && latest.escalate && (rulingAt === null || latest.at > rulingAt),
    rulingAt,
  };
}

/** A PR's ruling state, read from its reviews and comments. Null on a failed read. */
export function readRulingState(repo: string, pr: number, cwd: string, logger: Logger): RulingState | null {
  try {
    const lines = (out: string) => out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const reviews = lines(gh(["api", "--paginate", `repos/${repo}/pulls/${pr}/reviews?per_page=100`, "--jq",
      `.[] | {id, state, at: (.submitted_at // ""), escalate: ((.body // "") | contains("${TECH_LEAD_ESCALATE_MARKER}"))} | @json`], cwd)) as ReviewFact[];
    const comments = lines(gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments?per_page=100`, "--jq",
      `.[] | {at: .created_at, head: ((.body // "") | .[0:80])} | @json`], cwd)) as CommentFact[];
    return rulingState(reviews, comments);
  } catch (err) {
    logger.debug(`readRulingState: PR #${pr} failed: ${formatGhError(err).message}`);
    return null;
  }
}
