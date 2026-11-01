// The plugin registry (EM#1150): enabled plugins start once and fill their roles;
// disabled ones are never started or called; plugin commands resolve without a start.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerPlugin, startPlugins, reconfigurePlugins, pluginsFor, pluginCommand, observers, activeWorkSource,
  setWorkSource, addObserver, resetRegistryForTests,
} from "../dist/plugins/registry.js";
import { registerBuiltinPlugins } from "../dist/plugins/index.js";

const logs = [];
const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug() {}, error() {} };
const ctx = { logger, configText: () => null };

test("only enabled plugins start, in order, and their observers join the fan-out after earlier ones", async () => {
  resetRegistryForTests();
  const calls = [];
  const direct = { onEvent: async () => {} };
  addObserver(direct);
  const obsA = { onEvent: async () => {} };
  registerPlugin({ id: "a", roles: ["observer"], enabled: () => true, start: () => calls.push("start a"), reconfigure: () => calls.push("reconf a"), observer: obsA });
  registerPlugin({ id: "b", roles: ["observer"], enabled: () => false, disabledReason: () => "b is off", start: () => calls.push("start b") });
  await startPlugins({}, ctx);
  assert.deepEqual(calls, ["start a"]);
  assert.deepEqual(observers(), [direct, obsA]);
  assert.deepEqual(pluginsFor("observer").map((p) => p.id), ["a"]);
  assert.ok(logs.includes("b is off"));
  await reconfigurePlugins({}, ctx);
  assert.deepEqual(calls, ["start a", "reconf a"]);
  resetRegistryForTests();
});

test("a registered work source wins over a plugin's; none leaves the caller's default", async () => {
  resetRegistryForTests();
  assert.equal(activeWorkSource(), null);
  const ws = { selectWork: async () => [], record: async () => false };
  registerPlugin({ id: "src", roles: ["workSource"], enabled: () => true, workSource: ws });
  await startPlugins({}, ctx);
  assert.equal(activeWorkSource(), ws);
  const override = { selectWork: async () => [], record: async () => false };
  setWorkSource(override);
  assert.equal(activeWorkSource(), override);
  resetRegistryForTests();
});

test("a duplicate plugin id is refused", () => {
  resetRegistryForTests();
  registerPlugin({ id: "x", roles: [], enabled: () => false });
  assert.throws(() => registerPlugin({ id: "x", roles: [], enabled: () => false }), /registered twice/);
  resetRegistryForTests();
});

test("Paperclip is a built-in plugin: off unless enabled with agent and company ids; its doctor resolves regardless", async () => {
  resetRegistryForTests();
  registerBuiltinPlugins();
  assert.equal(typeof pluginCommand("paperclip:doctor"), "function");
  assert.equal(pluginCommand("nope"), undefined);
  logs.length = 0;
  await startPlugins({ paperclip: { enabled: true } }, ctx);
  assert.deepEqual(pluginsFor("observer"), []);
  assert.deepEqual(observers(), []);
  assert.ok(logs.some((m) => /no agentId configured/.test(m)));
  resetRegistryForTests();
  registerBuiltinPlugins();
  logs.length = 0;
  await startPlugins({ paperclip: { enabled: false } }, ctx);
  assert.deepEqual(observers(), []);
  assert.deepEqual(logs, [], "a disabled Paperclip says nothing");
  resetRegistryForTests();
});

test("reconfigure: started plugins get the fresh config; a throw is logged and later plugins still run", async () => {
  resetRegistryForTests();
  const seen = [];
  const fresh = { fresh: true };
  registerPlugin({ id: "p1", roles: [], enabled: () => true, reconfigure: (c) => { seen.push(["p1", c]); } });
  registerPlugin({ id: "p2", roles: [], enabled: () => true, reconfigure: () => { throw new Error("boom"); } });
  registerPlugin({ id: "p3", roles: [], enabled: () => true, reconfigure: async (c) => { seen.push(["p3", c]); } });
  registerPlugin({ id: "p4", roles: [], enabled: () => true });
  await startPlugins({}, ctx);
  logs.length = 0;
  await reconfigurePlugins(fresh, ctx);
  assert.deepEqual(seen, [["p1", fresh], ["p3", fresh]]);
  assert.ok(logs.some((m) => /plugin p2 reconfigure failed: boom/.test(m)));
  resetRegistryForTests();
});

test("reconfigure: an async rejection is caught and logged too", async () => {
  resetRegistryForTests();
  registerPlugin({ id: "r", roles: [], enabled: () => true, reconfigure: async () => { throw new Error("late"); } });
  await startPlugins({}, ctx);
  logs.length = 0;
  await reconfigurePlugins({}, ctx);
  assert.ok(logs.some((m) => /plugin r reconfigure failed: late/.test(m)));
  resetRegistryForTests();
});

test("reconfigure: a plugin the reload enables starts, one it disables stops and is not reconfigured", async () => {
  resetRegistryForTests();
  const calls = [];
  let on = { late: false, early: true };
  registerPlugin({ id: "early", roles: [], enabled: () => on.early, start: () => calls.push("start early"), stop: () => calls.push("stop early"), reconfigure: () => calls.push("reconf early") });
  registerPlugin({ id: "late", roles: [], enabled: () => on.late, start: () => calls.push("start late"), reconfigure: () => calls.push("reconf late") });
  await startPlugins({}, ctx);
  on = { late: true, early: false }; // the reloaded config flips both
  await reconfigurePlugins({}, ctx);
  assert.deepEqual(calls, ["start early", "stop early", "start late"]);
  resetRegistryForTests();
});
