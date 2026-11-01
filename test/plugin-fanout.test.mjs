// End to end (EM#1150): an event through the work-source emit path reaches an
// observer registered as a plugin and one added by the legacy addObserver, in
// registration order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPlugin, startPlugins, resetRegistryForTests } from "../dist/plugins/registry.js";
import { addObserver, emit, drainObservers } from "../dist/work-source.js";

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const ctx = { logger, configText: () => null };
const event = { kind: "unblocked", item: { issueNumber: 7, title: "t" } };

test("emit reaches a plugin observer and legacy addObserver observers, in registration order", async () => {
  resetRegistryForTests();
  const order = [];
  addObserver({ onEvent: async (e) => { order.push(["legacy-first", e.kind]); } });
  registerPlugin({ id: "obs", roles: ["observer"], enabled: () => true, observer: { onEvent: async (e) => { order.push(["plugin", e.kind]); } } });
  await startPlugins({}, ctx);
  addObserver({ onEvent: async (e) => { order.push(["legacy-last", e.kind]); } });
  await emit(event, null, logger);
  await drainObservers();
  assert.deepEqual(order, [["legacy-first", "unblocked"], ["plugin", "unblocked"], ["legacy-last", "unblocked"]]);
  resetRegistryForTests();
});

test("emit does not reach a disabled plugin's observer", async () => {
  resetRegistryForTests();
  const heard = [];
  addObserver({ onEvent: () => { heard.push("legacy"); } });
  registerPlugin({ id: "off", roles: ["observer"], enabled: () => false, observer: { onEvent: () => { heard.push("off"); } } });
  await startPlugins({}, ctx);
  await emit(event, null, logger);
  await drainObservers();
  assert.deepEqual(heard, ["legacy"]);
  resetRegistryForTests();
});
