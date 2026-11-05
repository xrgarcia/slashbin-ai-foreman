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
import type { IssueRecordStore } from "./issue-records.js";
import type { NoCommitStreak } from "./issue-records.js";

// The streak lives on the PR's record in the work source (EM#1244 f3). A read
// that fails is not "no streak": the caller leaves the PR alone this pass.

/** One no-commit is an answer; one more on the same head is a stalemate. */
export const MAX_CONSECUTIVE_NO_COMMIT = 1;

/** No-commit revisions in a row at `head` for a streak; 0 once the head has moved. */
export function noCommitCount(streak: NoCommitStreak | undefined, head: string): number {
  return streak && streak.head === head ? streak.count : 0;
}

/** The head a streak is in a no-commit stalemate on, or undefined when it is in none. */
export function stalemateHead(streak: NoCommitStreak | undefined): string | undefined {
  return streak && streak.count > MAX_CONSECUTIVE_NO_COMMIT ? streak.head : undefined;
}

/** True when `streak` is an unconfirmed marker for `head`. */
export const isUnconfirmed = (streak: NoCommitStreak | undefined, head: string): boolean => !!streak && streak.head === head && streak.inflight === true;

/** The no-commit streaks of one runtime: reads and writes on the PRs' records, and the PRs this process has seen one on. */
export class NoCommitStreaks {
  /** PRs this process has seen a streak on, so a closed PR's streak can be forgotten without listing the store. */
  private readonly seen = new Map<string, Set<number>>();

  constructor(private readonly records: IssueRecordStore) {}

  private seenOf(repoConfig: RepoConfig): Set<number> {
    return this.seen.get(repoConfig.githubRepo) ?? this.seen.set(repoConfig.githubRepo, new Set()).get(repoConfig.githubRepo)!;
  }

  /** The import knows these PRs hold a streak. */
  noteStreakPrs(githubRepo: string, prs: Iterable<number>): void {
    const into = this.seen.get(githubRepo) ?? this.seen.set(githubRepo, new Set()).get(githubRepo)!;
    for (const n of prs) into.add(n);
  }

  /** PR `pr`'s streak: `{ok:true}` with it (or none), or `{ok:false}` when its record cannot be read. */
  async read(repoConfig: RepoConfig, pr: number): Promise<{ ok: true; streak?: NoCommitStreak } | { ok: false }> {
    const record = await this.records.loadPrRecord(repoConfig, pr);
    if (!record) return { ok: false };
    if (record.noCommit) this.seenOf(repoConfig).add(pr);
    return { ok: true, ...(record.noCommit ? { streak: record.noCommit } : {}) };
  }

  /**
   * Admit a paid revision session on PR `pr` at `head`: save an in-flight marker (the count it already has at
   * `head`, unchanged, flagged `inflight`) BEFORE the session starts. A marker that cannot be saved admits no
   * session (a record store that rejects writes would otherwise let every pass pay for a round nothing can
   * track). The marker is not a round: nothing is added to the count, so nothing ever has to be taken back, and a
   * pass that fails after this (an unreadable branch sha, a crash) leaves a marker whose outcome is unknown, which
   * is neither counted nor consumed. One marker at most is outstanding per PR: the next admission replaces it.
   * False when it could not be saved.
   */
  async admitRevision(repoConfig: RepoConfig, pr: number, head: string, streak: NoCommitStreak | undefined): Promise<boolean> {
    const count = noCommitCount(streak, head);
    const at = count > 0 ? streak?.at : undefined;
    const ok = await this.records.updatePrRecord(repoConfig, pr, (d) => { d.noCommit = { head, count, inflight: true, ...(at ? { at } : {}) }; });
    if (ok) this.seenOf(repoConfig).add(pr);
    return ok;
  }

  /**
   * Resolve an unconfirmed marker at `head`: an earlier admission left it (its session finished or died with no
   * successful read after it), and this pass has just READ the branch successfully. The earlier attempt is neither
   * counted nor consumed, so the marker is dropped keeping the count it had, and THIS pass launches nothing: that is
   * what bounds paid retries to one unconfirmed attempt per head, resolved on the next readable pass. False when the
   * resolution could not be saved (the marker stays; the next pass tries again).
   */
  async resolveUnconfirmed(repoConfig: RepoConfig, pr: number, head: string, streak: NoCommitStreak | undefined): Promise<boolean> {
    const count = noCommitCount(streak, head);
    const at = streak?.at;
    return this.records.updatePrRecord(repoConfig, pr, (d) => { if (count > 0) d.noCommit = { head, count, ...(at ? { at } : {}) }; else delete d.noCommit; });
  }

  /**
   * Count the round the in-flight marker stood for: the session completed AND a successful read after it showed
   * the head still `head`, by declaration, so the caller only asks once it has both. Resolves the new count, or
   * null when it could not be saved (the marker stays, the round stays unconfirmed).
   */
  async record(repoConfig: RepoConfig, pr: number, head: string, streak: NoCommitStreak | undefined): Promise<number | null> {
    const count = noCommitCount(streak, head) + 1;
    const ok = await this.records.updatePrRecord(repoConfig, pr, (d) => { d.noCommit = { head, count, at: new Date().toISOString() }; });
    if (!ok) return null;
    this.seenOf(repoConfig).add(pr);
    return count;
  }

  /** Forget PR `pr`'s streak: it pushed a commit, or someone pushed to it. False when that could not be saved. */
  async clear(repoConfig: RepoConfig, pr: number): Promise<boolean> {
    const ok = await this.records.updatePrRecord(repoConfig, pr, (d) => { delete d.noCommit; });
    if (ok) this.seenOf(repoConfig).delete(pr);
    return ok;
  }

  /** The PRs this process knows a streak on. */
  prsWithStreak(repoConfig: RepoConfig): number[] {
    return [...this.seenOf(repoConfig)];
  }
}

/**
 * Whether an EM scope ruling posted at `rulingAt` answers a stalemate whose last
 * counted round was at `since`. Compared as instants, never strings: GitHub
 * stamps whole seconds and rounds are stamped to the millisecond, so a ruling
 * 600 ms older than the round must not sort after it. No `since` (a legacy
 * streak on a PR with no review yet) means nothing has answered the stalemate,
 * so any ruling does; the round that follows records a time, so it never loops.
 */
export function rulingAnswersStalemate(rulingAt: string | null | undefined, since: string | null | undefined): boolean {
  const ruling = rulingAt ? Date.parse(rulingAt) : NaN;
  if (!Number.isFinite(ruling)) return false;
  const boundary = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(boundary)) return true;
  return ruling > boundary;
}
