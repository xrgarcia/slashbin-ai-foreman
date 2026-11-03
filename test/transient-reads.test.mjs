// EM#1244 f5: retry lives only in the plugin (gh()). Past it, a read that fails is `unavailable` to the
// core: it THROWS and fails the pass. It is never an empty answer (no PR, no files, no fresh review, no
// sha) that a caller could act on, and the core keeps no classifier or retry of its own.
//
// A fake `gh` first on PATH answers from a state file; `fail` makes every call fail the way a network
// error and a 5xx do, for longer than the retry lasts.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkTmp } from "./tmp-dir.mjs";
import { configureBackoff } from "../dist/backoff.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import * as pr from "../dist/github/pr.js";
import * as branch from "../dist/github/branch.js";
import * as promotion from "../dist/github/promotion.js";
import * as reports from "../dist/github/reports.js";
import * as fresh from "../dist/github/review-freshness.js";

const REPO = "example/transient";
const config = {
  name: "t", githubRepo: REPO, repoPath: tmpdir(), baseBranch: "develop", featureBranch: "features", productionBranch: "main",
  lifecycleLabels: { prUnderReview: "pr under review" },
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };

let state;
before(() => {
  const dir = mkTmp("foreman-transient-");
  const bin = join(dir, "bin");
  state = join(dir, "state.json");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const S = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
if (S.fail === "network") { process.stderr.write("error connecting to api.github.com\\n"); process.exit(1); }
if (S.fail === "5xx") { process.stderr.write("HTTP 502: Bad Gateway (https://api.github.com/x)\\n"); process.exit(1); }
if (S.fail === "404") { process.stderr.write("HTTP 404: Not Found\\n"); process.exit(1); }
const a = process.argv.slice(2).join(" ");
if (a.includes("branches/")) process.stdout.write("a".repeat(40));
else if (a.includes("--json state")) process.stdout.write(JSON.stringify({ state: "OPEN" }));
else if (a.includes("headRefOid")) process.stdout.write(JSON.stringify({ headRefOid: "b".repeat(40) }));
else if (a.includes("--json files")) process.stdout.write(JSON.stringify({ files: [{ path: "client/a.tsx" }] }));
else if (a.includes("--json reviews,commits")) process.stdout.write(JSON.stringify({ commits: [{ committedDate: "2026-01-01T00:00:00Z" }], reviews: [{ author: { login: "tl" }, state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z" }] }));
else if (a.includes("--json reviews")) process.stdout.write(JSON.stringify({ reviews: [{ author: { login: "tl" }, state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z" }] }));
else if (a.includes("pr list")) process.stdout.write("[]");
else process.stdout.write("");
`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "fake";
  // Retry stays real (the plugin's) but short, so every failing read costs milliseconds.
  configureBackoff({ ...DEFAULT_BACKOFF, gh: { baseMs: 1, capMs: 1, factor: 1, maxAttempts: 2 } });
});
const setFail = (fail) => writeFileSync(state, JSON.stringify({ fail }));

const reads = {
  verifyPRExists: () => pr.verifyPRExists(REPO, "features", "develop", tmpdir(), logger),
  getReferencedIssuesFromOpenPR: () => pr.getReferencedIssuesFromOpenPR(REPO, "features", "develop", tmpdir(), logger),
  checkPRHasChanges: () => branch.checkPRHasChanges(REPO, "features", "develop", tmpdir(), logger),
  getRemoteBranchSha: () => branch.getRemoteBranchSha(REPO, "features", tmpdir(), logger),
  findOpenSyncPR: () => branch.findOpenSyncPR(REPO, "main", "develop", tmpdir(), logger),
  findOpenPromotionPR: () => promotion.findOpenPromotionPR(REPO, "main", "develop", tmpdir(), logger),
  prChangedFiles: () => reports.prChangedFiles(REPO, 5, tmpdir(), logger),
  readRulingState: () => reports.readRulingState(REPO, 5, tmpdir(), logger),
  readPrState: () => fresh.readPrState(config, 5, logger),
  readPrHeadSha: () => fresh.readPrHeadSha(config, 5, logger),
  readFreshReview: () => fresh.readFreshReview(config, 5, "tl", logger),
  currentVerdictRequestsChanges: () => fresh.currentVerdictRequestsChanges(config, 5, "tl", logger),
  currentApprovalMs: () => fresh.currentApprovalMs(config, 5, "tl", logger),
  returnedToReviewSinceVerdict: () => fresh.returnedToReviewSinceVerdict(config, 5, [7], "tl", logger),
};

for (const [name, read] of Object.entries(reads)) {
  for (const fail of ["network", "5xx"]) {
    test(`${name}: a ${fail} failure that outlasts the plugin's retry throws, never an empty answer`, () => {
      setFail(fail);
      assert.throws(read);
    });
  }
}

test("the same reads answer when GitHub does (the throw is the failure, not the shape)", () => {
  setFail(null);
  assert.equal(reads.verifyPRExists(), false);
  assert.equal(reads.getReferencedIssuesFromOpenPR(), null);
  assert.equal(reads.getRemoteBranchSha(), "a".repeat(40));
  assert.equal(reads.findOpenPromotionPR(), null);
  assert.equal(reads.findOpenSyncPR(), null);
  assert.deepEqual(reads.prChangedFiles(), ["client/a.tsx"]);
  assert.equal(reads.readPrState(), "OPEN");
  assert.equal(reads.readPrHeadSha(), "b".repeat(40));
  assert.equal(reads.readFreshReview(), true);
});

test("a branch that does not exist is null (a 404), not a failure and not a sha", () => {
  setFail("404");
  assert.equal(reads.getRemoteBranchSha(), null);
});

test("the core keeps no transient classifier, no retry and no sleep: gh() and the plugins own them", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(root);
  const core = files.filter((f) => !f.includes("/src/github/") && !f.includes("/src/plugins/") && !f.includes("/src/paperclip/"));
  const offenders = core.filter((f) => /isTransientGhError|isRateLimitGhError|sleepSync|\.transient\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});
