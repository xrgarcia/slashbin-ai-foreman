// An approved feature PR that never merged is offered for review again.
//
// 2026-10-10, 18:57-19:00Z: the Tech Lead posted APPROVE on five PRs, then
// GitHub refused each merge while required checks ran (HTTP 405). A current
// APPROVE is never reviewed again, so nothing offered them: Slashbin-console
// #1271, jerky_event_processor #110, Slashbin-io-docs #436, jerky_data_receiver
// #484 and slashbin-io-worker #704 sat approved and unmerged for five hours,
// each holding its repo's implement queue.
//
// Drives the BUILT module; `gh` is a fake on PATH serving one PR and its reviews.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPRsNeedingReview } from "../dist/github.js";
import { loadConfig } from "../dist/config.js";

let tmp, ghState, savedPath, savedToken;
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
const TL = "slasbhin-techlead";
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-approved-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  ghState = join(tmp, "gh-state.json");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, "utf8"));
const out = (v) => process.stdout.write(JSON.stringify(v));
if (a[0] === "pr" && a[1] === "list") out([st.pr]);
else if (a[0] === "issue" && a[1] === "list") out(st.issues);
else if (a[0] === "pr" && a[1] === "view") out({ reviews: st.reviews, commits: [{ committedDate: st.committed }] });
else out([]);
`);
  chmodSync(join(bin, "gh"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  savedToken = process.env.FOREMAN_GITHUB_TOKEN;
  process.env.FOREMAN_GITHUB_TOKEN = "test-placeholder"; // the gh runner refuses without one
});
after(() => {
  process.env.PATH = savedPath;
  if (savedToken === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = savedToken;
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
// A fresh repo name per case: open-issue and open-PR lists are cached per repo.
function arrange({ approvedMinAgo = 300, state = "APPROVED", issues = [{ number: 1270, state: "OPEN", title: "t", labels: [{ name: "approved" }, { name: "pr under review" }] }] } = {}) {
  const repo = `example/r${++n}`;
  const pr = { number: 1271, url: `https://github.com/${repo}/pull/1271`, title: "feat: implement #1270", body: "Closes #1270", headRefName: "features", baseRefName: "develop", headRefOid: "e389c50", updatedAt: ago(approvedMinAgo) };
  writeFileSync(ghState, JSON.stringify({ pr, issues, committed: ago(approvedMinAgo + 2),
    reviews: [{ author: { login: TL }, state, submittedAt: ago(approvedMinAgo) }] }));
  const p = join(tmp, `cfg${n}.json`);
  writeFileSync(p, JSON.stringify({ repos: [{ name: "a", repoPath: tmp, githubRepo: repo }] }));
  return loadConfig(p).repos[0];
}

test("the #1271 shape: approved five hours ago, still open — offered again", () => {
  const cfg = arrange();
  assert.deepEqual(findPRsNeedingReview(cfg, TL, logger), { prNumber: 1271, prUrl: `https://github.com/${cfg.githubRepo}/pull/1271`, issueNumbers: [1270], adopted: [] });
});

test("once offered it waits a window before the next offer, so a held PR is not reviewed every cycle", () => {
  const cfg = arrange();
  assert.ok(findPRsNeedingReview(cfg, TL, logger));
  assert.equal(findPRsNeedingReview(cfg, TL, logger), null);
});

test("an approval younger than the window is a merge still settling — not offered", () => {
  assert.equal(findPRsNeedingReview(arrange({ approvedMinAgo: 2 }), TL, logger), null);
});

test("an unlinked approved PR that never merged is offered with no issues", () => {
  const cfg = arrange({ issues: [] });
  assert.deepEqual(findPRsNeedingReview(cfg, TL, logger)?.issueNumbers, []);
});

test("a current CHANGES_REQUESTED is not an approval waiting on merge", () => {
  assert.equal(findPRsNeedingReview(arrange({ state: "CHANGES_REQUESTED" }), TL, logger)?.stranded, true);
});
