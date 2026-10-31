// foreman#148: the SRE's "Not caused by this release, needs triage:" lines reach the EM as
// `unrelated-error`, once per distinct signature, and never hold the release.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStatePath, loadRepoState } from "../dist/state.js";
import { tryUnstick } from "../dist/phases/unstick.js";
import { noteUnrelated, unrelatedSignature, UNSTICK_KINDS } from "../dist/unstick.js";
import { parseUnrelatedErrors, parseReviewTrailerRecords, verifyVerdict } from "../dist/agent.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";

const sreOut = (pr, errors) => [
  `Verified (dev) o/ue#${pr}: deploy=SUCCESS, passed.`,
  `Evidence: https://github.com/o/ue/pull/${pr}#issuecomment-1`,
  ...errors.map((e) => `Not caused by this release, needs triage: ${e}`),
  `FOREMAN_REVIEW pr=#${pr} verdict=APPROVE merged=yes deploy=SUCCESS`,
].join("\n");

function setup() {
  setStatePath(mkdtempSync(join(tmpdir(), "ue-state-")));
  const em = mkdtempSync(join(tmpdir(), "ue-em-"));
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
  assert.deepEqual(parseUnrelatedErrors(out), [stripe("a1"), "worker: redis timeout"]);
  assert.deepEqual(parseUnrelatedErrors("Verified (dev) o/ue#5: passed.\nFOREMAN_REVIEW pr=#5 verdict=APPROVE merged=yes deploy=SUCCESS"), []);
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
  assert.equal(noteUnrelated("ue", parseUnrelatedErrors(sreOut(5, [stripe("1111")])), "o/ue PR #5 (dev)"), 1);
  assert.equal(noteUnrelated("ue", parseUnrelatedErrors(sreOut(6, [stripe("2222"), "worker: redis timeout"])), "o/ue PR #6 (dev)"), 1);

  assert.equal(await tryUnstick(repo, config, logger, 1, {}), 2);
  const made = calls();
  assert.equal(made.length, 2);
  for (const argv of made) {
    assert.equal(argv[argv.indexOf("--kind") + 1], "unrelated-error");
    assert.equal(argv[argv.indexOf("--issue") + 1], "0");
  }
  assert.match(made[0][made[0].indexOf("--reason") + 1], /first seen on o\/ue PR #5 \(dev\).*Expired API Key/);

  // Nothing holds the release, and a later PR seeing either error again calls no one.
  assert.deepEqual(loadRepoState("ue").verifyHeld ?? {}, {});
  assert.equal(noteUnrelated("ue", [stripe("3333"), "worker: redis timeout"], "o/ue PR #7 (dev)"), 0);
  assert.equal(await tryUnstick(repo, config, logger, 2, {}), 0);
  assert.equal(calls().length, 2);
});
