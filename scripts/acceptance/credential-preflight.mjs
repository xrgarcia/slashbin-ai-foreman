#!/usr/bin/env node
// Acceptance for foreman#43: the daemon checks its GitHub tokens once, at startup, before any plugin, cycle or PID
// claim, and exits 78 on a missing or rejected one instead of polling with every phase failing.
//
//   npm run build && node scripts/acceptance/credential-preflight.mjs
//
// It drives the CLI (`node dist/cli.js --once --config <fixture>`), never the internal function, and asserts the
// EXIT CODE as well as the text: a message printed by a process that keeps going is the bug, not the fix.
// GitHub is a fake `gh` first on PATH, told by FAKE_GH how to answer `gh api user`; every other gh call fails (not
// transiently), so no real token or network is used, and the dummy tokens below are not secrets. The healthy path is
// proven by the cycle starting: the fake records a gh call other than the probe.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "credential-preflight-acceptance-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// The fake gh: `api user` answers per FAKE_GH; it records every call so a case can prove nothing else ran.
const bin = join(tmp, "bin");
mkdirSync(bin);
const calls = join(tmp, "gh-calls.log");
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  *"api user"*) : ;;
  *)       echo "fixture: no GitHub here" >&2; exit 1 ;;
esac
case "$FAKE_GH" in
  ok)       printf 'HTTP/2.0 200 OK\\n\\n{"login":"fixture"}\\n'; exit 0 ;;
  rejected) printf 'HTTP/2.0 401 Unauthorized\\n\\n{"message":"Bad credentials"}\\n'; echo "gh: Bad credentials (HTTP 401)" >&2; exit 1 ;;
  *)        echo "gh: something unexpected" >&2; exit 1 ;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);

const repo = join(tmp, "repo");
mkdirSync(repo);
const emRepo = join(tmp, "em");
mkdirSync(emRepo);
function config(name, extra) {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify({ repoPath: repo, githubRepo: "fixture/repo", ...extra }));
  return p;
}
const plain = config("plain", {});
const withEm = config("with-em", { emRepoPath: emRepo });

const ALLOW = ["HOME", "TMPDIR", "LANG", "TZ", "FOREMAN_STATE_DIR", "GH_CONFIG_DIR"];
function run(cfg, env) {
  writeFileSync(calls, "");
  const base = Object.fromEntries(ALLOW.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "--once", "--config", cfg], {
    cwd: tmp, encoding: "utf-8", timeout: 60_000,
    env: { ...base, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, secs: (Date.now() - started) / 1000, gh: readCalls() };
}
const readCalls = () => { try { return spawnSync("cat", [calls], { encoding: "utf-8" }).stdout.trim().split("\n").filter(Boolean); } catch { return []; } };

let checks = 0;
const ok = (label) => { checks++; console.log(`  ok  ${label}`); };
const DUMMY = "fixture-token-not-a-secret";
const cycleRan = (r) => r.gh.some((c) => !c.startsWith("api user"));

// 1. No FOREMAN_GITHUB_TOKEN: exit 78 within seconds, naming it; GitHub never asked.
{
  const r = run(plain, { FAKE_GH: "ok" });
  assert.equal(r.code, 78, r.out);
  assert.match(r.out, /Refusing to start: missing required GitHub token: FOREMAN_GITHUB_TOKEN\b/);
  assert.match(r.out, /no fallback to gh's own login/);
  assert.ok(!cycleRan(r), "no cycle");
  assert.ok(r.secs < 15, `took ${r.secs}s`);
  assert.ok(!r.gh.some((c) => c.startsWith("api user")), "GitHub not asked");
  ok("missing FOREMAN_GITHUB_TOKEN: exit 78, named, before anything else");
}

// 2. Unstick runs (emRepoPath set) and EM_GITHUB_TOKEN is missing: same refusal for the EM's token.
{
  const r = run(withEm, { FAKE_GH: "ok", FOREMAN_GITHUB_TOKEN: DUMMY });
  assert.equal(r.code, 78, r.out);
  assert.match(r.out, /missing required GitHub token: EM_GITHUB_TOKEN\b/);
  assert.doesNotMatch(r.out, /FOREMAN_GITHUB_TOKEN/);
  ok("unstick on, missing EM_GITHUB_TOKEN: exit 78, named");
}

// 2b. Unstick off: EM_GITHUB_TOKEN is not required.
{
  const r = run(plain, { FAKE_GH: "ok", FOREMAN_GITHUB_TOKEN: DUMMY });
  assert.notEqual(r.code, 78, r.out);
  assert.doesNotMatch(r.out, /EM_GITHUB_TOKEN/);
  assert.ok(cycleRan(r), "the cycle started");
  ok("unstick off: EM_GITHUB_TOKEN not required");
}

// 3. Token present but rejected (401): exit 78 before the first cycle, saying it was rejected.
{
  const r = run(withEm, { FAKE_GH: "rejected", FOREMAN_GITHUB_TOKEN: DUMMY, EM_GITHUB_TOKEN: DUMMY });
  assert.equal(r.code, 78, r.out);
  assert.match(r.out, /GitHub rejected FOREMAN_GITHUB_TOKEN, EM_GITHUB_TOKEN \(HTTP 401/);
  assert.ok(!cycleRan(r), "no cycle");
  assert.ok(r.gh.every((c) => c.startsWith("api user")), `only the probe ran: ${r.gh.join(" | ")}`);
  ok("rejected token: exit 78, 'GitHub rejected', only `gh api user` ran");
}

// 4. Healthy: both tokens accepted, startup proceeds past the gate to the next check.
{
  const r = run(withEm, { FAKE_GH: "ok", FOREMAN_GITHUB_TOKEN: DUMMY, EM_GITHUB_TOKEN: DUMMY });
  assert.doesNotMatch(r.out, /GitHub token|GitHub rejected|Could not reach GitHub/);
  assert.notEqual(r.code, 78, r.out);
  assert.match(r.out, /slashbin-ai-agent v/);
  assert.ok(cycleRan(r), "the cycle started");
  ok("healthy tokens: the gate passes and startup continues");
}

// 5. GitHub answers neither yes nor 401: a warning, and startup continues (a blip is not a credential fault).
{
  const r = run(plain, { FAKE_GH: "broken", FOREMAN_GITHUB_TOKEN: DUMMY });
  assert.match(r.out, /Could not reach GitHub to check FOREMAN_GITHUB_TOKEN; starting anyway/);
  assert.ok(cycleRan(r), "the cycle started");
  ok("unverifiable token: warn and continue");
}

// No case printed a token value.
for (const cfg of [plain, withEm]) assert.doesNotMatch(run(cfg, { FAKE_GH: "rejected", FOREMAN_GITHUB_TOKEN: DUMMY, EM_GITHUB_TOKEN: DUMMY }).out, new RegExp(DUMMY));
ok("no token value in any output");

console.log(`\nPASS: ${checks} checks`);
