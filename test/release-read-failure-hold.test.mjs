// A release-stage read that fails on every scan must become a visible hold, never a silent warning forever.
// `closeHeldNetZero` and `blockOrphans` used to log "left alone this scan" and move on: a GitHub node-cap failure
// hid for 16 hours. The first failure is now recorded on each affected issue (`releaseReadHeld`); past
// `toolingHoldLimitMs` the issues are blocked once with the error and since when; a successful read clears it.
// The decision is the pure `nextReleaseReadHold` (the pattern of verify.ts's `nextToolingHold`). No network.
import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkSource } from "../dist/work-source.js";
import { setCodeHost, resetRegistryForTests } from "../dist/plugins/registry.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { nextReleaseReadHold, releaseReadHoldReason, noteReleaseRead } from "../dist/phases/release.js";
import { seed, recordOf } from "./issue-records.mjs";

const LIMIT = 7_200_000;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
const REPO = { name: "r", githubRepo: "o/r", repoPath: "/nonexistent", github: { blockedLabel: "blocked" } };
const CONFIG = { toolingHoldLimitMs: LIMIT };

test("the first failure starts the clock and does not escalate", () => {
  const r = nextReleaseReadHold(undefined, "node cap", NOW, LIMIT);
  assert.deepEqual(r, { hold: { error: "node cap", firstFailedAt: at(0) }, escalates: false });
});

test("a failure keeps firstFailedAt and the newest error; it escalates once at the bound", () => {
  const prev = { error: "old", firstFailedAt: at(LIMIT - 1) };
  assert.deepEqual(nextReleaseReadHold(prev, "new", NOW, LIMIT), { hold: { error: "new", firstFailedAt: prev.firstFailedAt }, escalates: false });
  const due = { error: "old", firstFailedAt: at(LIMIT) };
  const r = nextReleaseReadHold(due, "new", NOW, LIMIT);
  assert.equal(r.escalates, true);
  assert.equal(r.hold.escalatedAt, at(0));
  const again = nextReleaseReadHold(r.hold, "new", NOW + HOUR, LIMIT);
  assert.equal(again.escalates, false);
  assert.equal(again.hold.escalatedAt, r.hold.escalatedAt);
});

test("an unreadable previous time starts afresh", () => {
  const r = nextReleaseReadHold({ error: "x", firstFailedAt: "garbage" }, "e", NOW, LIMIT);
  assert.equal(r.hold.firstFailedAt, at(0));
  assert.equal(r.escalates, false);
});

test("the block reason names the error and since when", () => {
  const text = releaseReadHoldReason("the orphan scan's", { error: "node cap exceeded", firstFailedAt: at(3 * HOUR) }, NOW, LIMIT);
  assert.match(text, /node cap exceeded/);
  assert.match(text, new RegExp(at(3 * HOUR)));
});

async function harness() {
  resetRegistryForTests();
  const store = new InMemoryRecordStore();
  const calls = { blocked: [], unblocked: [], comments: [], events: [], person: false };
  registerWorkSource({
    record: async (e) => { calls.events.push({ kind: e.kind, n: e.item?.issueNumber, stuck: e.stuck }); return true; },
    loadRecord: (k, rc) => store.loadRecord(k, rc),
    saveRecord: (k, r, rc) => store.saveRecord(k, r, rc),
  });
  setCodeHost({
    RELEASE_STOP_MARK: "<!-- release-stop -->",
    addBlockedLabel: async (_rc, n) => { calls.blocked.push(n); },
    blockedByPerson: async () => { if (calls.lookupFails) throw new Error("boom"); return calls.person; },
    removeBlockedLabel: async (_rc, n) => { calls.unblocked.push(n); },
    commentOnIssue: async (_rc, n, body) => { calls.comments.push({ n, body }); },
  });
  return { rt: new ForemanRuntime(), calls };
}
const done = () => { resetRegistryForTests(); registerWorkSource(null); setCodeHost(null); };

test("a failing read is recorded, held past the bound once, and cleared by a success", async () => {
  const h = await harness();
  try {
    await noteReleaseRead(h.rt, REPO, CONFIG, [1, 2], "node cap", "the orphan scan's", logger);
    assert.equal((await recordOf(h.rt, REPO, 1)).releaseReadHeld.error, "node cap");
    assert.deepEqual(h.calls.blocked, [], "under the bound nothing is blocked");

    await seed(h.rt, REPO, 1, { releaseReadHeld: { error: "node cap", firstFailedAt: new Date(Date.now() - 3 * HOUR).toISOString() } });
    await noteReleaseRead(h.rt, REPO, CONFIG, [1, 2], "node cap", "the orphan scan's", logger);
    assert.deepEqual(h.calls.blocked, [1], "only the issue past the bound is blocked");
    assert.deepEqual(h.calls.events.filter((e) => e.kind === "blocked"), [{ kind: "blocked", n: 1, stuck: "dead-zone" }], "the EM seat's unstick is told");
    assert.equal(h.calls.comments.length, 1);
    assert.match(h.calls.comments[0].body, /node cap/);
    assert.ok((await recordOf(h.rt, REPO, 1)).releaseReadHeld.escalatedAt);

    await noteReleaseRead(h.rt, REPO, CONFIG, [1, 2], "node cap", "the orphan scan's", logger);
    assert.deepEqual(h.calls.blocked, [1], "a repeat escalates nothing");
    assert.equal(h.calls.comments.length, 1);

    await noteReleaseRead(h.rt, REPO, CONFIG, [1, 2], null, "", logger);
    assert.equal((await recordOf(h.rt, REPO, 1)).releaseReadHeld, undefined);
    assert.equal((await recordOf(h.rt, REPO, 2)).releaseReadHeld, undefined);
    assert.deepEqual(h.calls.unblocked, [1], "only the escalated block is lifted");
  } finally { done(); }
});

test("a success never lifts a block a person owns, but still clears the row", async () => {
  const h = await harness();
  try {
    h.calls.person = true;
    await seed(h.rt, REPO, 1, { releaseReadHeld: { error: "e", firstFailedAt: at(3 * HOUR), escalatedAt: at(HOUR) } });
    const lifted = await noteReleaseRead(h.rt, REPO, CONFIG, [1], null, "", logger);
    assert.deepEqual(lifted, []);
    assert.deepEqual(h.calls.unblocked, []);
    assert.equal((await recordOf(h.rt, REPO, 1)).releaseReadHeld, undefined);
  } finally { done(); }
});

test("a success resolves the issues whose block it lifted", async () => {
  const h = await harness();
  try {
    await seed(h.rt, REPO, 1, { releaseReadHeld: { error: "e", firstFailedAt: at(3 * HOUR), escalatedAt: at(HOUR) } });
    assert.deepEqual(await noteReleaseRead(h.rt, REPO, CONFIG, [1], null, "", logger), [1]);
    assert.ok(h.calls.events.some((e) => e.kind === "unblocked" && e.n === 1));
  } finally { done(); }
});

test("an ownership lookup that fails keeps the marker, so the next healthy scan can still lift the block", async () => {
  const h = await harness();
  try {
    await seed(h.rt, REPO, 1, { releaseReadHeld: { error: "e", firstFailedAt: at(3 * HOUR), escalatedAt: at(HOUR) } });
    h.calls.lookupFails = true;
    assert.deepEqual(await noteReleaseRead(h.rt, REPO, CONFIG, [1], null, "", logger), []);
    assert.ok((await recordOf(h.rt, REPO, 1)).releaseReadHeld, "the marker stays");
    assert.deepEqual(h.calls.unblocked, []);
    h.calls.lookupFails = false;
    assert.deepEqual(await noteReleaseRead(h.rt, REPO, CONFIG, [1], null, "", logger), [1]);
    assert.equal((await recordOf(h.rt, REPO, 1)).releaseReadHeld, undefined);
  } finally { done(); }
});
