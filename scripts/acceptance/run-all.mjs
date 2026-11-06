#!/usr/bin/env node
// Runs every scripts/acceptance/*.mjs (except this file) as its own `node` child, in name order.
// Stops and exits non-zero on the first failure. `npm run acceptance` builds first; scripts use fakes and
// temp dirs only, and this runner gives them a throwaway FOREMAN_STATE_DIR like `npm test` does.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const self = basename(fileURLToPath(import.meta.url));
const scripts = readdirSync(here).filter((f) => f.endsWith(".mjs") && f !== self).sort();
const env = { ...process.env, FOREMAN_STATE_DIR: process.env.FOREMAN_STATE_DIR || mkdtempSync(join(tmpdir(), "foreman-acceptance-")) };

let passed = 0;
for (const f of scripts) {
  console.log(`\n=== ${f}`);
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: "inherit", env });
  if (r.status !== 0) {
    console.error(`\nFAIL: scripts/acceptance/${f} exited ${r.status ?? r.signal}`);
    process.exit(1);
  }
  passed++;
}
console.log(`\nPASS: ${passed} scripts`);
