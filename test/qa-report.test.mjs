// QA after the SRE's dev verify passes (report-only). The decision is pinned here
// with injected edges; the wiring into the verify phase is pinned against its source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QA_HEADING, QA_MAX_DURATION_MS, qaApplies, qaReportBody, readOutcome, runQaReport } from "../dist/qa-report.js";

const logs = [];
const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {}, debug() {}, child() { return this; } };
const CONSOLE = "xrgarcia/Slashbin-console";
const manifest = {
  verdict: "PASS", reason: "8 shots across 2 page(s) pass review",
  pages: [{ route: "/orders", why: "renders orders-table.tsx, edited here" }, { route: "/", why: "shared layout" }],
  shots: new Array(8).fill({}),
};
function deps(over = {}) {
  const posted = [];
  const d = {
    runs: 0, posted,
    hasReport: async () => false,
    post: async (pr, body) => { posted.push({ pr, body }); },
    run: async () => { d.runs++; return { kind: "manifest", exitCode: 0, manifest }; },
    ...over,
  };
  return d;
}

test("QA applies only to a configured repo on an install with a QA checkout", () => {
  const agent = { qaPath: "/qa", qaRepos: [CONSOLE] };
  assert.equal(qaApplies({ githubRepo: CONSOLE }, agent), true);
  assert.equal(qaApplies({ githubRepo: "xrgarcia/jerky_ops" }, agent), false, "a non-Console repo does not trigger it");
  assert.equal(qaApplies({ githubRepo: CONSOLE }, { qaRepos: [CONSOLE] }), false, "no qaPath: no QA");
});

test("a pass on Console runs QA once and posts the report under its heading", async () => {
  const d = deps();
  await runQaReport(CONSOLE, 1485, d, logger);
  assert.equal(d.runs, 1);
  assert.equal(d.posted.length, 1);
  const { pr, body } = d.posted[0];
  assert.equal(pr, 1485);
  assert.ok(body.startsWith(QA_HEADING));
  assert.match(body, /Verdict: PASS/);
  assert.match(body, /Reason: 8 shots across 2 page\(s\) pass review/);
  assert.match(body, /`\/orders` — renders orders-table\.tsx/);
  assert.match(body, /Shots: 8/);
  assert.match(body, /does not gate delivery yet/);
  assert.match(body, /slashbin_ai_qa#2/);
});

test("a second pass does not run or re-post: an existing heading comment ends it", async () => {
  const d = deps({ hasReport: async () => true });
  await runQaReport(CONSOLE, 1485, d, logger);
  assert.equal(d.runs, 0);
  assert.equal(d.posted.length, 0);
});

test("a run already in flight is not started twice", async () => {
  let release;
  const d = deps({ run: () => new Promise((r) => { release = () => r({ kind: "manifest", exitCode: 0, manifest }); }) });
  const first = runQaReport(CONSOLE, 7, d, logger);
  await new Promise((r) => setImmediate(r));
  await runQaReport(CONSOLE, 7, d, logger);
  release();
  await first;
  assert.equal(d.posted.length, 1);
});

test("a crash, a timeout and a post failure never reject, and the crash is told on the PR", async () => {
  const crash = deps({ run: async () => { throw new Error("boom"); } });
  await runQaReport(CONSOLE, 1, crash, logger);
  assert.equal(crash.posted.length, 1);
  assert.match(crash.posted[0].body, /QA errored/);
  assert.ok(logs.some((l) => /errored/.test(l)), "and logged");

  const broken = deps({ post: async () => { throw new Error("gh down"); } });
  await assert.doesNotReject(runQaReport(CONSOLE, 2, broken, logger));
  const unreadable = deps({ hasReport: async () => { throw new Error("gh down"); } });
  await assert.doesNotReject(runQaReport(CONSOLE, 3, unreadable, logger));
});

test("readOutcome: 0, 1 and 3 with a manifest are results; a timeout or another exit is an error", () => {
  const dir = new URL("./fixtures-qa/", import.meta.url).pathname;
  const ok = (code) => readOutcome({ code, stdout: "", stderr: "", timedOut: false }, dir, logger);
  assert.equal(ok(1).kind, "manifest");
  assert.equal(ok(3).kind, "manifest");
  assert.equal(ok(2).kind, "errored");
  assert.equal(readOutcome({ code: null, stdout: "", stderr: "", timedOut: true }, dir, logger).kind, "errored");
  assert.equal(readOutcome({ code: 0, stdout: "", stderr: "", timedOut: false }, "/nonexistent", logger).kind, "errored");
  assert.equal(QA_MAX_DURATION_MS, 600_000);
});

test("an errored body says QA errored and carries no process output", () => {
  const body = qaReportBody(9, { kind: "errored", detail: "timed out after 10 minutes" });
  assert.match(body, /^## QA Report \(report-only\)/);
  assert.match(body, /QA errored/);
});

test("verify wiring: the card advances first, QA is started after and never awaited", () => {
  const src = readFileSync(new URL("../src/phases/verify.ts", import.meta.url), "utf-8");
  const advanceAt = src.indexOf('"verifyPassed"');
  const qaAt = src.indexOf("runQaReport(");
  assert.ok(advanceAt > 0 && qaAt > advanceAt, "QA starts after the advance to pr approved");
  assert.ok(!/await\s+runQaReport/.test(src), "nothing waits on QA");
  assert.match(src.slice(qaAt - 200, qaAt), /qaApplies\(/, "gated on the QA repo list");
  assert.equal((src.match(/runQaReport\(/g) ?? []).length, 1, "only the pass path runs QA");
});

test("a timer fires while a slow lookup and a slow post are pending: runQaReport blocks nothing", async () => {
  const slow = (ms) => new Promise((r) => setTimeout(r, ms));
  const d = deps({ hasReport: async () => { await slow(150); return false; }, post: async (pr, body) => { await slow(150); d.posted.push({ pr, body }); } });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const started = runQaReport(CONSOLE, 4242, d, logger);
  assert.equal(d.runs, 0, "the call returns before any work starts");
  assert.equal(ticks, 0);
  await started;
  clearInterval(timer);
  assert.equal(d.posted.length, 1);
  assert.ok(ticks >= 15, `the loop kept ticking through ~300ms of waits (ticks=${ticks})`);
});
