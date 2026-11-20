// slashbin-ai-foreman#376: a deferred dev verification is a StallClock stall (`verify-deferred`), the only clock; the
// tooling clock (`stalls`) replaced it. A defer opens one stall and keeps its start; a verdict, a charge and a filed
// check-defect resolve it; an escalated stall frees the repo's next build; flag unset writes nothing and never passes.
//
// Drives the BUILT verify and build phases with a fake verifier, code host and work source over an in-memory
// record store: no network, no external system.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerPlugin, startPlugins, setCodeHost, resetRegistryForTests } from "../dist/plugins/registry.js";
import { registerWorkSource, addObserver, drainObservers } from "../dist/work-source.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { configSchema } from "../dist/config.js";
import {
  tryVerify, devVerifyHolding, pickVerifyTarget,
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
  const h = { store, log, asked, raised: [], verdict: DEFER, merged: [{ issueNumber: 1, prNumber: 11 }], rt: new ForemanRuntime() };
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
  h.sessions = []; // the session events observers saw
  addObserver({ id: "session-tap", wantsSessionReports: () => true, async onEvent(e) { if (e.kind === "session") h.sessions.push(e.session); } });
  await startPlugins(CONFIG, { logger, configText: () => null });
  h.rt.handoffs.raise = async (_rc, q) => { h.raised.push(q); return true; };
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
      canonicalRepoOf: async () => "o/r",
      correctivesOf: async () => h.correctives ?? [],
      darkIssues: async () => h.dark ?? new Map(),
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

process.env.FOREMAN_STALL_CLOCK = "1";
delete process.env.FOREMAN_CHECK_DEFECT;

const stallOf = async (h, n = 1, cause = "verify-deferred") => (await recordOf(h.rt, REPO, n)).stalls?.[cause];
const escalated = (extra = {}) => ({ "verify-deferred": {
  id: "o/r#1:verify-deferred", cause: "verify-deferred", affected: ["o/r#1"], resolver: "EM", nextAction: "fix it", resumptionCondition: "it passes",
  state: "escalated", startedAt: ago(3 * HOUR), escalatedAt: ago(HOUR), undeliveredSince: null, resolvedAt: null, lastNotifiedAt: null, evidence: ["check evidence-check-failed"], ...extra } });

test("a defer opens one stall with its owner fields; a repeat, a restart and a relabel keep its start", async () => {
  const h = await harness();
  try {
    await verify(h);
    const first = await stallOf(h);
    assert.equal(first.state, "open");
    assert.equal(first.resolver, "EM");
    assert.deepEqual(first.affected, ["o/r#1"]);
    assert.ok(first.nextAction && first.resumptionCondition);
    assert.equal((await recordOf(h.rt, REPO, 1)).verifyHeld, undefined, "uncharged");
    await verify(h);
    h.rt = new ForemanRuntime(); // restart: nothing in memory, the same records
    await verify(h);
    h.verdict = { ...DEFER, reason: "codex-unavailable" }; // a different slug is the same stall
    await verify(h);
    const later = await stallOf(h);
    assert.equal(later.startedAt, first.startedAt, "the clock is never re-stamped");
    assert.equal(Object.keys((await recordOf(h.rt, REPO, 1)).stalls).length, 1);
    assert.ok(h.log.some((e) => e.kind === "verifyWaiting" && e.n === 1), "the card waits on the SRE");
    assert.ok(!h.log.some((e) => e.kind === "blocked"), "an open stall blocks nothing");
    assert.equal(await build(h), "queued", "an open stall still holds the repo");
  } finally { done(); }
});

test("a pass and a charged verdict each resolve the stall; a launch error leaves it", async () => {
  for (const [verdict, state] of [[PASS, "resolved"], [{ ...DEFER, reason: "dev-verify-failed" }, "resolved"], [{ kind: "error", error: "spawn failed" }, "open"]]) {
    const h = await harness();
    try {
      await verify(h);
      h.verdict = verdict;
      await verify(h);
      assert.equal((await stallOf(h)).state, state, verdict.reason ?? verdict.error ?? "pass");
    } finally { done(); }
  }
});

test("an escalated stall frees the repo, the next issue builds, and re-asks keep the stall", async () => {
  const h = await harness();
  try {
    await seed(h.rt, REPO, 1, { stalls: escalated() });
    assert.equal(await build(h), "built");
    await verify(h);
    await verify(h);
    const s = await stallOf(h);
    assert.equal(s.state, "escalated");
    assert.ok(s.escalatedAt, "kept");
    assert.deepEqual(h.asked, [11, 11], "still re-asked");
    assert.equal(blocked(h).length, 0, "blocking belongs to the stalled raise, never to a verify retry");
    assert.equal((await recordOf(h.rt, REPO, 1)).verifyHeld, undefined, "and uncharged");
    await drainObservers();
    const starts = h.sessions.filter((e) => e.status === "started");
    assert.ok(starts.length >= 2 && starts.every((e) => e.cardHeld?.includes(1)), "a re-ask never places the Blocked card (cardHeld)");
  } finally { done(); }
});

test("a filed check-defect resolves the stall in the same pass", async () => {
  process.env.FOREMAN_CHECK_DEFECT = "1";
  const h = await harness();
  try {
    await h.rt.records.updateRepoRecord(REPO, (d) => { d.checkDefects = { "o/r:evidence-check-failed": {
      checkId: "o/r:evidence-check-failed", canonicalRepo: "o/r", check: "evidence-check-failed", state: "suspected", suspectedAt: ago(HOUR),
      affected: [{ repo: "o/r", issue: 9, pr: 19 }], defect: null, filedAt: null, closedAt: null } }; });
    await verify(h);
    assert.ok(h.raised.some((q) => q.kind === "check-defect"));
    assert.equal((await stallOf(h)).state, "resolved");
  } finally { delete process.env.FOREMAN_CHECK_DEFECT; done(); }
});

test("devVerifyHolding frees an issue on an escalated stall only; pickVerifyTarget orders it last", () => {
  assert.equal(devVerifyHolding([1], {}, 3, {}), 1);
  assert.equal(devVerifyHolding([1], {}, 3, { 1: escalated({ state: "open" }) }), 1, "open: still holds");
  assert.equal(devVerifyHolding([1], {}, 3, { 1: escalated({ state: "resolved" }) }), 1, "resolved: the verification is still owed");
  assert.equal(devVerifyHolding([1, 2], {}, 3, { 1: escalated() }), 2);
  const refs = [{ issueNumber: 1, prNumber: 11 }, { issueNumber: 2, prNumber: 12 }];
  assert.equal(pickVerifyTarget(refs, {}, Date.now(), DEFAULT_BACKOFF.verifyRetry, { 1: escalated() }).prNumber, 12);
  assert.equal(pickVerifyTarget(refs.slice(0, 1), {}, Date.now(), DEFAULT_BACKOFF.verifyRetry, { 1: escalated() }).prNumber, 11, "alone, it is still re-asked");
});

test("flag unset: nothing is written, the defer still defers and never passes", async () => {
  delete process.env.FOREMAN_STALL_CLOCK;
  const h = await harness();
  try {
    await verify(h);
    const rec = await recordOf(h.rt, REPO, 1);
    assert.equal(rec.stalls, undefined);
    assert.equal(rec.verifyHeld, undefined);
    assert.ok(!h.log.some((e) => e.kind === "transition"), "neither failed nor passed");
  } finally { process.env.FOREMAN_STALL_CLOCK = "1"; done(); }
});

test("a stopped corrective chain reports one stall before its raise; a switched-off holder resolves it; an unreadable count reports nothing", async () => {
  const h = await harness();
  try {
    h.correctives = [21, 22, 23];
    await seed(h.rt, REPO, 1, { verifyHeld: { heldAt: ago(HOUR), prNumber: 11, reason: "dev-verify-failed", attempts: 1 } });
    await build(h);
    const s = await stallOf(h, 1, "corrective-chain-stopped");
    assert.equal(s.state, "open");
    assert.deepEqual(s.affected, ["o/r#1"]);
    assert.ok(h.raised.some((q) => q.kind === "corrective-chain"), "the raise is unchanged");
    const start = s.startedAt;
    await build(h);
    assert.equal((await stallOf(h, 1, "corrective-chain-stopped")).startedAt, start);
    h.dark = new Map([[1, "FLAG"]]);
    await build(h);
    assert.equal((await stallOf(h, 1, "corrective-chain-stopped")).state, "resolved");
  } finally { done(); }
  const u = await harness();
  try {
    u.correctives = null;
    await seed(u.rt, REPO, 1, { verifyHeld: { heldAt: ago(HOUR), prNumber: 11, reason: "dev-verify-failed", attempts: 1 } });
    setCodeHost(new Proxy({}, { get: (_, k) => (k === "correctivesOf" ? async () => { throw new Error("unreadable"); } : (k === "then" || typeof k === "symbol" ? undefined : async () => { throw new Error("unexpected"); })) }));
    const { correctiveChainHold } = await import("../dist/phases/corrective-chain.js");
    const v = await correctiveChainHold(u.rt, REPO, 1, { heldAt: ago(HOUR), prNumber: 11, reason: "x", attempts: 1 }, logger);
    assert.equal(v.state, "build");
    assert.equal(await stallOf(u, 1, "corrective-chain-stopped"), undefined);
  } finally { done(); }
});

test("the documented default of toolingHoldLimitMs is the config's default", () => {
  const parsed = configSchema.parse({});
  assert.equal(parsed.toolingHoldLimitMs, 7_200_000);
  const doc = readFileSync(join(root, "docs", "configuration.md"), "utf8");
  const section = doc.slice(doc.indexOf("### `toolingHoldLimitMs`"));
  assert.match(section, new RegExp(`Default: \`${parsed.toolingHoldLimitMs}\``));
  assert.match(section, /Env: `AI_AGENT_TOOLING_HOLD_LIMIT_MS`/);
});

test("a later issue joining an already-filed defect keeps its check identity and frees the repo", async () => {
  process.env.FOREMAN_CHECK_DEFECT = "1";
  const h = await harness();
  try {
    await h.rt.records.updateRepoRecord(REPO, (d) => { d.checkDefects = { "o/r:evidence-check-failed": {
      checkId: "o/r:evidence-check-failed", canonicalRepo: "o/r", check: "evidence-check-failed", state: "filed", suspectedAt: ago(HOUR),
      affected: [{ repo: "o/r", issue: 9, pr: 19 }, { repo: "o/r", issue: 8, pr: 18 }], defect: { number: 500, url: "" }, filedAt: ago(HOUR / 2), closedAt: null } }; });
    for (let i = 0; i < 2; i++) {
      await verify(h);
      const s = await stallOf(h);
      assert.equal(s.state, "resolved", "no unresolved matching stall");
      assert.deepEqual(s.evidence, ["check evidence-check-failed"], "the check identity stays");
    }
    const rec = await recordOf(h.rt, REPO, 1);
    const filedDefects = { "o/r:evidence-check-failed": { checkId: "o/r:evidence-check-failed", canonicalRepo: "o/r", check: "evidence-check-failed", state: "filed", affected: [{ repo: "o/r", issue: 1, pr: 11 }] } };
    assert.equal(devVerifyHolding([1], {}, 3, { 1: rec.stalls }, filedDefects), null, "the filed defect frees it");
  } finally { delete process.env.FOREMAN_CHECK_DEFECT; done(); }
});

test("a chain's stall starts when it stops, not at the older verification hold", async () => {
  const h = await harness();
  try {
    h.correctives = [21, 22, 23];
    await seed(h.rt, REPO, 1, { verifyHeld: { heldAt: ago(3 * HOUR), prNumber: 11, reason: "dev-verify-failed", attempts: 1 } });
    await build(h);
    const s = await stallOf(h, 1, "corrective-chain-stopped");
    assert.ok(Date.now() - Date.parse(s.startedAt) < HOUR, "started now");
  } finally { done(); }
});

test("the sweep's raise is what blocks the card: once at escalation, never from a retry", async () => {
  const { sweep } = await import("../dist/stall-clock.js");
  const h = await harness();
  try {
    await seed(h.rt, REPO, 1, { stalls: escalated({ state: "open", escalatedAt: null, startedAt: ago(3 * HOUR) }) });
    await sweep(h.rt, REPO, new Date().toISOString(), [1], logger);
    assert.equal((await stallOf(h)).state, "escalated");
    assert.equal(blocked(h).length, 1, "one blocked, from the raise");
    assert.ok(h.raised.some((q) => q.kind === "stalled"));
    await verify(h);
    await verify(h);
    await sweep(h.rt, REPO, new Date().toISOString(), [1], logger);
    assert.equal(blocked(h).length, 1, "retries and later sweeps publish none");
  } finally { done(); }
});

test("a verdict on an escalated stall unblocks the card; a launch error does not", async () => {
  for (const [verdict, unblocked] of [[PASS, 1], [{ kind: "error", error: "spawn failed" }, 0]]) {
    const h = await harness();
    try {
      await seed(h.rt, REPO, 1, { stalls: escalated() });
      h.verdict = verdict;
      await verify(h);
      assert.equal(h.log.filter((e) => e.kind === "unblocked" && e.n === 1).length, unblocked);
    } finally { done(); }
  }
});

test("a PR a filed defect released does not keep the front of the queue", () => {
  const released = { 1: { "verify-deferred": { state: "resolved", evidence: ["check evidence-check-failed"] } } };
  const refs = [{ issueNumber: 1, prNumber: 11 }, { issueNumber: 3, prNumber: 13 }];
  assert.equal(pickVerifyTarget(refs, {}, Date.now(), undefined, released).prNumber, 13, "the PR that has not deferred goes first");
  assert.equal(pickVerifyTarget(refs.slice(0, 1), {}, Date.now(), undefined, released).prNumber, 11, "and it is still asked when alone");
});
