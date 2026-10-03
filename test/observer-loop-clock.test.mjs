/**
 * The observer timeout counts free event-loop time, not wall time: a
 * synchronous call holding the loop (the daemon's gh/git calls) must not
 * expire an observer that has not had the chance to run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loopTimeout } from "../dist/work-source.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const holdLoop = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };

test("a free loop expires the observer after the limit", async () => {
  let expired = false;
  const stop = loopTimeout(200, () => { expired = true; }, 20);
  await sleep(400);
  stop();
  assert.equal(expired, true);
});

test("time the loop was held does not count toward the limit", async () => {
  let expired = false;
  const stop = loopTimeout(300, () => { expired = true; }, 20);
  holdLoop(800);
  await sleep(100);
  assert.equal(expired, false, "an 800 ms blocked loop expired a 300 ms limit");
  await sleep(400);
  stop();
  assert.equal(expired, true);
});

test("stopping the clock means it never fires", async () => {
  let expired = false;
  const stop = loopTimeout(50, () => { expired = true; }, 10);
  stop();
  await sleep(150);
  assert.equal(expired, false);
});
