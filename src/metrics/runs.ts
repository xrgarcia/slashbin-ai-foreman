import type { DatabaseSync } from "node:sqlite";
import type { SessionOutcome } from "../adapters.js";
import type { MetricsRow } from "./report.js";

/**
 * The run ledger's billing read (docs/metrics.md): session rows in, billable runs out. Pure (no clock, no
 * SQLite) apart from `readSessionRows`, so it is unit-testable on its own. The recorder is the one writer; this is
 * the one reader that bills.
 */

export interface RunCard { repo: string; issueNumber: number }

export interface RunShare extends RunCard { ms: number }

/** One finished top-level run. `shares` split its duration across the cards it worked. */
export interface RunRecord {
  runId: string;
  phase: string;
  outcome: SessionOutcome;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  shares: RunShare[];
}

export type UnclassifiedReason = "noRunId" | "noOutcome" | "noStart" | "noEnd" | "noWorkedItems" | "orphanNested";

export interface Unclassified {
  runId: string | null;
  repo: string;
  issueNumber: number | null;
  reason: UnclassifiedReason;
}

export interface RunsOutput {
  from: string;
  to: string;
  /** Completed top-level runs whose end is in the window. The only ones that are billed. */
  billable: Array<RunRecord & { outcome: "completed" }>;
  /** Failed top-level runs, same shape (the weekly trend reads them); never billed. A failed run with no cards has no shares. */
  failed: Array<RunRecord & { outcome: "failed" }>;
  unclassified: Unclassified[];
}

/**
 * Every session row, `detail` parsed. Not cut at the window: a run that ends in it may have started before, and a run
 * that starts in it may end after, which is not a run with no end. Retention bounds it.
 */
export function readSessionRows(db: DatabaseSync): MetricsRow[] {
  const rows = db.prepare("SELECT id, at, repo, issue, kind, stage, detail FROM events WHERE kind = 'session' ORDER BY at, id")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let detail: Record<string, unknown> | null = null;
    try { detail = r.detail ? JSON.parse(String(r.detail)) : null; } catch { /* leave null */ }
    return { id: Number(r.id), at: String(r.at), repo: String(r.repo), issue: r.issue === null ? null : Number(r.issue), kind: "session", stage: null, detail };
  });
}

interface Run {
  runId: string;
  phase: string;
  parentRunId?: string;
  startedAt?: string;
  /** The earliest end row: a duplicate end counts once. */
  endedAt?: string;
  outcome?: SessionOutcome;
  cards: Map<string, RunCard>;
  /** One of its rows, to name the run when it cannot be classified. */
  repo: string;
  issue: number | null;
}

const OUTCOMES: readonly string[] = ["completed", "noWork", "failed"];
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const cardKey = (c: RunCard): string => `${c.repo}#${c.issueNumber}`;
const isEnd = (status: unknown): boolean => status === "finished" || status === "failed";

/** The cards a run's end row lists, malformed entries dropped. */
function cardsOf(v: unknown): RunCard[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is RunCard => typeof c?.repo === "string" && Number.isInteger(c?.issueNumber)).map((c) => ({ repo: c.repo, issueNumber: c.issueNumber }));
}

/**
 * Split `durationMs` equally across `cards`: integers that sum exactly to the duration, the remainder going to the
 * first card in (repo, issueNumber) ascending order. Pure, exported for tests.
 */
export function splitDuration(durationMs: number, cards: readonly RunCard[]): RunShare[] {
  const sorted = [...cards].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.issueNumber - b.issueNumber));
  if (sorted.length === 0) return [];
  const each = Math.floor(durationMs / sorted.length);
  const rest = durationMs - each * sorted.length;
  return sorted.map((c, i) => ({ repo: c.repo, issueNumber: c.issueNumber, ms: each + (i === 0 ? rest : 0) }));
}

/** Group session rows into runs by `runId`. Rows without one are returned apart. */
function groupRuns(rows: readonly MetricsRow[]): { runs: Map<string, Run>; unkeyed: MetricsRow[] } {
  const runs = new Map<string, Run>();
  const unkeyed: MetricsRow[] = [];
  for (const row of rows) {
    const d = row.detail;
    const runId = str(d?.runId);
    if (!runId) { unkeyed.push(row); continue; }
    const run = runs.get(runId) ?? { runId, phase: String(d?.phase ?? ""), cards: new Map<string, RunCard>(), repo: row.repo, issue: row.issue };
    runs.set(runId, run);
    const parent = str(d?.parentRunId);
    if (parent) run.parentRunId = parent;
    if (d?.status === "started") {
      if (!run.startedAt || row.at < run.startedAt) run.startedAt = row.at;
    } else if (isEnd(d?.status)) {
      if (!run.endedAt || row.at < run.endedAt) run.endedAt = row.at;
      const outcome = str(d?.outcome);
      if (outcome && OUTCOMES.includes(outcome) && !run.outcome) run.outcome = outcome as SessionOutcome;
      for (const c of cardsOf(d?.workedItems)) run.cards.set(cardKey(c), c);
    }
  }
  return { runs, unkeyed };
}

/**
 * The billable runs whose end falls in the half-open window [from, to) (ISO UTC). A run belongs to the window its end
 * falls in, so a re-run over the same rows returns the same answer. Pure.
 */
export function readRuns(rows: readonly MetricsRow[], from: string, to: string): RunsOutput {
  const lo = Date.parse(from);
  const hi = Date.parse(to);
  const inWindow = (at: string): boolean => Date.parse(at) >= lo && Date.parse(at) < hi;
  const { runs, unkeyed } = groupRuns(rows);
  const out: RunsOutput = { from, to, billable: [], failed: [], unclassified: [] };
  const unclassify = (run: Pick<Run, "repo" | "issue">, runId: string | null, reason: UnclassifiedReason): void => {
    out.unclassified.push({ runId, repo: run.repo, issueNumber: run.issue, reason });
  };

  // A row written before runs were recorded: its end is the only trace of a run, so each one in the window is reported.
  for (const row of unkeyed) if (isEnd(row.detail?.status) && inWindow(row.at)) unclassify(row, null, "noRunId");

  for (const run of runs.values()) {
    if (run.endedAt === undefined) {
      if (run.startedAt !== undefined && inWindow(run.startedAt)) unclassify(run, run.runId, "noEnd");
      continue;
    }
    if (!inWindow(run.endedAt)) continue;
    if (run.parentRunId) {
      // Its time is inside the enclosing run, which is the one that counts; with no such run ending in the window it is orphaned.
      const parent = runs.get(run.parentRunId);
      if (!parent?.endedAt || !inWindow(parent.endedAt)) unclassify(run, run.runId, "orphanNested");
      continue;
    }
    if (run.startedAt === undefined) { unclassify(run, run.runId, "noStart"); continue; }
    if (run.outcome === undefined) { unclassify(run, run.runId, "noOutcome"); continue; }
    if (run.outcome === "noWork") continue;
    if (run.outcome === "completed" && run.cards.size === 0) { unclassify(run, run.runId, "noWorkedItems"); continue; }
    const durationMs = Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
    const record = {
      runId: run.runId, phase: run.phase, startedAt: run.startedAt, endedAt: run.endedAt, durationMs,
      shares: splitDuration(durationMs, [...run.cards.values()]),
    };
    if (run.outcome === "completed") out.billable.push({ ...record, outcome: "completed" });
    else out.failed.push({ ...record, outcome: "failed" });
  }

  const byEnd = (a: RunRecord, b: RunRecord): number => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : a.runId < b.runId ? -1 : 1);
  out.billable.sort(byEnd);
  out.failed.sort(byEnd);
  return out;
}
