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
