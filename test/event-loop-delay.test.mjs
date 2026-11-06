// Per-pass event-loop delay line (slashbin-ai-foreman#228).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startEventLoopDelayMonitor, withPassDelay, EVENT_LOOP_DELAY_PREFIX } from "../dist/event-loop-delay.js";
import { UpstreamBackoffError } from "../dist/upstream-backoff.js";

const logger = () => {
  const lines = [];
  return { lines, info: (m, d) => lines.push({ m, d }), warn() {}, error() {}, debug() {}, child() { return this; } };
};
const block = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* hold the loop */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a pass logs one line with the prefix, repo, lane, p50, p99 and max in ms", async () => {
  const mon = startEventLoopDelayMonitor();
  const log = logger();
  assert.equal(await withPassDelay(mon, log, "r/x", "build", async () => { await sleep(50); return 7; }), 7);
  mon.disable();
  assert.equal(log.lines.length, 1);
  assert.ok(log.lines[0].m.startsWith(EVENT_LOOP_DELAY_PREFIX));
  assert.match(log.lines[0].m, /repo=r\/x lane=build p50=[\d.]+ms p99=[\d.]+ms max=[\d.]+ms blocked=[\d.]+ms/);
  const d = log.lines[0].d;
  assert.deepEqual(Object.keys(d).sort(), ["blocked", "lane", "max", "p50", "p99", "repo"]);
  assert.ok(d.max < 1000, "an idle pass does not invent a stall");
});

test("the first pass after start, with no warm-up, sees a synchronous block it ends on", async () => {
  const mon = startEventLoopDelayMonitor();
  const log = logger();
  await withPassDelay(mon, log, "r/x", "build", async () => { block(400); });
  mon.disable();
  assert.ok(log.lines[0].d.max >= 380, JSON.stringify(log.lines[0].d));
});

test("a stall mid-pass is charged to that pass and does not leak into the next", async () => {
  const mon = startEventLoopDelayMonitor();
  const log = logger();
  await withPassDelay(mon, log, "r/x", "build", async () => { await sleep(30); block(300); await sleep(30); });
  await withPassDelay(mon, log, "r/x", "build", async () => { await sleep(50); });
  mon.disable();
  assert.ok(log.lines[0].d.max >= 280, JSON.stringify(log.lines[0].d));
  assert.ok(log.lines[1].d.max < 100, JSON.stringify(log.lines[1].d));
});

test("overlapping passes: a pass finishing first does not take the stall from the one still running", async () => {
  const mon = startEventLoopDelayMonitor();
  const logA = logger(); const logB = logger();
  const b = withPassDelay(mon, logB, "r/x", "slow", async () => { await sleep(20); block(300); await sleep(150); });
  const a = withPassDelay(mon, logA, "r/x", "fast", async () => { await sleep(60); });
  await Promise.all([a, b]);
  mon.disable();
  assert.ok(logB.lines[0].d.max >= 280, "the blocking pass reports the stall: " + JSON.stringify(logB.lines[0].d));
  assert.ok(logA.lines[0].d.max >= 280, "so does the pass it held up: " + JSON.stringify(logA.lines[0].d));
});

test("a pass that throws, and one cut short by the back-off, each emit exactly one line and rethrow", async () => {
  const mon = startEventLoopDelayMonitor();
  for (const err of [new Error("boom"), new UpstreamBackoffError("backing off")]) {
    const log = logger();
    await assert.rejects(withPassDelay(mon, log, "r/x", "build", async () => { throw err; }), (e) => e === err);
    assert.equal(log.lines.length, 1);
  }
  mon.disable();
});

test("a pass shorter than one tick reports zeros, not NaN", async () => {
  const mon = startEventLoopDelayMonitor();
  const log = logger();
  await withPassDelay(mon, log, "r/x", "build", async () => {});
  mon.disable();
  assert.deepEqual(Object.values(log.lines[0].d).filter((v) => typeof v === "number" && !Number.isFinite(v)), []);
  assert.ok(log.lines[0].d.max < 5);
});

test("the wrapper adds well under 1 ms to a pass", async () => {
  const mon = startEventLoopDelayMonitor();
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
  const N = 2000; const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await withPassDelay(mon, log, "r/x", "build", async () => {});
  const perPassMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  mon.disable();
  assert.ok(perPassMs < 0.5, `${perPassMs} ms per pass`);
});

test("a stall of exactly 2000 ms on an injected clock reports max >= 2000 ms from the first pass", async () => {
  let t = 0;
  const mon = startEventLoopDelayMonitor(() => t);
  const log = logger();
  await withPassDelay(mon, log, "r/x", "build", async () => { t += 2000; });
  mon.disable();
  assert.ok(log.lines[0].d.max >= 2000, JSON.stringify(log.lines[0].d));
  assert.ok(log.lines[0].d.blocked >= 2000);
  assert.ok(log.lines[0].d.p99 >= 1000 && log.lines[0].d.p50 >= 1000, `stall must show in percentiles: ${JSON.stringify(log.lines[0].d)}`);
});

test("reporting work follows the stalls in a pass, not the passes in flight", async () => {
  let t = 0;
  const mon = startEventLoopDelayMonitor(() => t);
  const log = logger();
  const n = 160;
  const windows = Array.from({ length: n }, () => mon.begin());
  for (const w of windows) { t += 12; mon.end(w, log, "r/x", "build"); } // each ends on its own 12 ms stall
  mon.disable();
  assert.equal(log.lines.length, n);
  // every window began before the first stall, so window i saw stalls 0..i: the first one, the last all n
  assert.equal(log.lines[0].d.max, 12);
  assert.equal(log.lines[n - 1].d.blocked, n * 12);
});
