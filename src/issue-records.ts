// The Foreman's durable per-issue records (EM#1244 f2): what it holds an issue
// back for, and what it already told the EM about it. They live in the work
// source's record store (adapters.ts `loadRecord` / `saveRecord`), one record per
// issue holding every field below; a field that is absent means "none". Core
// reads and writes them only through this module. (EM#1244 f4 deleted state.ts and `.agent-state.json`.)
//
// A record that cannot be read is NOT an empty record. Every read reports the
// issues it could not load, and the caller leaves those alone this cycle (fail
// closed): a GitHub outage must never re-attempt a failed or held issue.

import type { ItemRecord, RecordKey, RecordKind } from "./adapters.js";
import type { RepoConfig } from "./config.js";
import { canonicalJson } from "./record-store.js";
import { activeWorkSource } from "./plugins/registry.js";
import type { UnstickEntry } from "./unstick.js";
import type { SavedRelease } from "./release-tracker.js";
import type { BatchHistory } from "./dependency-batch/ledger.js";

/**
 * A release the release stage is carrying (EM#578), keyed by release PR. Kept
 * so a deploy that merged while the Foreman died is finished after the
 * restart (tagged and verified, never deployed twice), and so a held prod
 * verification is retried on its back-off across restarts.
 */
export interface ProdRelease {
  pr: number;
  url?: string;
  /** The head the Tech Lead approved and the SRE was asked to merge. */
  headSha: string;
  /** The issues the release carries (its `release pending` issues when it started). */
  issues: number[];
  /**
   * `deploying`: handed to the SRE, outcome not yet read. `merged`: merged,
   * tag and verdict not yet recorded. `held`: merged and tagged, prod
   * verification held; re-verified on the prodVerifyRetry back-off.
   * `soaking`: verified and its issues closed; the SRE's 30-minute soak runs
   * once `soakAt` has passed, and the entry goes when it settles.
   */
  phase: "deploying" | "merged" | "held" | "soaking";
  mergeSha?: string;
  /** ISO time the Foreman saw the merge (no earlier than the merge itself). */
  mergedAt?: string;
  /** ISO time from which the soak may run: 30 minutes after `mergedAt`. */
  soakAt?: string;
  /** The soak ran (whatever it found): a release is soaked once, never again. */
  soaked?: boolean;
  tag?: string;
  /** The last hold slug, so a re-verify that holds for the same reason comments once. */
  hold?: string;
  evidence?: string;
  /** Prod verifications that did not pass. */
  attempts: number;
  /** ISO time before which a held release is not re-verified. */
  retryAt?: string;
  /** The production branch head at the last prod verification attempt; a different head makes a held release due now. */
  verifiedHead?: string;
  /** ISO time the release stage started it. */
  since: string;
  /**
   * Merged by someone else (a person, or before this stage existed): the
   * release stage adopted it for prod verification, soak and close, and never
   * asked the Tech Lead or the SRE to deploy it.
   */
  adopted?: boolean;
}

/** Consecutive no-commit revisions on one PR head. A different head starts afresh. */
export interface NoCommitStreak {
  head: string;
  count: number;
  /** A paid session was admitted at `head` and its outcome is not known yet: not a round, never counted (no-commit-streak.ts). */
  inflight?: true;
  /** When the last no-commit round was counted (ISO). An EM scope ruling posted after it releases the stalemate. Absent on records written before 2026-11-05. */
  at?: string;
}

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
  /**
   * The merge base of the branch divergence this issue was told about (EM#1244 f4, was `branchBlock.announced`).
   * One divergence episode is one merge base, so the notice is posted once per issue per episode.
   */
  divergenceTold?: string;
}

/** The record fields that are one value per issue; `unstick` is a map inside the record. */
export type IssueField = keyof IssueRecord;

/** What a read of several issues found: the records, and the issues that could not be read. */
export interface IssueRecords {
  readonly records: ReadonlyMap<number, IssueRecord>;
  /** Never to be treated as "no record": the caller must not act on these issues this cycle. */
  readonly unavailable: ReadonlySet<number>;
}

const FIELDS: readonly IssueField[] = ["failed", "skipped", "held", "verifyHeld", "unstick", "prodVerified", "promotionStallNoted", "divergenceTold"];

/** A repo's own record is addressed with this number; no issue or PR is 0. */
const REPO_RECORD_NUMBER = 0;

const keyOf = (repoConfig: RepoConfig, number: number, kind: RecordKind = "issue"): RecordKey => ({ repo: repoConfig.githubRepo, kind, number });

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

// ---- Repo-level records (EM#1244 f4) ----

/**
 * A block an observer (the Paperclip mirror) put on one of its cards: why (`reason`, the card's unblock action),
 * whose it is when not the stage's owner (`owner`, a role key), the stage its issue was at when it was blocked
 * (`at`; null: not yet known), and whether it waits on an EM scope ruling (`ruling`). Kept so a restart re-reads
 * them instead of guessing (EM#1150 f6).
 */
export interface CardBlockRecord {
  reason?: string;
  owner?: string;
  at?: string | null;
  ruling?: boolean;
}

/**
 * The Foreman's facts about a repo that no issue or PR owns. A field that is absent means "none".
 * A card block is here, not on an issue, because a card is Paperclip's and its uuid is the only key the
 * mirror holds at restart; the block names the repo it belongs to, so each repo record carries its own.
 */
export interface RepoRecord {
  /** The questions put to the EM that name no issue (`0:<kind>[:<tag>]`; was `repoUnstick`). */
  unstick?: Record<string, UnstickEntry>;
  /** Ids of the EM divergence rulings already carried out or failed (was `branchBlock.ruled`): a ruling is acted on once, never retried. */
  divergenceRuled?: string[];
  /** The Paperclip card blocks of this repo's cards, by card id (was `cardBlocks`). */
  cardBlocks?: Record<string, CardBlockRecord>;
  /** What became of each dependency batch, by batch key (PRs + head SHAs): the dependency sweep's durable memory (foreman#230). */
  dependencyBatches?: Record<string, BatchHistory>;
}

export type RepoField = keyof RepoRecord;
const REPO_FIELDS: readonly RepoField[] = ["unstick", "divergenceRuled", "cardBlocks", "dependencyBatches"];

/** What `actionableIssues` sorts a set of issues into. */
export interface Actionable {
  ok: number[];
  withheld: number[];
  loaded: IssueRecords;
}

/**
 * The record store of one Foreman runtime: reads and writes of the issue, PR and repo records through the work
 * source, and what is withheld until the one-time legacy import (legacy-records.ts) has moved it. The marks and
 * the write queue are this instance's, so a second store starts with nothing withheld and nothing queued.
 */
export class IssueRecordStore {
  /** Issues whose legacy `.agent-state.json` entry has not been imported yet, by repo: their store record is not the whole truth. */
  private readonly unimported = new Map<string, Set<number>>();
  /** PRs whose legacy `.agent-state.json` entry has not been imported yet, by repo (the PR-keyed twin of `unimported`). */
  private readonly unimportedPrs = new Map<string, Set<number>>();
  /** Branches whose legacy rejected-head entry could not be tied to a closed PR yet, by repo. */
  private readonly unresolvedBranches = new Map<string, Set<string>>();
  /** Repos whose legacy `.agent-state.json` repo-level entries (EM questions, card blocks) are not all imported yet, with what is pending. */
  private readonly unimportedRepos = new Map<string, Set<string>>();
  /** One writer per record at a time: a change is load, edit, save, and lanes run side by side. */
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Set by the one-time import (legacy-records.ts): the issues of `githubRepo` whose legacy entry could not be saved. */
  setUnimported(githubRepo: string, issues: ReadonlySet<number>): void {
    if (issues.size > 0) this.unimported.set(githubRepo, new Set(issues));
    else this.unimported.delete(githubRepo);
  }

  /** Set by the one-time import (legacy-records.ts): the PRs of `githubRepo` whose legacy entry could not be saved. */
  setUnimportedPrs(githubRepo: string, prs: ReadonlySet<number>): void {
    if (prs.size > 0) this.unimportedPrs.set(githubRepo, new Set(prs));
    else this.unimportedPrs.delete(githubRepo);
  }

  /** Set by the one-time import: the rejected branches of `githubRepo` whose entry is still in the file. */
  setUnresolvedBranches(githubRepo: string, branches: ReadonlySet<string>): void {
    if (branches.size > 0) this.unresolvedBranches.set(githubRepo, new Set(branches));
    else this.unresolvedBranches.delete(githubRepo);
  }

  /**
   * Set by the one-time import (legacy-records.ts): true while a repo-level legacy entry of `githubRepo` could not be
   * saved. `what` names the kind of entry, so the questions and the card blocks settle independently.
   */
  setRepoUnimported(githubRepo: string, pending: boolean, what = "records"): void {
    const kinds = this.unimportedRepos.get(githubRepo) ?? new Set<string>();
    if (pending) kinds.add(what);
    else kinds.delete(what);
    if (kinds.size > 0) this.unimportedRepos.set(githubRepo, kinds);
    else this.unimportedRepos.delete(githubRepo);
  }

  /** True while `branch`'s rejected-head entry has not been moved into a PR record: what the EM was told about it is unknown. */
  branchUnresolved(repoConfig: RepoConfig, branch: string): boolean {
    return this.unresolvedBranches.get(repoConfig.githubRepo)?.has(branch) === true;
  }

  private withheld(repoConfig: RepoConfig, n: number): boolean {
    return this.unimported.get(repoConfig.githubRepo)?.has(n) === true;
  }

  private prWithheld(repoConfig: RepoConfig, n: number): boolean {
    return this.unimportedPrs.get(repoConfig.githubRepo)?.has(n) === true;
  }

  private repoRecordWithheld(repoConfig: RepoConfig): boolean {
    return this.unimportedRepos.has(repoConfig.githubRepo);
  }

  private serially<T>(key: RecordKey, job: () => Promise<T>): Promise<T> {
    const id = `${key.repo}/${key.kind}#${key.number}`;
    const run = (this.chains.get(id) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => undefined);
    this.chains.set(id, tail);
    void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return run;
  }

  /** The record of one issue; null when it cannot be read (never an empty record in its place). */
  async loadIssueRecord(repoConfig: RepoConfig, n: number): Promise<IssueRecord | null> {
    const source = activeWorkSource();
    if (!source || this.withheld(repoConfig, n)) return null;
    const load = await source.loadRecord(keyOf(repoConfig, n), repoConfig);
    if (load.status === "unavailable") return null;
    return load.status === "found" ? (load.record as IssueRecord) : {};
  }

  /** The records of `numbers`, each read once; an issue that cannot be read is in `unavailable`, not in `records`. */
  async loadIssueRecords(repoConfig: RepoConfig, numbers: Iterable<number>): Promise<IssueRecords> {
    const records = new Map<number, IssueRecord>();
    const unavailable = new Set<number>();
    for (const n of new Set(numbers)) {
      const record = await this.loadIssueRecord(repoConfig, n);
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
  async actionableIssues(repoConfig: RepoConfig, numbers: Iterable<number>): Promise<Actionable> {
    const all = [...new Set(numbers)];
    const loaded = await this.loadIssueRecords(repoConfig, all);
    return { ok: all.filter((n) => !loaded.unavailable.has(n)), withheld: all.filter((n) => loaded.unavailable.has(n)), loaded };
  }

  /**
   * Change one issue's record: `change` edits a copy; the result is saved when it differs. Resolves
   * `false` when the record could not be read or saved, in which case nothing changed.
   */
  updateIssueRecord(repoConfig: RepoConfig, n: number, change: (draft: IssueRecord) => void): Promise<boolean> {
    return this.edit(repoConfig, n, change, false);
  }

  /** The one-time import's write (legacy-records.ts): like `updateIssueRecord`, but allowed on an issue still withheld for want of this very import. */
  importIssueRecord(repoConfig: RepoConfig, n: number, change: (draft: IssueRecord) => void): Promise<boolean> {
    return this.edit(repoConfig, n, change, true);
  }

  private edit(repoConfig: RepoConfig, n: number, change: (draft: IssueRecord) => void, importing: boolean): Promise<boolean> {
    return this.mutateRecord<IssueRecord>(keyOf(repoConfig, n), repoConfig, () => !importing && this.withheld(repoConfig, n), change, (draft) => {
      for (const f of FIELDS) if (draft[f] === undefined) delete draft[f];
      if (draft.unstick && Object.keys(draft.unstick).length === 0) delete draft.unstick;
    });
  }

  /**
   * The one load–clone–change–normalize–compare–save pipeline every record kind goes through (issue, PR, repo).
   * `blocked` withholds the record (its legacy import has not settled); `normalize` drops what holds nothing, per kind.
   * Resolves `false` when the record could not be read or saved, in which case nothing changed.
   */
  private mutateRecord<R extends object>(
    key: RecordKey,
    repoConfig: RepoConfig,
    blocked: () => boolean,
    change: (draft: R) => void,
    normalize: (draft: R & Record<string, unknown>) => void,
  ): Promise<boolean> {
    return this.serially(key, async () => {
      const source = activeWorkSource();
      if (!source || blocked()) return false;
      const load = await source.loadRecord(key, repoConfig);
      if (load.status === "unavailable") return false;
      const before: ItemRecord = load.status === "found" ? load.record : {};
      const draft = structuredClone(before) as R & Record<string, unknown>;
      change(draft);
      normalize(draft);
      // A record with nothing to record stays absent: no comment for an empty record.
      if (load.status === "absent" && Object.keys(draft).length === 0) return true;
      if (canonicalJson(draft) === canonicalJson(before)) return true;
      return source.saveRecord(key, draft, repoConfig);
    });
  }

  /**
   * Save `field` for each issue where `after` differs from `before` (both by issue number): set it, or remove it
   * where `after` has none. Resolves with the issues whose save failed.
   */
  async saveFieldChanges<F extends Exclude<IssueField, "unstick">>(
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
      const ok = await this.updateIssueRecord(repoConfig, n, (draft) => { draft[field] = next; });
      if (!ok) failed.push(n);
    }
    return failed;
  }

  /** The record of PR `n`; null when it cannot be read (never an empty record in its place). */
  async loadPrRecord(repoConfig: RepoConfig, n: number): Promise<PrRecord | null> {
    const source = activeWorkSource();
    if (!source || this.prWithheld(repoConfig, n)) return null;
    const load = await source.loadRecord(keyOf(repoConfig, n, "pr"), repoConfig);
    if (load.status === "unavailable") return null;
    return load.status === "found" ? (load.record as PrRecord) : {};
  }

  /** The records of `numbers`, each read once; a PR that cannot be read is in `unavailable`, not in `records`. */
  async loadPrRecords(repoConfig: RepoConfig, numbers: Iterable<number>): Promise<PrRecords> {
    const records = new Map<number, PrRecord>();
    const unavailable = new Set<number>();
    for (const n of new Set(numbers)) {
      const record = await this.loadPrRecord(repoConfig, n);
      if (record) records.set(n, record);
      else unavailable.add(n);
    }
    return { records, unavailable };
  }

  /** Change PR `n`'s record: `change` edits a copy; the result is saved when it differs. Resolves `false` when it could not be read or saved, in which case nothing changed. */
  updatePrRecord(repoConfig: RepoConfig, n: number, change: (draft: PrRecord) => void): Promise<boolean> {
    return this.editPr(repoConfig, n, change, false);
  }

  /** The one-time import's write: like `updatePrRecord`, but allowed on a PR still withheld for want of this very import. */
  importPrRecord(repoConfig: RepoConfig, n: number, change: (draft: PrRecord) => void): Promise<boolean> {
    return this.editPr(repoConfig, n, change, true);
  }

  private editPr(repoConfig: RepoConfig, n: number, change: (draft: PrRecord) => void, importing: boolean): Promise<boolean> {
    return this.mutateRecord<PrRecord>(keyOf(repoConfig, n, "pr"), repoConfig, () => !importing && this.prWithheld(repoConfig, n), change, (draft) => {
      for (const f of PR_FIELDS) if (draft[f] === undefined) delete draft[f];
    });
  }

  /** The repo record of `repoConfig`; null when it cannot be read (never an empty record in its place). */
  async loadRepoRecord(repoConfig: RepoConfig): Promise<RepoRecord | null> {
    const source = activeWorkSource();
    if (!source || this.repoRecordWithheld(repoConfig)) return null;
    const load = await source.loadRecord(keyOf(repoConfig, REPO_RECORD_NUMBER, "repo"), repoConfig);
    if (load.status === "unavailable") return null;
    return load.status === "found" ? (load.record as RepoRecord) : {};
  }

  /** Change the repo's record: `change` edits a copy; the result is saved when it differs. Resolves `false` when it could not be read or saved, in which case nothing changed. */
  updateRepoRecord(repoConfig: RepoConfig, change: (draft: RepoRecord) => void): Promise<boolean> {
    return this.editRepo(repoConfig, change, false);
  }

  /** The one-time import's write: like `updateRepoRecord`, but allowed while the repo record is still withheld for want of this very import. */
  importRepoRecord(repoConfig: RepoConfig, change: (draft: RepoRecord) => void): Promise<boolean> {
    return this.editRepo(repoConfig, change, true);
  }

  private editRepo(repoConfig: RepoConfig, change: (draft: RepoRecord) => void, importing: boolean): Promise<boolean> {
    return this.mutateRecord<RepoRecord>(keyOf(repoConfig, REPO_RECORD_NUMBER, "repo"), repoConfig, () => !importing && this.repoRecordWithheld(repoConfig), change, (draft) => {
      for (const f of REPO_FIELDS) {
        const v = draft[f];
        if (v === undefined || (Array.isArray(v) ? v.length === 0 : typeof v === "object" && v !== null && Object.keys(v).length === 0)) delete draft[f];
      }
    });
  }
}
