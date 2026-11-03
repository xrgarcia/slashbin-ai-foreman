// agent.ts was split into the session runner, the output protocol and the
// workflows beside their phases (EM#1267 f3). These tests hold the split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (rel) => readFileSync(join(src, rel), "utf-8");
const importsOf = (rel) => [...read(rel).matchAll(/^(?:import|\w+ \{[^}]*\}|\w+ type \{[^}]*\})[^;]*?from "([^"]+)"/gm)].map((m) => m[1]);

test("agent.ts is gone, and nothing imports it", () => {
  assert.equal(existsSync(join(src, "agent.ts")), false);
  const files = readdirSync(src, { recursive: true }).map(String).filter((n) => n.endsWith(".ts"));
  assert.ok(files.length > 20, "the source tree was found");
  for (const f of files) assert.ok(!importsOf(f).some((s) => /(^|\/)agent\.js$/.test(s)), `${f} imports agent.js`);
});

test("the output protocol is parsing only: it imports nothing", () => {
  assert.deepEqual(importsOf("session/protocol.ts"), []);
  assert.doesNotMatch(read("session/protocol.ts"), /\b(readFileSync|writeFileSync|spawn|execFile|process\.env)\b/);
});

test("the plugin contract takes its result types from the protocol, not a workflow or the runner", () => {
  const specs = importsOf("plugins/contract.ts");
  assert.ok(specs.includes("../session/protocol.js"));
  assert.ok(!specs.some((s) => /agent\.js$|runner\.js$/.test(s)));
});

test("no session or workflow module passes the size cap", () => {
  for (const rel of ["session/runner.ts", "session/env.ts", "session/secret-gate.ts", "session/protocol.ts",
    "phases/implement-workflow.ts", "phases/revise-workflow.ts", "phases/custom-workflow.ts", "phases/workflow-prompt.ts"]) {
    assert.ok(read(rel).split("\n").length <= 600, `${rel} is over 600 lines`);
  }
});
