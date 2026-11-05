// The unstick stage (foreman#103): what is stuck, and the EM call. Run with
// `npm test`. The whole-pass behaviour is proved by the EM's acceptance script
// (scripts/slashbin-ai/foreman-103-unstick-acceptance.mjs); these pin the parts.
import test from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNSTICK_KINDS, UNSTICK_MAX_ATTEMPTS, derivedCandidates, needsCall, nextStep, handoffGiveUpComment, openEntry, unstickKey,
} from "../dist/unstick.js";
import { applyOutcome } from "../dist/phases/unstick.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { unstickViaEm, buildEmEnv, EM_UNSTICK_MAX_DURATION_MS, emUnstickMaxDurationMs } from "../dist/plugins/em.js";
import { unstickStageReady } from "../dist/config.js";
import { startAgentPlugins } from "./agent-plugins.mjs";

await startAgentPlugins();

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const repo = { name: "r", githubRepo: "o/r" };
const opts = { verifyMaxAttempts: 3, isDeployFailureHold: (r) => r === "dev-verify-failed" || r.startsWith("deploy=") };
const held = (reason, attempts, prNumber = 5) => ({ heldAt: "2026-10-20T10:00:00Z", prNumber, reason, attempts });

test("the kinds are the EM contract, verbatim", () => {
  assert.deepEqual([...UNSTICK_KINDS], [
    "skip", "divergence", "verify-held", "verify-exhausted", "verify-no-pr", "revision-exhausted",
    "revision-stalemate", "needs-ruling", "dead-zone", "deploy-failed", "release-gate", "rework-decision",
    "unrelated-error",
    "epic-ready-to-close",
  ]);
  assert.equal(EM_UNSTICK_MAX_DURATION_MS, 20 * 60_000);
  assert.equal(emUnstickMaxDurationMs("skip"), 20 * 60_000);
  assert.equal(emUnstickMaxDurationMs("rework-decision"), 40 * 60_000);
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
  const dir = mkTmp("fake-em-");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/em.mjs"), script);
  return { emRepoPath: dir, sessionEnv: [] };
}

test("unstickViaEm: argv, cwd and token; exit codes map to outcomes", async () => {
  process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
  const log = join(mkTmp("em-log-"), "argv.json");
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

// The handoff watch (SLA-3693, 2026-11-05): the EM answered "invoked" to a
// release gate, its seat ran out of tokens, and nothing ever looked again.
const H = { maxAttempts: UNSTICK_MAX_ATTEMPTS, handoff: { baseMs: 1_000, capMs: 10_000, factor: 2, maxRecalls: 2 } };
const gate = { issue: 5, kind: "release-gate", reason: "at pr approved" };
const at = (ms) => new Date(ms).toISOString();

test("nextStep: an invoked handoff that never moved is called again on a growing window, then given up", () => {
  const t0 = 1_000_000;
  let e = { ...gate, status: "pending", attempts: 0, since: at(t0) };
  assert.equal(nextStep(e, gate, t0, H), "call");
  e = applyOutcome(e, { kind: "invoked", detail: "handed to the PO" }, t0, DEFAULT_BACKOFF.upstream);
  assert.equal(e.recalls, 0);
  assert.equal(nextStep(e, gate, t0 + 999, H), "wait");
  assert.equal(nextStep(e, gate, t0 + 1_000, H), "call", "window 1 passed");
  e = applyOutcome(e, { kind: "invoked", detail: "again" }, t0 + 1_000, DEFAULT_BACKOFF.upstream);
  assert.equal(e.recalls, 1);
  assert.equal(nextStep(e, gate, t0 + 1_000 + 1_999, H), "wait", "window 2 is longer");
  assert.equal(nextStep(e, gate, t0 + 3_000, H), "call");
  e = applyOutcome(e, { kind: "invoked", detail: "again" }, t0 + 3_000, DEFAULT_BACKOFF.upstream);
  assert.equal(e.recalls, 2);
  assert.equal(nextStep(e, gate, t0 + 3_000 + 4_000, H), "give-up", "recalls spent: tell the owner");
  assert.equal(nextStep({ ...e, gaveUpAt: at(t0) }, gate, t0 + 1e9, H), "wait", "given up once, never again");
  assert.equal(nextStep(e, { ...gate, reason: "new" }, t0, H), "call", "a changed reason is a new question");
});

test("nextStep: maxRecalls 0 keeps the old rule (an answer is final)", () => {
  const e = { ...gate, status: "invoked", attempts: 1, since: at(0), lastCallAt: at(0), recalls: 0 };
  assert.equal(nextStep(e, gate, 1e12, { ...H, handoff: { ...H.handoff, maxRecalls: 0 } }), "wait");
  assert.equal(needsCall(e, gate), false, "needsCall carries no handoff watch");
});

test("a refusal spends no attempt and waits for the stated reset, else the upstream window", () => {
  const t0 = 5_000_000;
  const up = { baseMs: 100, capMs: 1_000, factor: 2 };
  let e = { ...gate, status: "failed", attempts: 2, since: at(t0) };
  e = applyOutcome(e, { kind: "refused", detail: "You've hit your limit" }, t0, up);
  assert.equal(e.status, "refused");
  assert.equal(e.attempts, 2, "not charged");
  assert.equal(e.waitUntil, at(t0 + 100));
  assert.equal(nextStep(e, gate, t0 + 99, H), "wait");
  assert.equal(nextStep(e, gate, t0 + 100, H), "call");
  e = applyOutcome(e, { kind: "refused", detail: "again" }, t0 + 100, up);
  assert.equal(e.waitUntil, at(t0 + 100 + 200), "longer each refusal in a row");
  e = applyOutcome(e, { kind: "refused", detail: "again", resetAtMs: t0 + 60_000 }, t0 + 300, up);
  assert.equal(e.waitUntil, at(t0 + 60_000), "a stated reset wins");
  e = applyOutcome(e, { kind: "invoked", detail: "ok" }, t0 + 60_000, up);
  assert.equal(e.status, "invoked");
  assert.equal(e.refusals, undefined, "an answer clears the refusal run");
  assert.equal(e.waitUntil, undefined);
});

test("the handoff give-up comment names the owner, the kind and the last answer", () => {
  const c = handoffGiveUpComment("ray", { kind: "release-gate", reason: "r", attempts: 3, since: "s", lastCallAt: "l", detail: "d" });
  assert.match(c, /@ray/);
  assert.match(c, /`release-gate`/);
  assert.match(c, /acted 3 times/);
});

test("unstickViaEm: a run that ends in the runner's refusal is refused, whatever its exit", async () => {
  process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
  for (const code of [0, 1]) {
    const r = await unstickViaEm(repo, fakeEm(`console.log("You've hit your session limit · resets 9am (America/Chicago)"); process.exit(${code});`), 9, "release-gate", "why", logger);
    assert.equal(r.kind, "refused", `exit ${code}`);
    assert.match(r.detail, /hit your session limit/);
    assert.ok(r.resetAtMs > Date.now());
  }
  const esc = await unstickViaEm(repo, fakeEm(`console.log("You've hit your session limit"); process.exit(2);`), 9, "skip", "why", logger);
  assert.equal(esc.kind, "escalated", "an explicit escalation stands");
});
