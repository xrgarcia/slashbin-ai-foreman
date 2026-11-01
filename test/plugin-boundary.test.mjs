// The core calls one plugin interface, never GitHub or Paperclip (EM#1150;
// EM docs/architecture.md decision 4). Every core file that still imports
// plugin code directly is listed below with its exact count of such imports.
// The list is a ratchet: it may only shrink. A new violator, a count that
// grows, or a count that falls without the list being lowered fails the build.
// The epic is done when the list is empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

/** Plugin code: GitHub, Paperclip, and each plugin implementation under src/plugins/. */
const PLUGIN_FILES = [
  /^github\//,
  /^github\.ts$/,
  /^github-work-source\.ts$/,
  /^github-state\.ts$/,
  /^paperclip\//,
  /^plugins\/(?!contract\.ts$|registry\.ts$|index\.ts$)/,
];
const isPlugin = (rel) => PLUGIN_FILES.some((re) => re.test(rel));
/** The composition root names plugins; that is its job. */
const COMPOSITION_ROOT = "plugins/index.ts";

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

/** The plugin files a src-relative file imports (relative specifiers only). */
const pluginImports = (rel) =>
  importsOf(join(src, rel))
    .filter((spec) => spec.startsWith("."))
    .map((spec) => posix.normalize(posix.join(posix.dirname(rel), spec)).replace(/\.js$/, ".ts"))
    .filter(isPlugin);

/** Each core file's count of imports that resolve into plugin code. */
function violations() {
  const out = {};
  const files = readdirSync(src, { recursive: true }).map((n) => String(n).split("\\").join("/")).filter((n) => n.endsWith(".ts"));
  for (const rel of files) {
    if (isPlugin(rel) || rel === COMPOSITION_ROOT) continue;
    const n = pluginImports(rel).length;
    if (n > 0) out[rel] = n;
  }
  return out;
}

if (process.env.PRINT_PLUGIN_VIOLATIONS) console.log(JSON.stringify(violations(), null, 2));

test("core imports no plugin beyond the shrinking allowlist", () => {
  const now = violations();
  const problems = [];
  for (const [file, n] of Object.entries(now)) {
    const allowed = KNOWN_VIOLATORS[file];
    if (allowed === undefined) problems.push(`src/${file} imports plugin code directly (${n}); call it through src/plugins/registry.ts`);
    else if (n > allowed) problems.push(`src/${file} plugin imports grew ${allowed} -> ${n}; call the new ones through the registry`);
  }
  for (const [file, allowed] of Object.entries(KNOWN_VIOLATORS)) {
    const n = now[file] ?? 0;
    if (n < allowed) problems.push(`src/${file} is down to ${n} plugin imports from ${allowed}: lower KNOWN_VIOLATORS to ${n}${n === 0 ? " (delete the line)" : ""}`);
  }
  assert.deepEqual(problems, []);
});

test("the contract and the registry import no plugin", () => {
  for (const f of ["plugins/contract.ts", "plugins/registry.ts"]) {
    assert.deepEqual(pluginImports(f), [], `src/${f} must stay plugin-free`);
  }
});

test("the walk sees the core and the plugin code it judges", () => {
  const files = readdirSync(src, { recursive: true }).map((n) => String(n).split("\\").join("/"));
  assert.ok(files.includes("orchestrator.ts") && files.includes("phases/review.ts"), "core reached");
  assert.ok(files.some((f) => f.startsWith("github/")) && files.includes("plugins/paperclip.ts"), "plugins reached");
});
