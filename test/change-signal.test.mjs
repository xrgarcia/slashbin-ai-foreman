// The change-signal slot: a plugin says which repos changed, and a quiet repo skips its refresh
// and lane work, with a forced full check every forceMs. No plugin: behaviour is unchanged.
// Also the per-lane poll interval and external plugin loading.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChangeGate } from "../dist/change-gate.js";
import { GitHubState } from "../dist/github-state.js";
import { laneIntervalMs, loadConfig } from "../dist/config.js";
import { registerExternalPlugins, moduleSpecifier } from "../dist/plugins/external.js";
import { changeSignal, resetRegistryForTests, startPlugins } from "../dist/plugins/registry.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
const REPOS = ["a/x", "a/y"];
const T0 = Date.parse("2026-11-14T12:00:00Z");
const tmp = mkdtempSync(join(tmpdir(), "change-signal-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function gate(report, extra = {}) {
  let clock = T0;
  const asked = [];
  const signal = report === null ? undefined : { async changedSince(cursor, repos) { asked.push({ cursor, repos: [...repos] }); return report(cursor); } };
  const g = new ChangeGate({ signal: () => signal, repos: () => REPOS, forceMs: () => 300_000, logger, now: () => clock, pollTtlMs: 0, ...extra });
  return { g, asked, tick: (ms) => { clock += ms; } };
}

test("no plugin: every repo is always due and the gate is inactive", async () => {
  const { g } = gate(null);
  assert.equal(g.active(), false);
  assert.equal(await g.due("state", "a/x"), true);
  assert.equal(await g.due("state", "a/x"), true);
});

test("plugin says quiet: a repo already checked is skipped, a changed one is due", async () => {
  let n = 0;
  const { g, asked, tick } = gate(() => ({ changed: ++n === 1 ? "all" : n === 2 ? [] : ["a/y"], cursor: `c${n}` }));
  assert.equal(await g.due("state", "a/x"), true); // first sight
  tick(10_000);
  assert.equal(await g.due("state", "a/x"), false); // quiet
  tick(10_000);
  assert.equal(await g.due("state", "a/x"), false);
  assert.equal(await g.due("state", "a/y"), true); // reported changed
  assert.equal(asked[0].cursor, null);
  assert.equal(asked[1].cursor, "c1");
  assert.deepEqual(asked[1].repos, REPOS);
});

test("a quiet repo is still checked once forceMs has passed (5 minutes)", async () => {
  const { g, tick } = gate((c) => ({ changed: c === null ? "all" : [], cursor: "c" }));
  assert.equal(await g.due("lane:branch-sync", "a/x"), true);
  tick(299_000);
  assert.equal(await g.due("lane:branch-sync", "a/x"), false);
  tick(2_000);
  assert.equal(await g.due("lane:branch-sync", "a/x"), true);
  tick(10_000);
  assert.equal(await g.due("lane:branch-sync", "a/x"), false);
});

test("each consumer keeps its own view: a change one consumed still wakes the other", async () => {
  let n = 0;
  const { g, tick } = gate(() => ({ changed: ++n === 1 ? "all" : n === 2 ? ["a/x"] : [], cursor: `c${n}` }), { pollTtlMs: 500 });
  await g.due("state", "a/x");
  await g.due("lane:dependabot", "a/x");
  tick(1000);
  assert.equal(await g.due("state", "a/x"), true);
  assert.equal(await g.due("lane:dependabot", "a/x"), true);
  assert.equal(await g.due("state", "a/x"), false);
});

test("a failing signal fails open: everything is due", async () => {
  const { g, tick } = gate(() => { throw new Error("db down"); });
  await g.due("state", "a/x");
  tick(1000);
  assert.equal(await g.due("state", "a/x"), true);
});

function stateHarness(gateFn) {
  const queries = [];
  let clock = T0;
  const empty = { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
  const run = async (args) => {
    const q = args.find((a) => a.startsWith("query=")).slice(6);
    queries.push(q);
    return JSON.stringify({ data: { r0: empty, r1: empty } });
  };
  const s = new GitHubState();
  s.configure({ repos: REPOS, refreshMs: 30_000, runAsync: run, logger, now: () => clock, ...(gateFn ? { refreshGate: gateFn } : {}) });
  return { s, queries, tick: (ms) => { clock += ms; } };
}

test("fleet state, no gate: a stale view refreshes every repo as before", async () => {
  const h = stateHarness(null);
  await s_warm(h);
  h.tick(31_000);
  await s_warm(h);
  assert.equal(h.queries.length, 2);
});
async function s_warm(h) { await h.s.warm(); }

test("fleet state, gate says quiet: the time-driven refresh is skipped, a dirty repo still refreshes", async () => {
  const h = stateHarness(async () => []);
  await h.s.warm(); // first sight: no views, so queried
  assert.equal(h.queries.length, 1);
  h.tick(31_000);
  await h.s.warm();
  assert.equal(h.queries.length, 1, "quiet fleet makes no query");
  h.s.markRepoDirty("a/x");
  await h.s.warm();
  assert.equal(h.queries.length, 2, "an own mutation still refreshes");
});

test("fleet state, gate names a repo: only that repo is queried", async () => {
  const h = stateHarness(async (repos) => repos.filter((r) => r === "a/y"));
  await h.s.warm();
  h.tick(31_000);
  await h.s.warm();
  assert.equal(h.queries.length, 2);
  assert.doesNotMatch(h.queries[1], /name: "x"/);
  assert.match(h.queries[1], /name: "y"/);
});

test("per-lane interval: an override wins, other lanes keep pollIntervalMs", () => {
  const cfg = { pollIntervalMs: 30_000, laneIntervalsMs: { "branch-sync": 300_000 } };
  assert.equal(laneIntervalMs(cfg, "branch-sync"), 300_000);
  assert.equal(laneIntervalMs(cfg, "review"), 30_000);
  assert.equal(laneIntervalMs({ pollIntervalMs: 30_000 }, "branch-sync"), 30_000);
});

test("config: the new keys default to nothing set, and parse when given", () => {
  const repo = { name: "app", repoPath: tmp, githubRepo: "acme/app", skillPath: "builtin:", revisionSkillPath: "builtin:" };
  const p0 = join(tmp, "c0.json");
  writeFileSync(p0, JSON.stringify({ repos: [repo] }));
  const c0 = loadConfig(p0);
  assert.deepEqual(c0.laneIntervalsMs, {});
  assert.deepEqual(c0.plugins, []);
  assert.equal(c0.changeSignal.forceCheckMs, 300_000);
  const p1 = join(tmp, "c1.json");
  writeFileSync(p1, JSON.stringify({ repos: [repo], laneIntervalsMs: { unstick: 300000 }, plugins: ["./p.mjs"], changeSignal: { forceCheckMs: 60000 } }));
  const c1 = loadConfig(p1);
  assert.equal(laneIntervalMs(c1, "unstick"), 300_000);
  assert.deepEqual(c1.plugins, ["./p.mjs"]);
  assert.equal(c1.changeSignal.forceCheckMs, 60_000);
});

test("external plugins: a module path is imported and registered; a bad one is skipped", async () => {
  resetRegistryForTests();
  const mod = join(tmp, "ext.mjs");
  writeFileSync(mod, `export default ({ config }) => ({
    id: "ext-signal", roles: ["changeSignal"], enabled: () => true,
    catalog: { id: "ext-signal", name: "Ext", summary: "t", configKeys: [] },
    changeSignal: { async changedSince() { return { changed: [], cursor: "x" }; } },
  });`);
  const warns = [];
  const log = { ...logger, info() {}, warn: (m) => warns.push(m) };
  const ids = await registerExternalPlugins({ plugins: [mod, join(tmp, "missing.mjs")] }, log, tmp);
  assert.deepEqual(ids, ["ext-signal"]);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /not loaded/);
  await startPlugins({ plugins: [mod] , codeHost: undefined }, { logger }).catch(() => {});
  assert.equal(moduleSpecifier("lodash", tmp), "lodash");
  assert.match(moduleSpecifier("./a.mjs", "/x"), /^file:\/\/\/x\/a\.mjs$/);
  resetRegistryForTests();
});
