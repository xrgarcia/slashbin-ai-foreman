// QA as a gate (config.qaGate, EM#923 feature 3): QA runs on an SRE pass BEFORE the advance.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyQaGate, qaGateBody, qaGateMarker, qaFailSummary, QA_GATE_HEADING, qaApplies } from "../dist/qa-report.js";
import { verifyHoldPlan, reworkIssueBody } from "../dist/phases/verify.js";
import { configSchema } from "../dist/config.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const REPO = "xrgarcia/Slashbin-console";
const sre = { kind: "verdict", pass: true, trailer: { deploy: "SUCCESS" }, summary: "sre ok" };
const find = (route, vp, criterion, reason) => ({ route, viewport: vp, items: [{ criterion, reason }] });
const manifests = {
  PASS: { verdict: "PASS", reason: "8 shots have no regression", sha: "abc", pages: [{ route: "/a", why: "edited" }], shots: [{ file: "a-1.png" }],
    preExisting: [find("/old", "phone", "spacing", "gap missing")] },
  FAIL: { verdict: "FAIL", reason: "1 regression", sha: "abc", pages: [{ route: "/a" }], shots: [{ file: "a-phone.png" }, { file: "a-ipad.png" }],
    regressions: [find("/a", "ipad", "clipping_overflow", "badge spills")], preExisting: [find("/old", "phone", "spacing", "gap")] },
  HELD: { verdict: "HELD", reason: "dev-unreachable: x", hold: "dev-unreachable", sha: "abc", shots: [] },
};
function deps(outcome, over = {}) {
  const d = {
    posted: [], runs: 0, markers: new Set(),
    run: async () => { d.runs++; if (outcome instanceof Error) throw outcome; return outcome; },
    hasMarker: async (_pr, m) => d.markers.has(m),
    hasReport: async () => false,
    post: async (_pr, body) => { d.posted.push(body); },
    ...over,
  };
  return d;
}
const result = (v, code) => ({ kind: "manifest", exitCode: code, manifest: manifests[v] });

test("PASS: the SRE result goes through untouched, so the card advances", async () => {
  const out = await applyQaGate(sre, REPO, 5, deps(result("PASS", 0)), logger);
  assert.equal(out, sre);
});

test("FAIL: not a pass; the visual-qa-failed rework hold carries QA's regressions and shot names", async () => {
  const out = await applyQaGate(sre, REPO, 5, deps(result("FAIL", 1)), logger);
  assert.equal(out.pass, false);
  assert.equal(out.reason, "visual-qa-failed");
  assert.deepEqual(verifyHoldPlan(out.reason), { kind: "rework" });
  assert.match(out.summary, /`\/a` ipad: clipping_overflow \(badge spills\)/);
  assert.match(out.summary, /a-phone\.png, a-ipad\.png/);
  assert.doesNotMatch(out.summary, /\/old/, "pre-existing defects are not rework");
  const body = reworkIssueBody(7, 70, out.summary, out.by);
  assert.match(body, /clipping_overflow/);
  assert.match(body, /## Pre-Flight/);
  assert.match(body, /## Acceptance/);
  assert.match(body, /## QA output/);
});

test("HELD, a crash, an unreadable run and an inconsistent exit hold with a charged qa-* reason; never a pass", async () => {
  for (const o of [result("HELD", 3), { kind: "errored", detail: "timed out after 10 minutes" }, new Error("boom"), { kind: "manifest", exitCode: 0, manifest: manifests.FAIL }, { kind: "manifest", exitCode: 0, manifest: { verdict: "WAT" } }]) {
    const out = await applyQaGate(sre, REPO, 5, deps(o), logger);
    assert.equal(out.pass, false, JSON.stringify(o).slice(0, 60));
    assert.match(out.reason, /^qa-/);
    assert.deepEqual(verifyHoldPlan(out.reason), { kind: "charge" }, "held per the existing retry policy");
  }
  assert.equal((await applyQaGate(sre, REPO, 5, deps(result("HELD", 3)), logger)).reason, "qa-held-dev-unreachable");
});

test("no double post: a report with the same head SHA and verdict is not posted again; a changed verdict is", async () => {
  const d = deps(result("FAIL", 1));
  d.markers.add(qaGateMarker(result("FAIL", 1)));
  await applyQaGate(sre, REPO, 5, d, logger);
  assert.equal(d.posted.length, 0);
  const fresh = deps(result("FAIL", 1));
  await applyQaGate(sre, REPO, 5, fresh, logger);
  assert.equal(fresh.posted.length, 1);
  const passNow = deps(result("PASS", 0));
  passNow.markers.add(qaGateMarker(result("FAIL", 1)));
  await applyQaGate(sre, REPO, 5, passNow, logger);
  assert.equal(passNow.posted.length, 1, "same SHA, new verdict: posted");
});

test("a failed post or lookup never changes the decision", async () => {
  const out = await applyQaGate(sre, REPO, 5, deps(result("PASS", 0), { post: async () => { throw new Error("gh down"); } }), logger);
  assert.equal(out, sre);
});

test("the report: heading without the disclaimer, regressions before pre-existing", () => {
  const body = qaGateBody(5, result("FAIL", 1));
  assert.ok(body.startsWith(QA_GATE_HEADING + "\n"));
  assert.ok(!body.startsWith("## QA Report (report-only)"));
  assert.doesNotMatch(body, /does not gate delivery/);
  assert.ok(body.indexOf("Regressions") < body.indexOf("Already there before this PR (not blocking)"));
  assert.match(body, /<!-- foreman-qa sha=abc verdict=FAIL -->/);
  assert.match(qaGateBody(5, { kind: "errored", detail: "x" }), /QA errored/);
  assert.match(qaFailSummary(manifests.HELD), /HELD/);
});

test("gate off by default; the gate needs a QA repo", () => {
  const cfg = configSchema.parse({ repos: [] });
  assert.equal(cfg.qaGate, false);
  assert.equal(qaApplies({ githubRepo: "x/y" }, { qaPath: "/q", qaRepos: [REPO], qaGate: true }), false);
});

test("verify wiring: the gate runs before the advance; report-only runs only with the gate off", () => {
  const src = readFileSync(new URL("../src/phases/verify.ts", import.meta.url), "utf-8");
  const gateAt = src.indexOf("applyQaGate(sre");
  const advanceAt = src.indexOf('"verifyPassed"');
  assert.ok(gateAt > 0 && gateAt < advanceAt, "QA is decided before pr approved");
  assert.match(src, /config\.qaGate && qaApplies\(/);
  assert.match(src, /!config\.qaGate && qaApplies\(/, "gate off keeps the unawaited report-only run");
  assert.ok(!/await\s+runQaReport/.test(src));
});
