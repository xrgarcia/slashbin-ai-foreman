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
import { noteUnrelated, unrelatedSignature, UNSTICK_KINDS } from "../dist/unstick.js";
import { parseUnrelatedErrors, parseReviewTrailerRecords } from "../dist/plugins/agent-cli.js";
import { verifyVerdict } from "../dist/plugins/sre.js";
import { startAgentPlugins } from "./agent-plugins.mjs";

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
  assert.equal(await noteUnrelated(repo, parseUnrelatedErrors(sreOut(5, [stripe("1111")])), "o/ue PR #5 (dev)"), 1);
  assert.equal(await noteUnrelated(repo, parseUnrelatedErrors(sreOut(6, [stripe("2222"), "worker: redis timeout"])), "o/ue PR #6 (dev)"), 1);

  assert.equal(await tryUnstick(repo, config, logger, 1, {}), 2);
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
  assert.equal(Object.keys((await repoRecordOf(repo)).unstick ?? {}).length, 2, "the two distinct signatures sit in the repo's record");
  assert.deepEqual((await recordOf(repo, 5)).verifyHeld, undefined, "no issue's record holds anything");
  assert.equal(await noteUnrelated(repo, { errors: [stripe("3333"), "worker: redis timeout"], evidence: [] }, "o/ue PR #7 (dev)"), 0);
  assert.equal(await tryUnstick(repo, config, logger, 2, {}), 0);
  assert.equal(calls().length, 2);
});

// EM#1244 f5 review (Foreman PR #197): the hand-off is written before the event that raised it is acknowledged.
for (const [name, saves] of [["the repo record is unavailable", false], ["the repo record cannot be saved", true]]) {
  test(`${name}: noteUnrelated throws, nothing is dropped, and after recovery the same error is recorded once`, async () => {
    const { repo } = setup();
    const source = activeWorkSource();
    const [load, save] = [source.loadRecord, source.saveRecord];
    breakRecords([0], { saves, kind: "repo" });
    const seen = parseUnrelatedErrors(sreOut(5, [stripe("1111")]));
    await assert.rejects(noteUnrelated(repo, seen, "o/ue PR #5 (dev)"), (e) => e.name === "HandoffNotSaved");
    source.loadRecord = load; source.saveRecord = save;
    assert.equal(Object.keys((await repoRecordOf(repo)).unstick ?? {}).length, 0, "nothing half-written");
    assert.equal(await noteUnrelated(repo, seen, "o/ue PR #5 (dev)"), 1, "the same report, raised once the record is back");
    assert.equal(await noteUnrelated(repo, seen, "o/ue PR #5 (dev)"), 0, "and not again");
  });
}

test("dev verify raises the unrelated-error hand-off before the card advances, and lets its failure out", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "phases", "verify.ts"), "utf8");
  const note = src.indexOf("await noteUnrelated(");
  assert.ok(note > 0 && note < src.indexOf('"verifyPassed"'), "persisted ahead of the advance");
  assert.doesNotMatch(src.slice(note - 40, note + 260), /catch|\.catch\(/, "a failed save is not swallowed");
});
