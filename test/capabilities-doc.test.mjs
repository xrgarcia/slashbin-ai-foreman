// docs/capabilities.md is generated from each plugin's catalog (foreman#285): an AI or
// operator reading the repo learns every role, what it needs, and what happens without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerBuiltinPlugins } from "../dist/plugins/index.js";
import { registeredPlugins } from "../dist/plugins/registry.js";

test("every registered plugin has a complete catalog entry", () => {
  registerBuiltinPlugins({ builds: { isInFlight: () => false } });
  const plugins = registeredPlugins();
  assert.ok(plugins.length >= 7);
  for (const p of plugins) {
    const c = p.catalog;
    assert.ok(c, `${p.id}: no catalog`);
    for (const k of ["name", "purpose", "onWhen", "whenOff"]) assert.ok(c[k]?.trim(), `${p.id}: empty ${k}`);
    assert.ok(Array.isArray(c.requires.config) && Array.isArray(c.requires.env), `${p.id}: requires`);
  }
});

test("docs/capabilities.md matches the catalog", () => {
  const r = spawnSync(process.execPath, ["scripts/capabilities-doc.mjs", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
