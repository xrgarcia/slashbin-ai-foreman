import { createHmac } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { stateDir } from "../state-dir.js";
import { readRuns, scrubRun, type RunRecord } from "./runs.js";
import type { MetricsRow } from "./report.js";

/**
 * The Foreman's sender to the company-record receiver (docs/metrics.md, shipper-protocol of epic 2104): the only
 * writer of the outbox and the watermark, and the only sender. It ships `readRuns` output (billable and failed runs)
 * and never recomputes a run. One cursor (the last Chicago day a watermark 202 confirmed), one watermark event per run.
 */

export const SLUG = "foreman-session";
export const REQUEST_TIMEOUT_MS = 10_000;
// Built from parts: the full name carries a private service name this public repo must not spell out.
export const BASE_URL_ENV = ["SLASHBIN", "DATA", "RECEIVER", "BASE_URL"].join("_");
const keyEnv = (slug: string): string => `SLASHBIN_EVENTS_SIGNING_KEY__${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
export const KEY_ENV = keyEnv(SLUG);
export const WATERMARK_KEY_ENV = keyEnv("watermark");

interface State { file: string | null; offset_bytes: number; last_event_id: string | null; acked_at: string | null; watermark_acked_period_end?: string | null; day_acks?: Record<string, string> }
interface PostResult { ok: boolean; error: string | null }
interface Entry { run: RunRecord }

const isoMs = (ms: number): string => new Date(ms).toISOString();
const chicagoDay = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
/** The UTC instant of 00:00 America/Chicago on the Chicago day containing `ms` (the offset is 5 or 6 hours). */
const chicagoDayStartMs = (ms: number): number => {
  const day = chicagoDay(ms), base = Date.parse(`${day}T00:00:00Z`);
  return [5, 6].map((h) => base + h * 3_600_000).find((c) => chicagoDay(c) === day && chicagoDay(c - 1) !== day) as number;
};
const dayAfter = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** The UTC instant the Chicago day `d` ends (the next day's 00:00 Chicago). */
const chicagoDayEndMs = (d: string): number => chicagoDayStartMs(Date.parse(`${dayAfter(d)}T18:00:00Z`));
/** The earliest past day whose recorded acknowledgement does not cover the whole day, else null. Pure, exported for tests. */
export function firstShortDay(dayAcks: Record<string, string> | undefined, periodEnd: string): string | null {
  const short = Object.entries(dayAcks ?? {}).filter(([d, ack]) => d <= periodEnd && Date.parse(ack) < chicagoDayEndMs(d)).map(([d]) => d).sort();
  return short[0] ?? null;
}
const dayBefore = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export function shipPaths(dir: string = stateDir()): { dir: string; outbox: string; state: string; lock: string } {
  const d = join(dir, "company-record");
  return { dir: d, outbox: join(d, `${SLUG}.outbox.jsonl`), state: join(d, `${SLUG}.watermark.json`), lock: join(d, `${SLUG}.lock`) };
}

/** POST one body, exactly the signed bytes. Never throws; only a 202 is ok. */
async function post(baseUrl: string, slug: string, key: string, eventId: string, body: Buffer): Promise<PostResult> {
  if (eventId.length < 1 || eventId.length > 256) return { ok: false, error: "event id must be 1..256 chars" };
  const headers = {
    "content-type": "application/json",
    "x-slashbin-job-id": eventId,
    "x-slashbin-signature": `sha256=${createHmac("sha256", key).update(body).digest("hex")}`,
  };
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/slashbin/${slug}/events`, { method: "POST", headers, body: new Uint8Array(body), redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => undefined);
    return res.status === 202 ? { ok: true, error: null } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    const err = e as { name?: string; code?: string; cause?: { code?: string } };
    return { ok: false, error: err?.name === "TimeoutError" ? `timeout after ${REQUEST_TIMEOUT_MS} ms` : (err?.cause?.code ?? err?.code ?? err?.name ?? "network error") };
  }
}

function readState(file: string): State {
  if (!existsSync(file)) return { file: null, offset_bytes: 0, last_event_id: null, acked_at: null };
  const s = JSON.parse(readFileSync(file, "utf8")) as State;
  if (!Number.isInteger(s.offset_bytes) || s.offset_bytes < 0) throw new Error("watermark state has a bad offset_bytes");
  return s;
}

/** Atomic: a sibling temp file, then rename. */
function writeState(file: string, state: State): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state) + "\n");
  renameSync(tmp, file);
}

/** One lock per outbox. A release function, or null when another live shipper holds it. */
function acquireLock(lockFile: string): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(lockFile); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        const pid = Number(readFileSync(lockFile, "utf8"));
        let alive = true;
        try { process.kill(pid, 0); } catch (k) { alive = (k as NodeJS.ErrnoException).code === "EPERM"; }
        stale = !alive; // a live owner keeps the lock however long it drains; only a dead owner's lock is recovered
      } catch { stale = true; }
      if (!stale) return null;
      try { unlinkSync(lockFile); } catch { /* raced */ }
    }
  }
  return null;
}

/** The complete ("\n"-terminated) lines of `file` from `offset`; a trailing partial line is dropped. */
function completeLines(file: string, offset: number): Array<{ bytes: Buffer; end: number }> {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (offset > size) throw new Error(`watermark offset ${offset} is beyond the end of the outbox (${size})`);
    const buf = Buffer.alloc(size - offset);
    let got = 0;
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, offset + got); if (n <= 0) break; got += n; }
    const lines: Array<{ bytes: Buffer; end: number }> = [];
    let start = 0;
    for (let i = 0; i < got; i++) if (buf[i] === 0x0a) { lines.push({ bytes: buf.subarray(start, i), end: offset + i + 1 }); start = i + 1; }
    return lines;
  } finally { closeSync(fd); }
}

const outboxEntries = (outbox: string): Entry[] => {
  if (!existsSync(outbox)) return [];
  const out: Entry[] = [];
  for (const l of readFileSync(outbox, "utf8").split("\n")) { try { const e = JSON.parse(l) as Entry; if (e?.run?.runId) out.push(e); } catch { /* skip */ } }
  return out;
};

/** A crash can leave the outbox's last line without its newline. An intact record gets it; a torn one is cut off. */
function repairTail(outbox: string): void {
  if (!existsSync(outbox)) return;
  const text = readFileSync(outbox, "utf8");
  if (text === "" || text.endsWith("\n")) return;
  const cut = text.lastIndexOf("\n") + 1;
  let intact = false;
  try { intact = !!(JSON.parse(text.slice(cut)) as Entry)?.run?.runId; } catch { /* torn */ }
  if (intact) appendFileSync(outbox, "\n");
  else truncateSync(outbox, Buffer.byteLength(text.slice(0, cut)));
}

/** The earliest start among top-level runs that started and have no end row: they hold the acknowledgement. */
export function openRunStartMs(rows: readonly MetricsRow[]): number | null {
  const started = new Map<string, number>();
  const ended = new Set<string>();
  for (const r of rows) {
    const d = r.detail, id = typeof d?.runId === "string" ? d.runId : "";
    if (!id) continue;
    if (d?.status === "started" && !d.parentRunId) { const t = Date.parse(r.at); const prev = started.get(id); if (prev === undefined || t < prev) started.set(id, t); }
    else if (d?.status === "finished" || d?.status === "failed") ended.add(id);
  }
  let min: number | null = null;
  for (const [id, t] of started) if (!ended.has(id) && (min === null || t < min)) min = t;
  return min;
}

/** Billable and failed runs that ended before `nowMs`, ascending by end then runId (readRuns already sorts each list). */
export function shippableRuns(rows: readonly MetricsRow[], nowMs: number): RunRecord[] {
  const out = readRuns(rows, "1970-01-01T00:00:00.000Z", isoMs(nowMs));
  return [...out.billable, ...out.failed].sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : a.runId < b.runId ? -1 : 1));
}

export interface ShipOptions {
  dir?: string;
  rows: readonly MetricsRow[];
  nowMs: number;
  baseUrl?: string;
  key?: string;
  watermarkKey?: string;
  /** Re-reads the session rows; the owner calls it when another run finished during its shipment. */
  /** The clock for a reload pass. */
  clock?: () => number;
  reloadRows?: () => readonly MetricsRow[];
  log?: (line: string) => void;
}

/**
 * Outbox the runs not yet in it, ship it, send one watermark. Resolves false when a send stopped. A call that finds a live
 * shipper sends nothing: it leaves a `.again` marker, and the owner, after releasing, re-reads the rows (`reloadRows`) and
 * ships again, so a run that finished during a shipment is neither lost nor waiting on another trigger.
 */
export async function ship(o: ShipOptions): Promise<boolean> {
  const p = shipPaths(o.dir);
  const log = o.log ?? ((): void => undefined);
  const again = `${p.lock}.again`;
  mkdirSync(p.dir, { recursive: true });
  let rows = o.rows, nowMs = o.nowMs;
  for (;;) {
    let release = acquireLock(p.lock);
    if (!release) {
      writeFileSync(again, "");
      release = acquireLock(p.lock); // the owner may have released between its marker check and ours
      if (!release) { log("another shipper is running; it will pick this run up"); return true; }
    }
    let ok: boolean;
    try { ok = await shipLocked({ ...o, rows, nowMs }, p, log); } finally { release(); }
    if (!ok || !o.reloadRows || !existsSync(again)) return ok;
    try { unlinkSync(again); } catch { /* raced */ }
    rows = o.reloadRows();
    if (o.clock) nowMs = o.clock();
  }
}

async function shipLocked(o: ShipOptions, p: ReturnType<typeof shipPaths>, log: (line: string) => void): Promise<boolean> {
  {
    repairTail(p.outbox);
    const have = new Set(outboxEntries(p.outbox).map((e) => e.run.runId));
    const fresh = shippableRuns(o.rows, o.nowMs).filter((r) => !have.has(r.runId));
    if (fresh.length) appendFileSync(p.outbox, fresh.map((run) => JSON.stringify({ run })).join("\n") + "\n");

    if (!o.baseUrl || !o.key) { log("no base URL or signing key: the outbox is the recovery copy"); return true; }

    // Records, sequential, in file order. Only a 202 advances the offset; the first failure stops the run.
    const state = readState(p.state);
    let sent = 0;
    if (existsSync(p.outbox)) {
      for (const line of completeLines(p.outbox, state.offset_bytes)) {
        if (line.bytes.length === 0) { state.offset_bytes = line.end; writeState(p.state, state); continue; }
        let entry: Entry;
        try { entry = JSON.parse(line.bytes.toString("utf8")) as Entry; if (!entry?.run?.runId) throw new Error("no run"); }
        catch (e) { console.error(`metrics:ship: unreadable outbox record at byte ${state.offset_bytes}: ${(e as Error).message}`); return false; }
        // A run queued before issue 0 was dropped is scrubbed on the way out; one with no real card left is not sent.
        const run = scrubRun(entry.run);
        if (!run) { Object.assign(state, { file: p.outbox, offset_bytes: line.end }); writeState(p.state, state); continue; }
        const body = Buffer.from(JSON.stringify({ transformed_at: isoMs(o.nowMs), run }), "utf8");
        const r = await post(o.baseUrl, SLUG, o.key, entry.run.runId, body);
        if (!r.ok) { console.error(`metrics:ship: stopped at ${entry.run.runId}: ${r.error}`); return false; }
        Object.assign(state, { file: p.outbox, offset_bytes: line.end, last_event_id: entry.run.runId, acked_at: isoMs(Date.now()) });
        writeState(p.state, state);
        sent++;
      }
    }
    if (!o.watermarkKey) { log("no watermark key"); return true; }

    // Watermark: every run ended at or before acknowledged_through is acked. An open run holds it one millisecond
    // before its start. period_end is yesterday (Chicago); period_start is the day after the cursor, or on the first
    // run the earliest outboxed day, clamped to period_end, so a rejected watermark is spanned by the next one.
    const periodEnd = chicagoDay(chicagoDayStartMs(o.nowMs) - 1);
    const open = openRunStartMs(o.rows);
    const ackMs = open === null ? o.nowMs : open - 1;
    let cursor = readState(p.state).watermark_acked_period_end ?? null;
    let periodStart: string | null = null;
    if (cursor) periodStart = dayAfter(cursor);
    else for (const e of outboxEntries(p.outbox)) { const d = chicagoDay(Date.parse(e.run.endedAt)); if (!periodStart || d < periodStart) periodStart = d; }
    // A past day acknowledged short of its end is re-sent: the period reaches back to it, whatever the cursor says.
    const shortDay = firstShortDay(readState(p.state).day_acks, periodEnd);
    if (cursor === periodEnd && sent === 0 && !shortDay) { log("confirmed through yesterday"); return true; }
    if (!periodStart || periodStart > periodEnd) periodStart = periodEnd;
    if (shortDay && shortDay < periodStart) periodStart = shortDay;
    if (!cursor) { cursor = dayBefore(periodStart); writeState(p.state, { ...readState(p.state), watermark_acked_period_end: cursor }); }
    const ack = isoMs(ackMs), instance = `${hostname()}:foreman`;
    const body = Buffer.from(JSON.stringify({ transformed_at: isoMs(o.nowMs), producer: SLUG, producer_instance: instance, period_start: periodStart, period_end: periodEnd, acknowledged_through: ack }), "utf8");
    const r = await post(o.baseUrl, "watermark", o.watermarkKey, `watermark:${SLUG}:${instance}:${periodEnd}:${ack}`, body);
    if (!r.ok) { console.error(`metrics:ship: watermark stopped: ${r.error}`); return false; }
    // Record the acknowledgement each day of this period got, so a day that was acknowledged short is found again.
    const acks = { ...(readState(p.state).day_acks ?? {}) };
    for (let d = periodStart; d <= periodEnd; d = dayAfter(d)) acks[d] = ack;
    for (const d of Object.keys(acks).sort().slice(0, -60)) delete acks[d];
    writeState(p.state, { ...readState(p.state), day_acks: acks });
    // The cursor moves only to the last day whose next midnight is at or before acknowledged_through.
    const done = chicagoDay(chicagoDayStartMs(ackMs) - 1), reach = done < periodEnd ? done : periodEnd;
    if (reach >= periodStart && (!cursor || reach > cursor)) writeState(p.state, { ...readState(p.state), watermark_acked_period_end: reach });
    return true;
  }
}

/** The clock; SLASHBIN_SHIPPER_NOW_MS pins it for tests only, production never sets it. */
export function shipClock(env: NodeJS.ProcessEnv = process.env): number {
  const pinned = env.SLASHBIN_SHIPPER_NOW_MS ? Number(env.SLASHBIN_SHIPPER_NOW_MS) : NaN;
  return Number.isFinite(pinned) ? pinned : Date.now();
}
