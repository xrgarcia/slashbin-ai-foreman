// Consecutive revisions that pushed nothing BY DECLARATION, per PR head.
//
// A declared no-commit is a valid answer, so it returns to `pr under review`
// and gets re-reviewed. But if the reviewer (or QA) then asks for the same
// change again, the pair ping-pongs forever at no cost to either side and with
// nothing changing. One is an answer; two on the same head is a disagreement,
// and a disagreement between two agents is a human's call.
//
// Keyed by PR and head SHA and persisted on the PR's record in the work source, so neither an idle
// revise pass nor a restart resets it. It used to be a per-repo counter cleared
// on any pass with no pending revision; with qaBeforeMerge every round has such
// a pass (the card sits in review while QA runs), so it never reached two and
// Slashbin-console PR #1597 looped QA FAIL → no-commit 15+ times on one SHA
// (foreman#167, 2026-11-01). It ends only when the head moves (a push), or the
// PR closes or merges.

import type { RepoConfig } from "./config.js";
import { loadPrRecord, updatePrRecord } from "./issue-records.js";
import type { NoCommitStreak } from "./state.js";

// The streak lives on the PR's record in the work source (EM#1244 f3). A read
// that fails is not "no streak": the caller leaves the PR alone this pass.

/** One no-commit is an answer; one more on the same head is a stalemate. */
export const MAX_CONSECUTIVE_NO_COMMIT = 1;

/** PRs this process has seen a streak on, so a closed PR's streak can be forgotten without listing the store. */
const seen = new Map<string, Set<number>>();
const seenOf = (repoConfig: RepoConfig) => seen.get(repoConfig.githubRepo) ?? seen.set(repoConfig.githubRepo, new Set()).get(repoConfig.githubRepo)!;

/** The import knows these PRs hold a streak. */
export function noteStreakPrs(githubRepo: string, prs: Iterable<number>): void {
  const into = seen.get(githubRepo) ?? seen.set(githubRepo, new Set()).get(githubRepo)!;
  for (const n of prs) into.add(n);
}

/** PR `pr`'s streak: `{ok:true}` with it (or none), or `{ok:false}` when its record cannot be read. */
export async function readNoCommitStreak(repoConfig: RepoConfig, pr: number): Promise<{ ok: true; streak?: NoCommitStreak } | { ok: false }> {
  const record = await loadPrRecord(repoConfig, pr);
  if (!record) return { ok: false };
  if (record.noCommit) seenOf(repoConfig).add(pr);
  return { ok: true, ...(record.noCommit ? { streak: record.noCommit } : {}) };
}

/** No-commit revisions in a row at `head` for a streak; 0 once the head has moved. */
export function noCommitCount(streak: NoCommitStreak | undefined, head: string): number {
  return streak && streak.head === head ? streak.count : 0;
}

/** The head a streak is in a no-commit stalemate on, or undefined when it is in none. */
export function stalemateHead(streak: NoCommitStreak | undefined): string | undefined {
  return streak && streak.count > MAX_CONSECUTIVE_NO_COMMIT ? streak.head : undefined;
}

/**
 * Count one more no-commit revision on PR `pr` at `head`, after `streak` (a head the streak has not seen starts
 * it at one). Resolves the new count, or null when it could not be saved.
 */
export async function recordNoCommit(repoConfig: RepoConfig, pr: number, head: string, streak: NoCommitStreak | undefined): Promise<number | null> {
  const count = noCommitCount(streak, head) + 1;
  const ok = await updatePrRecord(repoConfig, pr, (d) => { d.noCommit = { head, count }; });
  if (!ok) return null;
  seenOf(repoConfig).add(pr);
  return count;
}

/**
 * Put PR `pr`'s streak back as it was before a round was admitted (`recordNoCommit` ahead of a session): the
 * session failed, or never ran. False when that could not be saved; the round then stays counted, which can
 * only make the stalemate come sooner, never later.
 */
export async function restoreNoCommitStreak(repoConfig: RepoConfig, pr: number, prior: NoCommitStreak | undefined): Promise<boolean> {
  const ok = await updatePrRecord(repoConfig, pr, (d) => { if (prior) d.noCommit = prior; else delete d.noCommit; });
  if (ok && !prior) seenOf(repoConfig).delete(pr);
  return ok;
}

/** Forget PR `pr`'s streak: it pushed a commit, or someone pushed to it. False when that could not be saved. */
export async function clearNoCommitStreak(repoConfig: RepoConfig, pr: number): Promise<boolean> {
  const ok = await updatePrRecord(repoConfig, pr, (d) => { delete d.noCommit; });
  if (ok) seenOf(repoConfig).delete(pr);
  return ok;
}

/** The PRs this process knows a streak on. */
export function prsWithNoCommitStreak(repoConfig: RepoConfig): number[] {
  return [...seenOf(repoConfig)];
}

/** Tests only. */
export function resetNoCommitStreaksForTests(): void {
  seen.clear();
}
