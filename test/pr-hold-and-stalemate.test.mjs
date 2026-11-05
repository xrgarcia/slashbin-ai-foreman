// foreman#167. Slashbin-console PR #1597 (2026-11-01) looped QA FAIL → no-commit revise on one head 15+
// times: the no-commit streak was reset by every pass with no pending revision, and a reused QA FAIL left
// no comment, so neither the stalemate nor the review-rounds alert fired. Then the EM's `blocked` label on
// its issue paused nothing. These drive the real phases against a fake `gh` and `claude` on PATH.
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
else if (args[0] === "pr" && args[1] === "list") out([{ number: ${PR}, url: "https://github.com/${REPO}/pull/${PR}", title: "Build #${ISSUE}", body: "Closes #${ISSUE}", headRefName: "foreman/${ISSUE}-build", baseRefName: "develop" }]);
else if (args[0] === "pr" && args[1] === "view" && has("headRefOid")) out({ headRefOid: w.head });
else if (args[0] === "pr" && args[1] === "view" && has("--json state")) out({ state: "OPEN" });
else if (args[0] === "pr" && args[1] === "view" && has("reviews")) out({ reviews: w.reviews ?? [], commits: [{ committedDate: "2026-11-01T19:40:00Z" }] });
else if (args[0] === "pr" && args[1] === "view") out("{}");
else if (args[0] === "api" && has("/branches/")) out(w.head);
else if (args[0] === "api" && has("/pulls/") && has("/reviews")) out((w.apiReviews ?? []).map((r) => JSON.stringify(r)).join("\\n"));
else if (args[0] === "api" && has("/issues/") && has("/comments")) out((w.comments ?? []).map((c) => JSON.stringify(c)).join("\\n"));
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
  world({ labels: ["approved"], head: SHA, reviews: [], comments: [], apiReviews: [] });
});

function load(top = {}) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    reviewerLogin: "tl", techLeadPath: tmp, reviewCheckoutRoot: join(tmp, "rc"), ...top,
    repos: [{ name: `r-${Math.random().toString(36).slice(2)}`, repoPath: tmp, githubRepo: REPO }],
  }));
  return loadConfig(p);
}

// --- Defect 1: the stalemate ---

test("#1597: QA FAIL → no-commit → a pass with no pending revision → QA FAIL → no-commit raises the stalemate on the second", async () => {
  const config = load();
  const repo = config.repos[0];

  labelIssue(LABELS.pending); // QA FAIL sends it back
  const events1 = [];
  assert.ok(await tryRevision(rt, repo, config, logger, 1, events1), "the first no-commit returns it to review");
  assert.equal(claudeRuns(), 1);

  labelIssue(LABELS.review); // QA runs on the head: no pending revision this pass
  assert.equal(await tryRevision(rt, repo, config, logger, 2, []), null);

  labelIssue(LABELS.pending); // QA FAILs the same head again
  const events2 = [];
  assert.equal(await tryRevision(rt, repo, config, logger, 3, events2), null, "the second no-commit does not relabel");
  assert.equal(claudeRuns(), 2);
  assert.ok(events2.some((e) => e.level === "error" && /answered 2 review rounds with no code change/.test(e.message)), JSON.stringify(events2));
  assert.deepEqual(withoutAt((await prRecordOf(rt, repo, PR)).noCommit), { head: SHA, count: 2 }, "persisted on the PR's record, so a restart keeps it");

  assert.equal(await tryRevision(rt, repo, config, logger, 4, []), null);
  assert.equal(claudeRuns(), 2, "no further session on the stalled head");
});

test("a push that moves the head clears the stalemate and revise runs again", async () => {
  const config = load();
  const repo = config.repos[0];
  labelIssue(LABELS.pending);
  await tryRevision(rt, repo, config, logger, 1, []);
  labelIssue(LABELS.review);
  await tryRevision(rt, repo, config, logger, 2, []);
  labelIssue(LABELS.pending);
  await tryRevision(rt, repo, config, logger, 3, []);
  assert.equal((await prRecordOf(rt, repo, PR)).noCommit.count, 2, "stalled");

  world({ head: NEW_SHA });
  assert.ok(await tryRevision(rt, repo, config, logger, 4, []), "the new head is revised and goes back to review");
  assert.equal(claudeRuns(), 3);
  assert.deepEqual(withoutAt((await prRecordOf(rt, repo, PR)).noCommit), { head: NEW_SHA, count: 1 }, "the old head's streak is gone");
});

/** Drive the PR into the no-commit stalemate on SHA (two no-commit rounds). */
async function stall(repo, config) {
  labelIssue(LABELS.pending);
  await tryRevision(rt, repo, config, logger, 1, []);
  labelIssue(LABELS.review);
  await tryRevision(rt, repo, config, logger, 2, []);
  labelIssue(LABELS.pending);
  await tryRevision(rt, repo, config, logger, 3, []);
  assert.equal((await prRecordOf(rt, repo, PR)).noCommit.count, 2, "stalled");
  assert.equal(claudeRuns(), 2);
}
const ruling = (at) => ({ at, head: "**EM scope ruling** — commit the file." });

test("an EM scope ruling posted after the stalemate releases it like a push: revise runs once more on the same head", async () => {
  const config = load();
  const repo = config.repos[0];
  await stall(repo, config);
  assert.ok((await prRecordOf(rt, repo, PR)).noCommit.at, "a counted round is timestamped");

  world({ comments: [ruling(new Date(Date.now() + 60_000).toISOString())] });
  assert.ok(await tryRevision(rt, repo, config, logger, 4, []), "the ruling releases the stalemate and the revise goes back to review");
  assert.equal(claudeRuns(), 3, "one more session");
  assert.equal((await prRecordOf(rt, repo, PR)).noCommit.count, 1, "the streak restarted from the ruling");
});

test("a ruling older than the stalemate's last round does not release it (no loop)", async () => {
  const config = load();
  const repo = config.repos[0];
  world({ comments: [ruling("2020-01-01T00:00:00Z")] });
  await stall(repo, config);
  assert.equal(await tryRevision(rt, repo, config, logger, 4, []), null);
  assert.equal(claudeRuns(), 2, "no session on a ruling the stalemate already answered");
});

test("a released stalemate that stalls again is not re-released by the same ruling", async () => {
  const config = load();
  const repo = config.repos[0];
  await stall(repo, config);
  world({ comments: [ruling(new Date(Date.now() + 1_000).toISOString())] });
  await new Promise((r) => setTimeout(r, 1_100));
  assert.ok(await tryRevision(rt, repo, config, logger, 4, []));
  assert.equal(claudeRuns(), 3);
  labelIssue(LABELS.pending);
  assert.equal(await tryRevision(rt, repo, config, logger, 5, []), null, "the second no-commit after the ruling stalls again");
  assert.equal(claudeRuns(), 4);
  assert.equal(await tryRevision(rt, repo, config, logger, 6, []), null);
  assert.equal(claudeRuns(), 4, "the old ruling does not release the new stalemate");
});

test("a legacy streak with no timestamp is released by a ruling newer than the newest review", async () => {
  const config = load();
  const repo = config.repos[0];
  world({ apiReviews: [{ id: 1, state: "CHANGES_REQUESTED", at: "2026-11-05T11:50:20Z", escalate: false }] });
  await stall(repo, config);
  await rt.records.updatePrRecord(repo, PR, (d) => { delete d.noCommit.at; });
  assert.equal((await prRecordOf(rt, repo, PR)).noCommit.at, undefined);
  world({ comments: [ruling("2026-11-05T12:15:47Z")] });
  assert.ok(await tryRevision(rt, repo, config, logger, 4, []), "released");
  assert.equal(claudeRuns(), 3);
});

test("a QA FAIL that stands on the same head is a review round: the third goes to needsRuling", () => {
  const fail = { at: "2026-11-01T20:13:49Z", head: `## QA Report\n<!-- foreman-qa sha=${SHA} verdict=FAIL -->` };
  const stands = (at) => ({ at, head: qaFailStandsBody(SHA).slice(0, 140) });
  const approved = [{ id: 1, state: "APPROVED", at: "2026-11-01T19:47:43Z", escalate: false }];
  assert.equal(rulingState(approved, [fail]).roundsSinceRuling, 1);
  const third = rulingState(approved, [fail, stands("2026-11-01T20:59:58Z"), stands("2026-11-01T21:05:00Z")]);
  assert.equal(third.roundsSinceRuling, 3);
  assert.ok(third.roundsSinceRuling >= REVIEW_ROUNDS_ALERT);
  assert.doesNotMatch(qaFailStandsBody(SHA), /verdict=FAIL/, "never read as a new FAIL report for the head");
});

test("a reused QA FAIL posts that it stands, once per send-back, without running QA", async () => {
  const config = load({ reviewEnabled: true, qaBeforeMerge: true, qaRepos: [REPO] });
  labelIssue(LABELS.review);
  world({ reviews: [{ author: { login: "tl" }, state: "APPROVED", submittedAt: "2026-11-01T19:47:43Z" }] });
  const deps = { runs: 0, posted: [], run: async () => { deps.runs++; return { kind: "errored", detail: "unused" }; },
    hasMarker: async (_pr, m) => m.includes("verdict=FAIL"), hasReport: async () => false, post: async (_pr, b) => { deps.posted.push(b); } };
  assert.equal(await tryQaBeforeMerge(rt, config.repos[0], config, logger, 1, [], deps), "handled");
  assert.equal(deps.runs, 0);
  assert.deepEqual(deps.posted, [qaFailStandsBody(SHA)]);
});

// --- Defect 2: the EM's `blocked` label pauses each PR phase ---

test("blocked: revise does not run on a PR whose issue carries the label", async () => {
  const config = load();
  labelIssue(LABELS.pending, "blocked");
  assert.equal(await tryRevision(rt, config.repos[0], config, logger, 1, []), null);
  assert.equal(claudeRuns(), 0);
  labelIssue(LABELS.pending);
  assert.ok(await tryRevision(rt, config.repos[0], config, logger, 2, []), "lifted: it runs");
  assert.equal(claudeRuns(), 1);
});

test("blocked: review does not offer the PR to the Tech Lead", async () => {
  const config = load({ reviewEnabled: true });
  const co = checkoutPathFor(config, config.repos[0]);
  mkdirSync(co, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: co }).status, 0);
  labelIssue(LABELS.review, "blocked");
  await tryReview(rt, config.repos[0], config, logger, 1);
  assert.equal(reviewed, 0);
  labelIssue(LABELS.review);
  await tryReview(rt, config.repos[0], config, logger, 2);
  assert.equal(reviewed, 1, "lifted: it is reviewed");
});

test("blocked: QA before the merge does not run, and the PR waits", async () => {
  const config = load({ reviewEnabled: true, qaBeforeMerge: true, qaRepos: [REPO] });
  world({ reviews: [{ author: { login: "tl" }, state: "APPROVED", submittedAt: "2026-11-01T19:47:43Z" }] });
  const deps = { runs: 0, run: async () => { deps.runs++; return { kind: "errored", detail: "x" }; },
    hasMarker: async () => false, hasReport: async () => false, post: async () => {} };
  labelIssue(LABELS.review, "blocked");
  assert.equal(await tryQaBeforeMerge(rt, config.repos[0], config, logger, 1, [], deps), "waiting");
  assert.equal(deps.runs, 0);
  labelIssue(LABELS.review);
  await tryQaBeforeMerge(rt, config.repos[0], config, logger, 2, [], deps);
  assert.equal(deps.runs, 1, "lifted: QA runs");
});
