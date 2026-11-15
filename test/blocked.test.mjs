// foreman#330: one blocked interval per block, by Central week; retention keeps an open block's start.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBlocked, readBlockedRows, weekStart, parseWindowEdge } from "../dist/metrics/blocked.js";
import { runBlocked } from "../dist/plugins/metrics.js";
import { MetricsRecorder, openMetricsDb } from "../dist/metrics/recorder.js";

const R = "o/r";
// November is CST (UTC-6): Mon 2026-11-02 00:00 CST = 06:00Z.
const row = (issue, at, kind) => ({ at, repo: R, issue, kind, stage: null, detail: null });
const read = (rows, now = "2026-11-16T12:00:00Z", from = "2026-11-02", to = "2026-11-15") => readBlocked(rows, from, to, now).rows;

test("an interval is cut at the Monday 00:00 Central edge", () => {
  const rows = read([row(1, "2026-11-07T04:00:00Z", "blocked"), row(1, "2026-11-09T08:00:00Z", "unblocked")]);
  assert.deepEqual(rows.map((r) => [r.week, r.hours]), [["2026-11-02", 50], ["2026-11-09", 2]]);
});

test("repeated blocked rows with changing reasons are one interval", () => {
  const rows = read([row(2, "2026-11-03T15:00:00Z", "blocked"), row(2, "2026-11-03T16:00:00Z", "blocked"), row(2, "2026-11-03T17:00:00Z", "blocked"), row(2, "2026-11-03T18:00:00Z", "unblocked")]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].hours, rows[0].intervals], [3, 1]);
});

test("a blocked row after a clear starts a second interval", () => {
  const rows = read([row(2, "2026-11-03T15:00:00Z", "blocked"), row(2, "2026-11-03T16:00:00Z", "unblocked"), row(2, "2026-11-03T17:00:00Z", "blocked"), row(2, "2026-11-03T19:00:00Z", "unblocked")]);
  assert.deepEqual([rows[0].hours, rows[0].intervals], [3, 2]);
});

test("closed ends the interval; a closed card that was never blocked has none", () => {
  const rows = read([row(3, "2026-11-04T15:00:00Z", "blocked"), row(3, "2026-11-04T17:00:00Z", "closed"), row(9, "2026-11-04T17:00:00Z", "closed")]);
  assert.deepEqual(rows.map((r) => [r.issue, r.hours]), [[3, 2]]);
});

test("an open block is counted to the week end, carried into later weeks and marked open", () => {
  const rows = read([row(4, "2026-11-08T22:00:00Z", "blocked")]);
  assert.deepEqual(rows.map((r) => [r.week, r.hours, r.open]), [["2026-11-02", 8, true], ["2026-11-09", 168, true]]);
});

test("the current week of an open block runs to now, and later weeks are not invented", () => {
  const rows = read([row(4, "2026-11-08T22:00:00Z", "blocked")], "2026-11-10T06:00:00Z", "2026-11-02", "2026-12-01");
  assert.deepEqual(rows.map((r) => [r.week, r.hours]), [["2026-11-02", 8], ["2026-11-09", 24]]);
});

test("a clear with no start row is incomplete, never zero; a duplicate clear after a block is ignored", () => {
  const rows = read([row(5, "2026-11-04T15:00:00Z", "unblocked"), row(6, "2026-11-04T15:00:00Z", "blocked"), row(6, "2026-11-04T16:00:00Z", "unblocked"), row(6, "2026-11-04T17:00:00Z", "unblocked")]);
  const five = rows.filter((r) => r.issue === 5);
  assert.deepEqual([five.length, five[0].incomplete, five[0].hours], [1, true, null]);
  assert.deepEqual(rows.filter((r) => r.issue === 6).map((r) => r.hours), [1]);
});

test("the window picks weeks that overlap it, and a block begun before it carries in", () => {
  const rows = [row(7, "2026-11-01T12:00:00Z", "blocked"), row(7, "2026-11-10T12:00:00Z", "unblocked")];
  assert.deepEqual(read(rows, "2026-11-16T12:00:00Z", "2026-11-09", "2026-11-16").map((r) => r.week), ["2026-11-09"]);
  assert.equal(read(rows, "2026-11-16T12:00:00Z", "2026-11-17", "2026-11-20").length, 0);
});

test("weeks follow US Central through DST: the fall-back week holds 169 hours", () => {
  assert.equal(weekStart(Date.parse("2026-11-04T12:00:00Z")), Date.parse("2026-11-02T06:00:00Z"));
  // The week of Mon 2026-10-26 (CDT, UTC-5) ends Mon 2026-11-02 (CST, UTC-6): 169 hours.
  const rows = read([row(8, "2026-10-26T05:00:00Z", "blocked")], "2026-11-02T06:00:00Z", "2026-10-26", "2026-11-02");
  assert.deepEqual(rows.map((r) => [r.week, r.hours]), [["2026-10-26", 169]]);
});

test("parseWindowEdge reads a bare date as Central midnight and rejects junk", () => {
  assert.equal(parseWindowEdge("2026-11-02"), Date.parse("2026-11-02T06:00:00Z"));
  assert.equal(parseWindowEdge("2026-11-02T10:00:00Z"), Date.parse("2026-11-02T10:00:00Z"));
  assert.ok(Number.isNaN(parseWindowEdge("soon")));
});

const dayMs = 86_400_000;
function store(days = 90) {
  const path = join(mkdtempSync(join(tmpdir(), "blocked-")), "m.db");
  const db = openMetricsDb(path);
  let clock = Date.parse("2026-11-10T00:00:00Z");
  const rec = new MetricsRecorder(db, days, () => clock);
  const at = (ago) => new Date(Date.parse("2026-11-10T00:00:00Z") - ago * dayMs).toISOString();
  const put = (issue, ago, kind) => db.prepare("INSERT INTO events (at, repo, issue, kind) VALUES (?, ?, ?, ?)").run(at(ago), R, issue, kind);
  return { db, rec, put, path, setClock: (t) => { clock = t; } };
}
const left = (db, issue) => db.prepare("SELECT kind FROM events WHERE issue = ? ORDER BY id").all(issue).map((r) => r.kind);

test("retain keeps the rows of a 100-day-old open block, drops a cleared one and other old kinds", () => {
  const { db, rec, put } = store();
  put(1, 100, "blocked"); put(1, 99, "blocked"); put(1, 100, "claim");
  put(2, 100, "blocked"); put(2, 95, "unblocked");
  put(3, 100, "blocked"); put(3, 95, "closed");
  put(4, 100, "blocked"); put(4, 95, "unblocked"); put(4, 94, "blocked");
  rec.retain(true);
  assert.deepEqual(left(db, 1), ["blocked", "blocked"]);
  assert.deepEqual(left(db, 2), []);
  assert.deepEqual(left(db, 3), []);
  assert.deepEqual(left(db, 4), ["blocked", "unblocked", "blocked"]);
});

test("after retention a 100-day-old open block still reads as one open interval", () => {
  const { db, rec, put } = store();
  put(1, 100, "blocked"); put(1, 99, "blocked");
  rec.retain(true);
  const rows = readBlocked(readBlockedRows(db), "2026-08-03", "2026-08-10", "2026-11-10T00:00:00Z").rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].open, true);
  assert.ok(!rows[0].incomplete);
});

test("runBlocked prints JSON for a store, and refuses a missing file or a bad window", async () => {
  const { path, put } = store();
  put(1, 3, "blocked");
  const lines = [];
  const log = console.log; const err = console.error;
  console.log = (m) => lines.push(m); console.error = () => {};
  try {
    assert.equal(await runBlocked({}, ["--db", path, "--from", "2026-11-02", "--to", "2026-11-09", "--now", "2026-11-10T00:00:00Z", "--json"]), true);
    assert.equal(JSON.parse(lines[0]).rows.length, 1);
    assert.equal(await runBlocked({}, ["--db", join(tmpdir(), "nope", "m.db"), "--from", "2026-11-02", "--to", "2026-11-09"]), false);
    assert.equal(await runBlocked({}, ["--db", path, "--from", "x", "--to", "2026-11-09"]), false);
  } finally {
    console.log = log; console.error = err;
  }
});
