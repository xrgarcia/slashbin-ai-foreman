// Paperclip truly optional (EM#1150 f2): a disabled block is never validated, and with no
// enabled observer that wants them, a pass makes none of the observer-only GitHub reads and
// publishes no snapshot. A plugin reload starts, stops and reconfigures plugins.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { runRepoPass } from "../dist/orchestrator.js";
import { configureIssueCache } from "../dist/github.js";
import { setStatePath } from "../dist/state.js";
import { wantsSessionReports, wantsSnapshot, drainObservers } from "../dist/work-source.js";
import {
  registerPlugin, startPlugins, reconfigurePlugins, pluginsFor, observers, addObserver, resetRegistryForTests,
} from "../dist/plugins/registry.js";
import { PaperclipPlugin } from "../dist/plugins/paperclip.js";
import { createLogger } from "../dist/logger.js";
import { startGitHubWorkSource } from "./agent-plugins.mjs";

const logger = createLogger({ format: "text", level: "error" });
let tmp, ghLog, saved;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-paperclip-optional-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  ghLog = join(tmp, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(ghLog)}, args.join(" ") + "\\n");
if (args[0] === "issue" && args[1] === "list") process.stdout.write(JSON.stringify([{ number: 1, title: "one", labels: [{ name: "approved" }] }]));
else if (args[0] === "api" && /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+$/.test(args[1])) process.stdout.write("## Acceptance\\n- **Script:** scripts/x/x-acceptance.mjs");
else if (args[0] === "ls-files") process.stdout.write("f0\\nf1");
else process.stdout.write("[]");
`);
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
process.stdout.write("done\\n");
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
  process.chdir(tmp);
  setStatePath(tmp);
  configureIssueCache({ ttlMs: 0 });
});

after(() => {
  resetRegistryForTests();
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.FOREMAN_GITHUB_TOKEN === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.FOREMAN_GITHUB_TOKEN;
  rmSync(tmp, { recursive: true, force: true });
});

function load(top = {}) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    ...top,
    stages: [{ type: "implement" }],
    repos: [{ name: `po-${Math.random().toString(36).slice(2)}`, repoPath: tmp, githubRepo: "example/repo", skillPath: "builtin:" }],
  }));
  return loadConfig(p);
}

// --- the disabled block is never validated ---

test("a disabled paperclip block with missing or invalid fields loads without error", () => {
  const bad = [
    { enabled: false, url: "not a url", board: { approved: { owner: "nobody" } }, roles: "x", repos: ["nope"] },
    { enabled: false, identityKeyFormat: "no placeholders", comments: { maxLength: 1 } },
    { enabled: "off", companyId: "" },
    { enabled: false, board: { approved: { label: "ghost" } } },
    {},
    "garbage",
    null,
  ];
  for (const block of bad) {
    const { paperclip } = load({ paperclip: block });
    assert.equal(paperclip.enabled, false, JSON.stringify(block));
  }
  assert.equal(load({}).paperclip.enabled, false, "no block at all");
});

test("an enabled paperclip block is validated exactly as before", () => {
  assert.throws(() => load({ paperclip: { enabled: true, agentId: "a" } }), /companyId/);
  assert.throws(() => load({ paperclip: { enabled: true, companyId: "c", url: "not a url" } }));
  assert.throws(() => load({ paperclip: { enabled: "maybe" } }));
  assert.throws(() => load({ paperclip: { enabled: true, companyId: "c", board: { approved: { owner: "nobody" } } } }), /owner/);
  const ok = load({ paperclip: { enabled: true, companyId: "c" } }).paperclip;
  assert.equal(ok.enabled, true);
  assert.equal(ok.agentId, undefined, "a missing agentId loads; the plugin stays off with its reason");
});

// --- observer-only reads ---

const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean) : []);

async function passWith(observer) {
  resetRegistryForTests();
  await startGitHubWorkSource();
  const events = [];
  if (observer) addObserver({ ...observer, onEvent: async (e) => { events.push(e); } });
  rmSync(ghLog, { force: true });
  const config = load();
  await runRepoPass(config.repos[0], config, logger);
  await drainObservers();
  return { events, calls: ghCalls() };
}

test("the interests are answered by enabled observers only", () => {
  resetRegistryForTests();
  assert.equal(wantsSessionReports(), false);
  assert.equal(wantsSnapshot(), false);
  addObserver({ onEvent: async () => {} });
  assert.equal(wantsSessionReports(), false, "a local observer that declares nothing wants nothing");
  assert.equal(wantsSnapshot(), false);
  addObserver({ onEvent: async () => {}, wantsCards: () => true });
  assert.equal(wantsSnapshot(), true, "wantsCards implies a snapshot");
  assert.equal(wantsSessionReports(), false);
  addObserver({ onEvent: async () => {}, wantsSessionReports: () => true });
  assert.equal(wantsSessionReports(), true);
  resetRegistryForTests();
});

const closedRead = (calls) => calls.filter((c) => c.startsWith("api graphql"));

test("with no observer wanting them, a pass makes no observer-only GitHub reads and publishes no snapshot", async () => {
  await passWith(null); // warm: the one-time label setup is not under test
  const none = await passWith(null);
  const local = await passWith({}); // the local activity observer: events only, no interests
  assert.deepEqual(local.events.filter((e) => e.kind === "snapshot"), [], "no snapshot published");
  assert.deepEqual(local.calls, none.calls, "an observer that wants nothing costs exactly nothing");
  assert.deepEqual(closedRead(local.calls), [], "no closed-issue read");
  const wanting = await passWith({ wantsSnapshot: () => true });
  assert.ok(wanting.events.some((e) => e.kind === "snapshot"), "a wanting observer is given the snapshot");
  assert.ok(wanting.calls.length > none.calls.length, "the snapshot's reads happen when wanted");
  assert.ok(closedRead(wanting.calls).length > 0, "including the closed-issue read");
});

test("a session's report is read only when an observer wants it", async () => {
  await passWith(null);
  const none = await passWith(null);
  const reports = await passWith({ wantsSessionReports: () => true });
  assert.ok(reports.calls.length > none.calls.length, `report reads happen when wanted (${reports.calls.length} vs ${none.calls.length})`);
  assert.deepEqual(reports.events.filter((e) => e.kind === "snapshot"), [], "reports are not snapshots");
});

// --- reload ---

const ctx = { logger: { info() {}, warn() {}, debug() {}, error() {} }, configText: () => null };
const cfg = (on) => ({ paperclip: { enabled: on } });

function probe(id = "p") {
  const calls = [];
  const observer = { onEvent: async () => {} };
  registerPlugin({
    id, roles: ["observer"], observer,
    enabled: (c) => c.paperclip.enabled,
    start: () => calls.push("start"), reconfigure: () => calls.push("reconfigure"), stop: () => calls.push("stop"),
  });
  return { calls, observer };
}

test("reload: off to on starts the plugin and adds it to the fan-out", async () => {
  resetRegistryForTests();
  const { calls, observer } = probe();
  await startPlugins(cfg(false), ctx);
  assert.deepEqual(observers(), []);
  await reconfigurePlugins(cfg(true), ctx);
  assert.deepEqual(calls, ["start"]);
  assert.deepEqual(observers(), [observer]);
  assert.deepEqual(pluginsFor("observer").map((p) => p.id), ["p"]);
  resetRegistryForTests();
});

test("reload: on to off stops the plugin and removes it from the fan-out", async () => {
  resetRegistryForTests();
  const { calls } = probe();
  const direct = { onEvent: async () => {} };
  addObserver(direct);
  await startPlugins(cfg(true), ctx);
  assert.equal(observers().length, 2);
  await reconfigurePlugins(cfg(false), ctx);
  assert.deepEqual(calls, ["start", "stop"]);
  assert.deepEqual(observers(), [direct], "only the plugin's observer left; the directly added one stays");
  assert.deepEqual(pluginsFor("observer"), []);
  await reconfigurePlugins(cfg(false), ctx);
  assert.deepEqual(calls, ["start", "stop"], "a plugin already off is not stopped again");
  resetRegistryForTests();
});

test("reload: on to on reconfigures and keeps the plugin in the fan-out", async () => {
  resetRegistryForTests();
  const { calls, observer } = probe();
  await startPlugins(cfg(true), ctx);
  await reconfigurePlugins(cfg(true), ctx);
  assert.deepEqual(calls, ["start", "reconfigure"]);
  assert.deepEqual(observers(), [observer]);
  resetRegistryForTests();
});

test("reload: a plugin that fails to start does not stop the others or join the fan-out", async () => {
  resetRegistryForTests();
  registerPlugin({ id: "bad", roles: ["observer"], observer: { onEvent: async () => {} }, enabled: () => true, start: () => { throw new Error("boom"); } });
  const { calls } = probe("good");
  await reconfigurePlugins(cfg(true), ctx);
  assert.deepEqual(calls, ["start"]);
  assert.equal(observers().length, 1);
  resetRegistryForTests();
});

test("Paperclip: a reload that switches it on starts the mirror, one that switches it off stops it", async () => {
  resetRegistryForTests();
  const plugin = new PaperclipPlugin();
  registerPlugin(plugin);
  const on = { ...load({ paperclip: { enabled: true, companyId: "c", agentId: "a" } }) };
  await startPlugins(load(), ctx);
  assert.equal(plugin.observer, undefined);
  assert.deepEqual(observers(), []);
  await reconfigurePlugins(on, ctx);
  assert.ok(plugin.observer, "the mirror exists");
  assert.deepEqual(observers(), [plugin.observer]);
  assert.equal(wantsSnapshot(), true);
  assert.equal(wantsSessionReports(), true);
  await reconfigurePlugins(load(), ctx);
  assert.equal(plugin.observer, undefined);
  assert.deepEqual(observers(), []);
  assert.equal(wantsSnapshot(), false, "off: no snapshot wanted");
  resetRegistryForTests();
});

test("reload: a reconfigure that replaces the plugin's observer swaps it in place; the old one hears nothing more", async () => {
  resetRegistryForTests();
  const first = { onEvent: async () => {} };
  const second = { onEvent: async () => {} };
  const direct = { onEvent: async () => {} };
  const plugin = {
    id: "swap", roles: ["observer"], observer: first,
    enabled: (c) => c.paperclip.enabled,
    reconfigure() { this.observer = second; },
  };
  registerPlugin(plugin);
  await startPlugins(cfg(true), ctx);
  addObserver(direct);
  assert.deepEqual(observers(), [first, direct]);
  await reconfigurePlugins(cfg(true), ctx);
  assert.deepEqual(observers(), [second, direct], "the replacement takes the old slot, delivery order kept");
  await reconfigurePlugins(cfg(false), ctx);
  assert.deepEqual(observers(), [direct], "switching off removes the replacement, not a stale copy");
  resetRegistryForTests();
});

for (const [field, value] of [
  ["url", "http://127.0.0.1:9/new"],
  ["companyId", "c-new"],
  ["agentId", "a-new"],
  ["identityKeyFormat", "replacement: {repo}#{N}"],
]) {
  test(`Paperclip: a reload changing ${field} delivers to the new mirror, which carries the new value`, async () => {
    resetRegistryForTests();
    const plugin = new PaperclipPlugin();
    registerPlugin(plugin);
    const base = { enabled: true, url: "http://127.0.0.1:9/old", companyId: "c", agentId: "a" };
    let text = "v1";
    const live = { ...ctx, configText: () => text };
    await startPlugins(load({ paperclip: base }), live);
    const old = plugin.observer;
    assert.deepEqual(observers(), [old]);
    text = "v2";
    await reconfigurePlugins(load({ paperclip: { ...base, [field]: value } }), live);
    assert.notEqual(plugin.observer, old, "a new mirror took over");
    assert.deepEqual(observers(), [plugin.observer], "events reach the new mirror only");
    assert.equal(plugin.observer.cfg[field], value);
    await reconfigurePlugins(load(), live);
    resetRegistryForTests();
  });
}
