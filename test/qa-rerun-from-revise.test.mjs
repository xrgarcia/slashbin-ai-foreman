// slashbin-io-docs#645: a QA FAIL that was QA's own defect left the card at `pr pending actions`, owned by revise, and
// the EM's `**EM QA re-run` comment was read only on the review/QA path, so nothing ever re-ran QA. Revise now sends the
// card back to review (no session) when the re-run is newer than every QA report for the head. Real phase, fake `gh`/`claude`.
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
import { memoryRecords, prRecordOf, breakRecords } from "./issue-records.mjs";
import { activeWorkSource } from "../dist/plugins/registry.js";
import { registerPlugin, startPlugins, resetRegistryForTests } from "../dist/plugins/registry.js";
import { GitHubPlugin } from "../dist/plugins/github.js";
import { checkoutPathFor } from "../dist/review-checkout.js";
import { rulingState } from "../dist/github/reports.js";
import { qaFailStandsBody } from "../dist/qa-report.js";
import { REVIEW_ROUNDS_ALERT } from "../dist/phases/common.js";
import { createLogger } from "../dist/logger.js";
import { configureBackoff, DEFAULT_BACKOFF } from "../dist/backoff.js";
import { ForemanRuntime } from "../dist/runtime.js";
const withoutAt = (s) => { if (!s) return s; const { at, ...rest } = s; return rest; };
let rt = new ForemanRuntime();

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
  tmp = mkdtempSync(join(tmpdir(), "foreman-qarerun-"));
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
else if (args[0] === "api" && args[1] === "user") out("foreman-bot\\n");
else if (args[0] === "api" && has("/comments")) out((w.comments ?? []).map((c) => JSON.stringify(c)).join("\\n"));
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
  rt = new ForemanRuntime();
  memoryRecords();
  for (const f of [F.world, F.ghLog, F.claudeLog]) rmSync(f, { force: true });
  world({ labels: ["approved"], head: SHA, reviews: [] });
});

function load(top = {}) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    reviewerLogin: "tl", qaBeforeMerge: true, techLeadPath: tmp, reviewCheckoutRoot: join(tmp, "rc"), ...top,
    repos: [{ name: `r-${Math.random().toString(36).slice(2)}`, repoPath: tmp, githubRepo: REPO }],
  }));
  return loadConfig(p);
}

const pendingPass = async (config, cycle) => tryRevision(rt, config.repos[0], config, logger, cycle, []);

const at = (m) => `2026-11-09T16:${String(m).padStart(2, "0")}:00Z`;
const marker = (v) => `<!-- foreman-qa sha=${SHA} verdict=${v} -->`;
const report = (m, v = "FAIL") => ({ at: at(m), author: "foreman-bot", body: `## QA Report\n\n**Verdict: ${v}**\n${marker(v)}` });
const rerun = (m) => ({ at: at(m), body: "**EM QA re-run** — the FAIL was QA's own defect" });
// The fake gh does not apply label edits, so the move is read from the edit it was asked to make.
const edits = () => (existsSync(F.ghLog) ? readFileSync(F.ghLog, "utf8") : "").split("\n").filter((l) => l.startsWith("issue edit"));
const movedToReview = () => edits().some((l) => l.includes(LABELS.review) && l.includes("--add-label") && l.includes(LABELS.pending));

test("a re-run newer than the QA report returns the card to review with no session, and clears the streak", async () => {
  const config = load();
  const repo = config.repos[0];
  labelIssue(LABELS.pending);
  world({ comments: [report(10), rerun(52)] });
  assert.equal(await pendingPass(config, 1), null);
  assert.equal(claudeRuns(), 0, "no revise session");
  assert.ok(movedToReview(), `pr pending actions -> pr under review, got ${edits().join(" | ")}`);
  assert.equal((await prRecordOf(rt, repo, PR)).noCommit, undefined, "no no-commit round saved");
});

test("a re-run that bypasses a no-commit stalemate still returns it to review", async () => {
  const config = load();
  const repo = config.repos[0];
  labelIssue(LABELS.pending);
  world({ comments: [report(10), rerun(52)] });
  await rt.streaks.record(repo, PR, SHA, undefined);
  await rt.streaks.record(repo, PR, SHA, (await rt.streaks.read(repo, PR)).streak);
  assert.equal(await pendingPass(config, 1), null);
  assert.equal(claudeRuns(), 0);
  assert.ok(movedToReview());
  assert.equal((await prRecordOf(rt, repo, PR)).noCommit, undefined, "the streak is cleared");
});

test("a re-run older than the QA report is spent: normal revise behaviour", async () => {
  const config = load();
  labelIssue(LABELS.pending);
  world({ comments: [rerun(5), report(10)] });
  assert.ok(await pendingPass(config, 1), "the session ran");
  assert.equal(claudeRuns(), 1);
});

test("no re-run comment: normal revise behaviour", async () => {
  const config = load();
  labelIssue(LABELS.pending);
  world({ comments: [report(10)] });
  assert.ok(await pendingPass(config, 1));
  assert.equal(claudeRuns(), 1);
});

test("a re-run for a report of another head does not void this head's (no report for this head: normal revise)", async () => {
  const config = load();
  labelIssue(LABELS.pending);
  world({ comments: [{ at: at(10), body: `<!-- foreman-qa sha=${"c".repeat(40)} verdict=FAIL -->` }, rerun(52)] });
  assert.ok(await pendingPass(config, 1));
  assert.equal(claudeRuns(), 1);
});

test("qaBeforeMerge off: a re-run comment is ignored by revise", async () => {
  const config = load({ qaBeforeMerge: false });
  labelIssue(LABELS.pending);
  world({ comments: [report(10), rerun(52)] });
  assert.ok(await pendingPass(config, 1));
  assert.equal(claudeRuns(), 1);
});
