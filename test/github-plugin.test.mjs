// GitHub is the work-source plugin (EM#1150 f4). The core gets its work source
// only through the registry: a work source registered as a plugin is the one
// selection, implement and review use, with nothing falling back to GitHub
// behind it; with none enabled the Foreman refuses to start; on the live config
// shape (no `workSource` key) the GitHub plugin is on.
//
// The pass-level cases drive the BUILT phases with a fake `gh` and a fake
// `claude` first on PATH. Nothing reaches GitHub or Anthropic, and no token is real.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { runRepoPass } from "../dist/orchestrator.js";
import { tryReview } from "../dist/phases/review.js";
import { configureIssueCache } from "../dist/github.js";
import { GitHubIssueConnector } from "../dist/github-work-source.js";
import { setStatePath } from "../dist/state.js";
import { selectWork, workSourceFor, workSourceRefusal, drainObservers } from "../dist/work-source.js";
import { registerPlugin, startPlugins, activeWorkSource, resetRegistryForTests } from "../dist/plugins/registry.js";
import { registerBuiltinPlugins } from "../dist/plugins/index.js";
import { GitHubPlugin } from "../dist/plugins/github.js";
import { checkoutPathFor } from "../dist/review-checkout.js";
import { createLogger } from "../dist/logger.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logger = createLogger({ format: "text", level: "error" });
const ctx = { logger, configText: () => null };
let tmp, bin, F, saved;

// Every GitHubIssueConnector method call, from any instance (the GitHub plugin's
// included): a fake source in front of it must leave this empty.
const githubCalls = [];
for (const name of Object.getOwnPropertyNames(GitHubIssueConnector.prototype)) {
  const orig = GitHubIssueConnector.prototype[name];
  if (name === "constructor" || typeof orig !== "function") continue;
  GitHubIssueConnector.prototype[name] = function (...args) {
    githubCalls.push(name);
    return orig.apply(this, args);
  };
}

/** A work source registered as a plugin, on when `workSource` is "fake". Records what it is asked. */
function fakeSource() {
  const calls = { selectWork: 0, selectEligible: 0, records: [] };
  const workSource = {
    selectWork: async (rc) => { calls.selectWork++; return [{ issueNumber: 7, repo: rc.githubRepo }]; },
    selectEligible: async (rc) => { calls.selectEligible++; return [{ issueNumber: 7, repo: rc.githubRepo }, { issueNumber: 8, repo: rc.githubRepo }]; },
    record: async (e) => { calls.records.push(e); return true; },
    snapshot: async () => [],
  };
  return { calls, plugin: { id: "fake-source", roles: ["workSource"], enabled: (c) => c.workSource === "fake", workSource } };
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-github-plugin-test-"));
  bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  F = { ghLog: join(tmp, "gh.log"), claudeLog: join(tmp, "claude.log"), prOpen: join(tmp, "pr-open"), issues: join(tmp, "issues.json") };
  // GitHub's own pick would be #1 (approved); the fake source offers #7. The
  // feature PR exists once `prOpen` does (the fake session creates it).
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(F.ghLog)}, args.join(" ") + "\\n");
const pr = { number: 50, url: "https://github.com/example/fake/pull/50", title: "Build #7", body: "Closes #7",
  headRefName: "features", baseRefName: "develop", headRefOid: "abc", updatedAt: "2026-11-01T00:00:00Z", commits: [], files: [{ path: "a.ts" }] };
if (args[0] === "issue" && args[1] === "list") process.stdout.write(fs.existsSync(${JSON.stringify(F.issues)}) ? fs.readFileSync(${JSON.stringify(F.issues)}, "utf8") : "[]");
else if (args[0] === "pr" && args[1] === "list") process.stdout.write(fs.existsSync(${JSON.stringify(F.prOpen)}) ? JSON.stringify([pr]) : "[]");
else if (args[0] === "pr" && args[1] === "view") process.stdout.write("{}");
else process.stdout.write("[]");
`);
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(F.claudeLog)}, JSON.stringify({ prompt: process.argv[3] }) + "\\n");
fs.writeFileSync(${JSON.stringify(F.prOpen)}, "");
process.stdout.write("opened https://github.com/example/fake/pull/50\\n");
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
  process.chdir(tmp);
  setStatePath(tmp);
  configureIssueCache({ ttlMs: 0 });
});

after(() => {
  resetRegistryForTests();
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.FOREMAN_GITHUB_TOKEN === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.FOREMAN_GITHUB_TOKEN;
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  resetRegistryForTests();
  githubCalls.length = 0;
  for (const f of [F.ghLog, F.claudeLog, F.prOpen, F.issues]) rmSync(f, { force: true });
});

function load(top = {}, repo = {}) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    ...top,
    repos: [{ name: `gp-${Math.random().toString(36).slice(2)}`, repoPath: tmp, githubRepo: "example/fake", ...repo }],
  }));
  return loadConfig(p);
}

/** The daemon's startup: every built-in plugin plus `extra`, the enabled ones started. */
async function boot(config, ...extra) {
  registerBuiltinPlugins();
  for (const p of extra) registerPlugin(p);
  await startPlugins(config, ctx);
}

test("a fake work source registered as a plugin is the one selection and implement use; nothing falls back to GitHub", async () => {
  writeFileSync(F.issues, JSON.stringify([{ number: 1, title: "GitHub's pick", labels: [{ name: "approved" }] }]));
  const fake = fakeSource();
  const config = load({ workSource: "fake", stages: [{ type: "implement" }] }, { skillPath: "builtin:" });
  await boot(config, fake.plugin);
  assert.equal(activeWorkSource(), fake.plugin.workSource, "the registry resolves the fake");
  assert.equal(workSourceFor(config.repos[0]), fake.plugin.workSource);

  assert.deepEqual((await selectWork(config.repos[0], config, logger)).map((w) => w.issueNumber), [7], "selection");
  fake.calls.selectWork = 0;

  await runRepoPass(config.repos[0], config, logger);
  await drainObservers();
  const prompt = JSON.parse(readFileSync(F.claudeLog, "utf8").trim().split("\n")[0]).prompt;
  assert.match(prompt, /no others: #7\./, "the session builds the fake source's item, not GitHub's #1");
  assert.equal(fake.calls.selectWork, 1, "implement selected through the fake");
  assert.equal(fake.calls.selectEligible, 1, "implement labels against the fake's eligible set");
  const implemented = fake.calls.records.filter((e) => e.kind === "transition" && e.move === "implemented").map((e) => e.item.issueNumber);
  assert.deepEqual(implemented, [7], "the move is recorded on the fake");
  assert.deepEqual(githubCalls, [], "no GitHubIssueConnector behind the fake");
});

test("review counts the fake work source's queue to keep its checkout; nothing falls back to GitHub", async () => {
  writeFileSync(F.issues, JSON.stringify([{ number: 9, title: "under review", labels: [{ name: "pr under review" }] }]));
  writeFileSync(F.prOpen, "");
  const fake = fakeSource();
  let reviewed = 0;
  const reviewer = {
    id: "fake-reviewer", roles: ["reviewer"], enabled: () => true,
    reviewer: { reviewPr: async () => { reviewed++; return { fallback: true, reason: "test" }; }, approvePromotion: async () => ({ kind: "retry", reason: "test" }) },
  };
  // techLeadPath only satisfies the config check: the real Tech Lead plugin is not registered here.
  const config = load({ workSource: "fake", reviewEnabled: true, techLeadPath: tmp, reviewCheckoutRoot: join(tmp, "rc") });
  // A warm checkout: prepareReviewCheckout fetches it (no remote, so a no-op) and hands it on.
  const co = checkoutPathFor(config, config.repos[0]);
  mkdirSync(co, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: co }).status, 0);
  for (const p of [new GitHubPlugin(), fake.plugin, reviewer]) registerPlugin(p);
  await startPlugins(config, ctx);

  await tryReview(config.repos[0], config, logger, 1);
  assert.equal(reviewed, 1, "the review ran (the checkout bookkeeping follows it)");
  assert.equal(fake.calls.selectEligible, 1, "review asked the fake for the approved queue");
  assert.deepEqual(githubCalls, [], "no GitHubIssueConnector behind the fake");
});

test("the GitHub plugin is the work source on the live config shape (no workSource key); another id turns it off", async () => {
  // The live fleet's top-level keys (24 repos, no `workSource`).
  const live = load({
    triggerLabel: "approved", baseBranch: "develop", featureBranch: "features", pollIntervalMs: 60000, maxTurns: 200,
    maxDurationMs: 3600000, logFormat: "json", logLevel: "info", emRepoPath: tmp, reviewEnabled: true, reviewerLogin: "tl",
    techLeadPath: tmp, srePath: tmp, qaPath: tmp, qaGate: false, qaBeforeMerge: false, sessionEnv: [],
    paperclip: { enabled: false }, skillSync: { enabled: false },
  });
  assert.equal(live.workSource, "github", "the default");
  await boot(live);
  assert.ok(activeWorkSource() instanceof GitHubIssueConnector, "GitHub fills the workSource role");
  assert.equal(workSourceRefusal(live), null);

  resetRegistryForTests();
  const other = load({ workSource: "linear" });
  await boot(other);
  assert.equal(activeWorkSource(), null, "GitHub is off when the config names another source");
  assert.match(workSourceRefusal(other), /no work source is enabled \(workSource: "linear"\)/);
  assert.throws(() => workSourceFor(other.repos[0]), /no work source is enabled/, "never a silent GitHub fallback mid-pass");
});

test("with no work source enabled, startup refuses (exit 78) before any GitHub or Claude call", () => {
  const cfg = join(tmp, "no-source.json");
  writeFileSync(cfg, JSON.stringify({ workSource: "nowhere", repos: [{ name: "r", repoPath: tmp, githubRepo: "example/fake" }] }));
  const env = { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "", FOREMAN_GITHUB_TOKEN: "test-fake", PATH: `${bin}:${saved.PATH}` };
  const run = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "--once", "--config", cfg], { cwd: tmp, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 78, `exit ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout + run.stderr, /Refusing to start: no work source is enabled \(workSource: "nowhere"\)/);
  assert.ok(!existsSync(F.ghLog), `gh was called: ${existsSync(F.ghLog) ? readFileSync(F.ghLog, "utf8") : ""}`);
  assert.ok(!existsSync(F.claudeLog), "claude was launched");
});
