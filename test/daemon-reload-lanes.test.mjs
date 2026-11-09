// A repo added to the config of a RUNNING daemon gets its lane loops on the next supervisor
// cycle, with no restart (slashbin-ai-foreman#215). The case that was reported: a `syncOnly`
// repo added by reload showed no `lane=skill-deliver` line for nine minutes.
//
// Drives the BUILT daemon with a fake `gh` first on PATH (every call answers `[]`), the way
// lanes.test.mjs does; nothing reaches GitHub. A recording logger sees every
// `logger.child({ repo, lane })` the lane loops take at the top of each pass, which is the
// observable "this lane is running for this repo".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { lanesFor } from "../dist/lanes.js";
import { startDaemon } from "../dist/daemon.js";
import { requestShutdown } from "../dist/orchestrator.js";
import { setStateDir } from "../dist/state-dir.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { startGitHubWorkSource } from "./agent-plugins.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp, saved;

before(async () => {
  await startGitHubWorkSource();
  tmp = mkdtempSync(join(tmpdir(), "foreman-reload-lanes-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin, "gh"), '#!/usr/bin/env node\nprocess.stdout.write("[]");\n');
  chmodSync(join(bin, "gh"), 0o755);
  saved = { PATH: process.env.PATH, token: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
  process.chdir(tmp);
  setStateDir(tmp);
});

after(() => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.token === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.token;
  rmSync(tmp, { recursive: true, force: true });
});

/** A logger that records the `{ repo, lane }` of every child a lane loop takes, and every warning. */
function recordingLogger() {
  const seen = new Set();
  const warnings = [];
  const make = (ctx) => ({
    debug() {},
    info() {},
    warn: (msg) => warnings.push(msg),
    error() {},
    child: (c) => {
      const merged = { ...ctx, ...c };
      if (merged.repo && merged.lane) seen.add(`${merged.repo}/${merged.lane}`);
      return make(merged);
    },
  });
  return { logger: make({}), seen, warnings };
}

async function until(cond, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

test("a repo (and a syncOnly repo) added by config reload gets its lane loops without a restart", async () => {
  const cfgPath = join(tmp, "reload.json");
  const base = { name: "alpha", repoPath: tmp, githubRepo: "example/alpha" };
  const write = (repos) => writeFileSync(cfgPath, JSON.stringify({ pollIntervalMs: 150, onboarding: false, repos }));
  write([base]);

  const config = loadConfig(cfgPath);
  const lanes = lanesFor(config.stages).map((l) => l.name);
  assert.ok(lanes.includes("skill-deliver"), "the default stages carry the skill-deliver lane");

  const { logger, seen, warnings } = recordingLogger();
  const handle = startDaemon(new ForemanRuntime(), config, logger, { configPath: cfgPath });
  try {
    await until(() => lanes.every((l) => seen.has(`alpha/${l}`)), "the first repo's lanes to start");
    assert.ok(![...seen].some((k) => k.startsWith("beta/") || k.startsWith("gamma/")), "the repos added later are not running yet");

    // Added while the daemon runs: one ordinary repo and one sync-only (human lane) repo.
    write([
      base,
      { name: "beta", repoPath: tmp, githubRepo: "example/beta" },
      { name: "gamma", repoPath: tmp, githubRepo: "example/gamma", syncOnly: true },
    ]);

    await until(
      () => lanes.every((l) => seen.has(`beta/${l}`) && seen.has(`gamma/${l}`)),
      `every lane of beta and gamma to start (saw ${[...seen].sort().join(", ")}; warnings: ${warnings.join(" | ")})`,
    );
    assert.ok(seen.has("gamma/skill-deliver"), "the sync-only repo's skill-deliver lane runs");
    assert.ok(!warnings.some((w) => /Config reload failed/.test(w)), "the reload did not fail");
  } finally {
    await handle.stop();
  }
});

test("a reload that cannot load is a WARN and the running repos keep their lanes", async () => {
  const cfgPath = join(tmp, "reload-bad.json");
  writeFileSync(cfgPath, JSON.stringify({ pollIntervalMs: 150, onboarding: false, repos: [{ name: "alpha", repoPath: tmp, githubRepo: "example/alpha" }] }));
  const config = loadConfig(cfgPath);
  const { logger, seen, warnings } = recordingLogger();
  const handle = startDaemon(new ForemanRuntime(), config, logger, { configPath: cfgPath });
  try {
    await until(() => seen.size > 0, "the first lanes to start");
    // A repo with no githubRepo and no origin to infer one from: the whole reload fails.
    writeFileSync(cfgPath, JSON.stringify({ pollIntervalMs: 150, onboarding: false, repos: [{ name: "alpha", repoPath: tmp, githubRepo: "example/alpha" }, { name: "delta", repoPath: join(tmp, "not-a-checkout") }] }));
    await until(() => warnings.some((w) => /Config reload failed/.test(w)), "the failed reload to be logged");
    assert.ok(![...seen].some((k) => k.startsWith("delta/")), "the broken entry runs nothing");
  } finally {
    await handle.stop();
    requestShutdown();
  }
});
