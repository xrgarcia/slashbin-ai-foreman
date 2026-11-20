// StallClock (slashbin-ai-foreman#364): one start per stall, one escalation, dark without the flag.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { HandoffNotSaved } from "../dist/unstick.js";
import { report, resolve, sweep, stallReason, stallsReadout, STALL_ESCALATION_BOUND_MS } from "../dist/stall-clock.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, recordOf, breakRecords } from "./issue-records.mjs";

await startAgentPlugins();
const rc = { ...loadConfig(), name: "r", githubRepo: "o/r", repoPath: ".", baseBranch: "develop" };
const T0 = Date.parse("2026-11-19T04:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();
const input = (o = {}) => ({
  issue: 7, cause: "verify-deferred", eventAt: at(0), affected: ["o/r#7"], resolver: "EM",
  nextAction: "fix the check", resumptionCondition: "the check passes", ...o,
});
function fresh() { memoryRecords(); return new ForemanRuntime(); }
function spy(rt) {
  const calls = [];
  const real = rt.handoffs.raise.bind(rt.handoffs);
  rt.handoffs.raise = async (c, a) => { calls.push(a); return real(c, a); };
  return calls;
}
process.env.FOREMAN_STALL_CLOCK = "1";

test("the start is kept across report, restart and relabel", async () => {
  const rt = fresh();
  const a = await report(rt, rc, input());
  assert.equal(a.created, true);
  assert.equal(a.record.id, "o/r#7:verify-deferred");
  const b = await report(rt, rc, input({ eventAt: at(60_000), evidence: "https://x/1", affected: ["o/r#7", "o/r#8"] }));
  assert.equal(b.created, false);
  assert.equal(b.record.startedAt, at(0));
  assert.deepEqual(b.record.affected, ["o/r#7", "o/r#8"]);
  assert.deepEqual(b.record.evidence, ["https://x/1"]);
  const restarted = new ForemanRuntime(); // a new process reads the same record
  const c = await report(restarted, rc, input({ eventAt: at(3_600_000) }));
  assert.equal(c.record.startedAt, at(0));
});

test("a second cause is its own entry with its own start", async () => {
  const rt = fresh();
  await report(rt, rc, input());
  await report(rt, rc, input({ cause: "handoff-gave-up", eventAt: at(10_000) }));
  const s = (await recordOf(rt, rc, 7)).stalls;
  assert.equal(s["verify-deferred"].startedAt, at(0));
  assert.equal(s["handoff-gave-up"].startedAt, at(10_000));
});

test("a release stall sits on its first affected issue, never issue 0", async () => {
  const rt = fresh();
  const r = await report(rt, rc, input({ issue: 3, cause: "release-sign-off", affected: ["o/r#3", "o/r#9"], nextAction: "sign" }));
  assert.equal(r.record.id, "o/r#3:release-sign-off");
  assert.ok((await recordOf(rt, rc, 3)).stalls["release-sign-off"]);
  await assert.rejects(report(rt, rc, input({ issue: 0 })));
});

test("invalid reports write nothing", async () => {
  const rt = fresh();
  for (const bad of [{ affected: [] }, { resolver: "" }, { nextAction: " " }, { resumptionCondition: "" }, { eventAt: "nope" }]) {
    await assert.rejects(report(rt, rc, input(bad)));
  }
  assert.equal((await recordOf(rt, rc, 7)).stalls, undefined);
});

test("a resolved key is replaced by a new record with a new start; resolve of nothing is a no-op", async () => {
  const rt = fresh();
  await resolve(rt, rc, 7, "verify-deferred", at(0));
  assert.equal((await recordOf(rt, rc, 7)).stalls, undefined);
  await report(rt, rc, input());
  await resolve(rt, rc, 7, "verify-deferred", at(5_000));
  const done = (await recordOf(rt, rc, 7)).stalls["verify-deferred"];
  assert.equal(done.state, "resolved");
  assert.equal(done.resolvedAt, at(5_000));
  const again = await report(rt, rc, input({ eventAt: at(9_000) }));
  assert.equal(again.created, true);
  assert.equal(again.record.startedAt, at(9_000));
});

test("sweep escalates once at 5_400_000 ms, raising `stalled` with dedupeKey = cause", async () => {
  const rt = fresh();
  const calls = spy(rt);
  await report(rt, rc, input());
  await sweep(rt, rc, at(STALL_ESCALATION_BOUND_MS - 1), [7]);
  assert.equal(calls.length, 0);
  assert.equal((await recordOf(rt, rc, 7)).stalls["verify-deferred"].state, "open");
  await sweep(rt, rc, at(STALL_ESCALATION_BOUND_MS), [7]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "stalled");
  assert.equal(calls[0].dedupeKey, "verify-deferred");
  assert.equal(calls[0].subject, 7);
  const rec = (await recordOf(rt, rc, 7)).stalls["verify-deferred"];
  assert.equal(rec.state, "escalated");
  assert.equal(rec.escalatedAt, at(STALL_ESCALATION_BOUND_MS));
  assert.equal(rec.undeliveredSince, null);
  assert.equal(JSON.parse(calls[0].reason).stall, rec.id);
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(calls[0].reason), "no timestamp in the reason");
  await sweep(rt, rc, at(STALL_ESCALATION_BOUND_MS + 1_800_000), [7]);
  assert.equal(calls.length, 1, "one escalation per stall");
  assert.ok((await recordOf(rt, rc, 7)).unstick["7:stalled:verify-deferred"], "the question is in the unstick outbox");
});

test("a raise that cannot be saved leaves the stall open with undeliveredSince; the next sweep retries", async () => {
  const rt = fresh();
  await report(rt, rc, input());
  let fail = true;
  const real = rt.handoffs.raise.bind(rt.handoffs);
  rt.handoffs.raise = async (c, a) => { if (fail) throw new HandoffNotSaved(a.kind, c.githubRepo); return real(c, a); };
  const t1 = at(STALL_ESCALATION_BOUND_MS + 1000);
  await sweep(rt, rc, t1, [7]);
  let rec = (await recordOf(rt, rc, 7)).stalls["verify-deferred"];
  assert.equal(rec.state, "open");
  assert.equal(rec.undeliveredSince, t1);
  assert.equal(rec.startedAt, at(0));
  await sweep(rt, rc, at(STALL_ESCALATION_BOUND_MS + 5000), [7]);
  assert.equal((await recordOf(rt, rc, 7)).stalls["verify-deferred"].undeliveredSince, t1, "kept from the first failure");
  fail = false;
  await sweep(rt, rc, at(STALL_ESCALATION_BOUND_MS + 9000), [7]);
  rec = (await recordOf(rt, rc, 7)).stalls["verify-deferred"];
  assert.equal(rec.state, "escalated");
  assert.equal(rec.undeliveredSince, null);
});

test("sweep reads only the open issues and skips resolved stalls", async () => {
  const rt = fresh();
  const calls = spy(rt);
  await report(rt, rc, input());
  await report(rt, rc, input({ issue: 8, affected: ["o/r#8"] }));
  await resolve(rt, rc, 8, "verify-deferred", at(1));
  await sweep(rt, rc, at(STALL_ESCALATION_BOUND_MS), [8]);
  assert.equal(calls.length, 0);
});

test("flag unset: report writes and raises nothing", async () => {
  const rt = fresh();
  const calls = spy(rt);
  delete process.env.FOREMAN_STALL_CLOCK;
  try {
    const r = await report(rt, rc, input());
    assert.equal(r.created, false);
    await sweep(rt, rc, at(STALL_ESCALATION_BOUND_MS * 2), [7]);
  } finally { process.env.FOREMAN_STALL_CLOCK = "1"; }
  assert.equal((await recordOf(rt, rc, 7)).stalls, undefined);
  assert.equal(calls.length, 0);
});

test("the readout lists unresolved stalls, delays, misses and undelivered", () => {
  const rec = (state, o = {}) => ({ id: `o/r#1:${state}`, state, startedAt: at(0), escalatedAt: null, undeliveredSince: null, ...o });
  const out = stallsReadout([
    rec("open"), rec("escalated", { escalatedAt: at(7_200_000) }), rec("resolved"), { ...rec("open"), id: "x", undeliveredSince: at(1) },
  ], T0 + STALL_ESCALATION_BOUND_MS);
  assert.equal(out.stalls.length, 3);
  assert.equal(out.stalls.find((s) => s.state === "escalated").missed, true);
  assert.equal(out.openPastBound, 2);
  assert.equal(out.undelivered, 1);
});

test("stalled is an unstick event kind", async () => {
  const { UNSTICK_KINDS, EVENT_KINDS } = await import("../dist/unstick.js");
  assert.ok(UNSTICK_KINDS.includes("stalled") && EVENT_KINDS.has("stalled"));
  assert.ok(stallReason);
});
