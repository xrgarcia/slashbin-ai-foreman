// Event-loop stall detector and delay histogram (slashbin-ai-foreman#228).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startEventLoopMonitor } from "../dist/event-loop-delay.js";
import { UpstreamBackoffError } from "../dist/upstream-backoff.js";

const logger = () => {
  const lines = [];
  return { lines, info: (m, d) => lines.push({ m, d }), warn() {}, error() {}, debug() {}, child() { return this; } };
};
const block = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* hold the loop */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stalls = (log) => log.lines.filter((l) => l.m.startsWith("Event-loop stall"));

test("a pass that blocks the loop 600 ms logs one stall line naming it", async () => {
  const log = logger();
  const mon = startEventLoopMonitor(log);
  assert.equal(await mon.track("r/x", "build", async () => { block(600); await sleep(20); return 7; }), 7);
  mon.disable();
  const s = stalls(log);
  assert.equal(s.length, 1, JSON.stringify(log.lines));
  assert.ok(s[0].d.gap >= 600);
  assert.match(s[0].m, /^Event-loop stall \d+ms active=r\/x:build$/);
});

test("a stall that ends the pass is still attributed to it", async () => {
  const log = logger();
  const mon = startEventLoopMonitor(log);
  await mon.track("r/x", "build", async () => { block(500); });
  mon.disable();
  assert.deepEqual(stalls(log).map((l) => l.d.active), [["r/x:build"]]);
});

test("an idle pass logs no stall line", async () => {
  const log = logger();
  const mon = startEventLoopMonitor(log);
  await mon.track("r/x", "build", async () => { await sleep(300); });
  mon.disable();
  assert.equal(stalls(log).length, 0);
});

test("concurrent passes are all named while in flight", async () => {
  const log = logger();
  const mon = startEventLoopMonitor(log);
  const a = mon.track("r/x", "build", async () => { await sleep(100); block(400); await sleep(20); });
  const b = mon.track("r/y", "review", async () => { await sleep(300); });
  await Promise.all([a, b]);
  mon.disable();
  const s = stalls(log);
  assert.ok(s.length >= 1);
  assert.deepEqual([...s[0].d.active].sort(), ["r/x:build", "r/y:review"]);
});

test("results and errors pass through, and the set is empty afterwards", async () => {
  const log = logger();
  const mon = startEventLoopMonitor(log);
  const boom = new Error("boom");
  await assert.rejects(mon.track("r/x", "build", async () => { throw boom; }), (e) => e === boom);
  const back = new UpstreamBackoffError("blocked");
  await assert.rejects(mon.track("r/x", "build", async () => { throw back; }), (e) => e === back);
  block(400);
  await sleep(150);
  mon.disable();
  assert.ok(stalls(log).every((l) => l.d.active.length === 0));
});

test("an injected 2000 ms gap logs gap >= 2000 at a pass end", async () => {
  let t = 0;
  const log = logger();
  const mon = startEventLoopMonitor(log, { now: () => t });
  await mon.track("r/x", "build", async () => { t += 2000; });
  mon.disable();
  assert.ok(stalls(log)[0].d.gap >= 2000);
  assert.deepEqual(stalls(log)[0].d.active, ["r/x:build"]);
});

test("the histogram line reports p50, p99 and max for the window, max >= the block", async () => {
  const log = logger();
  const mon = startEventLoopMonitor(log, { windowMs: 1200 });
  await sleep(100);
  block(800);
  await sleep(1300);
  mon.disable();
  const d = log.lines.find((l) => l.m.startsWith("Event-loop delay"));
  assert.ok(d, JSON.stringify(log.lines));
  assert.match(d.m, /^Event-loop delay p50=[\d.]+ms p99=[\d.]+ms max=[\d.]+ms$/);
  assert.ok(d.d.max >= 700, JSON.stringify(d.d));
});

test("per-pass cost is under 0.5 ms", async () => {
  const mon = startEventLoopMonitor(logger());
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) await mon.track("r/x", "build", async () => 1);
  mon.disable();
  assert.ok((performance.now() - t0) / 1000 < 0.5);
});

test("a freeze before the histogram's first tick still shows in the window max", async () => {
  const log = logger();
  const mon = startEventLoopMonitor(log, { windowMs: 1200 });
  await mon.track("r/x", "build", async () => { block(1500); });
  await sleep(1300);
  mon.disable();
  const d = log.lines.find((l) => l.m.startsWith("Event-loop delay"));
  assert.ok(d && d.d.max >= 1500, JSON.stringify(log.lines));
});
