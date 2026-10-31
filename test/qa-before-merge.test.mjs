// QA before the merge (config.qaBeforeMerge, EM#923): review (no merge) -> QA --local -> merge on PASS -> SRE.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewViaTechLead, QA_PENDING_HOLD, HEAD_MOVED_HOLD, NOT_APPROVED_HOLD, parseReviewTrailerRecords } from "../dist/agent.js";
import { runQaBeforeMerge, qaBeforeMergeApplies, qaVerdictMarker, qaFailLines, qaGateBody, runQaReport, applyQaGate, executeQa } from "../dist/qa-report.js";
import { rulingState } from "../dist/github/reports.js";
import { sessionFallbackStage, MOVES, STAGE_MEANING, SESSION_FALLBACK_STAGE } from "../dist/lifecycle.js";
import { TOOLING_HOLDS, verifyHoldPlan } from "../dist/phases/verify.js";
import { configSchema } from "../dist/config.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const REPO = "xrgarcia/Slashbin-console";
const SHA = "a".repeat(40);
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf-8");
process.env.TECHLEAD_GITHUB_KEY ||= "test-token-not-real";

const manifest = (verdict, extra = {}) => ({ verdict, reason: `${verdict} reason`, sha: SHA, pages: [{ route: "/a" }], shots: [{ file: "a.png" }],
  ...(verdict === "FAIL" ? { regressions: [{ route: "/a", viewport: "phone", items: [{ criterion: "clipping_overflow", reason: "badge spills" }] }] } : {}), ...extra });
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
const ran = (verdict, exitCode, extra) => ({ kind: "manifest", exitCode, manifest: manifest(verdict, extra) });

// 1. The Tech Lead is asked not to merge, and its answer is not a hold.
test("1: --no-merge is passed only when asked; the qa-pending trailer parses and is not a declared hold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-tl-"));
  mkdirSync(join(dir, "bin"));
  const argsFile = join(dir, "args.json");
  writeFileSync(join(dir, "bin/tech-lead.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
    console.log("FOREMAN_REVIEW pr=#5 verdict=APPROVE merged=no deploy=NA hold=qa-pending");
  `);
  const cfg = { techLeadPath: dir, emRepoPath: "/em", reviewMaxDurationMs: 30_000 };
  const r = await reviewViaTechLead({ name: "r", githubRepo: "o/r" }, cfg, 5, logger, undefined, undefined, undefined, true);
  assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), ["review-pr", "--repo", "o/r", "--pr", "5", "--no-merge"]);
  assert.equal(r.success, true);
  assert.deepEqual([r.trailers[0].verdict, r.trailers[0].merged, r.trailers[0].hold], ["APPROVE", false, QA_PENDING_HOLD]);
  await reviewViaTechLead({ name: "r", githubRepo: "o/r" }, cfg, 5, logger);
  assert.ok(!JSON.parse(readFileSync(argsFile, "utf8")).includes("--no-merge"), "flag off / the merge call: a plain review-pr");
  assert.match(src("phases/reconcile.ts"), /trailer\.hold && trailer\.hold !== QA_PENDING_HOLD/);
  assert.equal(QA_PENDING_HOLD, "qa-pending");
});

// 2. One QA run per head sha; QA is its own session phase with an inReview fallback.
test("2: QA is a session phase; its fallback is inReview in this mode and merged otherwise", () => {
  assert.equal(sessionFallbackStage("qa", true), "inReview");
  assert.equal(sessionFallbackStage("qa", false), "merged");
  assert.equal(sessionFallbackStage("qa"), SESSION_FALLBACK_STAGE.qa);
  assert.equal(sessionFallbackStage("verify", true), SESSION_FALLBACK_STAGE.verify, "only qa changes");
  assert.match(STAGE_MEANING.qaReviewing, /qaBeforeMerge/);
});

test("2: a PASS or FAIL report for this exact head is the answer; QA does not run twice", async () => {
  const pass = deps(ran("PASS", 0));
  pass.markers.add(qaVerdictMarker(SHA, "PASS"));
  assert.deepEqual(await runQaBeforeMerge(REPO, 5, SHA, pass, logger), { kind: "pass", reused: true });
  assert.equal(pass.runs, 0);
  const fail = deps(ran("PASS", 0));
  fail.markers.add(qaVerdictMarker(SHA, "FAIL"));
  assert.equal((await runQaBeforeMerge(REPO, 5, SHA, fail, logger)).kind, "fail");
  assert.equal(fail.runs, 0);
  const other = deps(ran("PASS", 0));
  other.markers.add(qaVerdictMarker("b".repeat(40), "PASS"));
  assert.equal((await runQaBeforeMerge(REPO, 5, SHA, other, logger)).kind, "pass", "a new sha runs QA again");
  assert.equal(other.runs, 1);
});

// 3. PASS posts the report, then the merge.
test("3: PASS posts the QA Report with the head's marker; the post-merge gate does not rerun", async () => {
  const d = deps(ran("PASS", 0));
  assert.deepEqual(await runQaBeforeMerge(REPO, 5, SHA, d, logger), { kind: "pass", reused: false });
  assert.equal(d.posted.length, 1);
  assert.match(d.posted[0], /^## QA Report\n/);
  assert.ok(d.posted[0].includes(qaVerdictMarker(SHA, "PASS")));
  const phase = src("phases/qa-before-merge.ts");
  assert.ok(phase.indexOf("runQaBeforeMerge(") < phase.indexOf("reviewViaTechLead("), "QA first, then the merge call");
  assert.match(phase, /reviewViaTechLead\(repoConfig, config, prNumber, qlog, runAbort\.signal, transcriptPath, undefined, false, headSha\)/, "the merge is pinned to the head QA passed");
  assert.match(phase, /settleReviewOutcome\(/);
  assert.match(src("phases/verify.ts"), /config\.qaGate && !qaBeforeMerge && qaApplies\(/);
  assert.match(src("phases/verify.ts"), /!config\.qaGate && !qaBeforeMerge && qaApplies\(/);
});

// 4. FAIL goes back to the builder and counts as a round.
test("4: FAIL posts the report and is a fail decision carrying QA's lines", async () => {
  const d = deps(ran("FAIL", 1));
  const out = await runQaBeforeMerge(REPO, 5, SHA, d, logger);
  assert.equal(out.kind, "fail");
  assert.match(out.summary, /clipping_overflow/);
  assert.ok(d.posted[0].includes(qaVerdictMarker(SHA, "FAIL")));
  assert.match(src("phases/qa-before-merge.ts"), /decision\.kind === "fail"[\s\S]{0,300}"changesRequested"/);
});

test("4: revise is handed QA's failing lines, cut at 'Pages checked:'", () => {
  const body = qaGateBody(5, { kind: "manifest", exitCode: 1, manifest: manifest("FAIL") });
  const lines = qaFailLines(body);
  assert.match(lines, /clipping_overflow/);
  assert.doesNotMatch(lines, /Pages checked:/);
  assert.doesNotMatch(lines, /foreman-qa/);
  assert.match(src("phases/revise.ts"), /latestQaFailLines/);
  assert.match(src("agent.ts"), /qaFeedback/);
});

test("4: a QA FAIL report counts as a review round for the rounds alert", () => {
  const fail = { at: "2026-10-31T10:00:00Z", head: `## QA Report\n<!-- foreman-qa sha=${SHA} verdict=FAIL -->` };
  const pass = { at: "2026-10-31T11:00:00Z", head: `## QA Report\n<!-- foreman-qa sha=${SHA} verdict=PASS -->` };
  const review = { id: 1, state: "CHANGES_REQUESTED", at: "2026-10-31T09:00:00Z", escalate: false };
  assert.equal(rulingState([review], [fail, pass]).roundsSinceRuling, 2);
  assert.equal(rulingState([], [pass]).roundsSinceRuling, 0);
});

// 5. HELD / errored / inconsistent: hold, never merge.
test("5: HELD, errored and inconsistent results hold; tooling holds are deferred and uncharged", async () => {
  const held = await runQaBeforeMerge(REPO, 5, SHA, deps(ran("HELD", 3, { hold: "qa-local-boot-failed" })), logger);
  assert.deepEqual([held.kind, held.reason], ["hold", "qa-held-qa-local-boot-failed"]);
  const errored = await runQaBeforeMerge(REPO, 5, SHA, deps({ kind: "errored", detail: "timed out" }), logger);
  assert.deepEqual([errored.kind, errored.reason], ["hold", "qa-errored"]);
  const threw = await runQaBeforeMerge(REPO, 5, SHA, deps(new Error("boom")), logger);
  assert.deepEqual([threw.kind, threw.reason], ["hold", "qa-errored"]);
  for (const o of [ran("PASS", 1), ran("FAIL", 0), ran("PASS", 0, { sha: "c".repeat(40) }), ran("PASS", 0, { sha: undefined })]) {
    const out = await runQaBeforeMerge(REPO, 5, SHA, deps(o), logger);
    assert.deepEqual([out.kind, out.reason], ["hold", "qa-inconsistent"], o.manifest.verdict);
  }
  for (const r of ["qa-held-qa-local-boot-failed", "qa-held-qa-local-seed-missing", "qa-held-worker-data-unavailable", "qa-held-attribution-unavailable", "qa-errored"]) {
    assert.ok(TOOLING_HOLDS.includes(r), r);
    assert.deepEqual(verifyHoldPlan(r), { kind: "defer" }, r);
  }
});

// 6. Never merge a head without a QA PASS.
test("6: a PASS for a different sha never passes this head", async () => {
  const out = await runQaBeforeMerge(REPO, 5, SHA, deps(ran("PASS", 0, { sha: "d".repeat(40) })), logger);
  assert.notEqual(out.kind, "pass");
  const short = await runQaBeforeMerge(REPO, 5, SHA, deps(ran("PASS", 0, { sha: SHA.slice(0, 7) })), logger);
  assert.equal(short.kind, "pass", "a prefix of the head is the head");
});

// 7. Flag off / outside qaRepos: unchanged.
test("7: the flag is off by default; it applies only to a qaRepos repo with the Tech Lead and QA configured", () => {
  assert.equal(configSchema.parse({ repos: [] }).qaBeforeMerge, false);
  const cfg = { qaBeforeMerge: true, qaPath: "/q", qaRepos: [REPO], techLeadPath: "/tl" };
  assert.equal(qaBeforeMergeApplies({ githubRepo: REPO }, cfg), true);
  assert.equal(qaBeforeMergeApplies({ githubRepo: REPO }, { ...cfg, qaBeforeMerge: false }), false, "flag off");
  assert.equal(qaBeforeMergeApplies({ githubRepo: "x/other" }, cfg), false, "repo outside qaRepos");
  assert.equal(qaBeforeMergeApplies({ githubRepo: REPO }, { ...cfg, techLeadPath: undefined }), false);
  assert.equal(qaBeforeMergeApplies({ githubRepo: REPO }, { ...cfg, qaPath: undefined }), false);
});

test("7: flag-off parity: the review call appends --no-merge only on request, and the moves are unchanged", () => {
  assert.match(src("phases/review.ts"), /const qaFirst = qaBeforeMergeApplies\(/);
  assert.match(src("agent.ts"), /noMerge \? \["--no-merge"\] : \[\]/);
  assert.ok(MOVES.reviewMerged && MOVES.changesRequested);
});

// --- Tech Lead review of EM#923 (PR #154) ---

// Finding 1: the merge is bound to the head QA passed.
test("F1: the PASS merge calls the Tech Lead with --merge-approved <full sha>, and only that call merges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-tl-"));
  mkdirSync(join(dir, "bin"));
  const argsFile = join(dir, "args.json");
  writeFileSync(join(dir, "bin/tech-lead.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
    console.log("FOREMAN_REVIEW pr=#5 verdict=NONE merged=no deploy=NA hold=head-moved");
  `);
  const cfg = { techLeadPath: dir, emRepoPath: "/em", reviewMaxDurationMs: 30_000 };
  const r = await reviewViaTechLead({ name: "r", githubRepo: "o/r" }, cfg, 5, logger, undefined, undefined, undefined, false, SHA);
  assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), ["review-pr", "--repo", "o/r", "--pr", "5", "--merge-approved", SHA]);
  assert.deepEqual([r.trailers[0].verdict, r.trailers[0].merged, r.trailers[0].hold], ["NONE", false, HEAD_MOVED_HOLD]);
  const phase = src("phases/qa-before-merge.ts");
  assert.ok(!/reviewViaTechLead\([^)]*transcriptPath\)/.test(phase), "no plain review-pr call is left in the QA phase");
  assert.match(phase, /\^\[0-9a-f\]\{40\}\$/, "a head that is not a full sha is never handed over");
});

test("F1: head-moved is no merge and no charge, and the card stays in review; not-approved is a hold", () => {
  const [moved, none] = parseReviewTrailerRecords("FOREMAN_REVIEW pr=#5 verdict=NONE merged=no deploy=NA hold=head-moved\nFOREMAN_REVIEW pr=#6 verdict=NONE merged=no deploy=NA hold=not-approved");
  assert.equal(moved.hold, HEAD_MOVED_HOLD);
  assert.equal(none.hold, NOT_APPROVED_HOLD);
  const phase = src("phases/qa-before-merge.ts");
  const movedAt = phase.indexOf("HEAD_MOVED_HOLD", phase.indexOf("--merge-approved"));
  const block = phase.slice(movedAt, phase.indexOf("NOT_APPROVED_HOLD", movedAt + 10));
  assert.match(block, /reviewFailureCount\.set\(repoName, 0\)/, "not charged");
  assert.doesNotMatch(block, /emit\(\{ kind: "blocked"/, "not blocked");
  assert.doesNotMatch(block, /settleReviewOutcome/, "not settled as a review outcome");
  const notApproved = phase.slice(phase.indexOf("result.success && own?.hold === NOT_APPROVED_HOLD"));
  assert.match(notApproved.slice(0, 900), /kind: "blocked"/);
});

// Finding 2: only a consistent verdict is cached.
test("F2 R1/R3: PASS with exit 1 holds, posts no PASS marker, and stays a hold on every retry (and after a restart)", async () => {
  const posted = [];
  const mk = () => deps(ran("PASS", 1), { post: async (_pr, b) => { posted.push(b); }, hasMarker: async (_pr, m) => posted.some((b) => b.includes(m)) });
  for (let i = 0; i < 3; i++) {
    const d = mk();   // a fresh module-equivalent each time: only the posted comments persist
    const out = await runQaBeforeMerge(REPO, 5, SHA, d, logger);
    assert.deepEqual([out.kind, out.reason], ["hold", "qa-inconsistent"], `attempt ${i}`);
    assert.equal(d.runs, 1, "QA runs again; an inconsistent run is never a cached verdict");
  }
  assert.ok(posted.length >= 1);
  assert.ok(!posted.some((b) => b.includes(qaVerdictMarker(SHA, "PASS"))), "no PASS marker");
  assert.ok(posted.every((b) => !b.includes("verdict=PASS") && !b.includes("verdict=FAIL")), "no verdict marker at all");
  assert.ok(posted.some((b) => b.includes(`sha=${SHA} verdict=INCONSISTENT`)));
});

test("F2 R2/R4: FAIL with exit 0 holds, never becomes a cached FAIL, and is not a QA FAIL review round", async () => {
  const posted = [];
  const mk = () => deps(ran("FAIL", 0), { post: async (_pr, b) => { posted.push(b); }, hasMarker: async (_pr, m) => posted.some((b) => b.includes(m)) });
  for (let i = 0; i < 3; i++) {
    const out = await runQaBeforeMerge(REPO, 5, SHA, mk(), logger);
    assert.deepEqual([out.kind, out.reason], ["hold", "qa-inconsistent"], `attempt ${i}`);
  }
  const heads = posted.map((b) => ({ at: "2026-10-31T10:00:00Z", head: b.slice(0, 140) }));
  assert.equal(rulingState([], heads).roundsSinceRuling, 0, "an inconsistent report is not a review round");
  const real = await runQaBeforeMerge(REPO, 5, SHA, deps(ran("FAIL", 1), { post: async (_p, b) => { posted.push(b); } }), logger);
  assert.equal(real.kind, "fail");
  assert.equal(rulingState([], posted.slice(-1).map((b) => ({ at: "2026-10-31T10:00:00Z", head: b.slice(0, 140) }))).roundsSinceRuling, 1, "a consistent FAIL counts once");
});

test("F2 R5/F3: a short manifest sha is accepted, the marker carries the full head sha, and the retry reuses it", async () => {
  const posted = [];
  const mk = () => deps(ran("PASS", 0, { sha: SHA.slice(0, 7) }), { post: async (_pr, b) => { posted.push(b); }, hasMarker: async (_pr, m) => posted.some((b) => b.includes(m)) });
  const first = mk();
  assert.deepEqual(await runQaBeforeMerge(REPO, 5, SHA, first, logger), { kind: "pass", reused: false });
  assert.ok(posted[0].includes(qaVerdictMarker(SHA, "PASS")), "the marker is the full sha, not the manifest's");
  assert.ok(!posted[0].includes(`sha=${SHA.slice(0, 7)} `));
  for (let i = 0; i < 2; i++) {
    const again = mk();
    assert.deepEqual(await runQaBeforeMerge(REPO, 5, SHA, again, logger), { kind: "pass", reused: true });
    assert.equal(again.runs, 0, "QA is not run again");
  }
  assert.equal(posted.length, 1, "one report, once");
});

test("F2: a valid PASS/0 and FAIL/1 for the head keep their decisions and are cached by the full sha", async () => {
  const p = deps(ran("PASS", 0));
  assert.equal((await runQaBeforeMerge(REPO, 5, SHA, p, logger)).kind, "pass");
  assert.ok(p.posted[0].includes(qaVerdictMarker(SHA, "PASS")));
  const f = deps(ran("FAIL", 1));
  assert.equal((await runQaBeforeMerge(REPO, 5, SHA, f, logger)).kind, "fail");
  assert.ok(f.posted[0].includes(qaVerdictMarker(SHA, "FAIL")));
  const other = await runQaBeforeMerge(REPO, 5, SHA, deps(ran("PASS", 0, { sha: "e".repeat(40) })), logger);
  assert.equal(other.kind, "hold", "a PASS naming another head is not this head's PASS");
});

// Finding 3: one QA execution path.
test("F3: runQaReport, applyQaGate and runQaBeforeMerge share one run helper; a throw is `errored` in all three", async () => {
  const boom = () => deps(new Error("dummy boom"));
  assert.deepEqual(await executeQa(REPO, 5, boom()), { kind: "errored", detail: "the run threw (Error: dummy boom)" });
  const gate = await applyQaGate({ kind: "verdict", pass: true, trailer: {}, summary: "" }, REPO, 5, boom(), logger);
  assert.equal(gate.reason, "qa-errored");
  const pre = await runQaBeforeMerge(REPO, 5, SHA, boom(), logger);
  assert.deepEqual([pre.kind, pre.reason], ["hold", "qa-errored"]);
  const d = boom();
  await runQaReport(REPO, 9, d, logger);
  assert.match(d.posted[0], /errored|did not|could not|no verdict/i, "report-only still posts an errored note");
  const code = src("qa-report.ts");
  assert.equal(code.split("mkdirSync(out, { recursive: true })").length - 1, 1, "cache setup exists once (the helper)");
  assert.equal(code.split("await deps.run(").length - 1, 1, "deps.run is called once (the helper)");
});
