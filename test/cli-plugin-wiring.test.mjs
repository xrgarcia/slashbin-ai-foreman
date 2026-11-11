// src/cli.ts reaches plugins only through plugins/index.js and plugins/registry.js (EM#1150).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"), "utf8");
const specs = [...cli.matchAll(/^(?:import|export)[^;]*?from "([^"]+)"/gm)].map((m) => m[1]);

test("cli.ts imports plugins only via plugins/index.js and plugins/registry.js (and the contract types)", () => {
  const plugin = specs.filter((s) => /(^|\/)plugins\//.test(s));
  assert.ok(plugin.includes("./plugins/index.js") && plugin.includes("./plugins/registry.js"), "uses both");
  for (const s of plugin) assert.ok(["./plugins/index.js", "./plugins/registry.js", "./plugins/contract.js"].includes(s), `unexpected plugin import ${s}`);
});

test("cli.ts names no plugin module directly", () => {
  assert.ok(!/plugins\/paperclip/.test(cli), "no reference to plugins/paperclip");
  assert.deepEqual(specs.filter((s) => /^\.\/(paperclip\/|github)/.test(s) && /paperclip/.test(s)), [], "no direct paperclip import");
});
