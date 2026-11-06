// Per-pass event-loop delay line (slashbin-ai-foreman#228).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startEventLoopDelayMonitor, withPassDelay, EVENT_LOOP_DELAY_PREFIX } from "../dist/event-loop-delay.js";
import { UpstreamBackoffError } from "../dist/upstream-backoff.js";

const logger = () => {
  const lines = [];
  return { lines, info: (m, d) => lines.push({ m, d }), warn() {}, error() {}, debug() {}, child() { return this; } };
};
const fakeHistogram = (ns) => {
  const h = { count: ns.length, enabled: false, resets: 0, enable() { h.enabled = true; }, disable() { h.enabled = false; }, reset() { h.resets++; h.count = 0; },
    percentile: (p) => ns[Math.min(ns.length - 1, Math.floor((p / 100) * ns.length))], get max() { return Math.max(...ns); } };
  return h;
};

test("a pass logs one line with repo, lane, p50, p99 and max in ms, then resets", async () => {
  const h = fakeHistogram([10e6, 11e6, 12e6, 2500e6]);
  const mon = startEventLoopDelayMonitor(h);
  const log = logger();
  assert.equal(await withPassDelay(mon, log, "r/x", "build", async () => 7), 7);
  assert.equal(log.lines.length, 1);
  assert.ok(log.lines[0].m.startsWith(EVENT_LOOP_DELAY_PREFIX));
  assert.match(log.lines[0].m, /repo=r\/x lane=build p50=12ms p99=2500ms max=2500ms/);
  assert.deepEqual(log.lines[0].d, { repo: "r/x", lane: "build", p50: 12, p99: 2500, max: 2500 });
  assert.equal(h.resets, 1);
  mon.disable();
  assert.equal(h.enabled, false);
});

test("a pass that throws, and one cut short by the back-off, each emit exactly one line and rethrow", async () => {
  const mon = startEventLoopDelayMonitor(fakeHistogram([10e6]));
  for (const err of [new Error("boom"), new UpstreamBackoffError("backing off")]) {
    const log = logger();
    await assert.rejects(withPassDelay(mon, log, "r/x", "build", async () => { throw err; }), (e) => e === err);
    assert.equal(log.lines.length, 1);
  }
  mon.disable();
});

test("an empty window reports zeros, not NaN", async () => {
  const mon = startEventLoopDelayMonitor(fakeHistogram([]));
  const log = logger();
  await withPassDelay(mon, log, "r/x", "build", async () => {});
  assert.deepEqual(log.lines[0].d, { repo: "r/x", lane: "build", p50: 0, p99: 0, max: 0 });
  mon.disable();
});

test("the real histogram sees a synchronous block", async () => {
  const mon = startEventLoopDelayMonitor();
  const log = logger();
  await withPassDelay(mon, log, "r/x", "build", async () => {
    await new Promise((r) => setTimeout(r, 30));
    const end = Date.now() + 300; while (Date.now() < end) { /* hold the loop */ }
    await new Promise((r) => setTimeout(r, 30));
  });
  mon.disable();
  assert.ok(log.lines[0].d.max >= 250, JSON.stringify(log.lines[0].d));
});

test("a stall in the pass's last synchronous call is charged to that pass, not the next", async () => {
  const mon = startEventLoopDelayMonitor();
  const log = logger();
  await new Promise((r) => setTimeout(r, 30)); // let sampling settle
  await withPassDelay(mon, log, "r/x", "build", async () => {
    const end = Date.now() + 300; while (Date.now() < end) { /* the pass ends straight after the block */ }
  });
  mon.disable();
  assert.ok(log.lines[0].d.max >= 250, JSON.stringify(log.lines[0].d));
});
