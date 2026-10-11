// Implement discovery: which approved issues have no delivering PR, and the batch.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { gh } from "./gh.js";


/** Most issues in the Foreman's own per-pass discovery batch (see discoveryBatch). */
export const MAX_BATCH_SIZE = 3;

/**
 * Extract the issue numbers a PR actually IMPLEMENTS (closes/relates), as
 * opposed to merely mentions in prose. An issue counts as implemented when:
 *   - it appears after a closing/relating keyword (Closes/Fixes/Resolves/
 *     Related to/Refs/See #N) anywhere in title, body, or commit messages, OR
 *   - it appears as a `(#N)` suffix in the PR TITLE or a commit HEADLINE
 *     (the canonical `feat: foo (#N)` form).
 *
 * A bare `#N`, or a `(#N)` mention in the free-text BODY (e.g.
 * "tracked separately in #3", "the forthcoming handler (#2)"), does NOT
 * count — those are forward references to sibling issues, not implementations.
 * Counting them orphaned cmneb_public_api #2/#3 (slashbin-ai-foreman#28):
 * a schema PR's body mentioning the not-yet-built endpoint issue marked that
 * issue "implemented"/"covered", so it was never picked up.
 *
 * Commits count only for the change they still carry at the PR's head: a
 * reverted commit and the revert itself deliver nothing (issuesImplementedByCommits).
 */
export function extractImplementedIssues(opts: {
  title?: string;
  body?: string;
  /** The PR's commits, oldest first, as `gh pr list --json commits` returns them. */
  commits?: PrCommit[];
  /**
   * STRICT mode — accept only *closing* keywords (`closes`/`fixes`/`resolves`),
   * dropping the weak affinity keywords (`related to`, `refs`, `see`).
   *
   * Default (false) is the historical predicate, correct for the PR-labeling path
   * where the consequence is merely ADDING `pr under review` — over-matching there
   * is cheap and recoverable.
   *
   * Strict is required by any TERMINAL transition (one that strips the trigger
   * label and declares work done), where a false positive permanently marks
   * unbuilt work as complete. "Related to #N" is not a claim of implementation —
   * and the Foreman's OWN reconciler writes `- Related to #N` into every recovery
   * PR body (reconciler.ts), so the loose predicate would terminally close issues
   * nobody built. That is slashbin-ai-foreman#28's bug with a worse blast radius.
   */
  strict?: boolean;
}): number[] {
  const { title = "", body = "", commits = [], strict = false } = opts;
  const found = new Set<number>(issuesNamed(title, body, strict, true));
  for (const n of issuesImplementedByCommits(commits, strict)) found.add(n);
  return Array.from(found).sort((a, b) => a - b);
}

/** One commit of a PR, as `gh pr list --json commits` returns it. */
export interface PrCommit {
  oid?: string;
  messageHeadline?: string;
  messageBody?: string;
}

/**
 * Issue numbers named in one headline + body: a keyword reference anywhere, a
 * `(#N)` suffix only in the headline (never the free-text body, where it is a
 * prose mention of a sibling issue).
 */
function issuesNamed(headline: string, body: string, strict: boolean, suffixInHeadline: boolean): number[] {
  const keywordRe = strict
    ? /\b(?:closes?|fixes?|resolves?)\s*:?\s*#(\d+)/gi
    : /\b(?:related\s+to|closes?|fixes?|resolves?|refs?|see)\s*:?\s*#(\d+)/gi;
  const found = new Set<number>();
  for (const m of `${headline}\n${body}`.matchAll(keywordRe)) found.add(parseInt(m[1], 10));
  if (suffixInHeadline) for (const m of headline.matchAll(/\(#(\d+)\)/g)) found.add(parseInt(m[1], 10));
  return [...found].filter(Number.isFinite);
}

const REVERTS_SHA_RE = /This reverts commit ([0-9a-f]{7,40})/gi;
const REVERT_HEADLINE_RE = /^\s*revert\b/i;

/** A commit that undoes another: git's `Revert "…"`, a conventional `revert:`, or git's body line. */
function isRevert(c: PrCommit): boolean {
  return REVERT_HEADLINE_RE.test(c.messageHeadline ?? "") || /This reverts commit [0-9a-f]{7,40}/i.test(c.messageBody ?? "");
}

/**
 * The issues a PR's commits still deliver at its head. A reverted change is
 * not a delivery, and a revert never is one:
 *
 *  - a revert naming its target by sha (`This reverts commit <sha>`) drops
 *    both, newest first, so a revert of a revert restores the original;
 *  - a revert naming an ISSUE (`revert: drop the #1164 change (#1164)`, the
 *    hand-written form, with no sha) cancels that issue: it counts only while
 *    the latest commit naming it is not a revert.
 *
 * Origin: Slashbin-console PR #1232 carried #1164's commit and its hand-written
 * revert, net zero for #1164. The revert's own headline ended `(#1164)`, so
 * every reader took the PR as delivering #1164: review labelled it `pr under
 * review` then `pr approved` (2026-10-03), the dead-zone resolver labelled it
 * `pr merged` (2026-10-09), and an issue nobody had built sat on the board as
 * awaiting release for a week. Under-matching is the safe direction here: an
 * issue missed is picked up again; an issue wrongly matched is marked done.
 */
export function issuesImplementedByCommits(commits: PrCommit[], strict = false): number[] {
  const dropped = new Set<number>();
  for (let i = commits.length - 1; i >= 0; i--) {
    if (dropped.has(i)) continue;
    for (const m of (commits[i].messageBody ?? "").matchAll(REVERTS_SHA_RE)) {
      const sha = m[1].toLowerCase();
      const j = commits.findIndex((c, k) => k < i && !dropped.has(k) && (c.oid ?? "").toLowerCase().startsWith(sha));
      if (j >= 0) { dropped.add(i); dropped.add(j); }
    }
  }
  const last = new Map<number, boolean>(); // issue → the latest commit naming it is a revert
  commits.forEach((c, i) => {
    if (dropped.has(i)) return;
    const revert = isRevert(c);
    for (const n of issuesNamed(c.messageHeadline ?? "", c.messageBody ?? "", strict, true)) last.set(n, revert);
  });
  return [...last].filter(([, revert]) => !revert).map(([n]) => n);
}

/**
 * The Foreman's own discovery batch, cut from the work a source offered:
 * ascending (lowest numbers — dependencies — first), capped at MAX_BATCH_SIZE,
 * 1 on a greenfield repo. This is what the orchestrator acts on per issue
 * (run gate, inline prompt, batch-wide skip, labeling fallback). It is NOT what
 * a skill is handed: a skill chooses by priority across every offered item,
 * and capping that list would hide a high-priority issue behind three older ones.
 */
export function discoveryBatch(config: RepoConfig, offered: number[], logger: Logger): number[] {
  if (offered.length === 0) return [];
  // Sort ascending so lowest issue numbers (dependencies) come first
  const uncovered = [...offered].sort((a, b) => a - b);

  // Greenfield detection: if repo has very few tracked files, limit to 1 issue
  // The skill implements one-at-a-time anyway, but a focused prompt is more reliable
  let effectiveBatchSize = MAX_BATCH_SIZE;
  try {
    const fileCount = gh(["ls-files", "--cached"], config.repoPath).split("\n").filter(Boolean).length;
    if (fileCount < 10) {
      effectiveBatchSize = 1;
      logger.info(`Greenfield repo detected (${fileCount} files) — limiting to 1 issue per cycle`);
    }
  } catch { /* ignore — use default batch size */ }

  const batch = uncovered.slice(0, effectiveBatchSize);
  if (uncovered.length > MAX_BATCH_SIZE) {
    logger.info(`Found ${uncovered.length} actionable issue(s), capping batch to ${MAX_BATCH_SIZE}: ${batch.map(n => `#${n}`).join(", ")} (${uncovered.length - MAX_BATCH_SIZE} deferred to next cycle)`);
  } else {
    logger.info(`Found ${uncovered.length} actionable issue(s) with no linked PR: ${batch.map(n => `#${n}`).join(", ")}`);
  }
  return batch;
}
