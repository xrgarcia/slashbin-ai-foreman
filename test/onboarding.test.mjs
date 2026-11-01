// Repo onboarding: before a repo's first lane pass the Foreman creates the
// labels it runs on that the repo is missing, and no lane runs on the repo
// until that has succeeded (xrgarcia/slashbin-ai-foreman#93).
//
// Drives the BUILT onboardRepo and runLanePass with a fake `gh` first on PATH:
// it serves a label list per repo, records every call, and appends POSTed
// names. A repo absent from its state answers 404. Nothing reaches GitHub.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { labelsFor, onboardRepo, resetOnboarding } from "../dist/onboarding.js";
import { requiredLabels } from "../dist/config.js";
import { runLanePass } from "../dist/orchestrator.js";
import { lanesFor } from "../dist/lanes.js";
import { configureIssueCache } from "../dist/github.js";
import { setStatePath } from "../dist/state.js";
import { createLogger } from "../dist/logger.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { githubCodeHost } from "../dist/plugins/github.js";

setCodeHost(githubCodeHost());

const DEFAULTS = ["approved", "pr under review", "pr pending actions", "pr merged", "pr approved", "ready for prod release",
  "release pending", "prod verification held", "ready to close", "blocked"];
const logger = createLogger({ format: "text", level: "error" });

let tmp, F, saved;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-onboarding-test-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  // The fake is CommonJS: pin it, so a stray "type": "module" package.json above the temp dir cannot make it ESM.
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  F = { log: join(tmp, "gh.log"), state: join(tmp, "gh-state.json") };
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(F.log)}, JSON.stringify(a) + "\\n");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(F.state)}, "utf8"));
const repo = (a.find((x) => x.startsWith("repos/")) || "").match(/^repos\\/([^/]+\\/[^/]+)\\/labels$/)?.[1];
if (a[0] !== "api" || !repo) { process.stdout.write("[]"); process.exit(0); }
if (!Array.isArray(st[repo])) { process.stderr.write("HTTP 404: Not Found"); process.exit(1); }
const method = a[a.indexOf("-X") + 1];
if (method === "GET") { process.stdout.write(st[repo].join("\\n") + "\\n"); process.exit(0); }
if (method === "POST") {
  const name = a[a.indexOf("-f") + 1].replace(/^name=/, "");
  if ((st.refuse || []).includes(name)) { process.stderr.write("HTTP 403: Resource not accessible"); process.exit(1); }
  st[repo].push(name);
  fs.writeFileSync(${JSON.stringify(F.state)}, JSON.stringify(st));
  process.stdout.write("{}");
  process.exit(0);
}
process.stderr.write("unexpected method " + method); process.exit(1);
`);
  chmodSync(join(bin, "gh"), 0o755);
  saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
  process.chdir(tmp);
  setStatePath(tmp);
  configureIssueCache({ ttlMs: 0 });
});

after(() => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.FOREMAN_GITHUB_TOKEN === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.FOREMAN_GITHUB_TOKEN;
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => resetOnboarding());

function load(cfg = {}, repo = {}) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ repos: [{ name: "svc", repoPath: tmp, githubRepo: "example/svc", ...repo }], ...cfg }));
  return loadConfig(p);
}
function arrange(state) {
  writeFileSync(F.log, "");
  writeFileSync(F.state, JSON.stringify(state));
}
const calls = () => readFileSync(F.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const labelCalls = () => calls().filter((a) => a[0] === "api" && /\/labels$/.test(a.find((x) => x.startsWith("repos/")) ?? ""));
const methods = () => labelCalls().map((a) => a[a.indexOf("-X") + 1]);
const state = () => JSON.parse(readFileSync(F.state, "utf8"));

test("the label set is the trigger, every lifecycle label and the blocked label", () => {
  assert.deepEqual(labelsFor(load().repos[0]).sort(), [...DEFAULTS].sort());
});

test("a repo missing labels gets exactly the missing ones; the next call makes no gh call", async () => {
  const repo = load().repos[0];
  arrange({ "example/svc": ["approved", "bug", "pr merged"] });
  assert.equal(await onboardRepo(repo, logger), true);
  assert.deepEqual(methods(), ["GET", ...Array(8).fill("POST")]);
  assert.deepEqual(state()["example/svc"].sort(), [...new Set([...DEFAULTS, "bug"])].sort());

  writeFileSync(F.log, "");
  assert.equal(await onboardRepo(repo, logger), true);
  assert.equal(calls().length, 0);
});

test("a repo that already carries every label: one GET, nothing written", async () => {
  arrange({ "example/svc": [...DEFAULTS, "S1"] });
  assert.equal(await onboardRepo(load().repos[0], logger), true);
  assert.deepEqual(methods(), ["GET"]);
});

test("configured label names are the ones installed", async () => {
  const repo = load({ lifecycleLabels: { prUnderReview: "in review" }, github: { blockedLabel: "on hold" } }, { triggerLabel: "go" }).repos[0];
  arrange({ "example/svc": [] });
  assert.equal(await onboardRepo(repo, logger), true);
  const have = state()["example/svc"];
  for (const name of ["go", "in review", "on hold"]) assert.ok(have.includes(name), name);
  for (const name of ["approved", "pr under review", "blocked"]) assert.ok(!have.includes(name), name);
});

test("an unreadable repo: false, nothing written; the very next pass tries again", async () => {
  const repo = load().repos[0];
  arrange({});
  assert.equal(await onboardRepo(repo, logger), false);
  assert.deepEqual(methods(), ["GET"]);

  arrange({ "example/svc": [...DEFAULTS] });
  assert.equal(await onboardRepo(repo, logger), true);
  assert.deepEqual(methods(), ["GET"]);
});

test("a failed create is retried on the next pass, and then the lanes are admitted", async () => {
  const repo = load().repos[0];
  arrange({ "example/svc": [], refuse: ["blocked"] });
  assert.equal(await onboardRepo(repo, logger), false);
  const st = state();
  st.refuse = [];
  writeFileSync(F.state, JSON.stringify(st));
  writeFileSync(F.log, "");
  assert.equal(await onboardRepo(repo, logger), true);
  assert.deepEqual(methods(), ["GET", "POST"]);
});

test("onboarding, labels:install and doctor share one selection rule", () => {
  assert.equal(labelsFor, requiredLabels);
  for (const f of ["scripts/install-labels.mjs", "scripts/doctor.mjs"]) {
    const src = readFileSync(join(saved.cwd, f), "utf8");
    assert.match(src, /requiredLabels\(repo\)/, f);
    assert.doesNotMatch(src, /new Set\(\[repo\.triggerLabel/, f);
  }
});

test("a label that cannot be created: false; the rest are still created", async () => {
  arrange({ "example/svc": [], refuse: ["blocked"] });
  assert.equal(await onboardRepo(load().repos[0], logger), false);
  assert.equal(state()["example/svc"].length, DEFAULTS.length - 1);
});

test("onboarding never edits or deletes a label", async () => {
  arrange({ "example/svc": ["approved"] });
  await onboardRepo(load().repos[0], logger);
  assert.ok(methods().every((m) => m === "GET" || m === "POST"), methods().join(","));
});

test("every lane of a repo shares one onboarding attempt", async () => {
  const repo = load().repos[0];
  arrange({ "example/svc": [] });
  const results = await Promise.all([onboardRepo(repo, logger), onboardRepo(repo, logger), onboardRepo(repo, logger)]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(methods().filter((m) => m === "GET").length, 1);
});

test("a lane pass on a repo that cannot be onboarded runs no stage", async () => {
  const config = load();
  arrange({});
  const r = await runLanePass(config.repos[0], config, lanesFor(config.stages)[0], logger, "never");
  assert.equal(r.processed, 0);
  assert.deepEqual(calls().map((a) => a.slice(0, 2)), [["api", "-X"]], "only the label read ran");
});

test("onboarding: false in the file skips onboarding, missing labels or a refused read alike", async () => {
  const config = load({ onboarding: false });
  assert.equal(config.onboarding, false);
  for (const st of [{ "example/svc": [] }, {}]) {
    arrange(st);
    await runLanePass(config.repos[0], config, lanesFor(config.stages)[0], logger, "never");
    assert.equal(labelCalls().length, 0);
  }
});
