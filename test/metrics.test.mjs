import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { configureIssueCache } from "../dist/github.js";
import { GitHubIssueConnector } from "../dist/github-work-source.js";
import { setStateDir } from "../dist/state-dir.js";
import { gateWaitReason } from "../dist/unstick.js";
import { MetricsRecorder, openMetricsDb, readRows } from "../dist/metrics/recorder.js";
import { buildTimelines, aggregate, percentile, formatReport } from "../dist/metrics/report.js";
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

test("node:sqlite is never imported at load (Node 22.12 has it only behind a flag)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["dist/metrics/recorder.js", "dist/metrics/report.js", "dist/plugins/metrics.js", "dist/plugins/index.js"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /^import .*node:sqlite/m, f);
  }
});

// ---- the flap (jerky_shipping#856) and the wait reason ----

test("root cause: snapshot and cards place an issue a release PR names at the same stage", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "metrics-flap-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  const gh = {
    issues: [{ number: 856, title: "t", labels: [{ name: "approved" }, { name: "pr approved" }] }],
    prs: [{ number: 9, url: "u", title: "Release", body: "- #856", headRefName: "develop", baseRefName: "main", headRefOid: "a".repeat(40) }],
  };
  writeFileSync(join(tmp, "gh-state.json"), JSON.stringify(gh));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const st = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(join(tmp, "gh-state.json"))}, "utf8"));
const a = process.argv.slice(2);
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (a[0] === "issue" && a[1] === "list") out(a.includes("closed") ? [] : st.issues);
if (a[0] === "pr" && a[1] === "list") out(st.prs);
out([]);
`);
  chmodSync(join(bin, "gh"), 0o755);
  const saved = { PATH: process.env.PATH, tok: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  process.chdir(tmp);
  setStateDir(tmp);
  configureIssueCache({ ttlMs: 0 });
  try {
    const cfgPath = join(tmp, "cfg.json");
    writeFileSync(cfgPath, JSON.stringify({ stages: [{ type: "implement" }], repos: [{ name: "r", repoPath: tmp, githubRepo: "o/r" }] }));
    const config = loadConfig(cfgPath).repos[0];
    const src = new GitHubIssueConnector();
    const card = (await src.cards(config, logger)).find((c) => c.item.issueNumber === 856);
    const snapItem = (await src.snapshot(config, logger)).find((i) => i.item.issueNumber === 856);
    assert.equal(card.stage, "awaitingRelease");
    assert.equal(snapItem.stage, card.stage, "one stage per pass, whichever read a recorder sees");
  } finally {
    process.chdir(saved.cwd);
    process.env.PATH = saved.PATH;
    if (saved.tok === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = saved.tok;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a snapshot whose items and cards disagree records one stage, not a flip each pass", () => {
  const { db, rec } = mk();
  const card = { item: item(856), title: "t", url: "u", state: "open", stage: "awaitingRelease" };
  for (let i = 0; i < 5; i++) { rec.record(snap([si(856, "pendingVerification")], { cards: [card] }), logger); tick(1 / 60); }
  assert.deepEqual(rows(db).map((r) => r.stage), ["awaitingRelease"]);
});

test("a snapshot-seen A -> B -> A inside the flap window is suppressed; a Foreman move and a later return are not", () => {
  const { db, rec } = mk();
  rec.record(snap([si(1, "pendingVerification")]), logger);
  tick(1);
  rec.record(snap([si(1, "awaitingRelease")]), logger);
  for (let i = 0; i < 4; i++) { tick(1 / 60); rec.record(snap([si(1, "pendingVerification")]), logger); rec.record(snap([si(1, "awaitingRelease")]), logger); }
  assert.deepEqual(rows(db).map((r) => r.stage), ["pendingVerification", "awaitingRelease"]);
  // Past the window the return to A is a real move.
  tick(1);
  rec.record(snap([si(1, "pendingVerification")]), logger);
  assert.deepEqual(rows(db).map((r) => r.stage), ["pendingVerification", "awaitingRelease", "pendingVerification"]);
  // The Foreman's own move is never suppressed.
  rec.record({ kind: "transition", item: item(1), observed: false, move: "x", from: "a", to: "awaitingRelease", stage: "awaitingRelease" }, logger);
  assert.equal(rows(db).at(-1).stage, "awaitingRelease");
});

const wsi = (n, stage, waitReason) => ({ ...si(n, stage), waitReason });

test("a hold row is written when the reason at pendingVerification changes, once per change, and again on re-entry", () => {
  const { db, rec } = mk();
  const holds = () => rows(db).filter((r) => r.kind === "hold").map((r) => JSON.parse(r.detail));
  rec.record(snap([wsi(1, "pendingVerification", "grant")]), logger);
  rec.record(snap([wsi(1, "pendingVerification", "grant")]), logger);
  tick();
  rec.record(snap([wsi(1, "pendingVerification", "seat-failed")]), logger);
  assert.deepEqual(holds(), [{ stage: "pendingVerification", reason: "grant" }, { stage: "pendingVerification", reason: "seat-failed" }]);
  tick();
  rec.record(snap([si(1, "releaseAuthorized")]), logger);
  tick();
  rec.record(snap([wsi(1, "pendingVerification", "seat-failed")]), logger);
  assert.equal(holds().length, 3, "leaving and re-entering the stage starts a new wait");
  rec.record(snap([wsi(2, "approved", "grant"), wsi(3, "pendingVerification", "bogus")]), logger);
  assert.equal(holds().length, 3, "a reason is only recorded at a hold stage and only from the closed set");
  rec.record(snap([wsi(4, "awaitingSignoff", "gate-failed")]), logger);
  assert.equal(holds().at(-1).stage, "awaitingSignoff");
});

test("gateWaitReason: grant, failed run, silent seat, failed gate, unknown", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const entry = (o) => ({ reason: "r", status: "pending", since: "2026-11-13T11:59:00Z", ...o });
  const g = (granted) => ` [grant: ${JSON.stringify({ granted, missing: [] })}]`;
  const w = (e) => gateWaitReason("pendingVerification", 1, e, undefined, now);
  assert.equal(w(entry({ reason: `x${g(false)}`, status: "invoked" })), "grant", "no grant wins over the run's status");
  assert.equal(w(entry({ reason: `x${g(true)}`, status: "failed" })), "seat-failed");
  assert.equal(w(entry({ status: "refused" })), "seat-failed");
  assert.equal(w(entry({ status: "invoked", recalls: 1 })), "seat-silent");
  assert.equal(w(entry({ status: "invoked", gaveUpAt: "2026-11-13T11:00:00Z" })), "seat-silent");
  assert.equal(w(entry({ status: "pending", since: "2026-11-13T09:00:00Z" })), "seat-silent");
  assert.equal(w(entry({ status: "invoked" })), "gate-failed");
  assert.equal(w(entry({ status: "escalated" })), "gate-failed");
  assert.equal(w(entry({ status: "declined" })), "gate-failed");
  assert.equal(w(entry({ reason: "x [grant: not json]" })), "other");
  assert.equal(w(undefined), "other");
  assert.equal(gateWaitReason("awaitingSignoff", 5, undefined, { unsigned: [5] }, now), "gate-failed");
  assert.equal(gateWaitReason("awaitingSignoff", 5, undefined, { unsigned: [6] }, now), "other");
});

test("report: pendingVerification hours split by reason, history before reasons is unrecorded", () => {
  const t = (h) => new Date(Date.parse("2026-11-01T00:00:00Z") + h * 3_600_000).toISOString();
  const mkRows = (n, spans) => spans;
  const a = [
    { at: t(0), repo: R, issue: 1, kind: "stage", stage: "pendingVerification", detail: null },
    { at: t(0), repo: R, issue: 1, kind: "hold", stage: null, detail: { stage: "pendingVerification", reason: "grant" } },
    { at: t(6), repo: R, issue: 1, kind: "hold", stage: null, detail: { stage: "pendingVerification", reason: "seat-silent" } },
    { at: t(10), repo: R, issue: 1, kind: "stage", stage: "releaseAuthorized", detail: null },
    { at: t(12), repo: R, issue: 1, kind: "closed", stage: "done", detail: null },
    { at: t(0), repo: R, issue: 2, kind: "stage", stage: "pendingVerification", detail: null },
    { at: t(4), repo: R, issue: 2, kind: "hold", stage: null, detail: { stage: "pendingVerification", reason: "grant" } },
    { at: t(8), repo: R, issue: 2, kind: "closed", stage: "done", detail: null },
  ];
  const [one, two] = buildTimelines(mkRows(0, a));
  assert.deepEqual(one.holdHours, { pendingVerification: { grant: 6, "seat-silent": 4 } });
  assert.deepEqual(two.holdHours, { pendingVerification: { unrecorded: 4, grant: 4 } });
  const agg = aggregate([one, two]);
  assert.equal(agg.holds.pendingVerification.grant.hours, 10);
  assert.equal(agg.holds.pendingVerification.grant.items, 2);
  assert.equal(agg.holds.pendingVerification["seat-silent"].hours, 4);
  assert.equal(agg.holds.pendingVerification.unrecorded.items, 1);
  assert.match(formatReport([one, two], agg), /pendingVerification by reason[\s\S]*grant\s+2\s+10\.0\s+56%/);
});
