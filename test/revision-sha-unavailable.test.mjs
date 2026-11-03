// EM#1244 f5 review (Foreman PR #197), revise.ts tryRevision: a branch-sha read that fails (network or 5xx,
// before or after the session) fails the pass, and it must not use up a no-commit round. Two GitHub outages
// had saved counts 1 and 2 for sessions that never ran, so the healthy pass read a stalemate and skipped the
// revision for good. These drive the real phase against a fake `gh` and `claude` on PATH.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { tryRevision } from "../dist/phases/revise.js";
import { tryReview } from "../dist/phases/review.js";
import { tryQaBeforeMerge } from "../dist/phases/qa-before-merge.js";
import { configureIssueCache } from "../dist/github.js";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { memoryRecords, prRecordOf } from "./issue-records.mjs";
import { registerPlugin, startPlugins, resetRegistryForTests } from "../dist/plugins/registry.js";
import { GitHubPlugin } from "../dist/plugins/github.js";
import { checkoutPathFor } from "../dist/review-checkout.js";
import { rulingState } from "../dist/github/reports.js";
import { qaFailStandsBody } from "../dist/qa-report.js";
import { REVIEW_ROUNDS_ALERT } from "../dist/phases/common.js";
import { createLogger } from "../dist/logger.js";
import { configureBackoff, DEFAULT_BACKOFF } from "../dist/backoff.js";
import { resetNoCommitStreaksForTests } from "../dist/no-commit-streak.js";

const logger = createLogger({ format: "text", level: "error" });
const REPO = "example/fake";
const PR = 1597;
const ISSUE = 1596;
const SHA = "f15eb0c".padEnd(40, "0");
const NEW_SHA = "b".repeat(40);
const LABELS = { pending: "pr pending actions", review: "pr under review" };
let tmp, F, saved;
let reviewed = 0;

/** What the fake `gh` answers from: the issue's labels, the PR head, the Tech Lead's reviews. */
function world(w) {
  const cur = existsSync(F.world) ? JSON.parse(readFileSync(F.world, "utf8")) : {};
  writeFileSync(F.world, JSON.stringify({ ...cur, ...w }));
}
const labelIssue = (...names) => world({ labels: ["approved", ...names] });
const claudeRuns = () => (existsSync(F.claudeLog) ? readFileSync(F.claudeLog, "utf8").trim().split("\n").length : 0);

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-167-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  F = { world: join(tmp, "world.json"), ghLog: join(tmp, "gh.log"), claudeLog: join(tmp, "claude.log") };
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(F.ghLog)}, args.join(" ") + "\\n");
const w = JSON.parse(fs.readFileSync(${JSON.stringify(F.world)}, "utf8"));
const has = (s) => args.join(" ").includes(s);
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
if (args[0] === "issue" && args[1] === "list") out([{ number: ${ISSUE}, title: "the issue", labels: w.labels.map((name) => ({ name })) }]);
else if (args[0] === "pr" && args[1] === "list") out([{ number: ${PR}, url: "https://github.com/${REPO}/pull/${PR}", title: "Build #${ISSUE}", body: "Closes #${ISSUE}", headRefName: "features", baseRefName: "develop" }]);
else if (args[0] === "pr" && args[1] === "view" && has("headRefOid")) out({ headRefOid: w.head });
else if (args[0] === "pr" && args[1] === "view" && has("--json state")) out({ state: "OPEN" });
else if (args[0] === "pr" && args[1] === "view" && has("reviews")) out({ reviews: w.reviews ?? [], commits: [{ committedDate: "2026-11-01T19:40:00Z" }] });
else if (args[0] === "pr" && args[1] === "view") out("{}");
else if (args[0] === "api" && has("/branches/")) {
  // branchDown: every read fails (a network error). branchOkLeft: that many reads answer, then they fail.
  const left = w.branchOkLeft;
  if (w.branchDown || (left !== undefined && left <= 0)) { process.stderr.write("error connecting to api.github.com\\n"); process.exit(1); }
  if (left !== undefined) { w.branchOkLeft = left - 1; fs.writeFileSync(${JSON.stringify(F.world)}, JSON.stringify(w)); }
  out(w.head);
}
else if (args[0] === "api" && has("--jq")) out("");
else out("[]");
`);
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(F.claudeLog)}, "run\\n");
process.stdout.write("Read QA's report; the branch already does this.\\nFOREMAN_REVISION no-commit reason=the branch is already correct\\n");
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  process.env.TECHLEAD_GITHUB_KEY ||= "test-token-not-real";
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
  process.chdir(tmp);
  setStatePath(tmp);
  configureIssueCache({ ttlMs: 0 });
  configureBackoff({ ...DEFAULT_BACKOFF, gh: { baseMs: 1, capMs: 1, factor: 1, maxAttempts: 2 } });

  resetRegistryForTests();
  registerPlugin(new GitHubPlugin());
  registerPlugin({ id: "fake-reviewer", roles: ["reviewer"], enabled: () => true,
    reviewer: { reviewPr: async () => { reviewed++; return { fallback: true, reason: "test" }; }, approvePromotion: async () => ({ kind: "retry", reason: "test" }) } });
  registerPlugin({ id: "fake-qa", roles: ["qa"], enabled: () => true, qa: { covers: () => true, check: async () => ({ kind: "errored", detail: "unused" }) } });
  await startPlugins(load(), { logger, configText: () => null });
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
  reviewed = 0;
  memoryRecords();
  for (const f of [F.world, F.ghLog, F.claudeLog]) rmSync(f, { force: true });
  world({ labels: ["approved"], head: SHA, reviews: [] });
});

function load(top = {}) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    reviewerLogin: "tl", techLeadPath: tmp, reviewCheckoutRoot: join(tmp, "rc"), ...top,
    repos: [{ name: `r-${Math.random().toString(36).slice(2)}`, repoPath: tmp, githubRepo: REPO }],
  }));
  return loadConfig(p);
}

const pendingPass = async (config, cycle) => tryRevision(config.repos[0], config, logger, cycle, []);

test("R1/R2: two passes whose pre-session sha read fails launch nothing and consume no round; the healthy pass revises", async () => {
  const config = load();
  const repo = config.repos[0];
  labelIssue(LABELS.pending);
  world({ branchDown: true });
  for (const cycle of [1, 2]) await assert.rejects(pendingPass(config, cycle), undefined, `pass ${cycle} fails closed`);
  assert.equal(claudeRuns(), 0, "no session was launched");
  assert.equal((await prRecordOf(repo, PR)).noCommit, undefined, "no no-commit round was saved for a session that never ran");
  assert.ok(String(JSON.parse(readFileSync(F.world, "utf8")).labels).includes(LABELS.pending), "the issue was not advanced");

  world({ branchDown: false });
  assert.ok(await pendingPass(config, 3), "GitHub is back: the unchanged head is still eligible");
  assert.equal(claudeRuns(), 1);
  assert.deepEqual((await prRecordOf(repo, PR)).noCommit, { head: SHA, count: 1 }, "one declared round, counted once");
});

test("R2: after a restart the saved record still lets the healthy pass revise", async () => {
  const config = load();
  const repo = config.repos[0];
  labelIssue(LABELS.pending);
  world({ branchDown: true });
  for (const cycle of [1, 2]) await assert.rejects(pendingPass(config, cycle));
  resetNoCommitStreaksForTests(); // a new process: only the saved record is left
  world({ branchDown: false });
  assert.ok(await pendingPass(config, 3));
  assert.equal(claudeRuns(), 1);
  assert.equal((await prRecordOf(repo, PR)).noCommit.count, 1);
});

test("R3: two passes whose post-session sha read fails neither return the issue to review nor consume a round", async () => {
  const config = load();
  const repo = config.repos[0];
  labelIssue(LABELS.pending);
  for (const cycle of [1, 2]) {
    world({ branchOkLeft: 1, branchDown: false }); // the read before the session answers, the one after fails
    await assert.rejects(pendingPass(config, cycle));
  }
  assert.equal(claudeRuns(), 2, "the sessions ran: the failure is the read after them");
  assert.equal((await prRecordOf(repo, PR)).noCommit, undefined, "the unread result consumed no round");
  assert.ok(String(JSON.parse(readFileSync(F.world, "utf8")).labels).includes(LABELS.pending), "the issue was not returned to review");

  world({ branchOkLeft: undefined, branchDown: false });
  assert.ok(await pendingPass(config, 3), "revision resumes on the unchanged head");
  assert.equal(claudeRuns(), 3);
});
