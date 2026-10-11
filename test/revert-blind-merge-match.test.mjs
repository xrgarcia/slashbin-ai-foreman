// A commit a PR reverted delivers nothing, and neither does the revert.
//
// Slashbin-console PR #1232, 2026-10-03: #1164's commit landed on `features` by
// accident and was reverted by hand (`revert: drop #1164 change … (#1164)`, no
// "This reverts commit" line). Net zero for #1164 — but the revert's own
// headline named it, so review labelled #1164 `pr approved` and, on 2026-10-09,
// the dead-zone resolver labelled it `pr merged`: unbuilt work shown as awaiting
// release for a week.
//
// Drives the BUILT module; `gh` is a fake on PATH serving one merged PR.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractImplementedIssues, issuesImplementedByCommits, findIssuesMergedToBase } from "../dist/github.js";
import { loadConfig } from "../dist/config.js";

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
const c = (oid, messageHeadline, messageBody = "") => ({ oid, messageHeadline, messageBody });

// The three commits of Slashbin-console PR #1232, as gh returned them.
const pr1232 = [
  c("2fbc678517aa", "fix: scope template-inheritance handlers to the caller's org (#1163)"),
  c("02d715b090aa", "fix: drop undeclared tool calls in chat() and name them in the reply …", "…(#1164)"),
  c("7a5a40ed6daa", "revert: drop #1164 change pushed onto #1163's open pr (#1164)", "Reverted so #1232 carries #1163 only."),
];

test("Slashbin-console #1232: the hand-reverted #1164 is not delivered; #1163 is", () => {
  assert.deepEqual(extractImplementedIssues({ title: "fix: scope … (#1163)", body: "Related to #1163", commits: pr1232 }), [1163]);
  assert.deepEqual(extractImplementedIssues({ title: "fix: scope … (#1163)", body: "Related to #1163", commits: pr1232, strict: true }), [1163]);
});

test("a git revert (by sha) drops the commit and itself", () => {
  const commits = [c("aaaa1111", "feat: x (#5)"), c("bbbb2222", "feat: y (#6)"), c("cccc3333", 'Revert "feat: x (#5)"', "This reverts commit aaaa1111ffff.")];
  assert.deepEqual(issuesImplementedByCommits(commits).sort(), [6]);
});

test("a revert of a revert restores the original", () => {
  const commits = [
    c("aaaa1111", "feat: x (#5)"),
    c("bbbb2222", 'Revert "feat: x (#5)"', "This reverts commit aaaa1111."),
    c("cccc3333", 'Revert "Revert "feat: x (#5)""', "This reverts commit bbbb2222."),
  ];
  assert.deepEqual(issuesImplementedByCommits(commits), [5]);
});

test("work re-landed after a hand-written revert counts again", () => {
  const commits = [c("a1", "fix: z (#7)"), c("a2", "revert: back out z (#7)"), c("a3", "fix: z, properly (#7)")];
  assert.deepEqual(issuesImplementedByCommits(commits), [7]);
});

test("a revert of base-branch work (sha not in the PR) delivers nothing itself", () => {
  assert.deepEqual(issuesImplementedByCommits([c("d1", 'Revert "feat: old (#3)"', "This reverts commit 9999eeee.\n\nFixes #3")]), []);
});

test("ordinary commits are unchanged", () => {
  assert.deepEqual(extractImplementedIssues({ title: "t", body: "", commits: [c("e1", "feat: a (#8)"), c("e2", "chore: b", "Closes #9")] }), [8, 9]);
  assert.deepEqual(extractImplementedIssues({ title: "t", body: "", commits: [c("e2", "chore: b", "Related to #9")], strict: true }), []);
});

let tmp, savedPath;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-revert-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const merged = [{ number: 1232, url: "https://github.com/example/console/pull/1232", title: "fix: scope template-inheritance handlers to the caller's org (#1163)",
    body: "Related to #1163", mergedAt: "2026-10-03T13:58:01Z", commits: pr1232 }];
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const a = process.argv.slice(2);
process.stdout.write(a[0] === "pr" && a[1] === "list" ? ${JSON.stringify(JSON.stringify(merged))} : "[]");
`);
  chmodSync(join(bin, "gh"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
});
after(() => {
  process.env.PATH = savedPath;
  rmSync(tmp, { recursive: true, force: true });
});

test("findIssuesMergedToBase does not read the reverted #1164 as merged", () => {
  const p = join(tmp, "cfg.json");
  writeFileSync(p, JSON.stringify({ repos: [{ name: "console", repoPath: tmp, githubRepo: "example/console" }] }));
  const cfg = loadConfig(p).repos[0];
  assert.deepEqual(findIssuesMergedToBase(cfg, [1163, 1164], logger).map((m) => m.issueNumber), [1163]);
});
