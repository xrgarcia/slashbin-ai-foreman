// slashbin-ai-foreman#158: a 0-shot QA PASS on a client change is not a verdict, and the EM can re-run QA on a merged PR.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyQaGate, decideQaBeforeMerge, isVoidQaPass, reportAlreadyPosted, postMergeQaNeeded, postMergeQaState, qaVerdictMarker, runQaBeforeMerge } from "../dist/qa-report.js";
import { MOVES } from "../dist/lifecycle.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const REPO = "xrgarcia/Slashbin-console";
const SHA = "d".repeat(40);
const CLIENT = ["client/src/App.tsx", "client/src/main.tsx"];
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf-8");

const report = (verdict, shots, sha = SHA) =>
  `## QA Report\n<!-- foreman-qa sha=${sha} verdict=${verdict} -->\n\n**Verdict: ${verdict}**\nReason: r\n\nPages checked:\n${shots ? "- `/`" : "- none"}\n\nShots: ${shots}`;
const at = (m) => `2026-11-01T${String(m).padStart(2, "0")}:00:00Z`;
const ran = (verdict, exitCode, shots) => ({ kind: "manifest", exitCode, manifest: { verdict, reason: "r", sha: SHA, pages: [], shots: Array.from({ length: shots }, (_, i) => ({ file: `${i}.png` })) } });

test("a PASS with no shot is void only when the PR changed client code", () => {
  assert.equal(isVoidQaPass(0, CLIENT), true);
  assert.equal(isVoidQaPass(0, ["server/routes.ts", "docs/x.md"]), false, "a server-only change has no page to check");
  assert.equal(isVoidQaPass(12, CLIENT), false);
});

test("before the merge, a fresh 0-shot PASS on a client change holds page-unplaced; one with shots passes", () => {
  assert.deepEqual(decideQaBeforeMerge(ran("PASS", 0, 0), SHA, CLIENT).reason, "qa-held-page-unplaced");
  assert.deepEqual(decideQaBeforeMerge(ran("PASS", 0, 0), SHA, ["server/a.ts"]), { kind: "pass", reused: false });
  assert.deepEqual(decideQaBeforeMerge(ran("PASS", 0, 4), SHA, CLIENT), { kind: "pass", reused: false });
});

test("a reused void PASS marker is not the answer: QA runs again; a real one is still reused", async () => {
  const mk = (body, outcome) => {
    const d = {
      runs: 0, posted: [],
      hasMarker: async (_pr, m) => body.includes(m),
      comments: async () => [{ at: at(1), body }],
      changedFiles: async () => CLIENT,
      run: async () => { d.runs++; return outcome; },
      hasReport: async () => false,
      post: async (_pr, b) => { d.posted.push(b); },
    };
    return d;
  };
  const voidPass = mk(report("PASS", 0), ran("PASS", 0, 12));
  assert.deepEqual(await runQaBeforeMerge(REPO, 1589, SHA, voidPass, logger), { kind: "pass", reused: false });
  assert.equal(voidPass.runs, 1);
  const real = mk(report("PASS", 12), ran("PASS", 0, 12));
  assert.deepEqual(await runQaBeforeMerge(REPO, 1589, SHA, real, logger), { kind: "pass", reused: true });
  assert.equal(real.runs, 0);
  assert.ok(qaVerdictMarker(SHA, "PASS"));
});

test("after the merge: the PR #1589 case needs the gate; a real PASS does not; a re-run request reopens it", () => {
  // The live case: the only report is the void pre-merge PASS.
  assert.deepEqual(postMergeQaState([{ at: at(1), body: report("PASS", 0) }], CLIENT), { rerunRequested: false, realPass: false });
  // A real pre-merge PASS: nothing runs again.
  assert.deepEqual(postMergeQaState([{ at: at(1), body: report("PASS", 24) }], CLIENT), { rerunRequested: false, realPass: true });
  // The EM asks again after it: requested, and that older PASS no longer counts.
  const asked = [{ at: at(1), body: report("PASS", 24) }, { at: at(2), body: "**EM QA re-run** — the pre-merge QA predates slashbin_ai_qa#14" }];
  assert.deepEqual(postMergeQaState(asked, CLIENT), { rerunRequested: true, realPass: false });
  // The gate's fresh PASS answers the request.
  assert.deepEqual(postMergeQaState([...asked, { at: at(3), body: report("PASS", 24, "e".repeat(40)) }], CLIENT), { rerunRequested: false, realPass: true });
  // A FAIL answers the request too (rework-decision takes it); it is never a pass.
  assert.deepEqual(postMergeQaState([...asked, { at: at(3), body: report("FAIL", 24) }], CLIENT), { rerunRequested: false, realPass: false });
  // The report-only heading and other comments are neither a report nor a request.
  assert.deepEqual(postMergeQaState([{ at: at(1), body: "## QA Report (report-only)\n\nShots: 3" }, { at: at(2), body: "please **EM QA re-run**" }], CLIENT), { rerunRequested: false, realPass: false });
});

test("postMergeQaNeeded: no edge to read comments keeps the old behaviour; an unreadable PR runs the gate", async () => {
  assert.equal(await postMergeQaNeeded(1, {}, logger), false);
  assert.equal(await postMergeQaNeeded(1, { comments: async () => { throw new Error("gh down"); } }, logger), true);
  assert.equal(await postMergeQaNeeded(1, { comments: async () => [{ at: at(1), body: report("PASS", 0) }], changedFiles: async () => CLIENT }, logger), true);
});

test("wiring: the re-run move goes pr approved -> pr merged, verify takes requests first and runs the gate under qaBeforeMerge", () => {
  assert.deepEqual([MOVES.qaRerun.from, MOVES.qaRerun.to], ["approved", "merged"]);
  const v = src("phases/verify.ts");
  assert.ok(v.indexOf("takeQaRerunRequests(repoConfig") < v.indexOf("findIssuesAwaitingVerify(repoConfig"), "a request is taken before this cycle reads its pr merged issues");
  assert.match(v, /advance\(itemOf\(repoConfig, n\), "qaRerun"/);
  assert.match(v, /qaBeforeMerge && await postMergeQaNeeded\(/);
  assert.match(v, /\|\| qaAgain\)\) \{/);
  assert.match(v, /!hasLabel\(i, readyForProd\)/, "an authorized issue is never sent back");
  assert.match(src("../docs/em-coordination.md"), /`\*\*EM QA re-run`/);
});

// A PR whose comments live in memory: post appends with a later time, so the gate reads back what it wrote.
const livePr = (initial, outcome, changed = async () => CLIENT) => {
  const d = {
    list: [...initial], runs: 0,
    comments: async () => d.list,
    changedFiles: changed,
    hasMarker: async (_pr, m) => d.list.some((c) => c.body.includes(m)),
    hasReport: async () => false,
    run: async () => { d.runs++; return outcome; },
    post: async (_pr, body) => { d.list.push({ at: at(10 + d.list.length), body }); },
  };
  return d;
};
const sre = { kind: "verdict", pass: true, trailer: {}, summary: "" };
const request = { at: at(2), body: "**EM QA re-run** — the pre-merge QA checked no page" };

test("after the merge, a fresh 0-shot PASS on a client change holds page-unplaced and is keyed HELD, never PASS", async () => {
  const d = livePr([{ at: at(1), body: report("PASS", 0) }, request], ran("PASS", 0, 0));
  const out = await applyQaGate(sre, REPO, 1589, d, logger);
  assert.equal(out.pass, false);
  assert.equal(out.reason, "qa-held-page-unplaced");
  assert.match(d.list.at(-1).body, /verdict=HELD -->/);
  assert.equal(postMergeQaState(d.list, CLIENT).realPass, false, "the issue stays at pr merged and the gate runs again next cycle");
  assert.equal(await postMergeQaNeeded(1589, d, logger), true);
});

test("the re-run's fresh PASS is posted even when an older report has the same sha and verdict, and answers the request", async () => {
  for (const old of [report("PASS", 0), report("PASS", 24)]) {
    const d = livePr([{ at: at(1), body: old }, request], ran("PASS", 0, 24));
    assert.equal((await applyQaGate(sre, REPO, 1589, d, logger)).pass, true);
    assert.equal(d.list.length, 3, "a report newer than the request was posted");
    assert.deepEqual(postMergeQaState(d.list, CLIENT), { rerunRequested: false, realPass: true });
    // The next cycle repeats nothing: the answered report is not posted twice.
    await applyQaGate(sre, REPO, 1589, d, logger);
    assert.equal(d.list.length, 3);
  }
});

test("before the merge, replacing a void cached PASS posts the fresh report with shots, and the next call reuses it", async () => {
  const d = livePr([{ at: at(1), body: report("PASS", 0) }], ran("PASS", 0, 12));
  assert.deepEqual(await runQaBeforeMerge(REPO, 1589, SHA, d, logger), { kind: "pass", reused: false });
  assert.match(d.list.at(-1).body, /Shots: 12$/);
  assert.deepEqual(await runQaBeforeMerge(REPO, 1589, SHA, d, logger), { kind: "pass", reused: true });
  assert.equal(d.runs, 1);
});

test("reportAlreadyPosted: a report counts only after the last request and only when it is not a void PASS", () => {
  const m = qaVerdictMarker(SHA, "PASS");
  assert.equal(reportAlreadyPosted([{ at: at(1), body: report("PASS", 24) }], m, CLIENT), true);
  assert.equal(reportAlreadyPosted([{ at: at(1), body: report("PASS", 24) }, request], m, CLIENT), false);
  assert.equal(reportAlreadyPosted([{ at: at(1), body: report("PASS", 0) }], m, CLIENT), false);
  assert.equal(reportAlreadyPosted([{ at: at(1), body: report("PASS", 0) }], m, ["server/a.ts"]), true, "no client change: a 0-shot PASS is a verdict");
});

test("unreadable changed files hold a 0-shot PASS instead of trusting it", async () => {
  const d = livePr([], ran("PASS", 0, 0), async () => { throw new Error("gh down"); });
  assert.equal((await applyQaGate(sre, REPO, 1589, d, logger)).reason, "qa-held-page-unplaced");
  assert.equal((await runQaBeforeMerge(REPO, 1589, SHA, livePr([], ran("PASS", 0, 0), async () => { throw new Error("gh down"); }), logger)).reason, "qa-held-page-unplaced");
});
