// The dependency batch ledger: the durable memory of what became of each batch.
//
// The sweep used to decide what to file from the open-issue list alone, so a
// batch that finished with "nothing to land" was invisible the moment its issue
// closed, and the Dependabot PR that caused it was filed again every poll
// (jerky-mcp-services #690-#1081, 397 sessions, 2026-11-05). The ledger is the
// object that owns a batch's outcome.
//
// Durable on purpose: no in-memory state. A restart must not reopen the loop
// (promote.ts, since 2026-09). The implementation keeps the ledger on the repo's
// record in the work source, which on GitHub is the Foreman's record comment
// (github/record-store.ts). Tests inject an in-memory fake of the interface.

import type { RepoConfig } from "../config.js";
import type { IssueRecordStore } from "../issue-records.js";
import { DependencyBatch, type DependencyPrRef } from "./batch.js";

/** How a batch ended. Any of them is terminal: the same batch is never filed again. */
export type BatchOutcome = "landed" | "partial" | "refused";

/** What the ledger holds about one batch key. */
export interface BatchHistory {
  /** The PRs of the batch, so a landed issue can find what to retire. */
  prs: DependencyPrRef[];
  /** ISO time of each filing of this batch, oldest first. */
  filings: string[];
  /** The issues filed for it. */
  issues: number[];
  outcome?: BatchOutcome;
  /** ISO time the outcome was recorded. */
  outcomeAt?: string;
  /** The EM was told this batch is looping and the sweep is holding it. Told once. */
  emNotified?: true;
}

/**
 * The ledger as the sweep and the landing see it. Every method resolves to
 * `null`/`false` when the record cannot be read or saved: a caller never treats
 * "unreadable" as "empty", and files nothing on it.
 */
export interface DependencyBatchLedger {
  /** The history of `batch`: `{}`-like `undefined` when never filed, `null` when the ledger cannot be read. */
  historyOf(repo: RepoConfig, batch: DependencyBatch): Promise<BatchHistory | undefined | null>;
  /** Record a filing of `batch` at `at`. False when it could not be saved (and then nothing may be filed). */
  recordFiling(repo: RepoConfig, batch: DependencyBatch, at: Date): Promise<boolean>;
  /** Attach the issue filed for `batch`. */
  attachIssue(repo: RepoConfig, batch: DependencyBatch, issue: number): Promise<boolean>;
  /** The batch an issue was filed for: `undefined` when it is not a batch issue, `null` when the ledger cannot be read. */
  batchOfIssue(repo: RepoConfig, issue: number): Promise<{ batch: DependencyBatch; history: BatchHistory } | undefined | null>;
  /** Record how `batch` ended. */
  recordOutcome(repo: RepoConfig, batch: DependencyBatch, outcome: BatchOutcome, at: Date): Promise<boolean>;
  /** Record that the EM was told `batch` is looping. */
  markEmNotified(repo: RepoConfig, batch: DependencyBatch): Promise<boolean>;
}

/** Entries that never reached a terminal outcome and have not been filed for this long are dropped. */
const STALE_OPEN_ENTRY_MS = 7 * 24 * 60 * 60_000;

/** The ledger on the repo's record in the work source (GitHub: the Foreman's record comment, via GitHubRecordStore). */
export class RecordStoreDependencyBatchLedger implements DependencyBatchLedger {
  constructor(private readonly records: IssueRecordStore) {}

  private async table(repo: RepoConfig): Promise<Record<string, BatchHistory> | null> {
    const record = await this.records.loadRepoRecord(repo);
    return record ? record.dependencyBatches ?? {} : null;
  }

  async historyOf(repo: RepoConfig, batch: DependencyBatch): Promise<BatchHistory | undefined | null> {
    const table = await this.table(repo);
    return table === null ? null : table[batch.key];
  }

  private change(repo: RepoConfig, batch: DependencyBatch, edit: (h: BatchHistory) => void, now: Date): Promise<boolean> {
    return this.records.updateRepoRecord(repo, (d) => {
      const table: Record<string, BatchHistory> = {};
      for (const [k, h] of Object.entries(d.dependencyBatches ?? {})) {
        const last = h.filings[h.filings.length - 1] ?? h.outcomeAt;
        const stale = h.outcome === undefined && last !== undefined && now.getTime() - Date.parse(last) > STALE_OPEN_ENTRY_MS;
        if (!stale || k === batch.key) table[k] = h;
      }
      const history: BatchHistory = structuredClone(table[batch.key] ?? { prs: [...batch.prs], filings: [], issues: [] });
      edit(history);
      table[batch.key] = history;
      d.dependencyBatches = table;
    });
  }

  recordFiling(repo: RepoConfig, batch: DependencyBatch, at: Date): Promise<boolean> {
    return this.change(repo, batch, (h) => { h.filings.push(at.toISOString()); }, at);
  }

  attachIssue(repo: RepoConfig, batch: DependencyBatch, issue: number): Promise<boolean> {
    return this.change(repo, batch, (h) => { if (!h.issues.includes(issue)) h.issues.push(issue); }, new Date());
  }

  async batchOfIssue(repo: RepoConfig, issue: number): Promise<{ batch: DependencyBatch; history: BatchHistory } | undefined | null> {
    const table = await this.table(repo);
    if (table === null) return null;
    for (const history of Object.values(table)) {
      if (history.issues.includes(issue)) return { batch: DependencyBatch.fromRefs(history.prs), history };
    }
    return undefined;
  }

  recordOutcome(repo: RepoConfig, batch: DependencyBatch, outcome: BatchOutcome, at: Date): Promise<boolean> {
    return this.change(repo, batch, (h) => { h.outcome = outcome; h.outcomeAt = at.toISOString(); }, at);
  }

  markEmNotified(repo: RepoConfig, batch: DependencyBatch): Promise<boolean> {
    return this.change(repo, batch, (h) => { h.emNotified = true; }, new Date());
  }
}
