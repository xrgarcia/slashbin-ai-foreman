import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkEvent, WorkItem } from "../adapters.js";
import type { Logger } from "../logger.js";
import type { MetricsRow } from "./report.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue INTEGER,
  kind TEXT NOT NULL,
  stage TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_item ON events (repo, issue, at);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE TABLE IF NOT EXISTS item_stage (
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  stage TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, issue)
);`;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const CLOSED_STAGES = new Set(["done", "notPlanned"]);

/** Open the metrics database (WAL, so a reader never blocks the writer) and ensure its schema. */
export function openMetricsDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

/** Read stored rows, with `detail` parsed, for the report. */
export function readRows(db: DatabaseSync, f: { sinceIso: string; repo?: string; issue?: number }): MetricsRow[] {
  // Items with any event in the window get their whole history, so a pickup before the window is found.
  const rows = db.prepare(
    `SELECT id, at, repo, issue, kind, stage, detail FROM events e
     WHERE issue IS NOT NULL
       AND (?1 IS NULL OR repo = ?1 OR repo LIKE '%/' || ?1)
       AND (?2 IS NULL OR issue = ?2)
       AND EXISTS (SELECT 1 FROM events x WHERE x.repo = e.repo AND x.issue = e.issue AND x.at >= ?3)
     ORDER BY at, id`,
  ).all(f.repo ?? null, f.issue ?? null, f.sinceIso) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let detail: Record<string, unknown> | null = null;
    try { detail = r.detail ? JSON.parse(String(r.detail)) : null; } catch { /* leave null */ }
    return {
      id: Number(r.id), at: String(r.at), repo: String(r.repo), issue: r.issue === null ? null : Number(r.issue),
      kind: String(r.kind), stage: r.stage === null ? null : String(r.stage), detail,
    };
  });
}

/**
 * Writes a raw event log of each item's lifecycle (docs/metrics.md). Records events, never
 * durations. `record` never throws: a failure is logged and the Foreman carries on.
 */
export class MetricsRecorder {
  private lastRetention = 0;

  constructor(
    private readonly db: DatabaseSync,
    private retentionDays: number,
    private readonly now: () => number = Date.now,
  ) {}

  setRetentionDays(days: number): void { this.retentionDays = days; }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  private insert(repo: string, issue: number | null, kind: string, stage: string | null, detail: Record<string, unknown> | null): void {
    this.db.prepare("INSERT INTO events (at, repo, issue, kind, stage, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date(this.now()).toISOString(), repo, issue, kind, stage, detail ? JSON.stringify(detail) : null);
  }

  private lastStage(item: WorkItem): string | null {
    const r = this.db.prepare("SELECT stage FROM item_stage WHERE repo = ? AND issue = ?").get(item.repo, item.issueNumber) as { stage?: string } | undefined;
    return r?.stage ?? null;
  }

  private setStage(item: WorkItem, stage: string): void {
    this.db.prepare(
      "INSERT INTO item_stage (repo, issue, stage, at) VALUES (?, ?, ?, ?) ON CONFLICT (repo, issue) DO UPDATE SET stage = excluded.stage, at = excluded.at",
    ).run(item.repo, item.issueNumber, stage, new Date(this.now()).toISOString());
  }

  /** A stage row, unless the item is already there. */
  private advance(item: WorkItem, stage: string, kind: string, detail: Record<string, unknown> | null): void {
    if (this.lastStage(item) === stage) return;
    this.insert(item.repo, item.issueNumber, kind, stage, detail);
    this.setStage(item, stage);
  }

  private closeItem(item: WorkItem, state: string): void {
    const last = this.lastStage(item);
    if (last !== null && CLOSED_STAGES.has(last)) return;
    this.advance(item, state === "completed" ? "done" : "notPlanned", "closed", { state });
  }

  record(event: WorkEvent, logger: Logger): void {
    try {
      this.retain();
      this.db.exec("BEGIN");
      try {
        this.apply(event);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* none open */ }
        throw err;
      }
    } catch (err) {
      logger.warn(`metrics: could not record ${(event as { kind?: unknown } | null)?.kind ?? "event"}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private apply(event: WorkEvent): void {
    switch (event.kind) {
      case "transition":
        this.insert(event.item.repo, event.item.issueNumber, "transition", event.stage, {
          move: event.move, from: event.from, to: event.to, observed: event.observed,
        });
        this.setStage(event.item, event.stage);
        return;
      case "snapshot": {
        for (const s of event.items ?? []) this.advance(s.item, s.stage, "stage", { detail: s.detail });
        for (const c of event.cards ?? []) {
          if (c.stage) this.advance(c.item, c.stage, "stage", null);
        }
        for (const c of event.closed ?? []) this.closeItem(c.item, c.state);
        for (const c of event.cards ?? []) {
          if (c.state === "completed" || c.state === "not_planned") this.closeItem(c.item, c.state);
        }
        return;
      }
      case "claim":
        this.insert(event.item.repo, event.item.issueNumber, "claim", null, null);
        return;
      case "blocked":
        this.insert(event.item.repo, event.item.issueNumber, "blocked", null, compact({ reason: event.reason, owner: event.owner, stuck: event.stuck, at: event.at }));
        return;
      case "escalated":
        this.insert(event.item.repo, event.item.issueNumber, "escalated", null, compact({ reason: event.reason, stuck: event.stuck, at: event.at }));
        return;
      case "unblocked":
      case "verifyWaiting":
        this.insert(event.item.repo, event.item.issueNumber, event.kind, null, { reason: event.reason });
        return;
      case "merged":
      case "promoted":
        this.insert(event.item.repo, event.item.issueNumber, event.kind, null, null);
        return;
      case "session": {
        const s = event.session;
        for (const item of s.items) {
          this.insert(item.repo, item.issueNumber, "session", null, compact({
            phase: s.phase, status: s.status, pr: s.pr, reviewer: s.reviewer, detail: s.detail,
          }));
        }
        return;
      }
      case "release":
        for (const item of event.release.issues) {
          this.insert(item.repo, item.issueNumber, "release", null, compact({ state: event.release.state, pr: event.release.pr }));
        }
        return;
      default:
        return; // reviewProgress, waiting, promotionStall, backoff, prLink: not lifecycle
    }
  }

  /** Delete events past retention, and item_stage rows left with no events. At most hourly. */
  retain(force = false): void {
    const t = this.now();
    if (!force && this.lastRetention && t - this.lastRetention < HOUR) return;
    this.lastRetention = t;
    const cutoff = new Date(t - this.retentionDays * DAY).toISOString();
    this.db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
    this.db.exec("DELETE FROM item_stage WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.repo = item_stage.repo AND e.issue = item_stage.issue)");
  }
}

/** Drop undefined fields so the stored JSON carries only what was present. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
