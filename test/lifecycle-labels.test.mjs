// Lifecycle labels come from config, and the configured names are the ones the
// daemon writes and the sessions it spawns are told about.
//
// Before this, the five names were string literals across src/ and only the
// trigger label was configurable — and even that one was not passed to the
// skill, so renaming it made the daemon select work the agent then never found.
// Defaults are Slashbin's names, so a config without `lifecycleLabels` runs
// exactly as before; every case here that renames proves the defaults are not
// still hiding somewhere.
//
// A fake `gh` and a fake `claude` (node scripts, first on PATH) record what they
// were asked — no real GitHub or Claude call, no token.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, defaultLifecycleLabels } from "../dist/config.js";
import {
  configureIssueCache,
  GitHubIssueConnector,
} from "../dist/github.js";
import { reviewOpenPRs } from "../dist/agent.js";
import { createLogger } from "../dist/logger.js";

const CUSTOM = {
  prUnderReview: "in-review",
  prPendingActions: "changes-requested",
  prApproved: "dev-verified",
  readyForProd: "ship-it",
  readyToClose: "shipped",
};

const tmp = mkdtempSync(join(tmpdir(), "foreman-lifecycle-labels-test-"));
const binDir = join(tmp, "bin");
mkdirSync(binDir);
const GH_LOG = join(tmp, "gh.log");
const GH_ISSUES = join(tmp, "issues.json");
const CLAUDE_ENV = join(tmp, "claude-env.json");

writeFileSync(join(binDir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + "\\n");
if (args[0] === "issue" && args[1] === "list") { process.stdout.write(fs.readFileSync(${JSON.stringify(GH_ISSUES)}, "utf8")); process.exit(0); }
process.stdout.write("[]");
`);
writeFileSync(join(binDir, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(CLAUDE_ENV)}, JSON.stringify({
  FOREMAN_TRIGGER_LABEL: process.env.FOREMAN_TRIGGER_LABEL ?? null,
  FOREMAN_LIFECYCLE_LABELS: process.env.FOREMAN_LIFECYCLE_LABELS ?? null,
}));
process.stdout.write(JSON.stringify({ type: "result", result: "FOREMAN_REVIEW none" }) + "\\n");
`);
chmodSync(join(binDir, "gh"), 0o755);
chmodSync(join(binDir, "claude"), 0o755);

const saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN, EM_GITHUB_TOKEN: process.env.EM_GITHUB_TOKEN };
process.env.PATH = `${binDir}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
process.env.EM_GITHUB_TOKEN = "test-fake";
configureIssueCache({ ttlMs: 0 });

test.after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const logger = createLogger({ format: "text", level: "error" });

function load(extra = {}) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    emRepoPath: tmp,
    repos: [{ name: "acceptance", repoPath: tmp, githubRepo: "example/acceptance" }],
    ...extra,
  }));
  return loadConfig(p);
}

function ghCalls() {
  return readFileSync(GH_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function resetGh(issues = []) {
  writeFileSync(GH_LOG, "");
  writeFileSync(GH_ISSUES, JSON.stringify(issues));
}
const issue = (number, ...labels) => ({ number, title: `#${number}`, labels: labels.map((name) => ({ name })) });

// --- Config ------------------------------------------------------------------

test("omitted: every label resolves to the name Slashbin runs on today", () => {
  const c = load();
  assert.deepEqual({ ...c.lifecycleLabels }, {
    prUnderReview: "pr under review",
    prPendingActions: "pr pending actions",
    prApproved: "pr approved",
    readyForProd: "ready for prod release",
    readyToClose: "ready to close",
  });
  assert.deepEqual({ ...c.lifecycleLabels }, { ...defaultLifecycleLabels() });
});

test("partial: a configured key wins, the rest keep their defaults", () => {
  const c = load({ lifecycleLabels: { prUnderReview: "in-review" } });
  assert.equal(c.lifecycleLabels.prUnderReview, "in-review");
  assert.equal(c.lifecycleLabels.readyForProd, "ready for prod release");
});

test("global: every repo carries the one configured set — there is no per-repo override", () => {
  const c = load({
    lifecycleLabels: CUSTOM,
    repos: [
      { name: "a", repoPath: tmp, githubRepo: "example/a" },
      { name: "b", repoPath: tmp, githubRepo: "example/b", lifecycleLabels: { prUnderReview: "ignored" } },
    ],
  });
  for (const r of c.repos) assert.deepEqual({ ...r.lifecycleLabels }, CUSTOM, r.name);
});

test("two lifecycle states sharing a name is refused at load", () => {
  assert.throws(
    () => load({ lifecycleLabels: { prApproved: "pr under review" } }),
    /five distinct names/,
  );
});

test("a trigger label that is also a lifecycle label is refused at load", () => {
  // It would be selected and excluded by the same filter: nothing would ever build.
  assert.throws(
    () => load({ triggerLabel: "go", lifecycleLabels: { prUnderReview: "go" } }),
    /also a lifecycle label/,
  );
});

// --- The daemon writes and reads the configured names --------------------------

test("actionable set excludes the CONFIGURED lifecycle labels, not the defaults", async () => {
  const c = load({ lifecycleLabels: CUSTOM });
  resetGh([
    issue(1, "approved", "in-review"),
    issue(2, "approved", "pr under review"),   // the default name is just a label here
    issue(3, "approved"),
    issue(4, "approved", "shipped"),
  ]);
  const items = await new GitHubIssueConnector().selectEligible(c.repos[0], logger);
  assert.deepEqual(items.map((w) => w.issueNumber), [2, 3]);
});

test("implementation applies the configured under-review label", async () => {
  const c = load({ lifecycleLabels: CUSTOM });
  resetGh();
  const item = { issueNumber: 7, repo: "example/acceptance" };
  assert.equal(await new GitHubIssueConnector().reportState(item, "new", "inReview", c.repos[0], logger), true);
  const [call] = ghCalls();
  assert.deepEqual(call, ["issue", "edit", "7", "--repo", "example/acceptance", "--add-label", "in-review"]);
});

test("dead-zone recovery writes configured names and never the production gate", async () => {
  // Separation of duties survives the rename: the most a recovery may do is the
  // state a healthy review would have left — never `readyForProd`.
  const c = load({ lifecycleLabels: CUSTOM });
  for (const [verdict, added] of [["pass", "dev-verified"], ["fail", "changes-requested"]]) {
    resetGh([issue(9, "approved", "in-review")]);
    const to = verdict === "pass" ? "approved" : "changesRequested";
    assert.equal(await new GitHubIssueConnector().reportState(
      { issueNumber: 9, repo: "example/acceptance" }, "unknown", to, c.repos[0], logger), true, verdict);
    const edit = ghCalls().find((a) => a[0] === "issue" && a[1] === "edit");
    assert.deepEqual(edit, ["issue", "edit", "9", "--repo", "example/acceptance",
      "--remove-label", "in-review", "--add-label", added], verdict);
    assert.equal(edit.includes("ship-it"), false, `${verdict} must not touch the gate`);
  }
});

// --- The spawned session is told the names ----------------------------------------

test("every claude session receives FOREMAN_TRIGGER_LABEL and FOREMAN_LIFECYCLE_LABELS", async () => {
  // reviewSkillPath has no default since EM#425; the review session needs one.
  const c = load({ triggerLabel: "build-me", reviewSkillPath: "review/SKILL.md", lifecycleLabels: { prUnderReview: "in-review" } });
  const result = await reviewOpenPRs(c.repos[0], c, logger);
  assert.equal(result.success, true, result.error);
  const env = JSON.parse(readFileSync(CLAUDE_ENV, "utf8"));
  assert.equal(env.FOREMAN_TRIGGER_LABEL, "build-me");
  assert.deepEqual(JSON.parse(env.FOREMAN_LIFECYCLE_LABELS), { ...c.lifecycleLabels });
  assert.equal(JSON.parse(env.FOREMAN_LIFECYCLE_LABELS).prUnderReview, "in-review");
});
