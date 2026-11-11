#!/usr/bin/env node
// Runs every scripts/acceptance/*.mjs (except this file) as its own `node` child, in name order.
// Stops and exits non-zero on the first failure. `npm run acceptance` builds first; scripts use fakes and
// temp dirs only, and this runner gives them a throwaway FOREMAN_STATE_DIR like `npm test` does.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const self = basename(fileURLToPath(import.meta.url));
const scripts = readdirSync(here).filter((f) => f.endsWith(".mjs") && f !== self).sort();
// Children get an allowlisted environment, never the operator's shell: an inherited AI_AGENT_* override (e.g.
// AI_AGENT_EM_REPO_PATH) would replace a fixture collaborator with the live one, and an inherited credential
// (EM_GITHUB_TOKEN, GH_TOKEN, TECHLEAD_GITHUB_KEY, PAPERCLIP_*) would reach it. `gh` gets an empty config dir, so a
// script that falls through to the real binary is unauthenticated instead of acting as the operator.
const ALLOW = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "TZ", "SHELL", "USER", "NODE_OPTIONS"];
const scratch = mkdtempSync(join(tmpdir(), "foreman-acceptance-"));
const env = Object.fromEntries(ALLOW.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
env.FOREMAN_STATE_DIR = join(scratch, "state");
env.GH_CONFIG_DIR = join(scratch, "gh");
mkdirSync(env.FOREMAN_STATE_DIR);
mkdirSync(env.GH_CONFIG_DIR);

process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

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
