// slashbin-ai-foreman#158: a QA PASS that checked nothing is not a PASS, and the EM can ask for a fresh QA run on a merged PR.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  runQaBeforeMerge, decideQaBeforeMerge, applyQaGate, qaVerdictMarker, isVoidPass, reportShots, withVoidPassHeld,
  postMergeQaRequirement, QA_RERUN_PATTERN,
} from "../dist/qa-report.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const REPO = "xrgarcia/Slashbin-console";
const HEAD = "d".repeat(40);
const MERGE = "3".repeat(40);
const CLIENT = ["client/src/App.tsx", "client/src/main.tsx"];

const manifest = (shots, extra = {}) => ({ verdict: "PASS", reason: "ok", sha: HEAD, pages: shots ? [{ route: "/" }] : [], shots: Array.from({ length: shots }, (_, i) => ({ file: `s${i}.png` })), ...extra });
const ran = (shots) => ({ kind: "manifest", exitCode: 0, manifest: manifest(shots) });
function deps(outcome, { files = CLIENT, markers = [], body } = {}) {
  const d = {
    posted: [], runs: 0, markers: new Set(markers),
    run: async () => { d.runs++; return outcome; },
    hasMarker: async (_pr, m) => d.markers.has(m),
    hasReport: async () => false,
    post: async (_pr, b) => { d.posted.push(b); },
    changedFiles: async () => files,
    reportBody: async () => body,
  };
  return d;
}
const voidReport = `## QA Report\n${qaVerdictMarker(HEAD, "PASS")}\n**Verdict: PASS**\nPages checked:\n- none\n\nShots: 0`;

test("the rule: 0 shots on a client change is void; 0 shots elsewhere, or any shots, is not", () => {
  assert.equal(isVoidPass(0, CLIENT), true);
  assert.equal(isVoidPass(0, ["docs/a.md", "server/x.ts"]), false);
  assert.equal(isVoidPass(3, CLIENT), false);
  assert.equal(reportShots(voidReport), 0);
  assert.equal(reportShots("Shots: 12"), 12);
  assert.equal(reportShots("no count"), undefined);
});

test("decideQaBeforeMerge: PASS with 0 shots and a changed client/src/App.tsx is HELD page-unplaced, not a pass", () => {
  const d = decideQaBeforeMerge(ran(0), HEAD, CLIENT);
  assert.deepEqual([d.kind, d.reason], ["hold", "qa-held-page-unplaced"]);
  assert.equal(decideQaBeforeMerge(ran(0), HEAD, ["README.md"]).kind, "pass");
  assert.equal(decideQaBeforeMerge(ran(4), HEAD, CLIENT).kind, "pass");
  const held = withVoidPassHeld(ran(0), CLIENT);
  assert.equal(held.manifest.verdict, "HELD");
});

test("a reused verdict=PASS marker whose report reads `Shots: 0` on a client change is not reused: QA runs again and posts the fresh PASS", async () => {
  const d = deps(ran(24), { markers: [qaVerdictMarker(HEAD, "PASS")], body: voidReport });
  const r = await runQaBeforeMerge(REPO, 1589, HEAD, d, logger);
  assert.equal(d.runs, 1, "a fresh run");
  assert.deepEqual([r.kind, r.reused], ["pass", false]);
  assert.equal(d.posted.length, 1, "posted even though the PASS marker is already on the PR, or the next look reads the old zero");
  assert.match(d.posted[0], /Shots: 24/);
});

test("a reused PASS with shots, or a 0-shot PASS on a non-client change, is still reused", async () => {
  const withShots = deps(ran(24), { markers: [qaVerdictMarker(HEAD, "PASS")], body: voidReport.replace("Shots: 0", "Shots: 8") });
  assert.deepEqual(await runQaBeforeMerge(REPO, 1, HEAD, withShots, logger), { kind: "pass", reused: true });
  assert.equal(withShots.runs, 0);
  const docsOnly = deps(ran(24), { files: ["docs/a.md"], markers: [qaVerdictMarker(HEAD, "PASS")], body: voidReport });
  assert.deepEqual(await runQaBeforeMerge(REPO, 1, HEAD, docsOnly, logger), { kind: "pass", reused: true });
});

test("a fresh 0-shot PASS on a client change is held, and its report says HELD under a HELD marker (never a reusable PASS marker)", async () => {
  const d = deps(ran(0));
  const r = await runQaBeforeMerge(REPO, 1589, HEAD, d, logger);
  assert.deepEqual([r.kind, r.reason], ["hold", "qa-held-page-unplaced"]);
  assert.match(d.posted[0], /verdict=HELD/);
  assert.ok(!d.posted[0].includes(qaVerdictMarker(HEAD, "PASS")));
  assert.match(d.posted[0], /\*\*Verdict: HELD\*\*/);
});

test("the post-merge gate holds a void PASS too, rather than returning the SRE's pass", async () => {
  const sre = { kind: "verdict", pass: true, trailer: {}, summary: "" };
  const out = await applyQaGate(sre, REPO, 5, deps(ran(0)), logger);
  assert.deepEqual([out.pass, out.reason], [false, "qa-held-page-unplaced"]);
  assert.equal(await applyQaGate(sre, REPO, 5, deps(ran(3)), logger), sre);
});

// --- The re-run input ---

const ask = "**EM QA rerun: QA's route parser was fixed (slashbin_ai_qa#15, #16)";
let n = 100;
const c = (body) => ({ id: ++n, body, at: new Date(1e12 + n * 1000).toISOString() });
const report = (sha, v, req) => c(`## QA Report\n<!-- foreman-qa sha=${sha} verdict=${v}${req ? ` req=${req}` : ""} -->\n**Verdict: ${v}**`);
const req = (comments) => comments.filter((x) => QA_RERUN_PATTERN.test(x.body)).pop().id;

test("postMergeQaRequirement: one owner for 'is post-merge QA satisfied'", () => {
  const old = report("dc3a2dd346c1b179e7432a41ed26a1eee259d905", "PASS");
  assert.deepEqual(postMergeQaRequirement([old], MERGE).required, false, "no request: nothing owed");
  const a = c(ask);
  let cs = [old, a];
  assert.deepEqual([postMergeQaRequirement(cs, MERGE).required, postMergeQaRequirement(cs, MERGE).fresh], [true, true], "the old PASS answers nothing");
  // R1/R2: a HELD report keeps the request open and QA required.
  cs = [...cs, report(MERGE, "HELD", a.id)];
  assert.deepEqual([postMergeQaRequirement(cs, MERGE).required, postMergeQaRequirement(cs, MERGE).fresh], [true, true]);
  // R3: a FAIL answers the request (no rerun) but QA stays required.
  cs = [...cs, report(MERGE, "FAIL", a.id)];
  assert.deepEqual([postMergeQaRequirement(cs, MERGE).required, postMergeQaRequirement(cs, MERGE).fresh], [true, false]);
  cs = [...cs, report(MERGE, "PASS", a.id)];
  assert.deepEqual([postMergeQaRequirement(cs, MERGE).required, postMergeQaRequirement(cs, MERGE).fresh], [false, false]);
  // A second request with the same verdict history needs its own report, and stops after it.
  const b = c(ask);
  cs = [...cs, b];
  assert.deepEqual([postMergeQaRequirement(cs, MERGE).required, postMergeQaRequirement(cs, MERGE).fresh], [true, true], "the earlier PASS does not answer the new request");
  assert.equal(postMergeQaRequirement([...cs, report(MERGE, "PASS", a.id)], MERGE).required, true, "a report for the old request id does not either");
  cs = [...cs, report(MERGE.slice(0, 9), "PASS", b.id)];
  assert.deepEqual([postMergeQaRequirement(cs, MERGE).required, postMergeQaRequirement(cs, MERGE).fresh], [false, false]);
});

test("the report is keyed to the request: a second request with the same verdict gets its own report (not deduped against the first)", async () => {
  const sre = { kind: "verdict", pass: true, trailer: {}, summary: "" };
  const first = deps(ran(24));
  await applyQaGate(sre, REPO, 1589, first, logger, { markerSha: MERGE, reqId: 111 });
  assert.ok(first.posted[0].includes(`<!-- foreman-qa sha=${MERGE} verdict=PASS req=111 -->`));
  const second = deps(ran(24), { markers: [`<!-- foreman-qa sha=${MERGE} verdict=PASS req=111 -->`] });
  await applyQaGate(sre, REPO, 1589, second, logger, { markerSha: MERGE, reqId: 222 });
  assert.equal(second.posted.length, 1, "request 222 is a new identity");
  assert.ok(second.posted[0].includes("req=222"));
  const again = deps(ran(24), { markers: [`<!-- foreman-qa sha=${MERGE} verdict=PASS req=222 -->`] });
  await applyQaGate(sre, REPO, 1589, again, logger, { markerSha: MERGE, reqId: 222 });
  assert.equal(again.posted.length, 0, "the same request is reported once");
});

test("a zero-shot rerun is HELD page-unplaced, keyed to the request, and leaves QA required", async () => {
  const sre = { kind: "verdict", pass: true, trailer: {}, summary: "" };
  const a = c(ask);
  const d = deps(ran(0));
  const out = await applyQaGate(sre, REPO, 1589, d, logger, { markerSha: MERGE, reqId: a.id });
  assert.deepEqual([out.pass, out.reason], [false, "qa-held-page-unplaced"]);
  const posted = { id: ++n, body: d.posted[0], at: "" };
  const need = postMergeQaRequirement([a, posted], MERGE);
  assert.deepEqual([need.required, need.fresh], [true, true]);
});

test("the rerun produces a fresh run keyed to the merge sha; a FAIL takes visual-qa-failed", async () => {
  const sre = { kind: "verdict", pass: true, trailer: {}, summary: "" };
  const d = deps(ran(24));
  assert.equal(await applyQaGate(sre, REPO, 1589, d, logger, { markerSha: MERGE, reqId: 5 }), sre);
  assert.equal(d.runs, 1);
  const fail = deps({ kind: "manifest", exitCode: 1, manifest: { ...manifest(24), verdict: "FAIL", regressions: [{ route: "/dlq", viewport: "phone", items: [{ criterion: "clipping_overflow" }] }] } });
  const f = await applyQaGate(sre, REPO, 1589, fail, logger, { markerSha: MERGE, reqId: 5 });
  assert.deepEqual([f.pass, f.reason], [false, "visual-qa-failed"]);
  assert.ok(fail.posted[0].includes(`sha=${MERGE} verdict=FAIL req=5`));
});

test("verify wiring: a request is staged before the targets are read, runs QA without the SRE, and moves an approved card back", () => {
  const src = readFileSync(new URL("../src/phases/verify.ts", import.meta.url), "utf-8");
  assert.ok(src.indexOf("stageQaReruns(repoConfig, held") < src.indexOf("findIssuesAwaitingVerify(repoConfig, vlog)"));
  assert.match(src, /owed\?\.fresh\s*\?\s*\{ kind: "verdict", pass: true/);
  assert.match(src, /"qaRerun"/);
  assert.match(src, /markerSha: owed\.sha, reqId: owed\.reqId/);
  // The qaBeforeMerge skip never applies while QA is owed: the gate condition is `owed || ...`, and the SRE pass alone cannot advance.
  assert.match(src, /\(owed \|\| \(config\.qaGate && !qaBeforeMerge\)\) && qaApplies/);
  assert.ok(src.indexOf("postMergeQaRequirement(comments") > 0 && !src.includes("pendingQaRerun"));
});
