// Regressions for the "endless loops" bugs: a step that acts twice on an input that has not changed.
//   #39  review re-picks a withdrawn PR forever; a COMMENTED review is ignored by the freshness check
//   #46  the reconciler labels an issue `pr under review` without checking `approved`
//   #110 an empty-diff PR loops in review and never reaches revise
//   #78  the revise skill carries "prefer a revert; fix only what this PR introduced"
//   #45  a side-branch PR into the base branch hides its issue instead of surfacing it
// plus the review attempt ledger end to end through tryReview.
//
// Drives the BUILT modules. `gh` is a fake on PATH; the code host in the review cases is a Proxy that throws on
// any method the test did not expect.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { findPRsNeedingReview, configureIssueCache } from "../dist/github.js";
import { readFreshReview } from "../dist/github/review-freshness.js";
import { BackoffTracker } from "../dist/backoff.js";
import { loadConfig } from "../dist/config.js";
import { GitHubIssueConnector } from "../dist/github-work-source.js";
import { transition } from "../dist/lifecycle.js";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { registerPlugin, startPlugins, resetRegistryForTests } from "../dist/plugins/registry.js";
import { tryReview } from "../dist/phases/review.js";
import { MAX_REVIEW_ATTEMPTS_PER_HEAD } from "../dist/step-attempts.js";
import { addObserver, drainObservers } from "../dist/work-source.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { memoryRecords } from "./issue-records.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const TL = "tl-bot";

let tmp, ghState, savedPath, savedToken, savedTl;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-endless-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  ghState = join(tmp, "gh-state.json");
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, "utf8"));
const out = (v) => process.stdout.write(JSON.stringify(v));
fs.appendFileSync(${JSON.stringify(join(tmp, "gh.log"))}, JSON.stringify(a) + "\\n");
if (a[0] === "api" && /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+$/.test(a[1])) process.stdout.write("## Acceptance\\n- **Script:** scripts/x/x-acceptance.mjs");
else if (a[0] === "api" && /\\/branches\\//.test(a[1])) process.stdout.write("0".repeat(40));
else if (a[0] === "pr" && a[1] === "list") out(st.prs ?? []);
else if (a[0] === "issue" && a[1] === "list") out(st.issues ?? []);
else if (a[0] === "issue" && a[1] === "view") {
  const i = (st.issues ?? []).find((x) => String(x.number) === a[2]);
  out(i ? { state: i.state ?? "OPEN", labels: i.labels } : null);
} else if (a[0] === "pr" && a[1] === "view") out({ reviews: st.reviews ?? [], commits: [{ committedDate: st.committed }] });
else out([]);
`);
  chmodSync(join(bin, "gh"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  savedToken = process.env.FOREMAN_GITHUB_TOKEN;
  savedTl = process.env.TECHLEAD_GITHUB_KEY;
  process.env.FOREMAN_GITHUB_TOKEN = "test-placeholder";
  process.env.TECHLEAD_GITHUB_KEY ||= "test-token-not-real";
  configureIssueCache({ ttlMs: 0 });
});
after(() => {
  process.env.PATH = savedPath;
  if (savedToken === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = savedToken;
  if (savedTl === undefined) delete process.env.TECHLEAD_GITHUB_KEY;
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function arrange({ issues, prs, reviews = [], committed = ago(600), extraRepo = {}, extra = {} } = {}) {
  const repo = `example/loops${++n}`;
  writeFileSync(ghState, JSON.stringify({ issues, prs: prs?.map((p) => ({ ...p, url: `https://github.com/${repo}/pull/${p.number}` })), reviews, committed }));
  const p = join(tmp, `cfg${n}.json`);
  writeFileSync(p, JSON.stringify({ emRepoPath: tmp, ...extra, repos: [{ name: `r${n}`, repoPath: tmp, githubRepo: repo, ...extraRepo }] }));
  return loadConfig(p).repos[0];
}
const issue = (number, ...labels) => ({ number, state: "OPEN", title: `#${number}`, labels: labels.map((name) => ({ name })) });
const featurePr = (head = "foreman/5-thing") => ({ number: 50, title: "feat (#5)", body: "Closes #5", headRefName: head, baseRefName: "develop", headRefOid: "abc", updatedAt: ago(600) });

// --- #39 ----------------------------------------------------------------------

test("#39: a PR whose issue was withdrawn (no `approved`) is not offered for review, and not adopted as unlinked", async () => {
  const cfg = arrange({ issues: [issue(5, "pr under review")], prs: [featurePr()] });
  assert.equal(await findPRsNeedingReview(cfg, TL, quiet, new BackoffTracker(), () => false), null);
});

test("#39: the same PR with `approved` is offered", async () => {
  const cfg = arrange({ issues: [issue(5, "approved", "pr under review")], prs: [featurePr()] });
  assert.deepEqual((await findPRsNeedingReview(cfg, TL, quiet, new BackoffTracker(), () => false))?.issueNumbers, [5]);
});

test("#39: a COMMENTED review at the head is a fresh review", async () => {
  const cfg = arrange({ issues: [], reviews: [{ author: { login: TL }, state: "COMMENTED", submittedAt: ago(10) }], committed: ago(30) });
  assert.equal(await readFreshReview(cfg, 50, TL, quiet), true);
});

test("#39: a COMMENTED review older than the last commit is not fresh", async () => {
  const cfg = arrange({ issues: [], reviews: [{ author: { login: TL }, state: "COMMENTED", submittedAt: ago(60) }], committed: ago(30) });
  assert.equal(await readFreshReview(cfg, 50, TL, quiet), false);
});

// --- #46 ----------------------------------------------------------------------

function ghEdits(repo) {
  return readFileSync(join(tmp, "gh.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((a) => a[0] === "issue" && a[1] === "edit" && a.includes(repo));
}
async function implemented(cfg, num) {
  writeFileSync(join(tmp, "gh.log"), "");
  return await new GitHubIssueConnector().record(
    { kind: "transition", item: { issueNumber: num, repo: cfg.githubRepo }, observed: false, ...transition("implemented") }, cfg, quiet);
}

test("#46: the reconciler does not label an issue whose `approved` was withdrawn", async () => {
  const cfg = arrange({ issues: [issue(5)] });
  assert.equal(await implemented(cfg, 5), false);
  assert.deepEqual(ghEdits(cfg.githubRepo), []);
});

test("#46: nor an issue that is closed", async () => {
  const cfg = arrange({ issues: [{ ...issue(5, "approved"), state: "CLOSED" }] });
  assert.equal(await implemented(cfg, 5), false);
  assert.deepEqual(ghEdits(cfg.githubRepo), []);
});

test("#46: an issue that cannot be read is not labelled (fail closed)", async () => {
  const cfg = arrange({ issues: [] });
  assert.equal(await implemented(cfg, 5), false);
  assert.deepEqual(ghEdits(cfg.githubRepo), []);
});

test("#46: an approved open issue is labelled", async () => {
  const cfg = arrange({ issues: [issue(5, "approved")] });
  assert.equal(await implemented(cfg, 5), true);
  assert.equal(ghEdits(cfg.githubRepo).length, 1);
});

// --- #45 ----------------------------------------------------------------------

test("#45: a side-branch PR into the base branch keeps its issue covered but holds it for the EM", async () => {
  const cfg = arrange({ issues: [issue(5, "approved")], prs: [featurePr("rays-side-branch")] });
  const source = new GitHubIssueConnector();
  assert.deepEqual(await source.selectWork(cfg, undefined, quiet), [], "covered: nothing is built twice");
  const held = source.heldWork(cfg);
  assert.equal(held.length, 1, "and it is surfaced, not hidden");
  assert.equal(held[0].item.issueNumber, 5);
  assert.equal(held[0].skipped, true, "held for a person");
  assert.match(held[0].reason, /PR #50/);
  assert.match(held[0].reason, /Owner: the EM/);
});

test("#45: a Foreman-owned PR covers its issue with no hold", async () => {
  const cfg = arrange({ issues: [issue(5, "approved")], prs: [featurePr("foreman/5-thing")] });
  const source = new GitHubIssueConnector();
  assert.deepEqual(await source.selectWork(cfg, undefined, quiet), []);
  assert.deepEqual(source.heldWork(cfg), []);
});

// --- #78 ----------------------------------------------------------------------

test("#78: the shipped revise skill says to prefer a revert and fix only what the PR introduced", () => {
  const skill = readFileSync(join(root, "skills/revise/SKILL.md"), "utf8");
  assert.match(skill, /Prefer a revert; fix only what this PR introduced/);
  assert.match(skill, /already in the base branch is not this PR's to fix/);
});

test("#110: the shipped revise skill reads the EM scope ruling on an empty-diff PR", () => {
  const skill = readFileSync(join(root, "skills/revise/SKILL.md"), "utf8");
  assert.match(skill, /<!-- foreman-empty-diff/);
  assert.match(skill, /EM scope ruling/);
});

// --- #110 and the review ledger, end to end through tryReview -----------------

const world = { head: "sha-1", files: ["a.ts"], rulingAt: null, comments: [], advanced: [], reviews: 0, bounced: [] };
const host = new Proxy({}, {
  get(_, key) {
    if (key === "then" || typeof key === "symbol") return undefined;
    return async (...args) => {
      switch (key) {
        case "findPRsNeedingReview": return { prNumber: 7, prUrl: "u", issueNumbers: [5], adopted: [] };
        case "blockedAmong": return [];
        case "getPRCheckVerdict": return { state: "passing", pending: [], failing: [] };
        case "readPrState": return "OPEN";
        case "readPrHeadSha": return world.head;
        case "prChangedFiles": return world.files;
        case "hasCommentContaining": return world.comments.some((c) => c.includes(args[2]));
        case "commentOnPr": world.comments.push(args[2]); return undefined;
        case "readRulingState": return { rulingAt: world.rulingAt, latestReviewAt: null };
        case "findRevokedEmGates": return [];
        default: return [];
      }
    };
  },
});
const codeHostPlugin = { id: "loops-host", roles: ["codeHost"], enabled: (c) => c.codeHost === "loops", fills: (role, c) => role === "codeHost" && c.codeHost === "loops", codeHost: host };
const events = [];
const sourceEvents = [];
const reviewer = {
  id: "loops-reviewer", roles: ["reviewer"], enabled: () => true,
  reviewer: {
    reviewPr: async () => { world.reviews++; return { success: true, trailers: [], summary: "reviewed" }; },
    approvePromotion: async () => ({ kind: "retry", reason: "unused" }),
  },
};
let config, rt;
before(async () => {
  setStatePath(join(tmp, "state.json"));
  const p = join(tmp, "loops-config.json");
  writeFileSync(p, JSON.stringify({
    codeHost: "loops", emRepoPath: "/x", techLeadPath: tmp, paperclip: { enabled: false },
    repos: [{ name: "loops", repoPath: tmp, githubRepo: "example/t", baseBranch: "develop", reviewEnabled: true }],
  }));
  config = loadConfig(p);
  resetRegistryForTests();
  const source = {
    id: "loops-src", roles: ["workSource"], enabled: () => true,
    workSource: { selectWork: async () => [], record: async (e) => { sourceEvents.push(e); return true; }, loadRecord: async () => ({ status: "absent" }), saveRecord: async () => true },
  };
  for (const pl of [codeHostPlugin, source, reviewer]) registerPlugin(pl);
  await startPlugins(config, { logger: quiet, configText: () => null });
  memoryRecords();
  addObserver({ onEvent: (e) => { events.push(e); } });
});
after(() => resetRegistryForTests());

function fresh() {
  Object.assign(world, { head: "sha-1", files: ["a.ts"], rulingAt: null, comments: [], reviews: 0 });
  events.length = 0;
  sourceEvents.length = 0;
  rt = new ForemanRuntime();
  memoryRecords();
}
const review = async () => { const r = await tryReview(rt, config.repos[0], config, quiet, 1); await drainObservers(); return r; };
const moves = () => sourceEvents.filter((e) => e.kind === "transition").map((e) => e.move);

test("#110: an empty-diff PR is sent to revise, with one comment per head, and no review is spent", async () => {
  fresh();
  world.files = [];
  assert.equal(await review(), true);
  assert.equal(world.reviews, 0, "the Tech Lead is never asked to review nothing");
  assert.deepEqual(moves(), ["changesRequested"], "it goes to revise, which reads the EM scope ruling");
  assert.equal(world.comments.length, 1);
  assert.match(world.comments[0], /<!-- foreman-empty-diff sha=sha-1 -->/);
  assert.equal(await review(), true);
  assert.equal(world.comments.length, 1, "the same head is explained once");
  world.head = "sha-2";
  await review();
  assert.equal(world.comments.length, 2, "a new head is a new input");
});

test("ledger: the same head is reviewed at most MAX times, then held for the EM with one escalation", async () => {
  fresh();
  for (let i = 0; i < MAX_REVIEW_ATTEMPTS_PER_HEAD; i++) assert.equal(await review(), true, `attempt ${i + 1}`);
  assert.equal(world.reviews, MAX_REVIEW_ATTEMPTS_PER_HEAD);
  assert.equal(await review(), false, "held");
  assert.equal(await review(), false, "still held");
  assert.equal(world.reviews, MAX_REVIEW_ATTEMPTS_PER_HEAD, "no further review ran");
  const escalations = events.filter((e) => e.kind === "escalated");
  assert.equal(escalations.length, 1, "the owner is told once");
  assert.equal(escalations[0].stuck, "needs-ruling");
  assert.match(escalations[0].reason, /rule-on-scope/);
});

test("ledger: a push (new head) resumes review", async () => {
  fresh();
  for (let i = 0; i < MAX_REVIEW_ATTEMPTS_PER_HEAD + 1; i++) await review();
  assert.equal(world.reviews, MAX_REVIEW_ATTEMPTS_PER_HEAD);
  world.head = "sha-2";
  assert.equal(await review(), true);
  assert.equal(world.reviews, MAX_REVIEW_ATTEMPTS_PER_HEAD + 1);
});

test("ledger: an EM scope ruling after the last attempt resumes review", async () => {
  fresh();
  for (let i = 0; i < MAX_REVIEW_ATTEMPTS_PER_HEAD + 1; i++) await review();
  world.rulingAt = new Date(Date.now() + 60_000).toISOString();
  assert.equal(await review(), true);
  assert.equal(world.reviews, MAX_REVIEW_ATTEMPTS_PER_HEAD + 1);
});
