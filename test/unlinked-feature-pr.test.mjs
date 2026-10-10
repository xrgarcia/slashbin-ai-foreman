// An open feature PR that names no approved issue is reviewed, not skipped.
//
// jerky_service #99, 2026-10-10: a person's PR on `features`, linked to nothing
// ("Follow-up to #98", a merged PR). The review stage only took PRs with an
// issue in review or one it could adopt, so it never touched #99; the implement
// stage queues every approved issue behind any open feature PR, so #102 sat
// "queued" once a minute for days. Now the Tech Lead gets it with no issues.
//
// Drives the BUILT module; `gh` is a fake on PATH serving one PR and its refs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPRsNeedingReview } from "../dist/github.js";
import { loadConfig } from "../dist/config.js";

let tmp, ghState, savedPath;
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-unlinked-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  ghState = join(tmp, "gh-state.json");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, "utf8"));
const out = (v) => process.stdout.write(JSON.stringify(v));
if (a[0] === "pr" && a[1] === "list") out([st.pr]);
else if (a[0] === "issue" && a[1] === "list") out(st.issues.filter((i) => i.state === "OPEN"));
else if (a[0] === "pr" && a[1] === "view") out({ reviews: st.reviews, commits: [{ committedDate: "2026-10-07T13:00:00Z" }] });
else if (a[0] === "issue" && a[1] === "view") {
  const i = st.issues.find((x) => String(x.number) === a[2]);
  if (!i) { process.stderr.write("HTTP 502"); process.exit(1); }
  out(i);
} else out([]);
`);
  chmodSync(join(bin, "gh"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
});
after(() => {
  process.env.PATH = savedPath;
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
// A fresh repo name per case: the open-issue and open-PR lists are cached per repo.
function arrange({ body = "Follow-up to #98", issues = [], reviews = [] } = {}) {
  const repo = `example/r${++n}`;
  const pr = { number: 99, url: `https://github.com/${repo}/pull/99`, title: "fix(mcp): keep the bearer out of argv", body, headRefName: "features", baseRefName: "develop", headRefOid: "e4927f5", updatedAt: "2026-10-08T20:08:13Z" };
  writeFileSync(ghState, JSON.stringify({ pr, issues, reviews }));
  const p = join(tmp, `cfg${n}.json`);
  writeFileSync(p, JSON.stringify({ repos: [{ name: "a", repoPath: tmp, githubRepo: repo }] }));
  return loadConfig(p).repos[0];
}
const issue = (number, labels, state = "OPEN") => ({ number, state, title: `t${number}`, labels: labels.map((name) => ({ name })) });

test("a feature PR that names only a closed ref is reviewed with no issues", () => {
  const cfg = arrange({ issues: [issue(98, ["approved"], "CLOSED"), issue(102, ["approved", "chore"])] });
  assert.deepEqual(findPRsNeedingReview(cfg, "slasbhin-techlead", logger), { prNumber: 99, prUrl: `https://github.com/${cfg.githubRepo}/pull/99`, issueNumbers: [], adopted: [] });
});

test("a feature PR that names nothing at all is reviewed with no issues", () => {
  const cfg = arrange({ body: "" });
  assert.deepEqual(findPRsNeedingReview(cfg, "slasbhin-techlead", logger)?.issueNumbers, []);
});

test("a current verdict by the reviewer is not reviewed again", () => {
  const cfg = arrange({ reviews: [{ author: { login: "slasbhin-techlead" }, state: "CHANGES_REQUESTED", submittedAt: "2026-10-08T20:08:13Z" }] });
  assert.equal(findPRsNeedingReview(cfg, "slasbhin-techlead", logger), null);
});

test("an approved issue the PR names is still adopted as before", () => {
  const cfg = arrange({ body: "Closes #98", issues: [issue(98, ["approved"])] });
  const c = findPRsNeedingReview(cfg, "slasbhin-techlead", logger);
  assert.deepEqual([c?.issueNumbers, c?.adopted], [[98], [98]]);
});

test("a PR whose issue is in revise or past review is left to that stage", () => {
  for (const labels of [["approved", "pr pending actions"], ["approved", "ready for prod release"]]) {
    const cfg = arrange({ body: "Closes #98", issues: [issue(98, labels)] });
    assert.equal(findPRsNeedingReview(cfg, "slasbhin-techlead", logger), null, labels.join(","));
  }
});

test("a ref that cannot be read holds the PR for a later pass", () => {
  const cfg = arrange({ body: "Closes #77" });
  assert.equal(findPRsNeedingReview(cfg, "slasbhin-techlead", logger), null);
});
