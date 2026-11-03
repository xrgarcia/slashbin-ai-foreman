// foreman#148: the SRE's "Not caused by this release, needs triage:" lines reach the EM as
// `unrelated-error`, once per distinct signature, and never hold the release.
import test from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { memoryRecords, repoRecordOf, recordOf, breakRecords } from "./issue-records.mjs";
import { activeWorkSource } from "../dist/plugins/registry.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tryUnstick } from "../dist/phases/unstick.js";
import { unrelatedSignature, UNSTICK_KINDS } from "../dist/unstick.js";
import { parseUnrelatedErrors, parseReviewTrailerRecords } from "../dist/plugins/agent-cli.js";
import { verifyVerdict } from "../dist/plugins/sre.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { ForemanRuntime } from "../dist/runtime.js";
let rt = new ForemanRuntime();

await startAgentPlugins();

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";

const sreOut = (pr, errors) => [
  `Verified (dev) o/ue#${pr}: deploy=SUCCESS, passed.`,
  `Evidence: https://github.com/o/ue/pull/${pr}#issuecomment-1`,
  ...errors.map((e) => `Not caused by this release, needs triage: ${e}`),
  `FOREMAN_REVIEW pr=#${pr} verdict=APPROVE merged=yes deploy=SUCCESS`,
].join("\n");

function setup() {
  setStatePath(mkTmp("ue-state-"));
  rt = new ForemanRuntime();
  memoryRecords();
  const em = mkTmp("ue-em-");
  const log = join(em, "calls.jsonl");
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "bin/em.mjs"), `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log("acted");`);
  const repo = { name: "ue", githubRepo: "o/ue", repoPath: join(em, "no-such-clone"), lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" } };
  const config = { emRepoPath: em, sessionEnv: [], backoff: { verifyRetry: { maxAttempts: 3 } } };
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { repo, config, calls };
}

const stripe = (id) => `stranded-billing healthcheck: Expired API Key provided: rk_test_${id} (401 api_key_expired)`;

test("unrelated-error is an unstick kind", () => {
  assert.ok(UNSTICK_KINDS.includes("unrelated-error"));
});

test("the triage lines are parsed from the SRE output, distinct, and the release still passes", () => {
  const out = sreOut(5, [stripe("a1"), stripe("a1"), "worker: redis timeout"]);
  assert.deepEqual(parseUnrelatedErrors(out), { errors: [stripe("a1"), "worker: redis timeout"], evidence: ["https://github.com/o/ue/pull/5#issuecomment-1"] });
  assert.equal(parseUnrelatedErrors("Verified (dev) o/ue#5: passed.\nFOREMAN_REVIEW pr=#5 verdict=APPROVE merged=yes deploy=SUCCESS"), undefined);
  // sre.mjs deploy prints the verification's lines prefixed `verify: `.
  const deploy = sreOut(5, [stripe("a1")]).split("\n").map((l) => `verify: ${l}`).join("\n");
  assert.deepEqual(parseUnrelatedErrors(deploy), { errors: [stripe("a1")], evidence: ["https://github.com/o/ue/pull/5#issuecomment-1"] });
  const t = parseReviewTrailerRecords(out).pop();
  assert.equal(verifyVerdict(t).pass, true);
});

test("a signature differing only by ids and counts is the same signature", () => {
  assert.equal(unrelatedSignature(stripe("1234")), unrelatedSignature(stripe("9876")));
  assert.equal(unrelatedSignature("attempts 43 at 2026-10-26"), unrelatedSignature("attempts 204 at 2026-10-30"));
  assert.notEqual(unrelatedSignature(stripe("1")), unrelatedSignature("worker: redis timeout"));
});

test("two PRs with the same signature plus one distinct: exactly two EM calls, no hold", async () => {
  const { repo, config, calls } = setup();
  assert.equal(await rt.handoffs.noteUnrelated(repo, parseUnrelatedErrors(sreOut(5, [stripe("1111")])), "o/ue PR #5 (dev)", "o/ue#5"), 1);
  assert.equal(await rt.handoffs.noteUnrelated(repo, parseUnrelatedErrors(sreOut(6, [stripe("2222"), "worker: redis timeout"])), "o/ue PR #6 (dev)", "o/ue#6"), 1);

  assert.equal(await tryUnstick(rt, repo, config, logger, 1, {}), 2);
  // A record store keeps keys sorted, so the order the two questions are asked in is the signature hash's, not arrival order.
  const made = calls().sort((a, b) => a[a.indexOf("--reason") + 1].localeCompare(b[b.indexOf("--reason") + 1]));
  assert.equal(made.length, 2);
  for (const argv of made) {
    assert.equal(argv[argv.indexOf("--kind") + 1], "unrelated-error");
    assert.equal(argv[argv.indexOf("--issue") + 1], "0");
  }
  assert.match(made[0][made[0].indexOf("--reason") + 1], /first seen on o\/ue PR #5 \(dev\).*Expired API Key.*Evidence: https:\/\/github\.com\/o\/ue\/pull\/5#issuecomment-1/);
  assert.match(made[1][made[1].indexOf("--reason") + 1], /first seen on o\/ue PR #6 \(dev\).*redis timeout.*Evidence: https:\/\/github\.com\/o\/ue\/pull\/6#issuecomment-1/);

  // Nothing holds the release, and a later PR seeing either error again calls no one.
  assert.equal(Object.keys((await repoRecordOf(rt, repo)).unstick ?? {}).length, 2, "the two distinct signatures sit in the repo's record");
  assert.deepEqual((await recordOf(rt, repo, 5)).verifyHeld, undefined, "no issue's record holds anything");
  assert.equal(await rt.handoffs.noteUnrelated(repo, { errors: [stripe("3333"), "worker: redis timeout"], evidence: [] }, "o/ue PR #7 (dev)", "o/ue#7"), 0);
  assert.equal(await tryUnstick(rt, repo, config, logger, 2, {}), 0);
  assert.equal(calls().length, 2);
});

// EM#1244 f5 review (Foreman PR #197): the SRE's report has no re-readable source, so a report whose save failed is
// held IN MEMORY under its PR (never a core state file) and drained at the gate every transition passes through.
for (const [name, saves] of [["R1: the repo record is unavailable", false], ["R2: the repo record cannot be saved", true]]) {
  test(`${name}: noteUnrelated throws; the gate keeps failing while the record is down; after recovery the ORIGINAL is recorded once without the error recurring`, async () => {
    const { repo } = setup();
    const source = activeWorkSource();
    const [load, save] = [source.loadRecord, source.saveRecord];
    breakRecords([0], { saves, kind: "repo" });
    const seen = parseUnrelatedErrors(sreOut(5, [stripe("1111")]));
    await assert.rejects(rt.handoffs.noteUnrelated(repo, seen, "o/ue PR #5 (dev)", "o/ue#5"), (e) => e.name === "HandoffNotSaved");
    await assert.rejects(rt.handoffs.settleHandoffs(repo, "o/ue#5"), (e) => e.name === "HandoffNotSaved", "a clean pass still cannot get past the gate");
    source.loadRecord = load; source.saveRecord = save;
    assert.equal(Object.keys((await repoRecordOf(rt, repo)).unstick ?? {}).length, 0, "nothing half-written");
    assert.equal(await rt.handoffs.settleHandoffs(repo, "o/ue#6"), 0, "another PR's gate has nothing pending");
    assert.equal(await rt.handoffs.settleHandoffs(repo, "o/ue#5"), 1, "the original, raised once the record is back, with no recurrence");
    const [e] = Object.values((await repoRecordOf(rt, repo)).unstick);
    assert.match(e.reason, /Expired API Key/);
    assert.equal(await rt.handoffs.settleHandoffs(repo, "o/ue#5"), 0, "and not again");
    assert.equal(await rt.handoffs.noteUnrelated(repo, seen, "o/ue PR #5 (dev)", "o/ue#5"), 0, "a recurrence adds nothing");
  });
}

test("dev R1: A unsaved, then the next result reports B while the drain still fails (and a clean one reports nothing): B is kept; recovery records both once", async () => {
  const { repo } = setup();
  const source = activeWorkSource();
  const [load, save] = [source.loadRecord, source.saveRecord];
  breakRecords([0], { saves: true, kind: "repo" });
  const A = { errors: [stripe("1111")], evidence: [] }, B = { errors: ["worker: redis connection refused"], evidence: [] };
  await assert.rejects(rt.handoffs.noteUnrelated(repo, A, "o/ue PR #5 (dev)", "o/ue#5"), (e) => e.name === "HandoffNotSaved");
  await assert.rejects(rt.handoffs.settleHandoffs(repo, "o/ue#5", { seen: B, seenOn: "o/ue PR #5 (dev)" }), (e) => e.name === "HandoffNotSaved", "B is buffered even though the drain throws");
  await assert.rejects(rt.handoffs.settleHandoffs(repo, "o/ue#5"), (e) => e.name === "HandoffNotSaved", "a clean pass cannot pass");
  source.loadRecord = load; source.saveRecord = save;
  assert.equal(await rt.handoffs.settleHandoffs(repo, "o/ue#5"), 2, "A and B, with no recurrence");
  const reasons = Object.values((await repoRecordOf(rt, repo)).unstick).map((x) => x.reason).join("\n");
  assert.match(reasons, /Expired API Key/); assert.match(reasons, /redis connection refused/);
  assert.equal(await rt.handoffs.settleHandoffs(repo, "o/ue#5"), 0);
});

test("two pending reports of one signature, and a recurrence, are one entry per signature", async () => {
  const { repo } = setup();
  const source = activeWorkSource();
  const [load, save] = [source.loadRecord, source.saveRecord];
  breakRecords([0], { saves: true, kind: "repo" });
  for (const id of ["1111", "2222"]) await assert.rejects(rt.handoffs.noteUnrelated(repo, { errors: [stripe(id), "worker: redis timeout"], evidence: [] }, "o/ue PR #5 (dev)", "o/ue#5"));
  source.loadRecord = load; source.saveRecord = save;
  assert.equal(await rt.handoffs.noteUnrelated(repo, { errors: [stripe("3333")], evidence: [] }, "o/ue PR #5 (dev)", "o/ue#5"), 2, "both signatures, once each");
  assert.equal(Object.keys((await repoRecordOf(rt, repo)).unstick).length, 2);
});

test("dev verify raises the unrelated-error hand-off before the card advances, and lets its failure out", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "phases", "verify.ts"), "utf8");
  const note = src.indexOf("await rt.handoffs.noteUnrelated(");
  const gate = src.indexOf("else await rt.handoffs.settleHandoffs(");
  const rel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "phases", "release.ts"), "utf8");
  const sk = rel.slice(rel.indexOf("async function soak("));
  assert.ok(sk.indexOf("await rt.handoffs.settleHandoffs(") < sk.indexOf("fromVerifyResult(") && /settleHandoffs\([^;]*r\.unrelated/s.test(sk), "soak buffers its result's reports in the gate call, ahead of the drop");
  assert.ok(note > 0 && gate > note && gate < src.indexOf('"verifyPassed"'), "the gate runs on every result, ahead of the advance");
  assert.doesNotMatch(src.slice(note - 40, gate + 120), /catch|\.catch\(/, "a failed save is not swallowed");
});
