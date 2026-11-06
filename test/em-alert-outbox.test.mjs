// foreman#232: the alert outbox's contract with the EM, and the delivery policy `nextStep` owns for every kind.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UNSTICK_KINDS, UNSTICK_MAX_ATTEMPTS, SPENT_QUESTION_REARM_MS, missingKinds, nextStep, epicChildClosedAlert, unrelatedErrorAlert } from "../dist/unstick.js";
import { checkKindContract } from "../dist/unstick-contract.js";
import { rejectedAsUnknownKind } from "../dist/plugins/em.js";
import { applyOutcome } from "../dist/phases/unstick.js";

const HOUR = 3600_000;
const T0 = Date.parse("2026-11-06T00:00:00Z");
const policy = { maxAttempts: UNSTICK_MAX_ATTEMPTS, handoff: { baseMs: 0, capMs: 0, factor: 1, maxRecalls: 0 } };

// The contract: the EM's `kinds --json` output (captured from bin/em.mjs) lists every kind the Foreman sends.
test("contract: every UNSTICK_KINDS member is in the EM's published kinds (fixture = bin/em.mjs kinds --json)", () => {
  const published = JSON.parse(readFileSync(new URL("./fixtures/em-kinds.json", import.meta.url), "utf8"));
  assert.deepEqual(missingKinds(published), []);
});

test("contract: a kind the EM does not list is reported missing", () => {
  const published = UNSTICK_KINDS.filter((k) => k !== "dependency-batch-loop");
  assert.deepEqual(missingKinds(published), ["dependency-batch-loop"]);
  assert.deepEqual(missingKinds([...published, "something-newer"]), ["dependency-batch-loop"], "extra EM kinds are harmless");
});

test("contract: the startup check logs an error and reports missing; unreadable is unchecked, not a break", async () => {
  const { registerPlugin, resetRegistryForTests, startPlugins } = await import("../dist/plugins/registry.js");
  const logs = [];
  const logger = { info() {}, warn: (m) => logs.push(["warn", m]), error: (m) => logs.push(["error", m]), debug() {}, child() { return this; } };
  const agent = (published) => ({ id: "fake-em", roles: ["unstick"], enabled: () => true, unstick: { unstick: async () => ({ kind: "invoked", detail: "" }), publishedKinds: async () => published } });
  const check = async (published) => {
    resetRegistryForTests();
    registerPlugin(agent(published));
    await startPlugins({}, { logger, configText: () => null });
    return checkKindContract({}, logger);
  };
  assert.deepEqual(await check(UNSTICK_KINDS), { status: "ok" });
  assert.deepEqual(await check(UNSTICK_KINDS.slice(1)), { status: "missing", missing: [UNSTICK_KINDS[0]] });
  assert.ok(logs.some(([lvl, m]) => lvl === "error" && m.includes(UNSTICK_KINDS[0])));
  logs.length = 0;
  assert.equal((await check(null)).status, "unchecked");
  assert.ok(logs.every(([lvl]) => lvl === "warn"));
});

test("unknown kind: only bin/em.mjs's exact rejection of THIS kind is a contract break; a decline is not", () => {
  const reject = { stdout: "", stderr: "unknown kind 'brand-new'; nothing written\n" };
  assert.equal(rejectedAsUnknownKind(reject, "brand-new"), true);
  assert.equal(rejectedAsUnknownKind(reject, "other"), false, "another kind's rejection");
  assert.equal(rejectedAsUnknownKind({ stdout: "", stderr: "already answered this reason; nothing written\n" }, "skip"), false);
  assert.equal(rejectedAsUnknownKind({ stdout: "", stderr: "out of scope: unknown kind 'skip' was in the reason text\n" }, "skip"), false, "prose that quotes it");
  assert.equal(rejectedAsUnknownKind({ stdout: "something\n", stderr: reject.stderr }, "brand-new"), false);
});

// The delivery policy, for every kind (not only inside the repo-level write path).
const entry = (o) => ({ issue: 0, kind: "unrelated-error", reason: "r", status: "failed", attempts: UNSTICK_MAX_ATTEMPTS, since: new Date(T0).toISOString(), lastCallAt: new Date(T0).toISOString(), ...o });
const cand = (e) => ({ issue: e.issue, kind: e.kind, reason: e.reason });

test("nextStep: failed at the cap re-arms after the window, for EVERY kind", () => {
  for (const kind of UNSTICK_KINDS) for (const issue of [0, 12]) {
    const e = entry({ kind, issue });
    assert.equal(nextStep(e, cand(e), T0 + SPENT_QUESTION_REARM_MS - 1, policy), "wait", `${kind}#${issue} inside the window`);
    assert.equal(nextStep(e, cand(e), T0 + SPENT_QUESTION_REARM_MS, policy), "call", `${kind}#${issue} past the window`);
  }
});

test("nextStep: a delivered entry (invoked, escalated, declined) is never re-armed", () => {
  for (const status of ["escalated", "declined"]) {
    const e = entry({ status });
    assert.equal(nextStep(e, cand(e), T0 + 99 * HOUR, policy), "wait", status);
  }
  const inv = entry({ status: "invoked" });
  assert.equal(nextStep(inv, cand(inv), T0 + 99 * HOUR, policy), "wait", "invoked with no handoff watch");
});

test("nextStep: calls left still call at once; a changed reason is a new question", () => {
  const e = entry({ attempts: 1 });
  assert.equal(nextStep(e, cand(e), T0, policy), "call");
  const spent = entry({});
  assert.equal(nextStep(spent, { ...cand(spent), reason: "new" }, T0, policy), "call");
});

test("applyOutcome: a re-arm is ONE call: attempts never reset, each failed re-arm is counted", () => {
  const upstream = { baseMs: 1000, capMs: 10000, factor: 2 };
  const spent = entry({});
  const r1 = applyOutcome(spent, { kind: "failed", detail: "x" }, T0 + SPENT_QUESTION_REARM_MS, upstream);
  assert.deepEqual([r1.attempts, r1.rearms, r1.status], [UNSTICK_MAX_ATTEMPTS + 1, 1, "failed"]);
  const r2 = applyOutcome(r1, { kind: "failed", detail: "x" }, T0 + 9 * HOUR, upstream);
  assert.deepEqual([r2.attempts, r2.rearms], [UNSTICK_MAX_ATTEMPTS + 2, 2]);
  const ok = applyOutcome(spent, { kind: "invoked", detail: "x" }, T0 + SPENT_QUESTION_REARM_MS, upstream);
  assert.equal(ok.status, "invoked");
  assert.equal(applyOutcome(entry({ attempts: 1 }), { kind: "failed", detail: "x" }, T0, upstream).attempts, 2);
  assert.equal(applyOutcome(entry({ attempts: 1 }), { kind: "failed", detail: "x" }, T0, upstream).rearms, undefined, "inside the first burst: not a re-arm");
  const refused = applyOutcome(r1, { kind: "refused", detail: "limit" }, T0 + 9 * HOUR, upstream);
  assert.deepEqual([refused.attempts, refused.rearms], [r1.attempts, 1], "a refusal spends nothing and keeps the back-off");
});

test("a question failing for ever: 3 calls, then re-arms on a 1h,2h,4h...24h back-off, one call each", () => {
  const upstream = { baseMs: 1000, capMs: 10000, factor: 2 };
  let e = { issue: 0, kind: "unrelated-error", reason: "r", status: "pending", attempts: 0, since: new Date(T0).toISOString() };
  const calls = [];
  for (let t = T0; t <= T0 + 72 * HOUR; t += 5 * 60_000) {
    if (nextStep(e, cand(e), t, policy) === "call") { calls.push((t - T0) / HOUR); e = applyOutcome(e, { kind: "failed", detail: "down" }, t, upstream); }
  }
  const within24 = calls.filter((h) => h <= 24).length;
  const rearmsIn24 = within24 - UNSTICK_MAX_ATTEMPTS;
  assert.ok(rearmsIn24 <= Math.ceil(Math.log2(24)), `re-arm calls in 24h: ${rearmsIn24}`);
  assert.equal(calls.length, 3 + 6, "3, then re-arms after waits of 1,2,4,8,16,24h");
  console.log(`# failing for ever, 72 simulated hours: ${calls.length} calls (${within24} in the first 24h), at hours ${calls.map((h) => h.toFixed(2)).join(", ")}`);
  assert.ok(calls.length <= 3 + 6, "bounded over 72h");
});

test("alerts: builders give a stable key and one subject per kind", () => {
  assert.deepEqual(epicChildClosedAlert("o/r", 5, 880, "epic"), { kind: "epic-ready-to-close", subject: 0, dedupeKey: "880-5", reason: "o/r#5 was closed as completed after its production verification; it belongs to epic #880. Close the epic if this was its last open child." });
  assert.equal(unrelatedErrorAlert("err 1", "o/r PR #1", []).dedupeKey, unrelatedErrorAlert("err 2", "o/r PR #2", []).dedupeKey, "numbers fold into one signature");
});
