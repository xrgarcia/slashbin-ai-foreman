import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WAIT_REASONS, type WaitReason, type WorkEvent, type WorkItem } from "../adapters.js";
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
);
CREATE TABLE IF NOT EXISTS item_hold (
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  stage TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (repo, issue)
);`;

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A snapshot-seen move straight back to the stage before the last one, within this long of it, is a flap, not a move. */
const FLAP_WINDOW = 10 * 60_000;
const CLOSED_STAGES = new Set(["done", "notPlanned"]);
const HOLD_STAGES = new Set(["pendingVerification", "awaitingSignoff"]);

/**
 * `node:sqlite` loaded on first use, not at import: Node 22.12 (the declared minimum) has it only behind
 * a flag, and a Foreman with metrics off must start there. Throws where it is unavailable.
 */
export function sqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)("node:sqlite");
}

/** Open the metrics database (WAL, so a reader never blocks the writer) and ensure its schema. */
export function openMetricsDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new (sqlite().DatabaseSync)(path);
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
    // A new stage ends the wait that was recorded for the last one.
    this.db.prepare("DELETE FROM item_hold WHERE repo = ? AND issue = ?").run(item.repo, item.issueNumber);
  }

  /**
   * True when a snapshot would put the item back to stage A right after A -> B, B being a snapshot row under
   * `FLAP_WINDOW` old: a pure A -> B -> A oscillation (two sources disagreeing, jerky_shipping#856), not a move.
   * Skipped, so the log keeps B until the item has stood there past the window. Moves the Foreman makes
   * (`transition`) are never suppressed.
   */
  private isFlap(item: WorkItem, stage: string): boolean {
    const last = this.db.prepare(
      "SELECT kind, stage, at FROM events WHERE repo = ? AND issue = ? AND stage IS NOT NULL AND kind IN ('transition', 'stage', 'closed') ORDER BY id DESC LIMIT 2",
    ).all(item.repo, item.issueNumber) as Array<{ kind: string; stage: string; at: string }>;
    const [b, a] = last;
    return !!b && !!a && b.kind === "stage" && a.stage === stage && this.now() - Date.parse(b.at) < FLAP_WINDOW;
  }

  /** A stage row, unless the item is already there (or a snapshot only flaps it back). */
  private advance(item: WorkItem, stage: string, kind: string, detail: Record<string, unknown> | null): void {
    if (this.lastStage(item) === stage) return;
    if (kind === "stage" && this.isFlap(item, stage)) return;
    this.insert(item.repo, item.issueNumber, kind, stage, detail);
    this.setStage(item, stage);
  }

  /** A `hold` row (detail: stage, reason) when why an item waits at `stage` changed; one row per change, not per pass. */
  private noteHold(item: WorkItem, stage: string, reason: WaitReason): void {
    if (!HOLD_STAGES.has(stage) || !WAIT_REASONS.includes(reason) || this.lastStage(item) !== stage) return;
    const cur = this.db.prepare("SELECT stage, reason FROM item_hold WHERE repo = ? AND issue = ?").get(item.repo, item.issueNumber) as { stage?: string; reason?: string } | undefined;
    if (cur?.stage === stage && cur.reason === reason) return;
    this.insert(item.repo, item.issueNumber, "hold", null, { stage, reason });
    this.db.prepare(
      "INSERT INTO item_hold (repo, issue, stage, reason) VALUES (?, ?, ?, ?) ON CONFLICT (repo, issue) DO UPDATE SET stage = excluded.stage, reason = excluded.reason",
    ).run(item.repo, item.issueNumber, stage, reason);
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
        // One stage per item per snapshot. A card's stage is the fuller read (it knows the open release PRs), so it
        // wins over the item's: applying both in turn flipped an item between the two every pass.
        const cardStage = new Map((event.cards ?? []).filter((c) => c.stage).map((c) => [`${c.item.repo}#${c.item.issueNumber}`, c.stage as string]));
        for (const s of event.items ?? []) {
          const stage = cardStage.get(`${s.item.repo}#${s.item.issueNumber}`) ?? s.stage;
          this.advance(s.item, stage, "stage", { detail: s.detail });
          if (s.waitReason && stage === s.stage) this.noteHold(s.item, stage, s.waitReason);
        }
        const seen = new Set((event.items ?? []).map((s) => `${s.item.repo}#${s.item.issueNumber}`));
        for (const c of event.cards ?? []) {
          if (c.stage && !seen.has(`${c.item.repo}#${c.item.issueNumber}`)) this.advance(c.item, c.stage, "stage", null);
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
    this.db.exec("DELETE FROM item_hold WHERE NOT EXISTS (SELECT 1 FROM item_stage s WHERE s.repo = item_hold.repo AND s.issue = item_hold.issue)");
  }
}

/** Drop undefined fields so the stored JSON carries only what was present. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
