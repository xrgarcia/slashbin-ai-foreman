// foreman#148: the SRE's "Not caused by this release, needs triage:" lines reach the EM as
// `unrelated-error`, once per distinct signature, and never hold the release.
import test from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStateDir as setStatePath, stateDir as stateDirPath } from "../dist/state-dir.js";
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

// EM#1244 f5 review (Foreman PR #197): the SRE's report has no durable source to re-read (its PR comment is
// model-written prose, its structured list is the SRE's local results file), so it is saved AT RECEIPT to an outbox
// on disk and drained into the repo's record. R1-R4: it stays recoverable until saved, without the error recurring.
const outboxFile = () => join(stateDirPath(), ".handoff-outbox.json");
const outboxLeft = () => (existsSync(outboxFile()) ? JSON.parse(readFileSync(outboxFile(), "utf8")).length : 0);
for (const [name, saves] of [["R1: the repo record is unavailable", false], ["R2: the repo record cannot be saved", true]]) {
  test(`${name}: noteUnrelated does not throw, the report waits in the outbox, and after recovery it is recorded once without recurring`, async () => {
    const { repo, config, calls } = setup();
    const source = activeWorkSource();
    const [load, save] = [source.loadRecord, source.saveRecord];
    breakRecords([0], { saves, kind: "repo" });
    const seen = parseUnrelatedErrors(sreOut(5, [stripe("1111")]));
    assert.equal(await noteUnrelated(repo, seen, "o/ue PR #5 (dev)"), 0, "acknowledged at once: nothing is lost");
    assert.equal(outboxLeft(), 1, "saved at receipt, on disk");
    assert.equal(await tryUnstick(repo, config, logger, 1, {}), 0, "the record is still down: the pass records nothing and asks no one");
    source.loadRecord = load; source.saveRecord = save;
    assert.equal(Object.keys((await repoRecordOf(repo)).unstick ?? {}).length, 0, "nothing half-written");
    // The error never recurs: the next unstick pass drains the outbox into the record and asks the EM once.
    assert.equal(await tryUnstick(repo, config, logger, 2, {}), 1);
    assert.equal(outboxLeft(), 0);
    assert.equal(calls().length, 1);
    assert.match(calls()[0][calls()[0].indexOf("--reason") + 1], /first seen on o\/ue PR #5 \(dev\).*Evidence: https:\/\/github\.com\/o\/ue\/pull\/5#issuecomment-1/, "with its PR and evidence");
    assert.equal(await noteUnrelated(repo, seen, "o/ue PR #5 (dev)"), 0, "a recurrence adds nothing");
    assert.equal(await tryUnstick(repo, config, logger, 3, {}), 0);
    assert.equal(calls().length, 1, "one entry per distinct signature");
  });
}

test("R3: the outbox survives a restart; two reports of one signature while down are one entry", async () => {
  const { repo, config, calls } = setup();
  const source = activeWorkSource();
  const [load, save] = [source.loadRecord, source.saveRecord];
  breakRecords([0], { saves: true, kind: "repo" });
  await noteUnrelated(repo, parseUnrelatedErrors(sreOut(5, [stripe("1111")])), "o/ue PR #5 (dev)");
  await noteUnrelated(repo, parseUnrelatedErrors(sreOut(6, [stripe("2222"), "worker: redis timeout"])), "o/ue PR #6 (dev)");
  assert.equal(outboxLeft(), 2, "one entry per distinct signature, even before it is drained");
  source.loadRecord = load; source.saveRecord = save;
  const { drainHandoffs } = await import("../dist/unstick.js?restart");
  assert.equal(await drainHandoffs(repo), 2, "a fresh module instance (a restart) still finds it on disk: two distinct signatures");
  assert.equal(await tryUnstick(repo, config, logger, 1, {}), 2);
  assert.equal(calls().length, 2);
  assert.equal(await drainHandoffs(repo), 0);
});

test("R4: if even the outbox cannot be written, noteUnrelated throws HandoffNotSaved so the event is not acknowledged", async () => {
  const { repo } = setup();
  mkdirSync(outboxFile(), { recursive: true }); // a directory where the file belongs: the write fails
  await assert.rejects(noteUnrelated(repo, parseUnrelatedErrors(sreOut(5, [stripe("1111")])), "o/ue PR #5 (dev)"), (e) => e.name === "HandoffNotSaved");
});

test("dev verify raises the unrelated-error hand-off before the card advances, and lets its failure out", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "phases", "verify.ts"), "utf8");
  const note = src.indexOf("await noteUnrelated(");
  assert.ok(note > 0 && note < src.indexOf('"verifyPassed"'), "persisted ahead of the advance");
  assert.doesNotMatch(src.slice(note - 40, note + 260), /catch|\.catch\(/, "a failed save is not swallowed");
});
