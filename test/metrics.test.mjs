import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsRecorder, openMetricsDb, readRows } from "../dist/metrics/recorder.js";
import { buildTimelines, aggregate, percentile } from "../dist/metrics/report.js";
import { registerBuiltinPlugins } from "../dist/plugins/index.js";
import { registeredPlugins } from "../dist/plugins/registry.js";
import { MetricsPlugin, metricsPath } from "../dist/plugins/metrics.js";
import { ForemanRuntime } from "../dist/runtime.js";

const warns = [];
const logger = { info() {}, debug() {}, error() {}, warn: (m) => warns.push(m), child() { return logger; } };
const R = "o/r";
const item = (n) => ({ issueNumber: n, repo: R });
let clock = Date.parse("2026-11-01T00:00:00Z");
const tick = (h = 1) => { clock += h * 3_600_000; };
function mk(days = 90) {
  const db = openMetricsDb(join(mkdtempSync(join(tmpdir(), "metrics-")), "m.db"));
  return { db, rec: new MetricsRecorder(db, days, () => clock) };
}
const rows = (db) => db.prepare("SELECT kind, stage, issue, detail FROM events ORDER BY id").all();
const snap = (items, extra = {}) => ({ kind: "snapshot", repo: R, items, ...extra });
const si = (n, stage) => ({ item: item(n), stage, detail: "x" });

test("transitions, context rows and snapshots record the right rows", () => {
  const { db, rec } = mk();
  rec.record({ kind: "claim", item: item(1) }, logger);
  rec.record({ kind: "transition", item: item(1), observed: false, move: "prOpened", from: "new", to: "inReview", stage: "inReview" }, logger);
  rec.record({ kind: "blocked", item: item(1), reason: "r" }, logger);
  rec.record({ kind: "session", session: { phase: "implement", status: "started", repo: R, items: [item(1), item(2)] } }, logger);
  rec.record({ kind: "release", release: { repo: R, state: "open", pr: 9, issues: [item(1)], productionBranch: "main" } }, logger);
  rec.record({ kind: "waiting", repo: R, items: [] }, logger);
  assert.deepEqual(rows(db).map((r) => `${r.kind}:${r.stage}:${r.issue}`),
    ["claim:null:1", "transition:inReview:1", "blocked:null:1", "session:null:1", "session:null:2", "release:null:1"]);
  const before = rows(db).length;
  rec.record(snap([si(1, "inReview")]), logger); // unchanged: nothing
  assert.equal(rows(db).length, before);
  rec.record(snap([si(1, "approved")]), logger); // changed: one row
  rec.record(snap([si(1, "approved")]), logger);
  assert.deepEqual(rows(db).slice(before).map((r) => `${r.kind}:${r.stage}`), ["stage:approved"]);
  rec.record(snap([], { cards: [{ item: item(3), title: "t", url: "u", state: "open", stage: "approved" }] }), logger);
  assert.equal(rows(db).filter((r) => r.issue === 3).length, 1);
});

test("a close via closed[] or cards[] is recorded once", () => {
  const { db, rec } = mk();
  rec.record(snap([], { closed: [{ item: item(1), state: "completed" }] }), logger);
  rec.record(snap([], { closed: [{ item: item(1), state: "completed" }] }), logger);
  const card = { item: item(2), title: "t", url: "u", state: "not_planned", stage: null };
  rec.record(snap([], { cards: [card] }), logger);
  rec.record(snap([], { cards: [card] }), logger);
  assert.deepEqual(rows(db).map((r) => `${r.kind}:${r.stage}:${r.issue}`), ["closed:done:1", "closed:notPlanned:2"]);
  rec.record({ kind: "transition", item: item(5), observed: false, move: "released", from: "releasing", to: "released", stage: "done" }, logger);
  rec.record(snap([], { closed: [{ item: item(5), state: "completed" }] }), logger);
  assert.equal(rows(db).filter((r) => r.issue === 5).length, 1);
});

test("retention deletes old rows and orphaned item_stage", () => {
  const { db, rec } = mk(10);
  rec.record(snap([si(1, "approved")]), logger);
  tick(24 * 11);
  rec.record(snap([si(2, "approved")]), logger);
  assert.deepEqual(rows(db).map((r) => r.issue), [2]);
  assert.deepEqual(db.prepare("SELECT issue FROM item_stage").all().map((r) => r.issue), [2]);
});

test("record never throws on a malformed event", () => {
  const { rec } = mk();
  warns.length = 0;
  for (const bad of [null, {}, { kind: "transition" }, { kind: "snapshot", items: [{}] }, { kind: "session", session: {} }]) {
    assert.doesNotThrow(() => rec.record(bad, logger));
  }
  assert.ok(warns.length > 0);
});

test("report: pickup from a batch implement session, durations, total, aggregates", () => {
  const t = (h) => new Date(Date.parse("2026-11-01T00:00:00Z") + h * 3_600_000).toISOString();
  const impl = { phase: "implement", status: "started" };
  const all = [
    { at: t(0), repo: R, issue: 7, kind: "session", stage: null, detail: impl },
    { at: t(1), repo: R, issue: 7, kind: "session", stage: null, detail: impl },
    { at: t(0.5), repo: R, issue: 8, kind: "session", stage: null, detail: impl },
    { at: t(0), repo: R, issue: 7, kind: "stage", stage: "approved", detail: null },
    { at: t(3), repo: R, issue: 7, kind: "transition", stage: "inReview", detail: {} },
    { at: t(3), repo: R, issue: 7, kind: "stage", stage: "inReview", detail: null },
    { at: t(5), repo: R, issue: 7, kind: "stage", stage: "approved", detail: null },
    { at: t(9), repo: R, issue: 7, kind: "closed", stage: "done", detail: null },
    { at: t(2), repo: R, issue: 8, kind: "stage", stage: "inReview", detail: null },
  ];
  const [a, b] = buildTimelines(all);
  assert.equal(a.issue, 7);
  assert.equal(a.pickup, t(1));
  assert.deepEqual(a.stages.map((s) => [s.stage, s.hours]), [["approved", 1], ["implementing", 2], ["inReview", 2], ["approved", 4], ["done", null]]);
  assert.equal(a.totalHours, 8);
  assert.equal(a.approvedToDoneHours, 9);
  assert.equal(b.pickup, t(0.5));
  assert.equal(b.doneAt, null);
  const agg = aggregate([a, b]);
  assert.equal(agg.items, 1);
  assert.equal(agg.stages.approved.median, 5);
  assert.equal(agg.stages.implementing.median, 2);
  assert.equal(agg.stages.inReview.count, 1);
  assert.equal(agg.total.median, 8);
  assert.equal(aggregate([a, b], Date.parse(t(10))).items, 0);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
});

test("readRows round-trips detail JSON and matches repo by short name", () => {
  const { db, rec } = mk();
  rec.record({ kind: "session", session: { phase: "implement", status: "started", repo: R, items: [item(1)], pr: 4 } }, logger);
  const r = readRows(db, { sinceIso: "2000-01-01T00:00:00Z", repo: "r" });
  assert.equal(r.length, 1);
  assert.equal(r[0].detail.phase, "implement");
  assert.equal(r[0].detail.pr, 4);
});

test("the plugin is registered, an observer, and off by default", () => {
  registerBuiltinPlugins(new ForemanRuntime());
  const p = registeredPlugins().find((x) => x.id === "metrics");
  assert.ok(p);
  assert.deepEqual([...p.roles], ["observer"]);
  assert.equal(p.enabled({}), false);
  assert.equal(p.enabled({ metrics: { enabled: false } }), false);
  assert.equal(p.enabled({ metrics: { enabled: true } }), true);
  assert.ok(p.commands["metrics:report"]);
  const dir = mkdtempSync(join(tmpdir(), "metrics-p-"));
  const mp = new MetricsPlugin();
  mp.start({ metrics: { enabled: true, path: join(dir, "x.db"), retentionDays: 5 } }, { logger, configText: () => null });
  assert.equal(mp.observer.wantsSnapshot(), true);
  assert.equal(metricsPath({ metrics: { enabled: true, path: "~/m.db", retentionDays: 1 } }).endsWith("/m.db"), true);
  mp.stop();
  assert.equal(mp.observer, undefined);
});
