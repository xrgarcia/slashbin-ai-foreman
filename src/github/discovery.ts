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
 */
export function extractImplementedIssues(opts: {
  title?: string;
  body?: string;
  commitHeadlines?: string[];
  commitBodies?: string[];
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
  const { title = "", body = "", commitHeadlines = [], commitBodies = [], strict = false } = opts;
  const keywordRe = strict
    ? /\b(?:closes?|fixes?|resolves?)\s*:?\s*#(\d+)/gi
    : /\b(?:related\s+to|closes?|fixes?|resolves?|refs?|see)\s*:?\s*#(\d+)/gi;
  const suffixRe = /\(#(\d+)\)/g;
  const found = new Set<number>();

  // Keyword references are explicit intent — authoritative anywhere.
  const keywordText = [title, body, ...commitHeadlines, ...commitBodies].join("\n");
  for (const m of keywordText.matchAll(keywordRe)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) found.add(n);
  }
  // `(#N)` suffix is authoritative ONLY in the title or a commit headline —
  // never the free-text body, where it is a prose mention of a sibling issue.
  const suffixText = [title, ...commitHeadlines].join("\n");
  for (const m of suffixText.matchAll(suffixRe)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) found.add(n);
  }
  return Array.from(found).sort((a, b) => a - b);
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
