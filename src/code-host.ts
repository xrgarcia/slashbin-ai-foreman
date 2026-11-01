// The code host as the core sees it (EM#1150 f5): the data it reads back and the
// operations it calls. The GitHub plugin fills it (src/plugins/github.ts) from
// src/github/*, which only the plugin imports. The core reaches it through
// codeHost() in src/plugins/registry.ts.

import type { LifecycleLabels, RepoConfig } from "./config.js";
import type { GithubConventions } from "./config-schema/github.js";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// What the code host returns
// ---------------------------------------------------------------------------
// From github/cache.ts.
/** One open issue in the per-repo snapshot (github/cache.ts explains the snapshot). */
export interface IssueSnapshot {
  number: number;
  title: string;
  labels: { name: string }[];
}

/** One open PR in the per-repo snapshot, with the scalar fields every lookup filters on. */
export interface PrSnapshot {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
}

/**
 * Extract the actionable bits of a thrown gh CLI error so callers can log
 * something useful instead of swallowing the failure. execFileSync attaches
 * `stderr` (Buffer) and `status` (exit code) to the Error it throws.
 */
export interface GhFailure {
  message: string;
  stderr: string;
  status: number | null;
}

// From github/lifecycle-scan.ts.
export interface MergedIssueRef {
  issueNumber: number;
  prNumber: number;
  prUrl: string;
  mergedAt: string;
}

export type StuckMergedIssue = MergedIssueRef;

/**
 * The lifecycle states a review can end in, as `LifecycleLabels` keys.
 * `prMerged` when dev verification is its own stage (EM#440): the reviewer
 * merged, and `pr approved` waits on the verifier.
 */
export type ReviewOutcome = "prApproved" | "prMerged" | "prPendingActions";

// From github/promotion.ts.

export interface PromotionIssue {
  number: number;
  title: string;
}

export interface OpenPromotionPR {
  number: number;
  url: string;
  body: string;
}

// From github/release-carry.ts.
/** One PR merged into the base branch and not yet on production. */
export interface CarriedMerge {
  pr: number;
  sha: string;
  title: string;
  /** The issues the PR implements; empty when it names none. */
  issues: number[];
  /** A sync or dependency-bot PR: carries no issue and needs none. */
  exempt: boolean;
}

/** What a release carries beyond the issues it was authorized for. */
export interface ReleaseCarry {
  /** Open issues whose merges are on the base branch and were not authorized: adopted into the release. */
  adopted: PromotionIssue[];
  /** The PRs that merged them, by issue number. */
  prsByIssue: Map<number, number[]>;
  /** Merges that link to no issue. */
  unlinked: Array<{ pr: number; title: string }>;
}

// From github/branch.ts.

export interface BranchDrift {
  developBehindMain: number;
  developAheadOfMain: number;
  /** Files differing between main and develop. Zero means merge-commit-only drift. */
  developAheadFiles: number;
  /**
   * The paths of those files, as GitHub lists them (capped at
   * `COMPARE_FILE_CAP` in github/branch.ts). Absent when the compare did not return them.
   */
  developAheadPaths?: string[];
}

// From github/dependencies.ts.
/** One dependency PR, reduced to what the issue body needs to say about it. */
export interface DependencyChange {
  number: number;
  packages: string[];
  from?: string;
  to?: string;
  /** True when the leading version component moves. `0.x` counts every minor. */
  major: boolean;
}

// From github/review-queue.ts.

export interface PendingRevisionPR {
  number: number;
  url: string;
  headRefName: string;
  /** The PR's head commit: an unblock check compares it to where the Foreman stopped. */
  headRefOid?: string;
}

export interface PendingRevisionInfo {
  issueNumbers: number[];
  pr: PendingRevisionPR;
}

export interface ReviewCandidate {
  prNumber: number;
  prUrl: string;
  issueNumbers: number[];
  /**
   * The subset of `issueNumbers` adopted by the orphan fallback — the ones the
   * caller must report `new → inReview` for. Empty on the normal path, where
   * every issue already carries `pr under review`.
   */
  adopted: number[];
  /**
   * True when the PR's current verdict is CHANGES_REQUESTED but its issues still
   * sit at `pr under review`: the review landed, its label move did not. The
   * caller reports them `inReview → changesRequested` instead of reviewing.
   */
  stranded?: boolean;
}

/** An approved, unmerged feature PR whose head QA has yet to pass (config.qaBeforeMerge). */
export interface QaPendingPr {
  prNumber: number;
  issueNumbers: number[];
  /** The head commit the approval covers; QA's PASS must name this sha. */
  headSha: string;
}

// From github/ci-gate.ts.
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

// From github/release.ts.
/** An issue read live, open or closed: the snapshot holds open issues only. */
export interface IssueView {
  state: "OPEN" | "CLOSED";
  labels: string[];
}

/** A release PR read live. */
export interface ReleasePrView {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** The full 40-character head SHA: what the Tech Lead approves and the SRE pins the merge to. */
  headSha: string;
  /** The merge commit, once merged. */
  mergeSha: string | null;
  /** ISO merge time, once merged. */
  mergedAt: string | null;
  body: string;
}

// From github/reports.ts.
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

// From github/skip-hold.ts.
/** What a skip says it waits on: another issue or PR, by structured reference. */
export interface WaitingOn {
  repo: string;
  number: number;
}

/** Where a waited-on reference stands: open or done, and whether it is a PR. */
export interface RefState {
  open: boolean;
  isPr: boolean;
  merged: boolean;
}

/** One change on the issue: when, by whom, and what kind (absent reads as an action). */
export interface IssueActivity {
  at: string;
  login?: string;
  kind?: "edit" | "comment" | "event";
  /** A comment opening `**EM unstick`: the EM's note from an unstick call. It is talk about the hold, never a change to the issue. */
  emUnstick?: boolean;
}

/** The reads a hold decision makes, injectable so the decision is testable without GitHub. */
export interface HoldReads {
  /** The waited-on reference's state. Throws when GitHub cannot say. */
  refState(ref: WaitingOn): RefState;
  /** The issue's changes after `since`. Throws when GitHub cannot say. */
  activitySince(since: string): IssueActivity[];
  /** The Foreman's own login; its writes never release a hold. */
  self: string | undefined;
  /** Other agents' logins (`backoff.skip.agentLogins`); their comments never release an escalated hold. */
  agents?: readonly string[];
}

/** What a held skip entry carries into the decision. */
export interface HeldEntry {
  lastSkippedAt: string;
  reason: string;
  skipCount?: number;
  waitingOn?: string;
  releasedAt?: string;
  escalatedAt?: string;
}

/** Whether a held skip runs a session this cycle. */
export type SkipGate =
  /**
   * Run it. `by` is the check that released it this cycle (absent: released
   * on an earlier one, so nothing new to announce). `reset` clears the entry,
   * attempt count included; otherwise the entry stays, marked released.
   */
  | { run: true; by?: "transientCauseGone" | "waitedOnDone" | "issueChanged"; reset: boolean }
  /** Hold it, with the reason the card shows; `escalate` the first time it is out of attempts. */
  | { run: false; reason: string; escalate: boolean };

// From github/dead-blocker.ts.
/** What `announceDeadBlocker` did for one dependent. */
export interface Announced {
  /** `#N` or `owner/repo#N`. */
  ref: string;
  repo: string;
  number: number;
}

// From github/pr.ts.
/**
 * Decide, with no I/O, what a FAILED review run actually earned.
 *
 * Split out from `tryReview` for the same reason as `planEmGateRestore`: the
 * rule is the part worth pinning, and the `gh` calls around it are not.
 *
 * A review run that dies is not automatically a review that achieved nothing.
 * On 2026-09-22 one merged `jerky_skuvault_service#362`, verified it, then spent
 * its remaining 52 minutes polling a backfill that needed longer than the budget
 * it was never told about. The wall-clock kill reported `Review failed (1/2):
 * timed out`, skipped every post-condition check — they all lived inside the
 * success branch — and left the issue dead-zoned for 55 minutes. The merge had
 * already happened; the retry had nothing to retry. Issue #41.
 *
 * So the question is not "did the process exit cleanly" but "did the work land":
 *
 *  - Nothing merged → a plain failure. Charge the retry, exactly as before.
 *  - Something merged → the work landed and the run outlived it. Reconcile the
 *    labels this cycle instead of waiting for the dead-zone sweep, and do NOT
 *    charge a retry: the next cycle would find the PR merged and no work to do.
 *
 * `stillUnderReview` is asked for separately because a run can merge AND label
 * correctly before dying — in which case there is nothing left to reconcile and
 * only the retry accounting changes.
 */
export interface FailedReviewPlan {
  /** True when at least one of the run's issues reached the base branch. */
  workLanded: boolean;
  /** PRs the run merged, deduped, ascending. */
  mergedPrs: number[];
  /** Merged issues still sitting at `pr under review` — the labels to repair. */
  toReconcile: number[];
  /** Whether this run counts against the review retry/backoff counter. */
  chargeRetry: boolean;
}

// ---------------------------------------------------------------------------
// The code host
// ---------------------------------------------------------------------------

/** The fleet state's options the core supplies; the code host adds how it reads. */
export interface CodeHostStateOptions {
  repos: string[];
  /** Refresh when the state is older than this. */
  refreshMs: number;
  /** A full refresh at least this often. */
  fullRefreshMs?: number;
  /** Most open issues per repo a full refresh reads. */
  issueLimit?: number;
  /** Where the state is persisted; omit to keep it in memory only. */
  persistPath?: string;
  logger: Logger;
  now?: () => number;
}

/** One comment or issue body a divergence ruling may be found in. */
export interface IssueTextRow {
  id: string;
  issue: number;
  author: string;
  at: string;
  body: string;
  title?: string;
}

/**
 * Every PR, branch, merge, comment and label operation the core performs, one
 * typed method per operation (EM#1150 f5). The core gets it from codeHost() in
 * src/plugins/registry.ts and never runs the host's CLI itself. Methods that
 * throw say so; the rest report failure in their return value, as before.
 */
export interface CodeHost {
  // Lifecycle: the daemon configures the host's caches and fleet state.
  configureIssueCache(opts: { ttlMs?: number; snapshotLimit?: number }): void;
  configureState(opts: CodeHostStateOptions): void;
  setStateRepos(repos: string[]): void;
  /** The fleet state's query cost since the last call, for the hourly usage line. */
  takeStateUsage(): { stateQueries: number; statePoints: number };
  recordActivity(repo: string, issueNumber: number, step: string, prUrl?: string): void;
  clearActivity(repo: string, issueNumber: number): void;

  // Reads and writes the core used to run the host's CLI for directly.
  /** An issue's `lastEditedAt`: undefined when absent, null when never edited. Throws on a failed read. */
  issueLastEditedAt(repoConfig: RepoConfig, n: number): string | null | undefined;
  /** Every comment on issue `n`. Throws on a failed read. */
  issueCommentRows(repo: string, n: number, cwd: string): IssueTextRow[];
  /** Every open issue (not PR) `creator` opened. Throws on a failed read. */
  openIssueRowsBy(repo: string, creator: string, cwd: string): IssueTextRow[];
  /** The open PR `head → base`, live (at most one). Throws on a failed read. */
  openPrsForBranch(repo: string, head: string, base: string, cwd: string): { number: number; url: string }[];
  /** The last 20 closed PRs `head → base`. Throws on a failed read. */
  closedPrsForBranch(repo: string, head: string, base: string, cwd: string): {
    number: number; url: string; mergedAt: string | null; headRefOid: string; closedAt: string | null;
  }[];
  /** Open a PR; the host's output, which names its URL. Throws on failure. */
  createPr(config: RepoConfig, pr: { base: string; head: string; title: string; body: string }): string;
  /** Every label name on the repo. Throws on a failed read. */
  labelNames(repo: RepoConfig): string[];
  /** Create one label. Throws on failure, an existing label included. */
  createLabel(repo: RepoConfig, name: string, color: string): void;
  /** The open feature PR's URL, asked directly (outside the back-off; the caller checks it). */
  featurePrUrlFallback(config: RepoConfig): string | undefined;

  // Branches: compare, drift, sync PRs.
  checkBranchDrift(repo: string, productionBranch: string, baseBranch: string, cwd: string, logger: Logger): BranchDrift | null;
  checkPRHasChanges(repo: string, headBranch: string, baseBranch: string, cwd: string, logger: Logger): number;
  createSyncPR(repo: string, productionBranch: string, baseBranch: string, behindBy: number, cwd: string, logger?: Logger, conventions?: GithubConventions): string | null;
  findOpenSyncPR(repo: string, productionBranch: string, baseBranch: string, cwd: string, logger?: Logger): OpenPromotionPR | null;
  getRemoteBranchSha(repo: string, branch: string, cwd: string, logger: Logger): string | null;
  productionDriftFiles(drift: BranchDrift): number;
  tryMergeSyncPR(repo: string, prNumber: number, cwd: string, logger?: Logger, productionBranch?: string): boolean;

  // Open issues and PRs, labels, errors.
  forgetOpenPrs(repo: string): void;
  formatGhError(err: unknown): GhFailure;
  getOpenIssues(repo: string, cwd: string, logger: Logger): IssueSnapshot[];
  hasLabel(issue: IssueSnapshot, name: string): boolean;
  isPrOpen(repo: string, prNumber: number, cwd: string): boolean | null;
  knownOpenPr(repo: string, head: string, base: string): {
    number: number;
    url: string;
    headRefOid: string;
} | undefined;
  openIssueLabels(config: RepoConfig, logger: Logger): Array<{
    number: number;
    labels: string[];
}>;

  // CI checks; issue comments.
  bounceForRedCI(config: RepoConfig, prNumber: number, verdict: CheckVerdict): void;
  commentOnIssue(config: RepoConfig, issueNumber: number, body: string): void;
  countCiBouncesSinceReview(config: RepoConfig, prNumber: number, reviewerLogin: string | undefined, logger: Logger): number;
  getPRCheckVerdict(config: RepoConfig, prNumber: number, logger: Logger): CheckVerdict;

  // Dead blockers.
  announceDeadBlocker(config: RepoConfig, blocker: number, reason: string, already?: readonly string[]): {
    told: Announced[];
    failed: {
        ref: string;
        error: string;
    }[];
    open: Announced[];
};
  closeAlreadyLanded(config: RepoConfig, num: number, reason: string): void;
  holdBlocker(config: RepoConfig, num: number): void;
  isDeadBlockerReason(reason: string): boolean;

  // Dependency PRs and their batch issue.
  buildDependencyBatchIssue(featureBranch: string, changes: readonly DependencyChange[], conventions?: GithubConventions, baseBranch?: string): {
    title: string;
    body: string;
};
  createDependencyBatchIssue(repo: string, cwd: string, title: string, body: string, label: string | null, logger?: Logger): number | null;
  dependencyBatchBases(featureBranch: string | undefined, baseBranch: string | undefined, productionBranch: string): string[];
  describeDependencyPR(number: number, title: string): DependencyChange;
  fetchOpenAlertPackages(repo: string, cwd: string): Set<string>;
  findDependencyPRs(repo: string, cwd: string, bases: readonly string[], logger?: Logger, conventions?: GithubConventions): PrSnapshot[];
  findOpenDependencyBatchIssue(repo: string, cwd: string, logger: Logger, conventions?: GithubConventions): IssueSnapshot | undefined;
  selectSecurityPRs<T extends Pick<PrSnapshot, "title" | "body">>(prs: readonly T[], alertPackages: ReadonlySet<string>): T[];

  // Discovery.
  discoveryBatch(config: RepoConfig, offered: number[], logger: Logger, size?: number, labelsOf?: (n: number) => readonly string[]): number[];

  // Merged-to-base and lifecycle scans.
  findIssuesAwaitingVerify(config: RepoConfig, logger: Logger): number[];
  findIssuesMergedToBase(config: RepoConfig, candidates: number[], logger: Logger): MergedIssueRef[];
  findIssuesStillUnderReview(config: RepoConfig, issueNumbers: number[], logger: Logger): number[];
  findOrphanedLifecycleIssues(config: RepoConfig, logger: Logger): number[];
  findRevokedEmGates(config: RepoConfig, issueNumbers: number[], sinceIso: string, logger: Logger): number[];
  findStuckMergedIssues(config: RepoConfig, logger: Logger): StuckMergedIssue[];
  readReviewOutcomes(config: RepoConfig, issueNumbers: number[], logger: Logger): Map<number, ReviewOutcome>;
  restoreEmGate(config: RepoConfig, hadGate: number[], logger: Logger): number[];

  // Issue and PR comments.
  commentBodies(config: RepoConfig, num: number): Promise<string[]>;
  commentOnPr(config: RepoConfig, pr: number, body: string): Promise<void>;
  commentsWithTimes(config: RepoConfig, num: number): Promise<Array<{
    at: string;
    body: string;
}>>;
  hasCommentContaining(config: RepoConfig, num: number, mark: string): Promise<boolean>;
  hasCommentStartingWith(config: RepoConfig, num: number, heading: string): Promise<boolean>;

  // Feature PRs.
  findOpenFeaturePR(config: RepoConfig): {
    number: number;
    headSha: string;
    issueNumbers: number[];
} | null;
  getReferencedIssuesFromOpenPR(repo: string, headBranch: string, baseBranch: string, cwd: string, logger?: Logger): number[] | null;
  planFailedReviewOutcome(mergedRefs: {
    issueNumber: number;
    prNumber: number;
}[], stillUnderReview: number[]): FailedReviewPlan;
  verifyPRExists(repo: string, headBranch: string, baseBranch: string, cwd: string, logger?: Logger): boolean;

  // Promotion PRs and the ready-for-prod set.
  countBranchDiffFiles(repo: string, base: string, head: string, cwd: string, logger: Logger): number;
  createPromotionPR(repo: string, productionBranch: string, baseBranch: string, issues: PromotionIssue[], cwd: string, logger?: Logger, conventions?: GithubConventions, unlinked?: ReleaseCarry["unlinked"]): string | null;
  findOpenPromotionPR(repo: string, productionBranch: string, baseBranch: string, cwd: string, logger?: Logger): OpenPromotionPR | null;
  findReadyForProdIssues(repo: string, cwd: string, labels: LifecycleLabels, logger: Logger): PromotionIssue[];
  getPrState(repo: string, prNumber: number, cwd: string, logger?: Logger): "OPEN" | "MERGED" | "CLOSED" | null;
  stripReadyForProdLabel(repo: string, issueNumbers: number[], cwd: string, labels: LifecycleLabels, logger: Logger): void;
  updatePromotionPR(repo: string, prNumber: number, issues: PromotionIssue[], cwd: string, conventions?: GithubConventions, unlinked?: ReleaseCarry["unlinked"]): boolean;

  // Issue bodies.
  readIssueBody(config: RepoConfig, num: number): string;

  // Release carry.
  adoptCarried(repoConfig: RepoConfig, authorized: ReadonlySet<number>, logger: Logger): ReleaseCarry;
  noteCarried(repoConfig: RepoConfig, carry: ReleaseCarry, releasePr: number, authorized: number[], logger: Logger): Promise<void>;

  // Release sign-off.
  foremanAppliedOrHold(config: RepoConfig, logger: Logger): (n: number) => boolean;
  syncSignoff(config: RepoConfig, pr: number, headSha: string, unsigned: number[], logger: Logger, unresolved?: number[]): Promise<void>;
  unsignedInHead(config: RepoConfig, logger: Logger): {
    unsigned: number[];
    unresolved: number[];
} | null;
  unsignedIssues(open: readonly IssueSnapshot[], listed: ReadonlySet<number>, labels: LifecycleLabels, foremanSigned?: (issue: number) => boolean): number[];

  // Release PRs, tags and holds.
  /** The heading of the comment the release stage leaves when it stops for a person. */
  readonly RELEASE_STOP_MARK: string;
  addBlockedLabel(config: RepoConfig, num: number): void;
  addReleasePrIssues(config: RepoConfig, pr: ReleasePrView, issues: {
    number: number;
    title: string;
}[]): void;
  ensureReleaseTag(config: RepoConfig, sha: string, name: string, message: string): {
    tag: string;
    created: boolean;
};
  findPvComment(config: RepoConfig, pr: number): {
    url: string;
    body: string;
} | null;
  findReleaseStop(config: RepoConfig, num: number): {
    pr: number | null;
    hold: string;
} | null;
  findSreSweepHold(config: RepoConfig, num: number): {
    pr: number;
    url: string;
} | null;
  productionHead(config: RepoConfig): string;
  readPvResult(body: string): {
    pass: true;
} | {
    pass: false;
    hold: string;
} | null;
  recentMergedReleasePrs(config: RepoConfig, sinceIso?: string, limit?: number): ReleasePrView[];
  removeBlockedLabel(config: RepoConfig, num: number): void;
  viewIssue(config: RepoConfig, num: number): IssueView | null;
  viewReleasePr(config: RepoConfig, pr: number): ReleasePrView;

  // PR reads: digest, files, reviews, rulings.
  issueTitles(config: RepoConfig, numbers: ReadonlyArray<number>, logger: Logger): Record<number, string>;
  prChangedFiles(repo: string, pr: number, cwd: string, logger: Logger): string[];
  readLatestReviewBody(repo: string, pr: number, since: string, cwd: string, logger: Logger): string | null;
  readPrDigest(repo: string, pr: string | number, cwd: string, logger: Logger): {
    number: number;
    url: string;
    title: string;
    additions: number;
    deletions: number;
    changedFiles: number;
} | null;
  readRulingState(repo: string, pr: number, cwd: string, logger: Logger): RulingState | null;

  // Review and revision queues.
  findPRsNeedingReview(config: RepoConfig, reviewerLogin: string | undefined, logger: Logger): ReviewCandidate | null;
  findPendingRevisions(config: RepoConfig, logger: Logger): PendingRevisionInfo | null;
  findQaPendingPr(config: RepoConfig, reviewerLogin: string | undefined, logger: Logger): QaPendingPr | null;
  /** The issues among `issueNumbers` that carry `github.blockedLabel` (the EM's hold). */
  blockedAmong(config: RepoConfig, issueNumbers: ReadonlyArray<number>, logger: Logger): number[];
  /** The PR's current head SHA, or null when it cannot be read. */
  readPrHeadSha(config: RepoConfig, prNumber: number, logger: Logger): string | null;
  hasPendingRevisions(config: RepoConfig, logger: Logger): boolean;

  // Skip holds.
  escalatedReason(reason: string, attempts: number): string;
  foremanLogin(cwd: string): string | undefined;
  heldReason(reason: string, repo: string, ref?: WaitingOn, refIsPr?: boolean): string;
  issueActivitySince(repo: string, issue: number, since: string, cwd: string): IssueActivity[];
  parseWaitingOn(raw: string | undefined, repo: string): WaitingOn | undefined;
  refState(ref: WaitingOn, cwd: string): RefState;
  skipGate(entry: HeldEntry, repo: string, maxAttempts: number, reads: HoldReads, transientCleared: () => boolean, onError?: (what: string, err: unknown) => void): SkipGate;
  waitingOnLabel(ref: WaitingOn, repo: string): string;
}
