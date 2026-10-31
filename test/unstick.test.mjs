// The unstick stage (foreman#103): what is stuck, and the EM call. Run with
// `npm test`. The whole-pass behaviour is proved by the EM's acceptance script
// (scripts/slashbin-ai/foreman-103-unstick-acceptance.mjs); these pin the parts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNSTICK_KINDS, UNSTICK_MAX_ATTEMPTS, derivedCandidates, needsCall, openEntry, unstickKey,
} from "../dist/unstick.js";
import { unstickViaEm, buildEmEnv, EM_UNSTICK_MAX_DURATION_MS } from "../dist/agent.js";
import { unstickStageReady } from "../dist/config.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const repo = { name: "r", githubRepo: "o/r" };
const opts = { verifyMaxAttempts: 3, isDeployFailureHold: (r) => r === "dev-verify-failed" || r.startsWith("deploy="), divergenceReason: () => "features diverged" };
const held = (reason, attempts, prNumber = 5) => ({ heldAt: "2026-10-20T10:00:00Z", prNumber, reason, attempts });

test("the kinds are the EM contract, verbatim", () => {
  assert.deepEqual([...UNSTICK_KINDS], [
    "skip", "divergence", "verify-held", "verify-exhausted", "verify-no-pr", "revision-exhausted",
    "revision-stalemate", "needs-ruling", "dead-zone", "deploy-failed", "release-gate", "rework-decision",
    "unrelated-error",
  ]);
  assert.equal(EM_UNSTICK_MAX_DURATION_MS, 20 * 60_000);
});

test("a hold with retries left is not stuck; one at its cap is, by kind", () => {
  assert.deepEqual(derivedCandidates({ verifyHeld: { 10: held("acceptance-not-verified", 1) } }, opts), []);
  const c = derivedCandidates({ verifyHeld: {
    10: held("acceptance-not-verified", 3), 11: held("dev-verify-failed", 3), 12: held("no-merged-pr", 3, 0),
  } }, opts);
  assert.deepEqual(c.map((x) => [x.issue, x.kind]), [[10, "verify-exhausted"], [11, "deploy-failed"], [12, "verify-no-pr"]]);
});

test("a no-merged-pr hold is stuck at once (it is born at its cap)", () => {
  const c = derivedCandidates({ verifyHeld: { 12: held("no-merged-pr", 0, 0) } }, opts);
  assert.equal(c[0].kind, "verify-no-pr");
});

test("divergence: once per announced issue, or issue 0 when none", () => {
  const block = (announced) => ({ featureBranch: "features", baseBranch: "develop", ahead: 1, behind: 2, since: "t", announced });
  assert.deepEqual(derivedCandidates({ branchBlock: block([7, 8]) }, opts).map((c) => [c.issue, c.kind]), [[7, "divergence"], [8, "divergence"]]);
  assert.deepEqual(derivedCandidates({ branchBlock: block([]) }, opts).map((c) => [c.issue, c.kind]), [[0, "divergence"]]);
});

test("an escalated skip is stuck; an unescalated one is not", () => {
  const c = derivedCandidates({ skipped: { 3: { lastSkippedAt: "t", reason: "x", skipCount: 9, escalatedAt: "t" }, 4: { lastSkippedAt: "t", reason: "x", skipCount: 1 } } }, opts);
  assert.deepEqual(c.map((x) => [x.issue, x.kind]), [[3, "skip"]]);
});

test("needsCall: answers are final until the reason changes; failures retry to the cap", () => {
  const c = { issue: 1, kind: "skip", reason: "r" };
  const e = (status, attempts = 1, reason = "r") => ({ ...openEntry(undefined, c, "t"), reason, status, attempts });
  assert.equal(needsCall(undefined, c), true);
  assert.equal(needsCall(e("pending", 0), c), true);
  for (const s of ["invoked", "escalated", "declined"]) assert.equal(needsCall(e(s), c), false, s);
  assert.equal(needsCall(e("failed", UNSTICK_MAX_ATTEMPTS - 1), c), true);
  assert.equal(needsCall(e("failed", UNSTICK_MAX_ATTEMPTS), c), false);
  assert.equal(needsCall(e("invoked", 1, "old"), c), true, "a changed reason is a new question");
  assert.equal(unstickKey(1, "skip"), "1:skip");
});

test("openEntry keeps the standing entry for an unchanged reason, replaces it for a new one", () => {
  const c = { issue: 1, kind: "skip", reason: "r" };
  const first = openEntry(undefined, c, "t0");
  assert.equal(openEntry(first, c, "t1"), first);
  const next = openEntry(first, { ...c, reason: "r2" }, "t1");
  assert.deepEqual([next.status, next.attempts, next.since], ["pending", 0, "t1"]);
});

test("unstickStageReady needs only emRepoPath, not Paperclip", () => {
  assert.equal(unstickStageReady({}), false);
  assert.equal(unstickStageReady({ emRepoPath: "/em" }), true);
});

function fakeEm(script) {
  const dir = mkdtempSync(join(tmpdir(), "fake-em-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/em.mjs"), script);
  return { emRepoPath: dir, sessionEnv: [] };
}

test("unstickViaEm: argv, cwd and token; exit codes map to outcomes", async () => {
  process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
  const log = join(mkdtempSync(join(tmpdir(), "em-log-")), "argv.json");
  const body = (code) => `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), token: Boolean(process.env.EM_GITHUB_TOKEN), foreman: Boolean(process.env.FOREMAN_GITHUB_TOKEN) })); console.log("done"); process.exit(${code});`;
  for (const [code, kind] of [[0, "invoked"], [2, "escalated"], [3, "declined"], [1, "failed"], [7, "failed"]]) {
    const cfg = fakeEm(body(code));
    const r = await unstickViaEm(repo, cfg, 9, "skip", "why", logger);
    assert.equal(r.kind, kind, `exit ${code}`);
    const seen = JSON.parse(readFileSync(log, "utf8"));
    assert.deepEqual(seen.argv, ["unstick", "--repo", "o/r", "--issue", "9", "--kind", "skip", "--reason", "why"]);
    assert.equal(seen.cwd, cfg.emRepoPath, "cwd is the EM checkout");
    assert.equal(seen.token, true);
  }
});

test("unstickViaEm: unconfigured or tokenless is a failure, never a call", async () => {
  assert.equal((await unstickViaEm(repo, {}, 1, "skip", "r", logger)).kind, "failed");
  const saved = process.env.EM_GITHUB_TOKEN;
  delete process.env.EM_GITHUB_TOKEN;
  try {
    assert.equal((await unstickViaEm(repo, fakeEm("process.exit(0)"), 1, "skip", "r", logger)).kind, "failed");
  } finally {
    if (saved !== undefined) process.env.EM_GITHUB_TOKEN = saved;
  }
});

test("buildEmEnv carries the EM token and no other agent's", () => {
  process.env.EM_GITHUB_TOKEN = "em-token-not-real";
  process.env.FOREMAN_GITHUB_TOKEN = "fm-token-not-real";
  process.env.TECHLEAD_GITHUB_KEY = "tl-token-not-real";
  const env = buildEmEnv({ sessionEnv: [] });
  assert.equal(env.EM_GITHUB_TOKEN, "em-token-not-real");
  assert.equal(env.TECHLEAD_GITHUB_KEY, undefined);
});
