// The run ledger (foreman#329, EM epic #2011): every agent run records its outcome and the cards it worked,
// and `metrics:runs` reads the billable ones. Fixture event streams go through the real MetricsRecorder into runs.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsRecorder, openMetricsDb } from "../dist/metrics/recorder.js";
import { readRuns, readSessionRows, splitDuration } from "../dist/metrics/runs.js";
import { aggregate, buildTimelines } from "../dist/metrics/report.js";
import { parseEmResult, emRunEnd, unstickViaEm } from "../dist/plugins/em.js";
import { prodVerifyEnd } from "../dist/phases/release.js";
import { isDeliveredVerdict, QA_FAIL_REASON, QaReports, qaReportEnd } from "../dist/qa-report.js";
import { addObserver, drainObservers } from "../dist/work-source.js";
import { runRuns } from "../dist/plugins/metrics.js";
import { recordRun } from "../dist/session-run.js";

const logger = { info() {}, debug() {}, error() {}, warn() {}, child() { return logger; } };
const R = "o/r";
const card = (n, repo = R) => ({ repo, issueNumber: n });
const T0 = Date.parse("2026-11-09T00:00:00Z");
const FROM = "2026-11-09T00:00:00.000Z";
const TO = "2026-11-16T00:00:00.000Z";
const at = (ms) => new Date(T0 + ms).toISOString();

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "runs-")), "m.db");
  const db = openMetricsDb(path);
  const rec = new MetricsRecorder(db, 90, () => T0);
  const session = (s) => rec.record({ kind: "session", session: { repo: R, items: [card(1)], ...s } }, logger);
  const run = (runId, phase, items, startMs, endMs, end = {}) => {
    session({ runId, phase, status: "started", items, at: at(startMs) });
    if (endMs !== null) session({ runId, phase, status: "finished", outcome: "completed", items, workedItems: items, at: at(endMs), ...end });
  };
  return { path, db, rec, session, run, read: (from = FROM, to = TO) => readRuns(readSessionRows(db), from, to) };
}

test("a run on 3 cards yields 3 shares that sum exactly to end minus start", () => {
  const f = fixture();
  f.run("a", "implement", [card(3), card(1), card(2)], 1000, 1000 + 3_600_001);
  const { billable } = f.read();
  assert.equal(billable.length, 1);
  const b = billable[0];
  assert.equal(b.durationMs, 3_600_001);
  assert.deepEqual(b.shares.map((s) => s.issueNumber), [1, 2, 3], "ascending by (repo, issueNumber)");
  assert.equal(b.shares.reduce((n, s) => n + s.ms, 0), b.durationMs);
  assert.deepEqual(b.shares.map((s) => s.ms), [1_200_001, 1_200_000, 1_200_000], "the remainder goes to the first share");
  assert.deepEqual([b.phase, b.outcome, b.startedAt, b.endedAt], ["implement", "completed", at(1000), at(1000 + 3_600_001)]);
  assert.deepEqual(splitDuration(10, [card(2, "b/x"), card(9, "a/x")]).map((s) => [s.repo, s.ms]), [["a/x", 5], ["b/x", 5]]);
});

test("a nested QA run inside a review counts once, and duplicate end rows count once", () => {
  const f = fixture();
  f.run("review", "review", [card(1), card(2)], 0, 60_000);
  f.session({ runId: "qa", parentRunId: "review", phase: "qa", status: "started", items: [card(1), card(2)], at: at(10_000) });
  f.session({ runId: "qa", parentRunId: "review", phase: "qa", status: "finished", outcome: "completed", items: [card(1), card(2)], workedItems: [card(1), card(2)], at: at(50_000) });
  f.session({ runId: "review", phase: "review", status: "finished", outcome: "completed", items: [card(1)], workedItems: [card(1), card(2)], at: at(60_000) });
  const out = f.read();
  assert.deepEqual(out.billable.map((r) => r.runId), ["review"]);
  assert.equal(out.billable[0].durationMs, 60_000);
  assert.deepEqual(out.unclassified, []);
});

test("noWork, failed, no runId and no end are not billable; failed runs are listed; a run with no end is unclassified", () => {
  const f = fixture();
  f.run("skip", "implement", [card(1)], 0, 1000, { outcome: "noWork" });
  f.run("bad", "verify", [card(2)], 0, 2000, { status: "failed", outcome: "failed" });
  f.run("open", "review", [card(3)], 500, null);
  f.session({ phase: "implement", status: "started", items: [card(4)], at: at(0) }); // before this feature
  f.session({ phase: "implement", status: "finished", items: [card(4)], at: at(5000) });
  f.run("nooutcome", "revise", [card(5)], 0, 3000, { outcome: undefined });
  f.run("done", "revise", [card(6)], 0, 4000);
  const out = f.read();
  assert.deepEqual(out.billable.map((r) => r.runId), ["done"]);
  assert.deepEqual(out.failed.map((r) => [r.runId, r.outcome, r.durationMs, r.shares]), [["bad", "failed", 2000, [{ repo: R, issueNumber: 2, ms: 2000 }]]]);
  const reasons = Object.fromEntries(out.unclassified.map((u) => [u.runId ?? `row${u.issueNumber}`, u.reason]));
  assert.deepEqual(reasons, { open: "noEnd", row4: "noRunId", nooutcome: "noOutcome" });
});

test("a run belongs to the window its end falls in; the window is half-open; an orphan nested run is reported", () => {
  const f = fixture();
  const week = 7 * 86_400_000;
  f.run("spans", "implement", [card(1)], week - 1000, week + 1000); // ends in the next week
  f.run("edge", "implement", [card(2)], week - 2000, week); // ends exactly at `to`: not in this window
  f.run("inside", "implement", [card(3)], 0, 5);
  f.session({ runId: "kid", parentRunId: "gone", phase: "qa", status: "started", items: [card(1)], at: at(0) });
  f.session({ runId: "kid", parentRunId: "gone", phase: "qa", status: "finished", outcome: "completed", items: [card(1)], workedItems: [card(1)], at: at(10) });
  const first = f.read();
  assert.deepEqual(first.billable.map((r) => r.runId), ["inside"]);
  assert.deepEqual(first.unclassified.map((u) => [u.runId, u.reason]), [["kid", "orphanNested"]]);
  const next = f.read(at(week), at(2 * week));
  assert.deepEqual(next.billable.map((r) => r.runId), ["edge", "spans"]);
  assert.deepEqual(f.read(), first, "a re-run returns the same answer");
});

test("an end row stamped by the producer keeps its own time; a phase's end with no cards is unclassified", () => {
  const f = fixture();
  f.run("none", "implement", [card(1)], 0, 1000, { workedItems: [] });
  assert.deepEqual(f.read().unclassified.map((u) => u.reason), ["noWorkedItems"]);
  const rows = readSessionRows(f.db);
  assert.equal(rows[0].at, at(0));
});

test("the recorder stores runId, parentRunId, outcome and workedItems in the session detail", () => {
  const f = fixture();
  f.session({ runId: "x", parentRunId: "p", phase: "qa", status: "finished", outcome: "failed", workedItems: [card(1)], reviewer: "QA" });
  const d = JSON.parse(f.db.prepare("SELECT detail FROM events WHERE kind = 'session'").get().detail);
  assert.deepEqual(d, { phase: "qa", status: "finished", reviewer: "QA", runId: "x", parentRunId: "p", outcome: "failed", workedItems: [card(1)] });
});

test("the new phases do not change the pickup report: only an implement start is a pickup", () => {
  const f = fixture();
  f.session({ runId: "e", phase: "em", status: "started", items: [card(1)], at: at(0) });
  f.session({ runId: "p", phase: "prodVerify", status: "started", items: [card(1)], at: at(10) });
  f.session({ runId: "i", phase: "implement", status: "started", items: [card(1)], at: at(0) });
  f.rec.record({ kind: "transition", item: card(1), observed: false, move: "prOpened", from: "new", to: "inReview", stage: "inReview" }, logger);
  const rows = f.db.prepare("SELECT id, at, repo, issue, kind, stage, detail FROM events ORDER BY id").all()
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  const [tl] = buildTimelines(rows);
  assert.equal(tl.pickup, at(0));
  assert.ok(aggregate([tl], 0));
});

test("each phase's end site sets the outcome the spec names", () => {
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const implement = src("phases/implement.ts");
  assert.match(implement, /skipped: true|result\.skipped\s*\n?\s*\? \{ status: "finished", outcome: "noWork"/);
  assert.match(implement, /result\.landed\s*\n?\s*\? \{ status: "finished", outcome: "noWork"/);
  assert.match(implement, /result\.success\s*\n?\s*\? \{ status: "finished", outcome: "completed"/);
  assert.match(src("phases/review.ts"), /outcome: noOp \? "noWork" : "completed", detail: outcome \}/, "a changes-requested review is a delivered verdict; a declared no-op is not");
  assert.match(src("phases/review.ts"), /ended = \{ status: "finished", outcome: "failed", detail: `merged PR/);
  assert.match(src("phases/revise.ts"), /outcome: result\.noCommit \? "noWork" : "completed"/);
  assert.match(src("phases/verify.ts"), /outcome: isDeliveredVerdict\(r\) \? "completed" : "failed", detail: why/, "a failing SRE or QA verdict is completed");
  assert.match(src("phases/verify.ts"), /parentRunId: session\.runId/, "the nested QA carries the verify run's id");
  assert.match(src("phases/qa-before-merge.ts"), /parentRunId: session\.runId/);
  assert.match(src("phases/qa-before-merge.ts"), /outcome: decision\.kind === "hold" \? "failed" : reused \? "noWork" : "completed"/);
  for (const f of ["implement", "review", "revise", "verify", "qa-before-merge"]) {
    assert.doesNotMatch(src(`phases/${f}.ts`), /ended = \{ status: "(finished|failed)", detail/, `${f} has an end with no outcome`);
  }
  const ok = { kind: "verdict", pass: true };
  assert.equal(isDeliveredVerdict(ok), true);
  assert.equal(isDeliveredVerdict({ kind: "verdict", pass: false, reason: "prod-failing" }), true);
  assert.equal(isDeliveredVerdict({ kind: "verdict", pass: false, by: "QA", reason: QA_FAIL_REASON }), true);
  assert.equal(isDeliveredVerdict({ kind: "verdict", pass: false, by: "QA", reason: "qa-errored" }), false);
  assert.equal(isDeliveredVerdict({ kind: "error", error: "x" }), false);
});

test("prodVerifyEnd: a verdict completes, nothing is noWork, an error fails; every call site is a recorded run", () => {
  const items = [card(1), card(2)];
  assert.deepEqual(prodVerifyEnd({ kind: "verdict", pass: false, reason: "held" }, "prod", items), { status: "finished", outcome: "completed", detail: "prod: held", workedItems: items });
  assert.equal(prodVerifyEnd({ kind: "nothing", reason: "none" }, "soak", items).outcome, "noWork");
  const e = prodVerifyEnd({ kind: "error", error: "boom" }, "prod", items);
  assert.deepEqual([e.status, e.outcome], ["failed", "failed"]);
  const release = readFileSync(new URL("../src/phases/release.ts", import.meta.url), "utf8");
  assert.equal((release.match(/verifyProd\(repoConfig, config, (rel|held),/g) ?? []).length, 4, "four call sites, all through the recorded wrapper");
  assert.match(release, /phase: "prodVerify"/);
  assert.doesNotMatch(release.slice(release.indexOf("async function mergedVerdict"), release.indexOf("const path = transcript(repoConfig, `verify-pr${rel.pr}`")), /recordRun/, "an existing comment's verdict runs nothing");
});

test("parseEmResult and emRunEnd follow the EM's own verdict", () => {
  const line = (o) => `noise\nEM unstick-result ${JSON.stringify(o)}\nEM unstick acted: commented on o/r#1`;
  const acted = parseEmResult(line({ verdict: "acted", readable: true, worked: [card(1), card(2)] }));
  assert.deepEqual(acted.worked, [card(1), card(2)]);
  assert.deepEqual(emRunEnd({ kind: "invoked", detail: "" }, acted), { status: "finished", outcome: "completed", detail: "invoked: acted", workedItems: [card(1), card(2)] });
  const esc = parseEmResult(line({ verdict: "escalated", readable: true, worked: [card(1)] }));
  assert.equal(emRunEnd({ kind: "escalated", detail: "" }, esc).outcome, "completed");
  const unreadable = parseEmResult(line({ verdict: "escalated", readable: false, worked: [] }));
  assert.deepEqual(emRunEnd({ kind: "escalated", detail: "" }, unreadable), { status: "failed", outcome: "failed", detail: "escalated: escalated", workedItems: [] });
  const oos = parseEmResult(line({ verdict: "out-of-scope", readable: true, worked: [] }));
  assert.deepEqual([emRunEnd({ kind: "declined", detail: "" }, oos).outcome, emRunEnd({ kind: "declined", detail: "" }, oos).status], ["noWork", "finished"]);
  for (const kind of ["failed", "refused"]) assert.equal(emRunEnd({ kind, detail: "x" }, acted).outcome, "failed");
  assert.equal(emRunEnd({ kind: "failed", detail: "unknown kind" }, null).outcome, "failed", "unknown-kind: no result line");
  assert.equal(emRunEnd({ kind: "declined", detail: "" }, null).outcome, "failed", "a decline with no result line is not trusted");
  for (const bad of ["", "EM unstick-result {not json", `EM unstick-result ${JSON.stringify({ verdict: "weird", readable: true, worked: [] })}`, `EM unstick-result ${JSON.stringify({ verdict: "acted", readable: true, worked: [{ repo: "o/r" }] })}`]) {
    assert.equal(parseEmResult(bad), null, bad);
  }
});

test("an em run and a prodVerify run are recorded with their worked cards, end to end", async () => {
  const f = fixture();
  addObserver({ onEvent: async (event, log) => f.rec.record(event, log), wantsSnapshot: () => false });
  const em = mkdtempSync(join(tmpdir(), "fake-em-"));
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "bin/em.mjs"), `
    const result = { verdict: "acted", readable: true, worked: [{ repo: "o/r", issueNumber: 7 }, { repo: "o/r", issueNumber: 8 }] };
    console.log("EM unstick-result " + JSON.stringify(result));
    console.log("EM unstick acted: commented on o/r#7");
  `);
  process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
  const outcome = await unstickViaEm({ githubRepo: "o/r", name: "r" }, { emRepoPath: em }, 7, "release-gate", "why", logger);
  assert.equal(outcome.kind, "invoked");
  await recordRun({ phase: "prodVerify", repo: R, pr: 9, items: [card(1), card(2)], reviewer: "SRE" }, logger, async () => ({ kind: "verdict", pass: true }), (r) => prodVerifyEnd(r, "prod", [card(1), card(2)]));
  await assert.rejects(recordRun({ phase: "prodVerify", repo: R, items: [card(3)], reviewer: "SRE" }, logger, async () => { throw new Error("aborted"); }, () => assert.fail()), /aborted/);
  await drainObservers();
  const rows = f.db.prepare("SELECT issue, detail FROM events WHERE kind = 'session' ORDER BY id").all().map((r) => ({ issue: r.issue, ...JSON.parse(r.detail) }));
  const emRows = rows.filter((r) => r.phase === "em");
  assert.deepEqual(emRows.map((r) => [r.issue, r.status, r.reviewer]), [[7, "started", "EM"], [7, "finished", "EM"]]);
  assert.deepEqual(emRows[1].workedItems, [card(7), card(8)]);
  assert.equal(emRows[0].runId, emRows[1].runId);
  const pv = rows.filter((r) => r.phase === "prodVerify" && r.issue === 1);
  assert.deepEqual(pv.map((r) => [r.status, r.outcome]), [["started", undefined], ["finished", "completed"]]);
  const threw = rows.filter((r) => r.issue === 3);
  assert.deepEqual(threw.map((r) => [r.status, r.outcome]), [["started", undefined], ["failed", "failed"]]);
  const out = readRuns(readSessionRows(f.db), "2000-01-01T00:00:00.000Z", new Date(Date.now() + 60_000).toISOString());
  assert.deepEqual(out.billable.map((r) => r.phase).sort(), ["em", "prodVerify"]);
  assert.deepEqual(out.billable.find((r) => r.phase === "em").shares.map((s) => s.issueNumber), [7, 8]);
});

test("metrics:runs --json prints the contract shape; an unreadable store prints nothing and fails", async () => {
  const f = fixture();
  f.run("a", "review", [card(1)], 0, 5000);
  f.db.close();
  const printed = [];
  const log = console.log;
  console.log = (s) => printed.push(s);
  try {
    assert.equal(await runRuns({ metrics: { enabled: true, path: f.path, retentionDays: 90 } }, ["--from", FROM, "--to", TO, "--json"]), true);
  } finally {
    console.log = log;
  }
  const out = JSON.parse(printed.join("\n"));
  assert.deepEqual(Object.keys(out).sort(), ["billable", "failed", "from", "to", "unclassified"]);
  assert.deepEqual([out.from, out.to], [FROM, TO]);
  assert.deepEqual(out.billable, [{ runId: "a", phase: "review", outcome: "completed", startedAt: at(0), endedAt: at(5000), durationMs: 5000, shares: [{ repo: R, issueNumber: 1, ms: 5000 }] }]);
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(await runRuns({ metrics: { enabled: true, path: join(tmpdir(), "nope", "m.db"), retentionDays: 90 } }, ["--from", FROM, "--to", TO, "--json"]), false);
    assert.equal(await runRuns({ metrics: { enabled: true, path: f.path, retentionDays: 90 } }, ["--from", "x", "--to", TO]), false);
  } finally {
    console.error = err;
  }
});

test("a production wait or tooling deferral is failed, never billable; a delivered fail stays completed", () => {
  const items = [card(1), card(2)];
  for (const reason of ["wait-until-20261116T0600Z", "codex-unavailable"]) {
    for (const mode of ["prod", "soak"]) assert.equal(prodVerifyEnd({ kind: "verdict", pass: false, reason }, mode, items).outcome, "failed", `${mode} ${reason}`);
  }
  assert.equal(prodVerifyEnd({ kind: "verdict", pass: false, reason: "prod-failing" }, "prod", items).outcome, "completed");
  assert.equal(prodVerifyEnd({ kind: "verdict", pass: true }, "prod", items).outcome, "completed");
});

test("a run with no cards stays in the ledger, and a run's worked list is stored once, not once per card", () => {
  const f = fixture();
  f.session({ runId: "c1", phase: "review", status: "started", items: [], at: at(0) });
  f.session({ runId: "c1", phase: "review", status: "finished", outcome: "completed", items: [], workedItems: [], at: at(1000) });
  f.session({ runId: "c2", phase: "review", status: "started", items: [], at: at(0) });
  f.session({ runId: "c2", phase: "review", status: "failed", outcome: "failed", items: [], workedItems: [], at: at(2000) });
  const out = f.read();
  assert.deepEqual(out.unclassified.map((u) => [u.runId, u.reason]), [["c1", "noWorkedItems"]]);
  assert.deepEqual(out.failed.map((r) => [r.runId, r.durationMs, r.shares.length]), [["c2", 2000, 0]]);
  const many = Array.from({ length: 100 }, (_, i) => card(i + 1));
  f.run("big", "implement", many, 0, 5000);
  const bytes = f.db.prepare("SELECT SUM(LENGTH(detail)) AS n FROM events WHERE kind = 'session' AND detail LIKE '%\"big\"%'").get().n;
  assert.ok(bytes < 100 * 400, `stored ${bytes} bytes for 100 cards`);
  assert.equal(f.read().billable.find((r) => r.runId === "big").shares.length, 100, "every card association is recoverable");
});

test("report-only QA is a ledger run of its own, ends by its outcome, and a report already on the PR runs nothing", async () => {
  const f = fixture();
  addObserver({ onEvent: async (event, log) => f.rec.record(event, log), wantsSnapshot: () => false });
  const manifest = { verdict: "FAIL", reason: "x", pages: [], shots: [] };
  const deps = (over = {}) => ({ hasReport: async () => false, post: async () => {}, run: async () => ({ kind: "manifest", exitCode: 1, manifest }), ...over });
  const track = { base: { phase: "qaReport", repo: R, pr: 9, items: [card(1), card(2)], reviewer: "QA" } };
  await new QaReports().run(R, 9, deps(), logger, track);
  await new QaReports().run(R, 10, deps({ hasReport: async () => true }), logger, { base: { ...track.base, pr: 10 } });
  await new QaReports().run(R, 11, deps({ run: async () => ({ kind: "errored", detail: "boom" }) }), logger, { base: { ...track.base, pr: 11 } });
  await drainObservers();
  const out = readRuns(readSessionRows(f.db), "2000-01-01T00:00:00.000Z", new Date(Date.now() + 60_000).toISOString());
  assert.deepEqual(out.billable.map((r) => [r.phase, r.outcome, r.shares.map((s) => s.issueNumber)]), [["qaReport", "completed", [1, 2]]], "a FAIL verdict is delivered; the existing report ran nothing");
  assert.deepEqual(out.failed.map((r) => r.phase), ["qaReport"], "the errored run is listed as failed");
  assert.equal(qaReportEnd({ kind: "errored", detail: "d" }, []).outcome, "failed");
  const paperclip = readFileSync(new URL("../src/phases/verify.ts", import.meta.url), "utf8");
  assert.match(paperclip, /phase: "qaReport"/, "the post-verify QA run is tracked");
});

test("a declared review no-op and a reused QA verdict record noWork with no cards", () => {
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  assert.match(src("phases/review.ts"), /const noOp = \(result\.trailers \?\? \[\]\)\.length === 0;[\s\S]*if \(noOp\) workedItems = \[\];/);
  assert.match(src("phases/qa-before-merge.ts"), /workedItems: reused \? \[\] : items/);
  assert.match(src("phases/qa-before-merge.ts"), /outcome: decision\.reused \? "noWork" : "completed"[\s\S]*if \(decision\.reused\) workedItems = \[\];/);
});
