// The core calls one plugin interface, never GitHub or Paperclip (EM#1150;
// EM docs/architecture.md decision 4). Every core file that still imports
// plugin code directly is listed below with its exact count of such imports.
// The list is a ratchet: it may only shrink. A new violator, a count that
// grows, or a count that falls without the list being lowered fails the build.
// The epic is done when the list is empty. The ratchet logic is the pure
// checkBoundary in plugin-boundary-check.mjs, tested below against fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBoundary, countViolations, isPlugin, pluginImportsOf } from "./plugin-boundary-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

const KNOWN_VIOLATORS = {
  "agent.ts": 2,
  "closed-holds.ts": 1,
  "config.ts": 2,
  "daemon.ts": 2,
  "divergence-repair.ts": 1,
  "index.ts": 2,
  "onboarding.ts": 2,
  "phases/common.ts": 2,
  "phases/custom.ts": 1,
  "phases/implement.ts": 5,
  "phases/promote.ts": 2,
  "phases/qa-before-merge.ts": 1,
  "phases/reconcile.ts": 1,
  "phases/release.ts": 3,
  "phases/review.ts": 3,
  "phases/revise.ts": 1,
  "phases/unstick.ts": 1,
  "phases/verify.ts": 2,
  "qa-report.ts": 2,
  "reconciler.ts": 2,
  "unstick.ts": 1,
  "work-source.ts": 1,
};

const importsOf = (file) => [...readFileSync(file, "utf8").matchAll(/^(?:import|export)[^;]*?from "([^"]+)"/gm)].map((m) => m[1]);
const srcFiles = () => readdirSync(src, { recursive: true }).map((n) => String(n).split("\\").join("/")).filter((n) => n.endsWith(".ts"));
/** Every src file mapped to its import specifiers. */
const realImports = () => Object.fromEntries(srcFiles().map((rel) => [rel, importsOf(join(src, rel))]));

if (process.env.PRINT_PLUGIN_VIOLATIONS) console.log(JSON.stringify(countViolations(realImports()), null, 2));

test("core imports no plugin beyond the shrinking allowlist", () => {
  assert.deepEqual(checkBoundary(realImports(), KNOWN_VIOLATORS), []);
});

test("the contract and the registry import no plugin", () => {
  for (const f of ["plugins/contract.ts", "plugins/registry.ts"]) {
    assert.deepEqual(pluginImportsOf(f, importsOf(join(src, f))), [], `src/${f} must stay plugin-free`);
  }
});

test("the walk sees the core and the plugin code it judges", () => {
  const files = readdirSync(src, { recursive: true }).map((n) => String(n).split("\\").join("/"));
  assert.ok(files.includes("orchestrator.ts") && files.includes("phases/review.ts"), "core reached");
  assert.ok(files.some((f) => f.startsWith("github/")) && files.includes("plugins/paperclip.ts"), "plugins reached");
});

// The ratchet itself, against fixtures: each fails if checkBoundary stops catching it.
test("ratchet: a new unlisted core file importing ./github.js fails", () => {
  const problems = checkBoundary({ "fresh.ts": ["./github.js"] }, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/fresh\.ts imports plugin code directly/);
});

test("ratchet: a listed file whose count grows fails", () => {
  const problems = checkBoundary({ "agent.ts": ["./github.js", "./github-state.js", "./paperclip/client.js"] }, { "agent.ts": 2 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /grew 2 -> 3/);
});

test("ratchet: a listed file whose count drops without the allowlist being lowered fails", () => {
  const problems = checkBoundary({ "agent.ts": ["./github.js"] }, { "agent.ts": 2 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /down to 1 plugin imports from 2/);
  assert.match(checkBoundary({ "agent.ts": ["./logger.js"] }, { "agent.ts": 1 })[0], /delete the line/);
});

test("ratchet: a listed file at exactly its count passes", () => {
  assert.deepEqual(checkBoundary({ "agent.ts": ["./github.js", "./config.js"] }, { "agent.ts": 1 }), []);
});

test("ratchet: core importing plugins/registry.js or plugins/contract.js is allowed", () => {
  assert.deepEqual(checkBoundary({ "orchestrator.ts": ["./plugins/registry.js", "./plugins/contract.js"], "phases/review.ts": ["../plugins/registry.js"] }, {}), []);
});

test("ratchet: core importing plugins/paperclip.js fails; plugins/index.ts may", () => {
  const problems = checkBoundary({ "orchestrator.ts": ["./plugins/paperclip.js"] }, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/orchestrator\.ts imports plugin code directly/);
  assert.deepEqual(checkBoundary({ "plugins/index.ts": ["./paperclip.js"] }, {}), []);
  assert.ok(isPlugin("plugins/paperclip.ts") && !isPlugin("plugins/registry.ts"));
});
