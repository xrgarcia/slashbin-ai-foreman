import type { DatabaseSync } from "node:sqlite";
import type { MetricsRow } from "./report.js";

/**
 * The blocked-time read (docs/metrics.md): `blocked`, `unblocked` and `closed` rows in, one interval per block out,
 * cut at Monday 00:00 US Central weeks. Pure (the clock is an argument) apart from `readBlockedRows`. The recorder
 * is the one writer; no writer was added for this.
 */

const ZONE = "America/Chicago";
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** One card's blocked hours in one Central week. `hours` is null for an `incomplete` row. */
export interface BlockedWeek {
  repo: string;
  issue: number;
  /** The Monday that starts the week, `YYYY-MM-DD`, Central. */
  week: string;
  hours: number | null;
  /** How many blocks touched this week (0 on an `incomplete` row). */
  intervals: number;
  /** The block has not cleared: it runs to the week's end, or to `now` in the current week, and carries on. */
  open?: true;
  /** A block's start row is gone, so its time cannot be established. Never zero hours. */
  incomplete?: true;
}

export interface BlockedOutput {
  from: string;
  to: string;
  now: string;
  rows: BlockedWeek[];
}

interface Interval { startMs: number; endMs: number | null }

const zoneFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short",
});

function zoned(ms: number): { y: number; m: number; d: number; weekday: string; asUtc: number } {
  const p = Object.fromEntries(zoneFormat.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const [y, m, d] = [Number(p.year), Number(p.month), Number(p.day)];
  return { y, m, d, weekday: String(p.weekday), asUtc: Date.UTC(y, m - 1, d, Number(p.hour), Number(p.minute), Number(p.second)) };
}

/** The instant Central local midnight of y-m-d falls on (DST-aware; midnight is never inside a transition). */
function centralMidnight(y: number, m: number, d: number): number {
  const local = Date.UTC(y, m - 1, d);
  let t = local;
  for (let i = 0; i < 2; i++) t = local - (zoned(t).asUtc - t);
  return t;
}

const MONDAY_BACK: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** The Monday 00:00 Central at or before `ms`. */
export function weekStart(ms: number): number {
  const z = zoned(ms);
  const monday = new Date(Date.UTC(z.y, z.m - 1, z.d) - MONDAY_BACK[z.weekday] * DAY);
  return centralMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

/** The Monday 00:00 Central after the week that starts at `start`. */
function nextWeek(start: number): number {
  const z = zoned(start + 3 * DAY); // mid-week, clear of any DST edge
  const monday = new Date(Date.UTC(z.y, z.m - 1, z.d) + 4 * DAY);
  return centralMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

/** `YYYY-MM-DD`, Central, of the instant a week starts. */
function weekLabel(start: number): string {
  const z = zoned(start);
  return `${z.y}-${String(z.m).padStart(2, "0")}-${String(z.d).padStart(2, "0")}`;
}

/**
 * A `--from` / `--to` value: a bare date is that day's Central midnight, anything else an ISO instant.
 * NaN when it is neither.
 */
export function parseWindowEdge(value: string): number {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return date ? centralMidnight(Number(date[1]), Number(date[2]), Number(date[3])) : Date.parse(value);
}

/** Blocks and clears in time order, per card. A row with no issue or no valid time is not a card's. */
function groupByCard(rows: readonly MetricsRow[]): Map<string, MetricsRow[]> {
  const cards = new Map<string, MetricsRow[]>();
  for (const row of rows) {
    if (row.issue === null || Number.isNaN(Date.parse(row.at))) continue;
    if (row.kind !== "blocked" && row.kind !== "unblocked" && row.kind !== "closed") continue;
    const key = `${row.repo}#${row.issue}`;
    cards.set(key, [...(cards.get(key) ?? []), row]);
  }
  return cards;
}

interface CardBlocks { intervals: Interval[]; lostStartAt: number[] }

/**
 * One card's blocks. The first `blocked` after a clear starts one; later `blocked` rows change nothing, whatever
 * their reason. `unblocked` or `closed` ends it. An `unblocked` that is the card's first row of the three has no
 * start in the store (retention took it), so it is a lost start; one after a clear is a duplicate and is ignored.
 */
function blocksOf(rows: readonly MetricsRow[]): CardBlocks {
  const out: CardBlocks = { intervals: [], lostStartAt: [] };
  let open: Interval | null = null;
  let seenAny = false;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (row.kind === "blocked") {
      open ??= { startMs: at, endMs: null };
    } else if (open) {
      open.endMs = at;
      out.intervals.push(open);
      open = null;
    } else if (row.kind === "unblocked" && !seenAny) {
      out.lostStartAt.push(at);
    }
    seenAny = true;
  }
  if (open) out.intervals.push(open);
  return out;
}

/** The weeks an interval covers, each with the hours in it. An open one runs to `nowMs`. */
function* segments(iv: Interval, nowMs: number): Generator<{ start: number; end: number; hours: number }> {
  const end = Math.max(iv.startMs, iv.endMs ?? nowMs);
  for (let ws = weekStart(iv.startMs); ws < end; ) {
    const we = nextWeek(ws);
    yield { start: ws, end: we, hours: (Math.min(end, we) - Math.max(iv.startMs, ws)) / HOUR };
    ws = we;
  }
}

const round = (h: number): number => Math.round(h * 100) / 100;

/**
 * Each card's blocked hours per Central week, for the weeks overlapping the half-open window [from, to) (a week
 * counts whole). A card's whole history is read, not just the window's: a block that began earlier carries in.
 */
export function readBlocked(rows: readonly MetricsRow[], from: string, to: string, now: string): BlockedOutput {
  const [fromMs, toMs, nowMs] = [parseWindowEdge(from), parseWindowEdge(to), Date.parse(now)];
  const out: BlockedOutput = { from, to, now, rows: [] };
  const inWindow = (start: number, end: number): boolean => start < toMs && end > fromMs;
  for (const [key, cardRows] of groupByCard(rows)) {
    const [repo, issue] = [key.slice(0, key.lastIndexOf("#")), Number(key.slice(key.lastIndexOf("#") + 1))];
    const { intervals, lostStartAt } = blocksOf(cardRows);
    const weeks = new Map<string, BlockedWeek>();
    for (const iv of intervals) {
      for (const seg of segments(iv, nowMs)) {
        if (!inWindow(seg.start, seg.end)) continue;
        const label = weekLabel(seg.start);
        const row = weeks.get(label) ?? { repo, issue, week: label, hours: 0, intervals: 0 };
        row.hours = (row.hours ?? 0) + seg.hours;
        row.intervals += 1;
        if (iv.endMs === null) row.open = true;
        weeks.set(label, row);
      }
    }
    for (const at of lostStartAt) {
      const ws = weekStart(at);
      if (!inWindow(ws, nextWeek(ws))) continue;
      weeks.set(`incomplete ${weekLabel(ws)}`, { repo, issue, week: weekLabel(ws), hours: null, intervals: 0, incomplete: true });
    }
    for (const row of weeks.values()) out.rows.push({ ...row, hours: row.hours === null ? null : round(row.hours) });
  }
  out.rows.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.issue - b.issue || (a.week < b.week ? -1 : 1)));
  return out;
}

/** Every `blocked`, `unblocked` and `closed` row, `detail` not read (nothing here needs it), oldest first. Not cut at the window. */
export function readBlockedRows(db: DatabaseSync): MetricsRow[] {
  const rows = db.prepare("SELECT id, at, repo, issue, kind FROM events WHERE kind IN ('blocked', 'unblocked', 'closed') AND issue IS NOT NULL ORDER BY at, id")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), at: String(r.at), repo: String(r.repo), issue: Number(r.issue), kind: String(r.kind), stage: null, detail: null }));
}
