// A build that ends with no PR must not leave its dependents waiting silently.
//
// 2026-10-26: Slashbin-Ingest-Gateway#222 (all 11 PRs fail npm ci) and
// jerky_skuvault_service#478 (all 16 already on features) ended "No PR produced"
// and stayed open and approved, so gateway#227 (S1) and skuvault#489, both
// GitHub-blocked-by them, never ran: ~13h of stall.
//
// Drives the BUILT modules; `gh` is a fake on PATH that records every call and
// serves the /dependencies/blocking list.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  announceDeadBlocker, closeAlreadyLanded, isDeadBlockerReason, deadBlockerComment, dependentRef,
} from "../dist/github/dead-blocker.js";
import { detectDeclaredLanded } from "../dist/agent.js";
import { prBlockingSkip } from "../dist/phases/implement.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let tmp, calls, dependents, savedPath, savedToken;
const cfg = { githubRepo: "o/gw", repoPath: tmp, featureBranch: "features", github: { blockedLabel: "blocked" } };

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-deadblocker-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  calls = join(tmp, "calls.jsonl");
  dependents = join(tmp, "dependents.json");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
if (a[0] === "api" && a[1].endsWith("/dependencies/blocking")) process.stdout.write(fs.readFileSync(${JSON.stringify(dependents)}, "utf8"));
`);
  chmodSync(join(bin, "gh"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  savedToken = process.env.FOREMAN_GITHUB_TOKEN;
  process.env.FOREMAN_GITHUB_TOKEN = "test-placeholder";
  cfg.repoPath = tmp;
});
after(() => {
  process.env.PATH = savedPath;
  if (savedToken === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = savedToken;
  rmSync(tmp, { recursive: true, force: true });
});
const made = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const reset = (deps) => { writeFileSync(calls, ""); writeFileSync(dependents, JSON.stringify(deps)); };
const dep = (number, state = "open", repo = "o/gw", ...labels) =>
  ({ number, state, labels: labels.map((name) => ({ name })), repository_url: `https://api.github.com/repos/${repo}` });

test("every open dependent is commented on and labelled blocked, naming the dead blocker", () => {
  reset([dep(227), dep(300, "closed"), dep(9, "open", "o/other")]);
  const r = announceDeadBlocker(cfg, 222, "all 11 PRs fail npm ci");
  assert.deepEqual(r.told.map((t) => t.ref), ["#227", "o/other#9"]);
  assert.equal(r.open, 2);
  const c = made().filter((x) => x[0] === "issue");
  const comment = c.find((x) => x[1] === "comment" && x[2] === "227");
  assert.ok(comment, "the S1 dependent was not commented on");
  assert.match(comment[comment.indexOf("--body") + 1], /o\/gw#222/);
  assert.match(comment[comment.indexOf("--body") + 1], /npm ci/);
  assert.ok(c.some((x) => x[1] === "edit" && x[2] === "227" && x.includes("--add-label") && x.includes("blocked")));
  assert.ok(c.some((x) => x[1] === "comment" && x[2] === "9" && x.includes("o/other")), "a cross-repo dependent is written in ITS repo");
  assert.ok(!c.some((x) => x[2] === "300"), "a closed dependent must be left alone");
});

test("a dependent already told is not told again; one already blocked is not relabelled", () => {
  reset([dep(227), dep(228, "open", "o/gw", "blocked")]);
  const r = announceDeadBlocker(cfg, 222, "x", ["#227"]);
  assert.deepEqual(r.told.map((t) => t.ref), ["#228"]);
  const c = made().filter((x) => x[0] === "issue");
  assert.ok(!c.some((x) => x[2] === "227"));
  assert.ok(!c.some((x) => x[1] === "edit"), "label already present");
});

test("one dependent failing does not stop the next, and the failure is returned", () => {
  reset([dep(1), dep(2)]);
  writeFileSync(join(tmp, "bin", "gh"), `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
if (a[0] === "api") process.stdout.write(fs.readFileSync(${JSON.stringify(dependents)}, "utf8"));
else if (a[2] === "1") { process.stderr.write("boom"); process.exit(1); }
`);
  const r = announceDeadBlocker(cfg, 222, "x");
  assert.deepEqual(r.told.map((t) => t.number), [2]);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].ref, "#1");
});

test("closing an already-landed issue comments the evidence, then closes as completed", () => {
  writeFileSync(calls, "");
  closeAlreadyLanded(cfg, 478, "all 16 PRs already on features");
  const c = made();
  assert.equal(c[0][1], "comment");
  assert.match(c[0][c[0].indexOf("--body") + 1], /already on features/);
  assert.deepEqual(c[1].slice(0, 2), ["issue", "close"]);
  assert.equal(c[1][c[1].indexOf("--reason") + 1], "completed");
});

test("only a cause that will not clear by itself counts as a dead blocker", () => {
  assert.equal(isDeadBlockerReason("all 11 dependency PRs fail npm ci"), true);
  assert.equal(isDeadBlockerReason("diverged from origin/features — not a fast-forward"), false);
  // The other transient wait (an open PR on the branch) is the caller's, through prBlockingSkip:
  for (const r of ["PR #88 is still open on features", "features occupied by open PR #843"]) {
    assert.notEqual(prBlockingSkip(r), null, r);
  }
  assert.equal(prBlockingSkip("all 11 dependency PRs fail npm ci"), null);
  assert.match(deadBlockerComment("o/gw#222", "r", "blocked"), /remove the `blocked` label/);
  assert.equal(dependentRef(dep(5, "open", "o/x"), "o/gw"), "o/x#5");
});

test("the landed trailer needs its issue, starts a line, and the last one wins", () => {
  assert.deepEqual(detectDeclaredLanded('x\nFOREMAN_RESULT: landed issue=478 reason="all 16 on features"'),
    { landed: true, issue: 478, reason: "all 16 on features" });
  assert.equal(detectDeclaredLanded('FOREMAN_RESULT: landed reason="no issue named"').landed, false);
  assert.equal(detectDeclaredLanded('I did not write FOREMAN_RESULT: landed issue=5 here').landed, false);
  assert.equal(detectDeclaredLanded('FOREMAN_RESULT: skipped issue=5 reason="x"').landed, false);
  assert.equal(detectDeclaredLanded('FOREMAN_RESULT: landed issue=1 reason="a"\nFOREMAN_RESULT: landed issue=2 reason="b"').issue, 2);
});

test("wiring: landed is checked before PR attribution and behind the SHA guard; skips tell dependents", () => {
  const agent = readFileSync(join(root, "src/agent.ts"), "utf-8");
  const fn = agent.slice(agent.indexOf("export async function implementApprovedIssues"), agent.indexOf("export async function revisePRFeedback"));
  const landedAt = fn.indexOf("detectDeclaredLanded(result.stdout)");
  assert.ok(landedAt > 0 && landedAt < fn.indexOf("const prMatch = result.stdout.match"));
  assert.match(fn.slice(landedAt, fn.indexOf("const declaredSkip")), /beforeSha !== afterSha/);
  const impl = readFileSync(join(root, "src/phases/implement.ts"), "utf-8");
  assert.match(impl, /actionableIssues\.includes\(result\.landedIssue\)/, "only an issue in the batch may be closed");
  assert.match(impl, /await tellDependents\(/);
});

test("a wait on an open PR is never told to dependents or labelled blocked", () => {
  const impl = readFileSync(join(root, "src/phases/implement.ts"), "utf-8");
  assert.match(impl, /isDeadBlockerReason\(reason\) && prBlockingSkip\(reason\) === null/);
});

test("a dependent is escalated under ITS repo's config, with a stuck kind the unstick stage reads", () => {
  const impl = readFileSync(join(root, "src/phases/implement.ts"), "utf-8");
  const body = impl.slice(impl.indexOf("async function tellDependents"), impl.indexOf("export async function tryBatchImplementation"));
  assert.match(body, /managed\.find\(\(r\) => r\.githubRepo === t\.repo\)/, "cross-repo dependents need their own repo config");
  assert.match(body, /stuck: "needs-ruling"/, "without a stuck kind no EM handoff is recorded (Paperclip off = nobody hears it)");
  assert.match(body, /itemOf\(home, t\.number\)/);
  assert.match(impl, /tellDependents\(skippedSet, reason, repoName, repoConfig, config\.repos, repoLogger\)/);
});

test("the landed protocol is in the COMMON prompt, so a repo-local skill hears it", () => {
  const agent = readFileSync(join(root, "src/agent.ts"), "utf-8");
  const fn = agent.slice(agent.indexOf("export async function implementApprovedIssues"), agent.indexOf("export async function revisePRFeedback"));
  const at = fn.indexOf("Nothing-to-land protocol");
  assert.ok(at > 0, "the prompt no longer teaches landed");
  assert.ok(at > fn.indexOf("Skip protocol") && at < fn.indexOf("PRIOR ATTEMPT FAILED"));
  assert.match(fn.slice(at, at + 900), /FOREMAN_RESULT: landed issue=/);
});
