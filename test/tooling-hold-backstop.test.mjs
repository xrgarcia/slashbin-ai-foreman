// slashbin-ai-foreman#350: a tooling hold (the verifier or its checker could not run) is deferred and never charged,
// so before this bound it held the repo's next build forever. Now its age is recorded on the issue (`toolingHeld`);
// past `toolingHoldLimitMs` it escalates once (one `blocked` naming the slug, the PR and the age), stops holding the
// repo's other builds and is verified after every other PR, still uncharged, until a verdict deletes the row
// and unblocks it.
//
// Drives the BUILT verify and build phases with a fake verifier, code host and work source over an in-memory
// record store: no network, no external system.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerPlugin, startPlugins, setCodeHost, resetRegistryForTests } from "../dist/plugins/registry.js";
import { registerWorkSource } from "../dist/work-source.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { configSchema } from "../dist/config.js";
import {
  tryVerify, devVerifyHolding, pickVerifyTarget, nextToolingHold,
} from "../dist/phases/verify.js";
import { tryBatchImplementation } from "../dist/phases/implement.js";
import { seed, recordOf } from "./issue-records.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
const LIMIT = 7_200_000;
const HOUR = 3_600_000;
const REPO = {
  name: "r", githubRepo: "o/r", repoPath: "/nonexistent", baseBranch: "develop", productionBranch: "main", featureBranch: "develop",
  lifecycleLabels: { prUnderReview: "pr under review", prPendingActions: "pr pending actions", prMerged: "pr merged", prApproved: "pr approved", readyForProd: "ready for prod release", releasePending: "release pending", prodVerifyHeld: "prod verification held", readyToClose: "ready to close" },
  github: { blockedLabel: "blocked" },
};
const CONFIG = {
  qaRepos: [], stages: [], repos: [REPO], paperclip: { enabled: false }, backoff: DEFAULT_BACKOFF, qaGate: false,
  buildWaitsForDevVerify: true, buildBatchSize: 1, toolingHoldLimitMs: LIMIT,
};
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const DEFER = { kind: "verdict", pass: false, reason: "evidence-check-failed", trailer: { deploy: "SUCCESS" }, summary: "" };
const PASS = { kind: "verdict", pass: true, trailer: { deploy: "SUCCESS" }, summary: "" };
const PICKED = new Error("build picked up");

/**
 * One Foreman over one record store. Issue 1 is merged by PR 11 and awaits dev verification; issue 2 is the next
 * approved issue the work source offers. `merged` adds issues merged since (issue 2 by PR 12).
 */
async function harness() {
  resetRegistryForTests();
  const store = new InMemoryRecordStore();
  const log = []; // every event the work source recorded, in order
  const asked = []; // the PRs the verifier was asked to verify
  const h = { store, log, asked, verdict: DEFER, merged: [{ issueNumber: 1, prNumber: 11 }], rt: new ForemanRuntime() };
  registerWorkSource({
    record: async (e) => { log.push(e.kind === "transition" ? { kind: "transition", move: e.move, n: e.item.issueNumber } : { kind: e.kind, n: e.item?.issueNumber, reason: e.reason }); return true; },
    loadRecord: (k, rc) => store.loadRecord(k, rc),
    saveRecord: (k, r, rc) => store.saveRecord(k, r, rc),
    selectWork: async () => (h.merged.some((m) => m.issueNumber === 2) ? [] : [{ issueNumber: 2 }]),
  });
  registerPlugin({
    id: "fake-sre", roles: ["verifier"], enabled: () => true, fills: (role) => role === "verifier",
    verifier: { verifyDev: async (_r, _c, pr) => { asked.push(pr); return h.verdict; } },
  });
  await startPlugins(CONFIG, { logger, configText: () => null });
  setCodeHost(new Proxy({}, { get: (_, k) => {
    if (k === "then" || typeof k === "symbol") return undefined;
    const merged = () => h.merged.map((m) => m.issueNumber);
    const impl = {
      findIssuesAwaitingVerify: async () => merged(),
      getOpenIssues: async () => [1, 2].map((number) => ({ number, title: `issue ${number}`, labels: merged().includes(number) ? [{ name: "pr merged" }] : [] })),
      findIssuesMergedToBase: async () => h.merged.map((m) => ({ ...m, prUrl: "", mergedAt: "2026-11-18T00:00:00Z" })),
      issueLastEditedAt: async () => null,
      forgetOpenPrs: () => {},
      findOpenFeaturePR: async () => null,
      discoveryBatch: async (_rc, handOff) => handOff.slice(0, 1),
      hasPendingRevisions: async () => false,
      relationsOf: async () => new Map(),
    }[k];
    return impl ?? (async () => { throw new Error(`unexpected code host call: ${String(k)}`); });
  } }));
  return h;
}

/** One verify pass, its in-memory defer window cleared first, as if it had elapsed. */
async function verify(h) {
  h.rt.memory.verifyDefer.clear(REPO.name);
  await tryVerify(h.rt, REPO, CONFIG, logger, 1);
}

/** One build pass: "queued" (issue 2 waited behind a hold), "built" (it was picked up), or "idle". */
async function build(h) {
  const before = h.log.length;
  const events = { push: (e) => { if (/^Picked up/.test(e.message)) throw PICKED; } };
  try {
    await tryBatchImplementation(h.rt, REPO, CONFIG, logger, 1, events);
  } catch (err) {
    if (err === PICKED) return "built";
    throw err;
  }
  return h.log.slice(before).some((e) => e.kind === "transition" && e.move === "queue" && e.n === 2) || h.rt.memory.queuedBehind.get(REPO.name)?.has(2) ? "queued" : "idle";
}

const blocked = (h) => h.log.filter((e) => e.kind === "blocked" && e.n === 1);
const done = () => { resetRegistryForTests(); registerWorkSource(null); setCodeHost(null); };

test("before the bound a second actionable issue is queued behind the held merge", async () => {
  const h = await harness();
  try {
    await verify(h);
    const row = (await recordOf(h.rt, REPO, 1)).toolingHeld;
    assert.equal(row.prNumber, 11);
    assert.equal(row.reason, "evidence-check-failed");
    assert.equal(row.escalatedAt, undefined, "not yet past the bound");
    assert.equal(await build(h), "queued");
    assert.equal(blocked(h).length, 0);
    assert.ok(h.log.some((e) => e.kind === "verifyWaiting" && e.n === 1), "the card waits on the SRE");
  } finally { done(); }
});

test("after the bound the second issue builds", async () => {
  const h = await harness();
  try {
    await seed(h.rt, REPO, 1, { toolingHeld: { reason: "evidence-check-failed", prNumber: 11, firstHeldAt: ago(3 * HOUR) } });
    assert.equal(await build(h), "queued", "a hold past the bound but not yet escalated still holds");
    await verify(h);
    assert.ok((await recordOf(h.rt, REPO, 1)).toolingHeld.escalatedAt, "escalated on the defer past the bound");
    assert.equal(await build(h), "built");

    // The PR that build merges is verified before the escalated one, whose re-ask comes only when nothing else waits.
    h.merged.push({ issueNumber: 2, prNumber: 12 });
    h.asked.length = 0;
    h.verdict = PASS;
    await verify(h);
    assert.deepEqual(h.asked, [12], "the later merge is verified first");
    assert.ok((await recordOf(h.rt, REPO, 1)).toolingHeld.escalatedAt, "a verdict on a later PR leaves the escalated row");
    assert.ok(!h.log.some((e) => e.kind === "unblocked" && e.n === 1), "and does not unblock it");
  } finally { done(); }
});

test("exactly one blocked event naming the slug, the PR and the age", async () => {
  const h = await harness();
  try {
    await seed(h.rt, REPO, 1, { toolingHeld: { reason: "evidence-check-failed", prNumber: 11, firstHeldAt: ago(3 * HOUR) } });
    for (let i = 0; i < 3; i++) await verify(h);
    assert.deepEqual(h.asked, [11, 11, 11], "still re-asked after the escalation");
    const b = blocked(h);
    assert.equal(b.length, 1, "escalates once");
    assert.match(b[0].reason, /evidence-check-failed/);
    assert.match(b[0].reason, /PR #11/);
    assert.match(b[0].reason, /for 3 h/);
    assert.match(b[0].reason, /past the 2 h bound/);
    assert.ok(!h.log.some((e) => e.kind === "verifyWaiting"), "an escalated card is not moved back to waiting");
  } finally { done(); }
});

test("verifyHeld stays absent and attempts stay 0", async () => {
  const h = await harness();
  try {
    await seed(h.rt, REPO, 1, { toolingHeld: { reason: "evidence-check-failed", prNumber: 11, firstHeldAt: ago(3 * HOUR) } });
    for (let i = 0; i < 4; i++) await verify(h);
    const rec = await recordOf(h.rt, REPO, 1);
    assert.equal(rec.verifyHeld, undefined, "no charged hold: attempts stay 0");
    assert.ok(rec.toolingHeld.escalatedAt);
    assert.ok(!h.log.some((e) => e.kind === "transition"), "no lifecycle move: neither failed nor passed");
  } finally { done(); }
});

test("a slug change keeps firstHeldAt", async () => {
  const h = await harness();
  try {
    const first = ago(30 * 60_000);
    await seed(h.rt, REPO, 1, { toolingHeld: { reason: "evidence-check-failed", prNumber: 11, firstHeldAt: first } });
    h.verdict = { ...DEFER, reason: "codex-unavailable" };
    await verify(h);
    const row = (await recordOf(h.rt, REPO, 1)).toolingHeld;
    assert.equal(row.firstHeldAt, first);
    assert.equal(row.reason, "codex-unavailable");
    // A different PR on the issue (a re-merge) starts its own clock.
    const now = Date.now();
    assert.equal(nextToolingHold({ reason: "x", prNumber: 11, firstHeldAt: first }, 13, "x", now, LIMIT).hold.firstHeldAt, new Date(now).toISOString());
  } finally { done(); }
});

test("a restart keeps escalatedAt", async () => {
  const h = await harness();
  try {
    await seed(h.rt, REPO, 1, { toolingHeld: { reason: "evidence-check-failed", prNumber: 11, firstHeldAt: ago(3 * HOUR) } });
    await verify(h);
    const at = (await recordOf(h.rt, REPO, 1)).toolingHeld.escalatedAt;
    assert.ok(at);
    h.rt = new ForemanRuntime(); // the daemon restarts: nothing in memory, the same records
    await verify(h);
    await verify(h);
    assert.equal((await recordOf(h.rt, REPO, 1)).toolingHeld.escalatedAt, at);
    assert.equal(blocked(h).length, 1, "not blocked again after the restart");
    assert.equal(await build(h), "built", "still frees the repo after the restart");
  } finally { done(); }
});

test("a verdict deletes the row and emits unblocked", async () => {
  const h = await harness();
  try {
    await seed(h.rt, REPO, 1, { toolingHeld: { reason: "evidence-check-failed", prNumber: 11, firstHeldAt: ago(3 * HOUR), escalatedAt: ago(HOUR) } });
    h.verdict = PASS;
    await verify(h);
    assert.equal((await recordOf(h.rt, REPO, 1)).toolingHeld, undefined);
    const u = h.log.findIndex((e) => e.kind === "unblocked" && e.n === 1);
    const moved = h.log.findIndex((e) => e.kind === "transition" && e.move === "verifyPassed" && e.n === 1);
    assert.ok(u >= 0, "unblocked");
    assert.match(h.log[u].reason, /dev verification returned a verdict/);
    assert.ok(u < moved, "unblocked before the card moves on, so the Blocked card is released");

    // A wait verdict also ends the hold and unblocks; a charged failure ends it silently; a launch error keeps it.
    const cases = [
      [{ ...DEFER, reason: "wait-until-20991231T0000Z" }, undefined, 1],
      [{ ...DEFER, reason: "dev-verify-failed" }, undefined, 0],
      [{ kind: "error", error: "spawn failed" }, "kept", 0],
    ];
    for (const [verdict, row, unblocks] of cases) {
      const c = await harness();
      try {
        await seed(c.rt, REPO, 1, { toolingHeld: { reason: "evidence-check-failed", prNumber: 11, firstHeldAt: ago(3 * HOUR), escalatedAt: ago(HOUR) } });
        c.verdict = verdict;
        await verify(c);
        const after = (await recordOf(c.rt, REPO, 1)).toolingHeld;
        assert.equal(after === undefined ? undefined : "kept", row, `${verdict.reason ?? verdict.error}: row`);
        assert.equal(c.log.filter((e) => e.kind === "unblocked" && e.n === 1).length, unblocks, `${verdict.reason ?? verdict.error}: unblocked`);
      } finally { done(); }
    }
  } finally { done(); }
});

test("pure: devVerifyHolding skips an escalated hold; pickVerifyTarget orders it last; it escalates once", () => {
  const esc = { reason: "evidence-check-failed", prNumber: 11, firstHeldAt: ago(3 * HOUR), escalatedAt: ago(HOUR) };
  assert.equal(devVerifyHolding([1], {}, 3, {}), 1);
  assert.equal(devVerifyHolding([1], {}, 3, { 1: { ...esc, escalatedAt: undefined } }), 1, "not escalated: still holds");
  assert.equal(devVerifyHolding([1, 2], {}, 3, { 1: esc }), 2);
  const refs = [{ issueNumber: 1, prNumber: 11 }, { issueNumber: 2, prNumber: 12 }];
  assert.equal(pickVerifyTarget(refs, {}, Date.now(), DEFAULT_BACKOFF.verifyRetry, { 1: esc }).prNumber, 12);
  assert.equal(pickVerifyTarget(refs.slice(0, 1), {}, Date.now(), DEFAULT_BACKOFF.verifyRetry, { 1: esc }).prNumber, 11, "alone, it is still re-asked");
  const now = Date.now();
  const first = nextToolingHold(undefined, 11, "evidence-check-failed", now, LIMIT);
  assert.equal(first.escalates, false);
  const past = nextToolingHold({ ...first.hold, firstHeldAt: ago(LIMIT) }, 11, "evidence-check-failed", now, LIMIT);
  assert.equal(past.escalates, true, "at the bound it escalates");
  assert.equal(nextToolingHold(past.hold, 11, "evidence-check-failed", now + HOUR, LIMIT).escalates, false, "once");
});

test("the documented default of toolingHoldLimitMs is the config's default", () => {
  const parsed = configSchema.parse({});
  assert.equal(parsed.toolingHoldLimitMs, 7_200_000);
  const doc = readFileSync(join(root, "docs", "configuration.md"), "utf8");
  const section = doc.slice(doc.indexOf("### `toolingHoldLimitMs`"));
  assert.match(section, new RegExp(`Default: \`${parsed.toolingHoldLimitMs}\``));
  assert.match(section, /Env: `AI_AGENT_TOOLING_HOLD_LIMIT_MS`/);
});
