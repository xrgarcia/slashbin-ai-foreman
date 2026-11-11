// foreman#208 (phase 1): every issue is built on its own branch `foreman/<N>-<slug>` cut from baseBranch.
// The Foreman owns a PR iff its head starts with branchPrefix, or equals the LEGACY shared featureBranch
// (so a `features -> develop` PR open at the cutover still drains). A human-named head is never revised,
// reconciled, pushed to or deleted. These tests pin that boundary, with a fake `gh` and a real git origin.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isForemanOwnedHead, isLegacyFeatureHead, slugify, foremanBranchName, branchPrefixOf } from "../dist/foreman-branch.js";
import { loadConfig } from "../dist/config.js";
import { configureIssueCache } from "../dist/github.js";
import { findOpenForemanPrs } from "../dist/github/cache.js";
import { findOpenFeaturePR } from "../dist/github/pr.js";
import { deleteMergedBranch } from "../dist/github/core-reads.js";
import { pruneMergedBranches } from "../dist/reconciler.js";
import { setStateDir } from "../dist/state-dir.js";
import { createLogger } from "../dist/logger.js";
import { startAgentPlugins } from "./agent-plugins.mjs";

await startAgentPlugins();
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logger = createLogger({ format: "text", level: "error" });
const cfg = { branchPrefix: "foreman/", featureBranch: "features", baseBranch: "develop", productionBranch: "main" };

// --- ownership -------------------------------------------------------------------------------

test("a head is Foreman-owned iff it starts with branchPrefix or is the legacy featureBranch", () => {
  assert.equal(isForemanOwnedHead(cfg, "foreman/208-per-issue"), true);
  assert.equal(isForemanOwnedHead(cfg, "features"), true, "the legacy shared head still drains");
  assert.equal(isLegacyFeatureHead(cfg, "features"), true);
  for (const human of ["ray/fix-x", "features-x", "feature/foreman/1", "develop", "main", "dependabot/npm/lodash", "", undefined, null]) {
    assert.equal(isForemanOwnedHead(cfg, human), false, String(human));
  }
});

test("the prefix is configurable and defaults to foreman/", () => {
  assert.equal(branchPrefixOf({}), "foreman/");
  assert.equal(isForemanOwnedHead({ branchPrefix: "bot/", featureBranch: "features" }, "bot/3-x"), true);
  assert.equal(isForemanOwnedHead({ branchPrefix: "bot/", featureBranch: "features" }, "foreman/3-x"), false);
});

test("slugify and foremanBranchName build a git-safe, bounded name", () => {
  assert.equal(slugify("Fix: the Bearer  token (in argv)!"), "fix-the-bearer-token-in-argv");
  assert.equal(slugify("   "), "");
  assert.ok(slugify("x".repeat(100)).length <= 40);
  assert.ok(!slugify("a".repeat(39) + " b").endsWith("-"), "no trailing dash after the cut");
  assert.equal(foremanBranchName(cfg, 208, "Build each issue on its own branch"), "foreman/208-build-each-issue-on-its-own-branch");
  assert.equal(foremanBranchName(cfg, 7, "???"), "foreman/7", "a title with no slug is just the number");
});

test("config: branchPrefix defaults, reads the env, and is per repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-bp-"));
  const write = (top, repo = {}) => {
    const p = join(dir, `c-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify({ ...top, repos: [{ name: "r", repoPath: dir, githubRepo: "o/r", ...repo }] }));
    return p;
  };
  try {
    delete process.env.AI_AGENT_BRANCH_PREFIX;
    assert.equal(loadConfig(write({})).repos[0].branchPrefix, "foreman/");
    assert.equal(loadConfig(write({ branchPrefix: "bot/" })).repos[0].branchPrefix, "bot/");
    assert.equal(loadConfig(write({ branchPrefix: "bot/" }, { branchPrefix: "x/" })).repos[0].branchPrefix, "x/");
    process.env.AI_AGENT_BRANCH_PREFIX = "env/";
    assert.equal(loadConfig(write({})).repos[0].branchPrefix, "env/");
  } finally {
    delete process.env.AI_AGENT_BRANCH_PREFIX;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fake gh + real git ------------------------------------------------------------------------

let tmp, bin, F, saved;
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const calls = () => (existsSync(F.log) ? readFileSync(F.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const deletes = () => calls().filter((a) => a[0] === "api" && a.includes("DELETE"));

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-pib-"));
  bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  F = { log: join(tmp, "gh.log"), state: join(tmp, "gh-state.json") };
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(F.log)}, JSON.stringify(a) + "\\n");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(F.state)}, "utf8"));
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
if (a[0] === "pr" && a[1] === "list") {
  const state = flag("--state"), head = flag("--head");
  if (state === "closed") process.stdout.write(JSON.stringify((st.closed || {})[head] || []));
  else process.stdout.write(JSON.stringify(st.open.filter((p) => !head || p.headRefName === head)));
} else if (a[0] === "pr" && a[1] === "view") {
  process.stdout.write(JSON.stringify(st.open.find((p) => String(p.number) === a[2]) || {}));
} else process.stdout.write("[]");
`);
  chmodSync(join(bin, "gh"), 0o755);
  saved = { PATH: process.env.PATH, tok: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  process.chdir(tmp);
  setStateDir(tmp);
  configureIssueCache({ ttlMs: 0 });
});

after(() => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.tok === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.tok;
  rmSync(tmp, { recursive: true, force: true });
});

const pr = (number, head, base = "develop") => ({
  number, url: `https://github.com/o/r/pull/${number}`, title: `t${number} (#${number})`, body: `Related to #${number}`,
  headRefName: head, baseRefName: base, headRefOid: "a".repeat(40), updatedAt: "2026-11-03T00:00:00Z", commits: [],
});
const arrange = (open, closed = {}) => {
  writeFileSync(F.log, "");
  writeFileSync(F.state, JSON.stringify({ open, closed }));
};
const repo = () => ({ ...cfg, name: "r", githubRepo: "o/r", repoPath: tmp });
beforeEach(() => arrange([]));

// --- finding the Foreman's PRs ------------------------------------------------------------------

test("the Foreman finds per-issue and legacy PRs into the base, never a human's", async () => {
  arrange([pr(1, "ray/fix-x"), pr(2, "foreman/2-thing"), pr(3, "features"), pr(4, "foreman/4-other", "main"), pr(5, "dependabot/npm/x")]);
  assert.deepEqual((await findOpenForemanPrs(repo())).map((p) => p.number), [2, 3]);
});

test("a legacy features -> develop PR is still found (head and issues), so review, revise and verify still see it", async () => {
  arrange([pr(9, "features")]);
  const found = await findOpenFeaturePR(repo());
  assert.equal(found?.number, 9);
  assert.equal(found?.headBranch, "features");
});

test("a per-issue PR is found with its own head branch", async () => {
  arrange([pr(12, "foreman/12-slug")]);
  const found = await findOpenFeaturePR(repo());
  assert.equal(found?.headBranch, "foreman/12-slug");
});

test("a human-named PR alone is no Foreman PR: nothing to review, revise or hold the repo", async () => {
  arrange([pr(1, "ray/fix-x")]);
  assert.equal(await findOpenFeaturePR(repo()), null);
});

// --- revise: only the PR's own Foreman-owned head ------------------------------------------------

test("revise refuses a head the Foreman does not own, and pushes only to the PR's own head", () => {
  const revise = readFileSync(join(root, "src/phases/revise.ts"), "utf8");
  assert.match(revise, /!isForemanOwnedHead\(repoConfig, headBranch\)[\s\S]{0,300}return null;/, "a human head is skipped before any session");
  assert.match(revise, /headBranch = pending\.pr\.headRefName/, "the push target is the PR's own head");
  const wf = readFileSync(join(root, "src/phases/revise-workflow.ts"), "utf8");
  assert.ok((wf.match(/config\.featureBranch/g) ?? []).length <= 1, "revise-workflow uses the shared branch only as the parameter default, never in its checks");
  assert.match(wf, /push only to this branch/);
});

// --- deleting merged branches --------------------------------------------------------------------

test("deleteMergedBranch refuses a human head, the legacy shared head, the base and production: no API call", async () => {
  arrange([]);
  for (const head of ["ray/fix-x", "features", "develop", "main", "feature/foreman/1"]) {
    assert.equal(await deleteMergedBranch(repo(), head), false, head);
  }
  assert.deepEqual(deletes(), []);
});

test("deleteMergedBranch deletes a Foreman per-issue branch (and treats already-gone as done)", async () => {
  arrange([]);
  assert.equal(await deleteMergedBranch(repo(), "foreman/5-x"), true);
  assert.equal(deletes().length, 1);
  assert.ok(deletes()[0].some((x) => x.endsWith("git/refs/heads/foreman/5-x")));
});

// --- pruning merged branches ----------------------------------------------------------------------

/** A bare origin with develop, a clone, and the named branches pushed (each one commit ahead of develop). */
function remote(names) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-pib-git-"));
  const bare = join(dir, "origin.git"), clone = join(dir, "clone");
  git(dir, "init", "--quiet", "--bare", "-b", "develop", bare);
  git(dir, "clone", "--quiet", bare, clone);
  git(clone, "config", "user.email", "t@t"); git(clone, "config", "user.name", "t");
  git(clone, "checkout", "--quiet", "-b", "develop");
  writeFileSync(join(clone, "a"), "0"); git(clone, "add", "."); git(clone, "commit", "--quiet", "-m", "base");
  git(clone, "push", "--quiet", "origin", "develop");
  const shas = {};
  for (const n of names) {
    git(clone, "checkout", "--quiet", "-b", n, "develop");
    writeFileSync(join(clone, "f"), n); git(clone, "add", "."); git(clone, "commit", "--quiet", "-m", `work ${n}`);
    git(clone, "push", "--quiet", "origin", n);
    shas[n] = git(clone, "rev-parse", "HEAD");
  }
  git(clone, "fetch", "--quiet", "origin");
  return { dir, clone, shas };
}

test("pruneMergedBranches deletes only a per-issue branch still at the head a merged PR delivered", async () => {
  const r = remote(["foreman/1-merged", "foreman/2-moved", "foreman/3-open", "foreman/4-rejected", "ray/fix-x", "features"]);
  try {
    const merged = (sha) => [{ number: 1, url: "u", mergedAt: "2026-11-02T00:00:00Z", headRefOid: sha, closedAt: "2026-11-02T00:00:00Z" }];
    arrange([pr(30, "foreman/3-open")], {
      "foreman/1-merged": merged(r.shas["foreman/1-merged"]),
      "foreman/2-moved": merged("b".repeat(40)),
      "foreman/4-rejected": [{ number: 4, url: "u", mergedAt: null, headRefOid: r.shas["foreman/4-rejected"], closedAt: "2026-11-02T00:00:00Z" }],
      "ray/fix-x": merged(r.shas["ray/fix-x"]),
      features: merged(r.shas.features),
    });
    const out = await pruneMergedBranches({ ...repo(), repoPath: r.clone }, logger, ["foreman/1-merged", "foreman/2-moved", "foreman/3-open", "foreman/4-rejected", "ray/fix-x", "features"]);
    assert.deepEqual(out, ["foreman/1-merged"], "delivered and untouched since: deleted; moved on, open, rejected: kept");
    assert.equal(deletes().length, 1);
    assert.ok(deletes()[0].some((x) => x.endsWith("heads/foreman/1-merged")));
    assert.ok(!calls().some((a) => a.some((x) => /ray\/fix-x|heads\/features/.test(String(x))) && a.includes("DELETE")), "a human head and the legacy head are never deleted, even when merged");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("pruneMergedBranches deletes nothing when the PR lookup fails (unknown is not merged)", async () => {
  const r = remote(["foreman/1-merged"]);
  try {
    writeFileSync(F.log, "");
    writeFileSync(F.state, "not json");
    const out = await pruneMergedBranches({ ...repo(), repoPath: r.clone }, logger, ["foreman/1-merged"]);
    assert.deepEqual(out, []);
    assert.deepEqual(deletes(), []);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

// --- the reconciler scans only owned heads ---------------------------------------------------------

test("the reconciler lists remote branches by prefix plus the exact legacy head, through the one ownership test", () => {
  const src = readFileSync(join(root, "src/reconciler.ts"), "utf8");
  assert.match(src, /origin\/\$\{branchPrefixOf\(config\)\}\*/);
  assert.match(src, /isForemanOwnedHead\(config, b\)/);
  assert.doesNotMatch(src, /diverge/i, "no divergence machinery remains");
});

// --- the issue's acceptance: the retired machinery is gone -----------------------------------------

test("the shared-branch machinery is gone: no divergence module, no fast-forward of features", () => {
  for (const f of ["src/divergence.ts", "src/divergence-repair.ts"]) assert.equal(existsSync(join(root, f)), false, f);
  const impl = readFileSync(join(root, "src/phases/implement.ts"), "utf8");
  assert.doesNotMatch(impl, /fastForward|announceDivergence|diverged from origin/);
});
