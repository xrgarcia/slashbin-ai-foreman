// The `github` block: every GitHub name the Foreman reads or writes beyond the
// trigger and lifecycle labels. No block runs on exactly the old names; a set key
// reaches the code that reads or writes it.
//
// Drives the BUILT modules; `gh` is a fake on PATH that logs its arguments.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_GITHUB_CONVENTIONS, fillTitle, signed, githubConventionsSchema } from "../dist/github/conventions.js";
import { loadConfig } from "../dist/config.js";
import { issueStage } from "../dist/github-work-source.js";
import { buildDependencyBatchIssue, findDependencyPRs, findOpenDependencyBatchIssue } from "../dist/github/dependencies.js";
import { createPromotionPR } from "../dist/github/promotion.js";
import { createSyncPR } from "../dist/github/branch.js";
import { buildSessionEnv, buildTechLeadEnv, buildSreEnv } from "../dist/agent.js";

const L = {
  prUnderReview: "pr under review", prMerged: "pr merged", prPendingActions: "pr pending actions",
  prApproved: "pr approved", readyForProd: "ready for prod release", readyToClose: "ready to close",
};

function load(extra, repo = {}) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-github-"));
  const p = join(dir, ".ai-agent.json");
  writeFileSync(p, JSON.stringify({ repos: [{ name: "a", repoPath: dir, githubRepo: "example/a", ...repo }], ...extra }));
  try {
    return loadConfig(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("defaults are the names the Foreman always used", () => {
  const d = DEFAULT_GITHUB_CONVENTIONS;
  assert.equal(d.blockedLabel, "blocked");
  assert.deepEqual(d.priorityLabels[0], ["S1"]);
  assert.deepEqual(d.priorityLabels.at(-1), ["chore"]);
  assert.deepEqual(d.dependencyBranchPrefixes, ["dependabot/"]);
  assert.equal(d.dependencyBatchTitlePrefix, "chore(deps): validate and land ");
  assert.equal(fillTitle(d.promotionTitle, { title: "Fix x", N: 5 }), "release: Fix x");
  assert.equal(fillTitle(d.promotionBatchTitle, { n: 3 }), "release: promote 3 changes to production");
  assert.equal(fillTitle(d.syncTitle, { base: "develop", production: "main" }), "chore: sync develop with main (merge commits backfill)");
  assert.equal(fillTitle(d.reconcileTitle, { N: 7 }), "feat: implement #7");
  assert.equal(signed("body", d), "body\n\n---\nAutomated by slashbin-ai-agent");
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.priorityLabels) && Object.isFrozen(d.priorityLabels[0]));
});

test("fillTitle leaves an unknown placeholder as written; an empty signature writes none", () => {
  assert.equal(fillTitle("ship {title} {oops}", { title: "x" }), "ship x {oops}");
  assert.equal(signed("body", { ...DEFAULT_GITHUB_CONVENTIONS, signature: "" }), "body");
});

test("config: no block runs on the defaults, on Config and on every repo", () => {
  const c = load({});
  assert.deepEqual(c.github, DEFAULT_GITHUB_CONVENTIONS);
  assert.deepEqual(c.repos[0].github, DEFAULT_GITHUB_CONVENTIONS);
  assert.ok(Object.isFrozen(c.github));
});

test("config: a partial block overrides only what it names", () => {
  const c = load({ github: { blockedLabel: "on hold", dependencyBranchPrefixes: ["renovate/", "dependabot/"] } });
  assert.equal(c.repos[0].github.blockedLabel, "on hold");
  assert.deepEqual(c.repos[0].github.dependencyBranchPrefixes, ["renovate/", "dependabot/"]);
  assert.equal(c.github.promotionTitle, DEFAULT_GITHUB_CONVENTIONS.promotionTitle);
});

test("config: a blocked label that clashes, or a signature naming an issue, fails at load", () => {
  assert.throws(() => load({ github: { blockedLabel: "pr merged" } }), /blockedLabel/);
  assert.throws(() => load({ github: { blockedLabel: "approved" } }), /blockedLabel/);
  assert.throws(() => load({ github: { blockedLabel: "go" } }, { triggerLabel: "go" }), /blockedLabel/);
  assert.throws(() => load({ github: { signature: "see #5" } }), /#<number>/);
  assert.throws(() => load({ github: { priorityLabels: [] } }));
  assert.equal(githubConventionsSchema.parse({ signature: "  " }).signature, "");
});

test("issueStage: a custom blocked label holds the issue; the default word no longer does", () => {
  assert.equal(issueStage(["pr merged", "on hold"], false, L, "approved", "on hold"), "blocked");
  assert.notEqual(issueStage(["pr merged", "blocked"], false, L, "approved", "on hold"), "blocked");
  assert.equal(issueStage(["pr merged", "blocked"], false, L, "approved"), "blocked", "four args keep the default");
});

test("dependency batch: title prefix and base branch come from the arguments", () => {
  const c = { ...DEFAULT_GITHUB_CONVENTIONS, dependencyBatchTitlePrefix: "deps: land " };
  const { title, body } = buildDependencyBatchIssue("features", [{ number: 1, title: "t", packages: ["x"], from: "1.0.0", to: "1.1.0", major: false }], c, "staging");
  assert.match(title, /^deps: land 1 dependency update on `features`/);
  assert.match(body, /do not reach `staging`/);
  assert.doesNotMatch(buildDependencyBatchIssue("features", []).body, /`staging`/);
});

test("session env: every builder hands over the blocked and priority labels", () => {
  const tiers = [["P0"], ["bug"]];
  const c = load({ github: { blockedLabel: "on hold", priorityLabels: tiers } });
  const r = c.repos[0];
  const session = buildSessionEnv({ sessionEnv: [], triggerLabel: "approved", lifecycleLabels: L, github: r.github });
  for (const env of [session, buildTechLeadEnv(c, r), buildSreEnv(c, r)]) {
    assert.equal(env.FOREMAN_BLOCKED_LABEL, "on hold");
    assert.deepEqual(JSON.parse(env.FOREMAN_PRIORITY_LABELS), tiers);
  }
  const bare = buildSessionEnv({ sessionEnv: [], triggerLabel: "approved", lifecycleLabels: L });
  assert.equal(bare.FOREMAN_BLOCKED_LABEL, "blocked", "no github passed reads the defaults");
});

// --- What reaches gh ---

let tmp, ghLog, ghState, savedPath;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-github-gh-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  ghLog = join(tmp, "gh.log");
  ghState = join(tmp, "gh-state.json");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + "\\n");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, "utf8"));
if (args[0] === "pr" && args[1] === "list") process.stdout.write(JSON.stringify(st.prs));
else if (args[0] === "issue" && args[1] === "list") process.stdout.write(JSON.stringify(st.issues));
else if (args[0] === "pr" && args[1] === "create") process.stdout.write("https://github.com/example/a/pull/9\\n");
else process.stdout.write("[]");
`);
  chmodSync(join(bin, "gh"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
});
after(() => {
  process.env.PATH = savedPath;
  rmSync(tmp, { recursive: true, force: true });
});

function arrange(st) {
  writeFileSync(ghState, JSON.stringify({ prs: [], issues: [], ...st }));
  writeFileSync(ghLog, "");
}
const calls = () => readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const flag = (args, name) => args[args.indexOf(name) + 1];

test("findDependencyPRs selects by the configured branch prefixes", () => {
  const pr = (n, head) => ({ number: n, url: "u", title: "t", body: "", headRefName: head, baseRefName: "features" });
  arrange({ prs: [pr(1, "dependabot/npm/x"), pr(2, "renovate/y"), pr(3, "feature/z")] });
  assert.deepEqual(findDependencyPRs("example/a", tmp, ["features"]).map((p) => p.number), [1]);
  const c = { ...DEFAULT_GITHUB_CONVENTIONS, dependencyBranchPrefixes: ["renovate/"] };
  assert.deepEqual(findDependencyPRs("example/b", tmp, ["features"], undefined, c).map((p) => p.number), [2]);
});

test("findOpenDependencyBatchIssue matches the configured title prefix", () => {
  arrange({ issues: [{ number: 4, title: "deps: land 2 dependency updates", labels: [], body: "" }] });
  const c = { ...DEFAULT_GITHUB_CONVENTIONS, dependencyBatchTitlePrefix: "deps: land " };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  assert.equal(findOpenDependencyBatchIssue("example/c", tmp, logger), undefined);
  assert.equal(findOpenDependencyBatchIssue("example/d", tmp, logger, c)?.number, 4);
});

test("promotion and sync PRs carry the configured titles and signature", () => {
  const c = { ...DEFAULT_GITHUB_CONVENTIONS, promotionTitle: "ship #{N}: {title}", syncTitle: "sync {production} into {base}", signature: "by the bot" };
  arrange({});
  createPromotionPR("example/a", "prod", "dev", [{ number: 12, title: "Fix x" }], tmp, undefined, c);
  createSyncPR("example/a", "prod", "dev", 2, tmp, undefined, c);
  const [promo, sync] = calls().filter((a) => a[0] === "pr" && a[1] === "create");
  assert.equal(flag(promo, "--title"), "ship #12: Fix x");
  assert.match(flag(promo, "--body"), /- #12: Fix x\n\n---\nby the bot$/);
  assert.equal(flag(sync, "--title"), "sync prod into dev");
  assert.match(flag(sync, "--body"), /\n---\nby the bot$/);
});

test("no GitHub name is a literal outside conventions.ts", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const files = readdirSync(src, { recursive: true }).filter((f) => f.endsWith(".ts") && f !== join("github", "conventions.ts"));
  const banned = [/Automated by slashbin-ai-agent/, /`release: /, /`chore: sync /, /`feat: implement /, /"dependabot\/"/, /includes\("blocked"\)/, /hasLabel\([^,]+, "blocked"\)/];
  for (const f of files) {
    const text = readFileSync(join(src, f), "utf8");
    for (const re of banned) assert.doesNotMatch(text, re, `${f} hard-codes ${re}`);
  }
});
