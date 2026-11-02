// The Foreman's durable per-issue records (EM#1244 f2): what it holds an issue
// back for, and what it already told the EM about it. They live in the work
// source's record store (adapters.ts `loadRecord` / `saveRecord`), one record per
// issue holding every field below; a field that is absent means "none". Core
// reads and writes them only through this module, never through state.ts.
//
// A record that cannot be read is NOT an empty record. Every read reports the
// issues it could not load, and the caller leaves those alone this cycle (fail
// closed): a GitHub outage must never re-attempt a failed or held issue.

import type { ItemRecord, RecordKey, RecordKind } from "./adapters.js";
import type { RepoConfig } from "./config.js";
import { canonicalJson } from "./record-store.js";
import { activeWorkSource } from "./plugins/registry.js";
import type { UnstickEntry } from "./unstick.js";
import type { NoCommitStreak, ProdRelease } from "./state.js";
import type { SavedRelease } from "./release-tracker.js";

export interface FailedIssue {
  count: number;
  lastError: string;
}

export interface SkippedIssue {
  lastSkippedAt: string; // ISO timestamp
  reason: string;
  // Consecutive times the agent has skipped this issue. Drives the ESCALATING
  // back-off (a fixed snooze never gives up, so a permanently-unactionable issue
  // costs one agent session per window forever — slashbin-ai-foreman#32).
  // Absent is read as 0, i.e. the original single-window behavior.
  skipCount?: number;
  // What the skip said it waits on (`owner/repo#N`), when it named one. Held
  // under `backoff.skip.hold`, the issue runs again once this closes or merges.
  // Absent: held until the issue changes, with `lastSkippedAt` as the baseline.
  waitingOn?: string;
  // Held: when a check let it run again (its issue changed, its `waiting_on`
  // closed, a transient cleared). It is admitted until a session ends on it;
  // `skipCount` stands, so the attempt cap counts every session.
  releasedAt?: string;
  // Held: when it used up `backoff.skip.maxAttempts` and was escalated for the
  // EM's ruling. From then on only a person changing the issue releases it,
  // and that release clears the entry, count included.
  escalatedAt?: string;
  // The issues blocked by this one (`owner/repo#N`) that were told, once, that
  // this build ended with no PR and will not land by itself (dead-blocker.ts).
  deadBlockerTold?: string[];
  // The subset of those with an EM handoff on record. Kept apart so a dependent
  // told while its repo was outside the config is escalated on a later pass.
  deadBlockerEscalated?: string[];
}

/**
 * An issue whose reviewer DELIBERATELY withheld the outcome label (trailer
 * `hold=`), e.g. an acceptance criterion that cannot be observed until a later
 * time boundary. Distinct from a dropped label: neither the label reconciler nor
 * dead-zone recovery may overwrite it.
 */
export interface HeldIssue {
  /** ISO timestamp of the review run that declared the hold. */
  heldAt: string;
  /** The PR whose review declared it. */
  prNumber: number;
  /** Why the reviewer withheld the outcome label, verbatim from the trailer. */
  reason: string;
}

/** A merged PR whose dev verification did not pass (EM#440). */
export interface VerifyHold {
  /** ISO timestamp of the last verify attempt. */
  heldAt: string;
  prNumber: number;
  /** The SRE's hold slug, or the error that left no verdict. */
  reason: string;
  /** Verify runs spent on this issue so far. */
  attempts: number;
  /** ISO time the SRE said the criterion becomes observable (`hold=wait-until-…`); not retried before it. */
  retryAt?: string;
  /** Legacy: holds written before 2026-10-31, when the Foreman filed its own rework issue. Read so they finish; never written. */
  rework?: { issue: number | null; landed: boolean };
  /**
   * What the EM is shown on the first failure (`rework-decision`): the files the PR touched, the evidence links
   * and the verdict tail. Set by a visual QA FAIL or a charged verification failure that returned a verdict.
   */
  decision?: { files: string[]; evidence: string[]; verdict: string };
}

/** A passed prod verification: the evidence the promote stage's 0-diff path may close on. */
export interface ProdVerified {
  pr: number;
  mergeSha: string;
  tag?: string;
  evidence?: string;
  /** ISO time it passed. */
  at: string;
}

/** Everything the Foreman records about one issue (this feature's fields; the store keeps any other key it finds). */
export interface IssueRecord {
  failed?: FailedIssue;
  skipped?: SkippedIssue;
  held?: HeldIssue;
  verifyHeld?: VerifyHold;
  /** The EM questions asked about this issue, by `unstickKey` (src/unstick.ts). */
  unstick?: Record<string, UnstickEntry>;
  prodVerified?: ProdVerified;
  /** The promote stage already commented on this issue's promotion stall (EM#578). */
  promotionStallNoted?: true;
}

/** The record fields that are one value per issue; `unstick` is a map inside the record. */
export type IssueField = keyof IssueRecord;

/** What a read of several issues found: the records, and the issues that could not be read. */
export interface IssueRecords {
  readonly records: ReadonlyMap<number, IssueRecord>;
  /** Never to be treated as "no record": the caller must not act on these issues this cycle. */
  readonly unavailable: ReadonlySet<number>;
}

const FIELDS: readonly IssueField[] = ["failed", "skipped", "held", "verifyHeld", "unstick", "prodVerified", "promotionStallNoted"];

const keyOf = (repoConfig: RepoConfig, number: number, kind: RecordKind = "issue"): RecordKey => ({ repo: repoConfig.githubRepo, kind, number });

/** Issues whose legacy `.agent-state.json` entry has not been imported yet, by repo: their store record is not the whole truth. */
const unimported = new Map<string, Set<number>>();

/** Set by the one-time import (legacy-records.ts): the issues of `githubRepo` whose legacy entry could not be saved. */
export function setUnimported(githubRepo: string, issues: ReadonlySet<number>): void {
  if (issues.size > 0) unimported.set(githubRepo, new Set(issues));
  else unimported.delete(githubRepo);
}

function withheld(repoConfig: RepoConfig, n: number): boolean {
  return unimported.get(repoConfig.githubRepo)?.has(n) === true;
}

/** PRs whose legacy `.agent-state.json` entry has not been imported yet, by repo (the PR-keyed twin of `unimported`). */
const unimportedPrs = new Map<string, Set<number>>();
/** Branches whose legacy rejected-head entry could not be tied to a closed PR yet, by repo. */
const unresolvedBranches = new Map<string, Set<string>>();

/** Set by the one-time import (legacy-records.ts): the PRs of `githubRepo` whose legacy entry could not be saved. */
export function setUnimportedPrs(githubRepo: string, prs: ReadonlySet<number>): void {
  if (prs.size > 0) unimportedPrs.set(githubRepo, new Set(prs));
  else unimportedPrs.delete(githubRepo);
}

/** Set by the one-time import: the rejected branches of `githubRepo` whose entry is still in the file. */
export function setUnresolvedBranches(githubRepo: string, branches: ReadonlySet<string>): void {
  if (branches.size > 0) unresolvedBranches.set(githubRepo, new Set(branches));
  else unresolvedBranches.delete(githubRepo);
}

/** True while `branch`'s rejected-head entry has not been moved into a PR record: what the EM was told about it is unknown. */
export function branchUnresolved(repoConfig: RepoConfig, branch: string): boolean {
  return unresolvedBranches.get(repoConfig.githubRepo)?.has(branch) === true;
}

function prWithheld(repoConfig: RepoConfig, n: number): boolean {
  return unimportedPrs.get(repoConfig.githubRepo)?.has(n) === true;
}

// One writer per record at a time: a change is load, edit, save, and lanes run side by side.
const chains = new Map<string, Promise<unknown>>();

function serially<T>(key: RecordKey, job: () => Promise<T>): Promise<T> {
  const id = `${key.repo}/${key.kind}#${key.number}`;
  const run = (chains.get(id) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => undefined);
  chains.set(id, tail);
  void tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return run;
}

/** The record of one issue; null when it cannot be read (never an empty record in its place). */
export async function loadIssueRecord(repoConfig: RepoConfig, n: number): Promise<IssueRecord | null> {
  const source = activeWorkSource();
  if (!source || withheld(repoConfig, n)) return null;
  const load = await source.loadRecord(keyOf(repoConfig, n), repoConfig);
  if (load.status === "unavailable") return null;
  return load.status === "found" ? (load.record as IssueRecord) : {};
}

/** The records of `numbers`, each read once; an issue that cannot be read is in `unavailable`, not in `records`. */
export async function loadIssueRecords(repoConfig: RepoConfig, numbers: Iterable<number>): Promise<IssueRecords> {
  const records = new Map<number, IssueRecord>();
  const unavailable = new Set<number>();
  for (const n of new Set(numbers)) {
    const record = await loadIssueRecord(repoConfig, n);
    if (record) records.set(n, record);
    else unavailable.add(n);
  }
  return { records, unavailable };
}

/**
 * Which of `numbers` a pass may act on: those whose record can be read. The one owner of that question for
 * the release stage and its neighbours: a pass loads once, up front, hands only `ok` to anything that
 * comments, labels, closes, deploys or saves, and leaves `withheld` for a later cycle.
 */
export async function actionableIssues(repoConfig: RepoConfig, numbers: Iterable<number>): Promise<{ ok: number[]; withheld: number[]; loaded: IssueRecords }> {
  const all = [...new Set(numbers)];
  const loaded = await loadIssueRecords(repoConfig, all);
  return { ok: all.filter((n) => !loaded.unavailable.has(n)), withheld: all.filter((n) => loaded.unavailable.has(n)), loaded };
}

/**
 * Change one issue's record: `change` edits a copy; the result is saved when it differs. Resolves
 * `false` when the record could not be read or saved, in which case nothing changed.
 */
export function updateIssueRecord(repoConfig: RepoConfig, n: number, change: (draft: IssueRecord) => void): Promise<boolean> {
  return edit(repoConfig, n, change, false);
}

/** The one-time import's write (legacy-records.ts): like `updateIssueRecord`, but allowed on an issue still withheld for want of this very import. */
export function importIssueRecord(repoConfig: RepoConfig, n: number, change: (draft: IssueRecord) => void): Promise<boolean> {
  return edit(repoConfig, n, change, true);
}

function edit(repoConfig: RepoConfig, n: number, change: (draft: IssueRecord) => void, importing: boolean): Promise<boolean> {
  const key = keyOf(repoConfig, n);
  return serially(key, async () => {
    const source = activeWorkSource();
    if (!source || (!importing && withheld(repoConfig, n))) return false;
    const load = await source.loadRecord(key, repoConfig);
    if (load.status === "unavailable") return false;
    const before: ItemRecord = load.status === "found" ? load.record : {};
    const draft = structuredClone(before) as IssueRecord & Record<string, unknown>;
    change(draft);
    for (const f of FIELDS) if (draft[f] === undefined) delete draft[f];
    if (draft.unstick && Object.keys(draft.unstick).length === 0) delete draft.unstick;
    // An issue with no record and nothing to record stays that way: no comment for an empty record.
    if (load.status === "absent" && Object.keys(draft).length === 0) return true;
    if (canonicalJson(draft) === canonicalJson(before)) return true;
    return source.saveRecord(key, draft, repoConfig);
  });
}

/** `field` of each loaded record that has it, by issue number. */
export function fieldTable<F extends Exclude<IssueField, "unstick">>(loaded: IssueRecords, field: F): Record<number, NonNullable<IssueRecord[F]>> {
  const out: Record<number, NonNullable<IssueRecord[F]>> = {};
  for (const [n, record] of loaded.records) {
    const v = record[field];
    if (v !== undefined) out[n] = v as NonNullable<IssueRecord[F]>;
  }
  return out;
}

/** Every unstick entry of the loaded records, by `unstickKey`. */
export function unstickTable(loaded: IssueRecords): Record<string, UnstickEntry> {
  return Object.assign({}, ...[...loaded.records.values()].map((r) => r.unstick ?? {}));
}

/**
 * Save `field` for each issue where `after` differs from `before` (both by issue number): set it, or remove it
 * where `after` has none. Resolves with the issues whose save failed.
 */
export async function saveFieldChanges<F extends Exclude<IssueField, "unstick">>(
  repoConfig: RepoConfig,
  field: F,
  before: Readonly<Record<number, IssueRecord[F]>>,
  after: Readonly<Record<number, IssueRecord[F]>>,
): Promise<number[]> {
  const failed: number[] = [];
  const numbers = new Set([...Object.keys(before), ...Object.keys(after)].map(Number));
  for (const n of numbers) {
    if (canonicalJson(before[n]) === canonicalJson(after[n])) continue;
    const next = after[n];
    const ok = await updateIssueRecord(repoConfig, n, (draft) => { draft[field] = next; });
    if (!ok) failed.push(n);
  }
  return failed;
}

// ---- PR-keyed records (EM#1244 f3) ----

/**
 * Everything the Foreman records about one pull request. A field that is absent means "none"; the store keeps
 * any other key it finds. A PR is at most a few of these at once (a release PR carries `release` and `tracked`).
 */
export interface PrRecord {
  /** This PR is a release PR the release stage is carrying: its phase, issues and progress (was `prodReleases[pr]`). */
  release?: ProdRelease;
  /** The release PR was announced open and its end is not yet announced (was the single `release` pointer). */
  tracked?: SavedRelease;
  /** Consecutive no-commit revisions of this PR at one head (was `noCommitStreaks[pr]`). */
  noCommit?: NoCommitStreak;
  /** This PR was the last one closed unmerged on its branch, and the EM was alerted that the branch still stands at this head (was `rejectedBranches[branch]`). */
  rejectedHead?: string;
}

export type PrField = keyof PrRecord;
const PR_FIELDS: readonly PrField[] = ["release", "tracked", "noCommit", "rejectedHead"];

/** What a read of several PRs found. `unavailable` is never "no record": nothing may act on those PRs this cycle. */
export interface PrRecords {
  readonly records: ReadonlyMap<number, PrRecord>;
  readonly unavailable: ReadonlySet<number>;
}

/** The record of PR `n`; null when it cannot be read (never an empty record in its place). */
export async function loadPrRecord(repoConfig: RepoConfig, n: number): Promise<PrRecord | null> {
  const source = activeWorkSource();
  if (!source || prWithheld(repoConfig, n)) return null;
  const load = await source.loadRecord(keyOf(repoConfig, n, "pr"), repoConfig);
  if (load.status === "unavailable") return null;
  return load.status === "found" ? (load.record as PrRecord) : {};
}

/** The records of `numbers`, each read once; a PR that cannot be read is in `unavailable`, not in `records`. */
export async function loadPrRecords(repoConfig: RepoConfig, numbers: Iterable<number>): Promise<PrRecords> {
  const records = new Map<number, PrRecord>();
  const unavailable = new Set<number>();
  for (const n of new Set(numbers)) {
    const record = await loadPrRecord(repoConfig, n);
    if (record) records.set(n, record);
    else unavailable.add(n);
  }
  return { records, unavailable };
}

/** Change PR `n`'s record: `change` edits a copy; the result is saved when it differs. Resolves `false` when it could not be read or saved, in which case nothing changed. */
export function updatePrRecord(repoConfig: RepoConfig, n: number, change: (draft: PrRecord) => void): Promise<boolean> {
  return editPr(repoConfig, n, change, false);
}

/** The one-time import's write: like `updatePrRecord`, but allowed on a PR still withheld for want of this very import. */
export function importPrRecord(repoConfig: RepoConfig, n: number, change: (draft: PrRecord) => void): Promise<boolean> {
  return editPr(repoConfig, n, change, true);
}

function editPr(repoConfig: RepoConfig, n: number, change: (draft: PrRecord) => void, importing: boolean): Promise<boolean> {
  const key = keyOf(repoConfig, n, "pr");
  return serially(key, async () => {
    const source = activeWorkSource();
    if (!source || (!importing && prWithheld(repoConfig, n))) return false;
    const load = await source.loadRecord(key, repoConfig);
    if (load.status === "unavailable") return false;
    const before: ItemRecord = load.status === "found" ? load.record : {};
    const draft = structuredClone(before) as PrRecord & Record<string, unknown>;
    change(draft);
    for (const f of PR_FIELDS) if (draft[f] === undefined) delete draft[f];
    // A PR with no record and nothing to record stays that way: no comment for an empty record.
    if (load.status === "absent" && Object.keys(draft).length === 0) return true;
    if (canonicalJson(draft) === canonicalJson(before)) return true;
    return source.saveRecord(key, draft, repoConfig);
  });
}

/** Tests only: forget the import marks and any write still queued. */
export function resetIssueRecordsForTests(): void {
  unimportedPrs.clear();
  unresolvedBranches.clear();
  unimported.clear();
  chains.clear();
}
