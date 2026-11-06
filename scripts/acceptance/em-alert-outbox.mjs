#!/usr/bin/env node
// Acceptance for foreman#232 (A1-A3 and A5; A4 is `npm test` plus dependency-batch-landed.mjs, run beside this one):
// one raise API, one delivery policy owned by the outbox, one kind contract published by the receiver.
//
//   npm run build && node scripts/acceptance/em-alert-outbox.mjs
//
// It drives the Foreman's runtime surface: alerts enter through `rt.handoffs` (settleHandoffs / raiseAll / noteStuck,
// the calls the phases make), and the unstick stage is `tryUnstick`, the entry point the daemon's lane pass calls.
//   - a fixture CodeHost + work source plugin (open issues as state),
//   - a fixture EM at <emRepoPath>/bin/em.mjs that speaks the real contract: `kinds --json` prints its list;
//     `unstick` with a kind outside the list exits 3 with bin/em.mjs's exact message; it fails (exit 1) while "down";
//     it can be told to decline a kind the way the real EM does (exit 3, "out of scope: ...");
//   - a DURABLE record backend (files on disk). A restart builds new runtime objects over the same files.
// Polls after a delivery stay inside the handoff watch window (backoff.handoff, 10 min by default): a later recall of an
// `invoked` handoff is the pre-existing watch, not a re-delivery.
// Time is simulated with node:test's Date mock; nothing sleeps. Exit 0 when every check holds.

import assert from "node:assert/strict";
import { mock } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (p) => import(join(root, "dist", p));
const { loadConfig } = await dist("config.js");
const { setStateDir } = await dist("state-dir.js");
const { registerPlugin, startPlugins, resetRegistryForTests } = await dist("plugins/registry.js");
const { EmPlugin } = await dist("plugins/em.js");
const { ForemanRuntime } = await dist("runtime.js");
const { tryUnstick } = await dist("phases/unstick.js");
const { checkKindContract } = await dist("unstick-contract.js");
const { UNSTICK_KINDS, UNSTICK_MAX_ATTEMPTS, SPENT_QUESTION_REARM_MS, epicChildClosedAlert, dependencyBatchLoopAlert } = await dist("unstick.js");

const logs = [];
const logger = { info() {}, warn: (m) => logs.push(["warn", m]), error: (m) => logs.push(["error", m]), debug() {}, child() { return logger; } };
const MIN = 60_000;
const tmp = mkdtempSync(join(tmpdir(), "em-alert-outbox-acceptance-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
mock.timers.enable({ apis: ["Date"], now: Date.now() });
const advance = (ms) => mock.timers.tick(ms);

let checks = 0;
const ok = (label) => { checks++; console.log(`  ok  ${label}`); };
const scenario = (name) => console.log(`\n${name}`);

// --- the durable record backend: one JSON file per record key ------------------------------------------------
const recordsDir = join(tmp, "records");
mkdirSync(recordsDir);
const fileOf = (key) => join(recordsDir, `${key.kind}-${key.number}.json`);
const workSource = {
  async selectWork() { return []; },
  async selectEligible() { return []; },
  async record() { return false; },
  async snapshot() { return []; },
  async loadRecord(key) { return existsSync(fileOf(key)) ? { status: "found", record: JSON.parse(readFileSync(fileOf(key), "utf8")) } : { status: "absent" }; },
  async saveRecord(key, record) { writeFileSync(fileOf(key), JSON.stringify(record)); return true; },
};
// --- the fixture code host: one open issue (#7), nothing else -------------------------------------------------------
const host = new Proxy({
  getOpenIssues: () => [{ number: 7, title: "stuck one", labels: [], body: "" }],
  hasLabel: () => false,
  formatGhError: (e) => ({ message: String(e), stderr: "", status: 1 }),
}, { get: (t, k) => (k === "then" || typeof k === "symbol" ? undefined : k in t ? t[k] : () => []) });
const FixturePlugin = {
  id: "fixture-host", roles: ["codeHost", "workSource"], enabled: () => true,
  fills: (role, config) => (role === "codeHost" ? config.codeHost === "fixture" : config.workSource === "fixture"),
  codeHost: host, workSource,
};

// --- the fixture EM --------------------------------------------------------------------------------------------------
const em = join(tmp, "em");
mkdirSync(join(em, "bin"), { recursive: true });
const emFiles = { kinds: join(em, "kinds.json"), up: join(em, "up"), decline: join(em, "decline.json"), log: join(em, "calls.log") };
process.env.EM_GITHUB_TOKEN ||= "acceptance-token-not-real";
writeFileSync(join(em, "bin", "em.mjs"), `import { existsSync, readFileSync, appendFileSync } from "node:fs";
const F = ${JSON.stringify(emFiles)};
const [cmd, ...rest] = process.argv.slice(2);
const kinds = JSON.parse(readFileSync(F.kinds, "utf8"));
if (cmd === "kinds") { console.log(JSON.stringify(kinds)); process.exit(0); }
const kind = rest[rest.indexOf("--kind") + 1];
if (!kinds.includes(kind)) { console.error("unknown kind '" + kind + "'; nothing written"); process.exit(3); }
appendFileSync(F.log, kind + "\\n");
if (existsSync(F.decline) && JSON.parse(readFileSync(F.decline, "utf8")).includes(kind)) { console.error("out of scope: not the EM's to rule on"); process.exit(3); }
if (!existsSync(F.up)) { console.error("EM down"); process.exit(1); }
console.log("EM unstick acted: commented");
process.exit(0);
`);
const setKinds = (kinds) => writeFileSync(emFiles.kinds, JSON.stringify(kinds));
const emUp = (up) => (up ? writeFileSync(emFiles.up, "") : rmSync(emFiles.up, { force: true }));
const setDecline = (kinds) => writeFileSync(emFiles.decline, JSON.stringify(kinds));
const sessions = (kind) => (existsSync(emFiles.log) ? readFileSync(emFiles.log, "utf8").split("\n").filter(Boolean) : []).filter((k) => !kind || k === kind).length;
const reset = () => { rmSync(recordsDir, { recursive: true, force: true }); mkdirSync(recordsDir); rmSync(emFiles.log, { force: true }); rmSync(emFiles.decline, { force: true }); setKinds(UNSTICK_KINDS); emUp(false); logs.length = 0; };

// --- config, plugins, runtime ------------------------------------------------------------------------------------------
writeFileSync(join(tmp, "config.json"), JSON.stringify({
  codeHost: "fixture", workSource: "fixture", techLeadPath: "/x", srePath: "/x", qaPath: "/x", emRepoPath: em, paperclip: { enabled: false },
  repos: [{ name: "svc", repoPath: tmp, githubRepo: "o/svc", baseBranch: "features", featureBranch: "feature/ai", productionBranch: "main" }],
}));
setStateDir(join(tmp, "state.json"));
const config = loadConfig(join(tmp, "config.json"));
const repo = config.repos[0];
resetRegistryForTests();
for (const p of [FixturePlugin, new EmPlugin()]) registerPlugin(p);
await startPlugins(config, { logger, configText: () => null });

const boot = () => new ForemanRuntime(); // a Foreman start: new runtime objects, the same durable backend
let cycle = 0;
const pass = (rt) => tryUnstick(rt, repo, config, logger, ++cycle);
const entries = async (rt) => [
  ...Object.values((await rt.records.loadRepoRecord(repo))?.unstick ?? {}),
  ...Object.values((await rt.records.loadIssueRecord(repo, 7))?.unstick ?? {}),
];
const entry = async (rt, kind) => (await entries(rt)).find((e) => e.kind === kind);
const unrelated = { errors: ["stripe: expired dev key"], evidence: [] };
/** One alert of each outbox path: settleHandoffs (SRE reports), raiseAll (epic), raise (batch), noteStuck (an event). */
async function raiseAllKinds(rt) {
  await rt.handoffs.settleHandoffs(repo, "o/svc#5", { seen: unrelated, seenOn: "o/svc PR #5 (dev)" });
  await rt.handoffs.raiseAll(repo, [epicChildClosedAlert("o/svc", 5, 880, "engineering-manager")]);
  await rt.handoffs.raise(repo, dependencyBatchLoopAlert("627@sha627", 3));
  await rt.handoffs.noteStuck(repo, 7, "needs-ruling", "the ruling is needed");
}
const REPO_KINDS = ["unrelated-error", "epic-ready-to-close"];

// === A1 ======================================================================================================================
scenario("A1  unrelated-error and epic-ready-to-close each fail 3 calls, the EM recovers: after the re-arm window each is delivered exactly once, across a restart");
reset();
let rt = boot();
await rt.handoffs.settleHandoffs(repo, "o/svc#5", { seen: unrelated, seenOn: "o/svc PR #5 (dev)" });
await rt.handoffs.raiseAll(repo, [epicChildClosedAlert("o/svc", 5, 880, "engineering-manager")]);
for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) assert.equal(await pass(rt), 2);
for (const k of REPO_KINDS) assert.deepEqual([(await entry(rt, k)).status, (await entry(rt, k)).attempts], ["failed", UNSTICK_MAX_ATTEMPTS]);
ok(`both alerts failed ${UNSTICK_MAX_ATTEMPTS} calls and sit spent at \`failed\` (before: dropped for good)`);
assert.equal(await pass(rt), 0); ok("a pass inside the window makes no call");
emUp(true); // the EM recovers
advance(10 * MIN);
rt = boot(); // restart
assert.equal(await pass(rt), 0); ok("after the restart, still inside the re-arm window: no call");
advance(SPENT_QUESTION_REARM_MS);
assert.equal(await pass(rt), 2); ok("past the window each alert is asked afresh (one pass, two calls)");
for (const k of REPO_KINDS) assert.equal((await entry(rt, k)).status, "invoked");
ok("both hold an accepted EM answer");
for (let i = 0; i < 3; i++) { rt = boot(); advance(MIN); assert.equal(await pass(rt), 0); }
for (const k of REPO_KINDS) assert.equal(sessions(k), UNSTICK_MAX_ATTEMPTS + 1);
ok(`3 more polls, each after a restart: no further call; each kind saw ${UNSTICK_MAX_ATTEMPTS} failed calls and exactly 1 accepted one`);

// === A2 ======================================================================================================================
scenario("A2  a kind the EM does not list: the contract check fails, and at runtime it is `failed` and retried, never `declined`");
reset();
setKinds(UNSTICK_KINDS.filter((k) => k !== "dependency-batch-loop"));
const contract = await checkKindContract(config, logger);
assert.deepEqual(contract, { status: "missing", missing: ["dependency-batch-loop"] }); ok("the startup check names the missing kind");
assert.ok(logs.some(([lvl, m]) => lvl === "error" && /dependency-batch-loop/.test(m))); ok("and logs it at error level (the Foreman's notification channel)");
setKinds(UNSTICK_KINDS);
assert.deepEqual(await checkKindContract(config, logger), { status: "ok" }); ok("the same check passes once the EM lists every kind");
setKinds(UNSTICK_KINDS.filter((k) => k !== "dependency-batch-loop"));
rt = boot();
await rt.handoffs.raise(repo, dependencyBatchLoopAlert("627@sha627", 3));
await rt.handoffs.raiseAll(repo, [epicChildClosedAlert("o/svc", 5, 880, "engineering-manager")]);
emUp(true);
setDecline(["epic-ready-to-close"]); // a REAL decline for the other alert: exit 3 "out of scope"
assert.equal(await pass(rt), 2);
let b = await entry(rt, "dependency-batch-loop"), e = await entry(rt, "epic-ready-to-close");
assert.equal(b.status, "failed"); assert.match(b.detail, /unknown/); ok("the unknown kind is recorded `failed`, with the reason");
assert.equal(e.status, "declined"); ok("a genuine out-of-scope decline (exit 3) is still `declined`");
for (let i = 2; i <= UNSTICK_MAX_ATTEMPTS; i++) assert.equal(await pass(rt), 1);
assert.deepEqual([(await entry(rt, "dependency-batch-loop")).status, (await entry(rt, "dependency-batch-loop")).attempts], ["failed", UNSTICK_MAX_ATTEMPTS]); ok("it was retried up to the cap");
assert.equal(sessions("epic-ready-to-close"), 1); ok("the genuine decline was not retried");
setKinds(UNSTICK_KINDS); // the EM is updated
rt = boot();
advance(SPENT_QUESTION_REARM_MS);
assert.equal(await pass(rt), 1); assert.equal((await entry(rt, "dependency-batch-loop")).status, "invoked"); ok("after the EM learns the kind and the window passes, it is delivered");
advance(24 * 60 * MIN);
assert.equal((await entry(rt, "epic-ready-to-close")).status, "declined"); ok("a declined alert is never re-armed, however long it stands");

// === A3 ======================================================================================================================
scenario("A3  a delivered alert of each kind produces no second EM session across 3 polls and a restart");
reset();
emUp(true);
rt = boot();
await raiseAllKinds(rt);
assert.equal(await pass(rt), 4); ok("four alerts (three repo-level, one issue event) are delivered, one session each");
for (const k of ["unrelated-error", "epic-ready-to-close", "dependency-batch-loop", "needs-ruling"]) assert.equal((await entry(rt, k)).status, "invoked");
const delivered = await entries(rt);
for (let i = 0; i < 3; i++) { advance(MIN); assert.equal(await pass(rt), 0); await raiseAllKinds(rt); }
rt = boot();
advance(MIN);
await raiseAllKinds(rt);
assert.equal(await pass(rt), 0);
assert.deepEqual(await entries(rt), delivered); ok("3 polls (the senders raise again each time), a restart and one more: the entries are untouched");
assert.equal(sessions(), 4); ok("exactly 4 EM sessions in total");

// === A5 ======================================================================================================================
scenario("A5  an alert the EM can never take: 3 calls, then ONE call per back-off window (1h doubling to 24h), one give-up notice, over 72 hours");
reset(); // the EM stays down the whole time
rt = boot();
await rt.handoffs.settleHandoffs(repo, "o/svc#5", { seen: unrelated, seenOn: "o/svc PR #5 (dev)" });
const callHours = [];
for (let t = 0; t <= 72 * 60; t += 5) {
  if (t % 360 === 0) rt = boot(); // a restart every 6 hours
  const made = await pass(rt);
  assert.ok(made <= 1, "never more than one call in a pass for one alert");
  for (let i = 0; i < made; i++) callHours.push(t / 60);
  advance(5 * MIN);
}
const early = callHours.filter((h) => h < 1);
assert.equal(early.length, UNSTICK_MAX_ATTEMPTS); ok(`the first burst is ${UNSTICK_MAX_ATTEMPTS} calls (never a fresh burst after it)`);
const rearmCalls = callHours.slice(UNSTICK_MAX_ATTEMPTS);
const gaps = rearmCalls.map((h, i) => h - (i === 0 ? early[early.length - 1] : rearmCalls[i - 1]));
console.log(`      72 simulated hours: ${callHours.length} EM calls in all, at hours ${callHours.map((h) => h.toFixed(2)).join(", ")}`);
assert.ok(gaps.every((g, i) => g >= Math.min(2 ** i, 24) - 0.01), "each wait is at least double the last, capped at 24h"); ok(`re-arm waits ${gaps.map((g) => g.toFixed(1) + "h").join(", ")}: doubling to the 24h cap`);
assert.ok(callHours.filter((h) => h <= 24).length - UNSTICK_MAX_ATTEMPTS <= Math.ceil(Math.log2(24))); ok("at most ceil(log2 24) re-arm calls in the first 24 hours");
assert.equal(sessions("unrelated-error"), callHours.length); ok("the fixture EM saw exactly those sessions");
assert.equal(logs.filter(([, m]) => /EM unreachable after/.test(m)).length, 1); ok("exactly one give-up notice for it");

console.log(`\nPASS: ${checks} checks`);
mock.timers.reset();
