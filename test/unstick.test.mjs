// The unstick stage (foreman#103): what is stuck, and the EM call. Run with
// `npm test`. These pin the parts; the EM's side of the call is covered by the EM's
// own `bin/em.mjs unstick` acceptance (slashbin-engineering-manager).
import test from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNSTICK_KINDS, UNSTICK_MAX_ATTEMPTS, derivedCandidates, needsCall, nextStep, handoffGiveUpComment, openEntry, unstickKey, releaseGateReason, releaseGateCandidateReason, followUpOrigin,
} from "../dist/unstick.js";
import { applyOutcome } from "../dist/phases/unstick.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { unstickViaEm, grantStateViaEm, buildEmEnv, EM_UNSTICK_MAX_DURATION_MS, emUnstickMaxDurationMs } from "../dist/plugins/em.js";
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
    "dependency-batch-loop",
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

test("a recall the EM declines as already answered keeps the handoff watched", () => {
  const t0 = Date.parse("2026-11-05T12:00:00Z");
  const up = DEFAULT_BACKOFF.upstream;
  let e = { issue: 7, kind: "release-gate", reason: "r", status: "pending", attempts: 0, since: "t" };
  e = applyOutcome(e, { kind: "declined", detail: "no" }, t0, up);
  assert.equal(e.status, "declined", "a decline on a question never handed off is final");
  e = { issue: 7, kind: "release-gate", reason: "r", status: "pending", attempts: 0, since: "t" };
  e = applyOutcome(e, { kind: "invoked", detail: "handed off" }, t0, up);
  e = applyOutcome(e, { kind: "declined", detail: "already answered this reason; nothing written" }, t0 + 1, up);
  assert.equal(e.status, "invoked");
  assert.equal(e.recalls, 1, "it counts as a recall");
  assert.equal(e.attempts, 2);
});

test("an invoked entry recorded before recalls existed is a standing handoff: a duplicate decline or a refusal keeps it watched", () => {
  const t0 = Date.parse("2026-11-05T12:00:00Z");
  const up = DEFAULT_BACKOFF.upstream;
  const legacy = { issue: 7, kind: "release-gate", reason: "r", status: "invoked", attempts: 1, since: "t", lastCallAt: "2026-11-05T10:00:00Z" };
  let e = applyOutcome(legacy, { kind: "declined", detail: "already answered this reason; nothing written" }, t0, up);
  assert.equal(e.status, "invoked");
  assert.equal(e.recalls, 1);
  e = applyOutcome(legacy, { kind: "refused", detail: "You've hit your limit" }, t0, up);
  assert.equal(e.recalls, 0, "the refusal keeps the handoff marked");
  e = applyOutcome(e, { kind: "declined", detail: "already answered" }, t0 + 1, up);
  assert.equal(e.status, "invoked");
  assert.equal(e.recalls, 1);
  e = applyOutcome(legacy, { kind: "invoked", detail: "again" }, t0, up);
  assert.equal(e.recalls, 1, "a second handoff on a legacy entry is its first recall");
});

// A grant landing at the gate re-calls the EM (jerky_ops#201, 2026-11-05): the reason
// carries the labels, so an answered gate with a new label is a new question.
test("releaseGateReason: a new label changes the reason, so an answered release gate is called again", () => {
  const before = releaseGateReason(["pr approved", "approved"]);
  const after = releaseGateReason(["approved", "pr approved", "deliver-to-prod"]);
  assert.equal(before, releaseGateReason(["approved", "pr approved", "approved"]), "order and repeats do not matter");
  assert.notEqual(before, after);
  const H = { maxAttempts: UNSTICK_MAX_ATTEMPTS, handoff: { baseMs: 1_000, capMs: 10_000, factor: 2, maxRecalls: 2 } };
  const answered = { issue: 5, kind: "release-gate", reason: before, status: "invoked", attempts: 1, since: "t", lastCallAt: new Date(0).toISOString(), recalls: 2 };
  assert.equal(nextStep(answered, { issue: 5, kind: "release-gate", reason: after }, 1, H), "call");
});

const H0 = { maxAttempts: UNSTICK_MAX_ATTEMPTS, handoff: { baseMs: 1_000, capMs: 10_000, factor: 2, maxRecalls: 2 } };
test("releaseGateReason: the EM's grant-state answer changes the reason though the child's labels do not (PR #222 S2)", () => {
  const labels = ["pr approved", "approved"];
  const no = releaseGateCandidateReason(labels, '{"granted": false, "missing": ["o/em#900 lacks `deliver-to-prod`"]}');
  const yes = releaseGateCandidateReason(labels, '{"granted": true, "missing": []}');
  assert.notEqual(no, yes);
  assert.match(yes, /\[grant: \{"granted": true/);
  const answered = { issue: 201, kind: "release-gate", reason: no, status: "invoked", attempts: 1, since: "t", lastCallAt: new Date(0).toISOString(), recalls: 2 };
  assert.equal(nextStep(answered, { issue: 201, kind: "release-gate", reason: yes }, 1, H0), "call");
  assert.equal(nextStep(answered, { issue: 201, kind: "release-gate", reason: no }, 1, H0) === "call", false);
});

test("releaseGateCandidateReason: no grant answer keeps the prior reason; with no prior it drops the grant part", () => {
  const labels = ["pr approved"];
  const prior = releaseGateCandidateReason(labels, '{"granted": false, "missing": []}');
  assert.equal(releaseGateCandidateReason(labels, null, prior), prior, "a flaky read is not a new question");
  assert.equal(releaseGateCandidateReason(labels, null), releaseGateReason(labels));
  assert.doesNotMatch(releaseGateCandidateReason(labels, null), /grant:/);
});

test("grantStateViaEm: exit 0 gives the trimmed stdout; non-zero, empty, tokenless or unconfigured is null", async () => {
  process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
  const log = join(mkTmp("em-gs-"), "argv.json");
  const ok = fakeEm(`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })); console.log('  {"granted": true, "missing": []}  ');`);
  assert.equal(await grantStateViaEm(repo, ok, 9, logger), '{"granted": true, "missing": []}');
  const seen = JSON.parse(readFileSync(log, "utf8"));
  assert.deepEqual(seen.argv, ["grant-state", "--repo", "o/r", "--issue", "9"]);
  assert.equal(seen.cwd, ok.emRepoPath);
  assert.equal(await grantStateViaEm(repo, fakeEm('console.log("{}"); process.exit(1)'), 9, logger), null, "non-zero");
  assert.equal(await grantStateViaEm(repo, fakeEm("process.exit(0)"), 9, logger), null, "no output");
  assert.equal(await grantStateViaEm(repo, {}, 9, logger), null, "no emRepoPath");
  const saved = process.env.EM_GITHUB_TOKEN;
  delete process.env.EM_GITHUB_TOKEN;
  try {
    assert.equal(await grantStateViaEm(repo, ok, 9, logger), null, "no token");
  } finally {
    if (saved !== undefined) process.env.EM_GITHUB_TOKEN = saved;
  }
});

test("followUpOrigin: reads the issue a title follows up", () => {
  assert.equal(followUpOrigin("Fix it — follow-up to #123"), 123);
  assert.equal(followUpOrigin("plain"), null);
});

test("followUpTargets: every target in order; followUpsOf matches only the exact holder", async () => {
  const { followUpTargets } = await import("../dist/unstick.js");
  const { followUpsOf } = await import("../dist/phases/verify.js");
  assert.deepEqual(followUpTargets("a — follow-up to #5, follow-up to #12"), [5, 12]);
  assert.deepEqual(followUpsOf(12, [1, 2, 3], new Map([[1, "x follow-up to #12"], [2, "x follow-up to #123"], [3, "no"]])), [1]);
});
