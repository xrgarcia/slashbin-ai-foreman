// Consecutive revisions that pushed nothing BY DECLARATION, per PR head.
//
// A declared no-commit is a valid answer, so it returns to `pr under review`
// and gets re-reviewed. But if the reviewer (or QA) then asks for the same
// change again, the pair ping-pongs forever at no cost to either side and with
// nothing changing. One is an answer; two on the same head is a disagreement,
// and a disagreement between two agents is a human's call.
//
// Keyed by PR and head SHA and persisted in the repo state, so neither an idle
// revise pass nor a restart resets it. It used to be a per-repo counter cleared
// on any pass with no pending revision; with qaBeforeMerge every round has such
// a pass (the card sits in review while QA runs), so it never reached two and
// Slashbin-console PR #1597 looped QA FAIL → no-commit 15+ times on one SHA
// (foreman#167, 2026-11-01). It ends only when the head moves (a push), or the
// PR closes or merges.

import { loadRepoState, saveRepoState, type NoCommitStreak } from "./state.js";

/** One no-commit is an answer; one more on the same head is a stalemate. */
export const MAX_CONSECUTIVE_NO_COMMIT = 1;

function streaksOf(repoName: string): Record<number, NoCommitStreak> {
  return loadRepoState(repoName).noCommitStreaks ?? {};
}

function saveStreaks(repoName: string, streaks: Record<number, NoCommitStreak>): void {
  const state = loadRepoState(repoName);
  saveRepoState(repoName, { ...state, noCommitStreaks: Object.keys(streaks).length ? streaks : undefined });
}

/** No-commit revisions in a row on PR `pr` at `head`; 0 once the head has moved. */
export function noCommitCount(repoName: string, pr: number, head: string): number {
  const streak = streaksOf(repoName)[pr];
  return streak && streak.head === head ? streak.count : 0;
}

/** Count one more no-commit revision on PR `pr` at `head`. A head the streak has not seen starts it at one. */
export function recordNoCommit(repoName: string, pr: number, head: string): void {
  const streaks = streaksOf(repoName);
  streaks[pr] = { head, count: noCommitCount(repoName, pr, head) + 1 };
  saveStreaks(repoName, streaks);
}

/** The head PR `pr` is in a no-commit stalemate on, or undefined when it is in none. */
export function stalemateHead(repoName: string, pr: number): string | undefined {
  const streak = streaksOf(repoName)[pr];
  return streak && streak.count > MAX_CONSECUTIVE_NO_COMMIT ? streak.head : undefined;
}

/** Forget PR `pr`'s streak: it pushed a commit, or someone pushed to it. */
export function clearNoCommitStreak(repoName: string, pr: number): void {
  const streaks = streaksOf(repoName);
  if (!(pr in streaks)) return;
  delete streaks[pr];
  saveStreaks(repoName, streaks);
}

/** The PRs with a streak on record. */
export function prsWithNoCommitStreak(repoName: string): number[] {
  return Object.keys(streaksOf(repoName)).map(Number);
}
