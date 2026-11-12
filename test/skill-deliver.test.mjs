// Human-lane skill delivery (skill-deliver stage): the Foreman pushes the golden skills onto an
// approved-for-human issue's feature/<N>-<slug> branch, cut from origin/<base>, and touches nothing else.
//
// (Copied fixtures from skill-sync.test.mjs.) Skill sync: a repo's skill copies follow a golden source, brought current in
// the commit before the next approved issue's session — never all at once.
//
// Origin (2026-10-15): the EM's mass publish filed one PR per repo for every
// skill change, and one publish put 26 cards in the board's Review column. The
// guards here are the ones whose regression would bring that back, or worse:
// a sync made when nothing is stale, a sync that blocks an issue when it
// fails, and a config without the block that changes anything at all.
//
// Real git against temp repos: a bare origin, the Foreman's clone of it, and a
// golden repo, so the commit, the ff and the undo are exercised, not described.

import { test, beforeEach } from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ss = await import(join(root, "dist", "skill-sync.js"));
const { loadConfig } = await import(join(root, "dist", "config.js"));

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };

function logger() {
  const lines = [];
  const l = { lines };
  for (const lvl of ["info", "warn", "debug", "error"]) l[lvl] = (msg) => lines.push(`${lvl}: ${msg}`);
  l.child = () => l;
  return l;
}

const GOLDEN = {
  ".claude/skill-templates/foreman-lane/README.md": "not a skill\n",
  ".claude/skill-templates/foreman-lane/implement-approved-issues/SKILL.md": "implement v2\n",
  ".claude/skill-templates/foreman-lane/revise-pr-feedback/SKILL.md": "revise v1\n",
  ".claude/skill-templates/shared/clean-code/SKILL.md": "clean v1\n",
};

/** A golden repo with an origin, so `origin/develop` is a committed, fetched ref. */
function makeGolden(tmp) {
  const bare = join(tmp, "golden.git");
  git(tmp, "init", "--quiet", "--bare", "-b", "develop", bare);
  const work = join(tmp, "golden");
  git(tmp, "clone", "--quiet", bare, work);
  git(work, "checkout", "--quiet", "-b", "develop");
  for (const [p, t] of Object.entries(GOLDEN)) put(work, p, t);
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "golden");
  git(work, "push", "--quiet", "origin", "develop");
  return work;
}

/** A second golden (own dir) whose implement skill differs. */
function makeGoldenAt(dir, impl) {
  mkdirSync(dir, { recursive: true });
  const g = makeGolden(dir);
  put(g, ".claude/skill-templates/foreman-lane/implement-approved-issues/SKILL.md", impl);
  git(g, "add", "-A"); git(g, "commit", "--quiet", "-m", "g2"); git(g, "push", "--quiet", "origin", "develop");
  return g;
}

/** A service repo: bare origin with `develop`, and the Foreman's clone on it. */
function makeRepo(tmp, files) {
  const bare = join(tmp, "svc.git");
  git(tmp, "init", "--quiet", "--bare", "-b", "develop", bare);
  const seed = join(tmp, "seed");
  git(tmp, "clone", "--quiet", bare, seed);
  git(seed, "checkout", "--quiet", "-b", "develop");
  put(seed, "README.md", "svc\n");
  for (const [p, t] of Object.entries(files)) put(seed, p, t);
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", "origin", "develop");
  const clone = join(tmp, "svc");
  git(tmp, "clone", "--quiet", "-b", "develop", bare, clone);
  return clone;
}

const CURRENT = {
  ".claude/skills/implement-approved-issues/SKILL.md": "implement v2\n",
  ".claude/skills/revise-pr-feedback/SKILL.md": "revise v1\n",
  ".claude/skills/clean-code/SKILL.md": "clean v1\n",
};

function cfgFor(goldenPath, over = {}) {
  return ss.resolveSkillSync({
    enabled: true, source: "git", repoPath: goldenPath, ref: "origin/develop",
    dirs: [".claude/skill-templates/foreman-lane", ".claude/skill-templates/shared"],
    skills: [], targetDir: ".claude/skills", refreshMs: 300000, label: "em", ...over,
  });
}

let tmp;
let skillSync;
beforeEach(() => {
  skillSync = new ss.SkillSync();
  tmp = mkTmp("skill-sync-");
});

// --- Human lane: deliverSkillsForIssue ---

const STALE = { ".claude/skills/implement-approved-issues/SKILL.md": "implement v1\n", ".claude/skills/revise-pr-feedback/SKILL.md": "revise v1\n" };
const repoOf = (clone) => ({ name: "svc", repoPath: clone, baseBranch: "develop" });
const ISSUE = { number: 42, title: "Add the Quiz popup! (v2)" };

test("deliver: a stale repo gets ONE commit on feature/<N>-<slug> cut from origin/<base>, pushed, with no PR and no checkout change", async () => {
  const cfg = cfgFor(makeGolden(tmp));
  const clone = makeRepo(tmp, { ...STALE, ".claude/skills/implement-approved-issues/old.md": "gone\n" });
  const base = git(clone, "rev-parse", "origin/develop");
  put(clone, "scratch.txt", "someone's untracked file\n");
  const out = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger());

  assert.equal(out.status, "delivered");
  assert.equal(out.branch, "feature/42-add-the-quiz-popup-v2");
  assert.deepEqual(out.skills, ["clean-code", "implement-approved-issues"]);
  assert.match(out.subject, /^chore\(skills\): sync clean-code, implement-approved-issues from em@[0-9a-f]{7,} \(#42\)$/);
  const bare = join(tmp, "svc.git");
  assert.equal(git(bare, "rev-parse", out.branch), out.sha, "pushed");
  assert.equal(git(bare, "rev-parse", `${out.sha}~1`), base, "one commit on origin/develop's tip");
  assert.equal(git(bare, "rev-parse", "develop"), base, "the base itself is untouched");
  assert.equal(git(bare, "show", `${out.sha}:.claude/skills/implement-approved-issues/SKILL.md`), "implement v2");
  assert.equal(git(bare, "show", `${out.sha}:.claude/skills/clean-code/SKILL.md`), "clean v1");
  assert.equal(git(bare, "ls-tree", "-r", "--name-only", out.sha, ".claude/skills/implement-approved-issues/old.md"), "", "the copy is the golden: extras go");
  assert.equal(git(bare, "show", `${out.sha}:README.md`), "svc", "the rest of the tree is the base's");
  // The clone: HEAD, branch, index and working tree never moved.
  assert.equal(git(clone, "rev-parse", "HEAD"), base);
  assert.equal(git(clone, "branch", "--show-current"), "develop");
  assert.equal(git(clone, "status", "--porcelain"), "?? scratch.txt");
  assert.equal(readFileSync(join(clone, ".claude/skills/implement-approved-issues/SKILL.md"), "utf8"), "implement v1\n");
});

test("deliver: a dirty checkout does not matter, a current repo gets nothing", async () => {
  const cfg = cfgFor(makeGolden(tmp));
  const clone = makeRepo(tmp, CURRENT);
  put(clone, "README.md", "uncommitted\n");
  const out = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger());
  assert.equal(out.status, "current");
  assert.equal(git(join(tmp, "svc.git"), "branch", "--list", "feature/*"), "");
});

test("deliver: an existing feature/<N>-* branch (the person's, or an earlier delivery) is left alone, never pushed over", async () => {
  const cfg = cfgFor(makeGolden(tmp));
  const clone = makeRepo(tmp, STALE);
  const first = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger());
  assert.equal(first.status, "delivered");
  // Same issue again, even with a re-worded title: the branch exists under another slug.
  const again = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), { number: 42, title: "Quiz popup, reworded" }, logger());
  assert.deepEqual(again, { status: "exists", branch: first.branch });
  assert.equal(git(join(tmp, "svc.git"), "rev-parse", first.branch), first.sha, "no force, no second commit");
  // Issue 4 is not issue 42: `feature/4-*` must not match `feature/42-...`.
  assert.equal((await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), { number: 4, title: "Other" }, logger())).status, "delivered");
});

// --- Refreshing an untouched delivery branch ---

const noPr = async () => [];
/** Golden moves on: the base is still stale, and the branch (delivered earlier) carries the older golden. */
async function deliveredThenGoldenMoves(over = {}) {
  const golden = makeGolden(tmp);
  const cfg = cfgFor(golden, over);
  const clone = makeRepo(tmp, STALE);
  const first = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger());
  assert.equal(first.status, "delivered");
  put(golden, ".claude/skill-templates/foreman-lane/implement-approved-issues/SKILL.md", "implement v3\n");
  put(golden, ".claude/skill-templates/shared/ship/SKILL.md", "ship v1\n");
  git(golden, "add", "-A"); git(golden, "commit", "--quiet", "-m", "golden v3"); git(golden, "push", "--quiet", "origin", "develop");
  skillSync = new ss.SkillSync(); // the golden is cached per instance; a new one reads the moved source
  return { cfg, clone, first, bare: join(tmp, "svc.git") };
}

test("refresh: an untouched Foreman delivery with stale skills and no PR is rebuilt as one fresh commit on origin/<base>", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const lg = logger();
  const out = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, lg, noPr);
  assert.equal(out.status, "refreshed", lg.lines.join("\n"));
  assert.equal(out.branch, first.branch);
  assert.notEqual(out.sha, first.sha);
  assert.equal(git(bare, "rev-parse", first.branch), out.sha);
  assert.equal(git(bare, "rev-parse", `${out.sha}~1`), git(bare, "rev-parse", "develop"), "one commit on the base's tip");
  assert.equal(git(bare, "show", `${out.sha}:.claude/skills/implement-approved-issues/SKILL.md`), "implement v3");
  assert.equal(git(bare, "show", `${out.sha}:.claude/skills/ship/SKILL.md`), "ship v1");
  // Run again: the branch is now current, nothing more happens.
  assert.deepEqual(await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), noPr), { status: "exists", branch: first.branch });
  assert.equal(git(bare, "rev-parse", first.branch), out.sha);
});

test("refresh: an untouched delivery that already carries the current golden is left alone", async () => {
  const cfg = cfgFor(makeGolden(tmp));
  const clone = makeRepo(tmp, STALE);
  const first = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger());
  const out = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), noPr);
  assert.deepEqual(out, { status: "exists", branch: first.branch });
  assert.equal(git(join(tmp, "svc.git"), "rev-parse", first.branch), first.sha);
});

test("refresh: a human commit on the branch (or a merge of the base) means it is not touched", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const work = join(tmp, "person");
  git(tmp, "clone", "--quiet", "-b", first.branch, bare, work);
  put(work, "feature.txt", "the person's work\n");
  git(work, "add", "-A"); git(work, "commit", "--quiet", "-m", "wip: the actual feature");
  git(work, "push", "--quiet", "origin", first.branch);
  const tip = git(bare, "rev-parse", first.branch);
  assert.deepEqual(await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), noPr), { status: "exists", branch: first.branch });
  assert.equal(git(bare, "rev-parse", first.branch), tip);
});

test("refresh: a person's work amended into the delivery commit, metadata unchanged, is not overwritten", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const work = join(tmp, "amender");
  git(tmp, "clone", "--quiet", "-b", first.branch, bare, work);
  put(work, "feature.txt", "the person's work\n");
  git(work, "add", "-A"); git(work, "commit", "--quiet", "--amend", "--no-edit");
  git(work, "push", "--quiet", "--force", "origin", first.branch);
  const tip = git(bare, "rev-parse", first.branch);
  assert.deepEqual(await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), noPr), { status: "exists", branch: first.branch });
  assert.equal(git(bare, "rev-parse", first.branch), tip);
  assert.equal(git(bare, "show", `${tip}:feature.txt`), "the person's work");
});

test("refresh: a skill a person amended into the delivery commit, under the skills directory, is not overwritten (Tech Lead S1 on #296)", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const work = join(tmp, "skill-amender");
  git(tmp, "clone", "--quiet", "-b", first.branch, bare, work);
  put(work, ".claude/skills/team-helper/SKILL.md", "the team's own skill\n");
  git(work, "add", "-A"); git(work, "commit", "--quiet", "--amend", "--no-edit");
  git(work, "push", "--quiet", "--force", "origin", first.branch);
  const tip = git(bare, "rev-parse", first.branch);
  assert.deepEqual(await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), noPr), { status: "exists", branch: first.branch });
  assert.equal(git(bare, "rev-parse", first.branch), tip);
  assert.equal(git(bare, "show", `${tip}:.claude/skills/team-helper/SKILL.md`), "the team's own skill");
});

/** Strips the Foreman-Tree line, keeping author, subject and marker: a delivery made before the tree was recorded. */
function asLegacy(bare, branch, name) {
  const work = join(tmp, name);
  git(tmp, "clone", "--quiet", "-b", branch, bare, work);
  const msg = git(work, "log", "-1", "--format=%B").split("\n").filter((l) => !l.startsWith("Foreman-Tree:")).join("\n");
  git(work, "commit", "--quiet", "--amend", "-m", msg);
  git(work, "push", "--quiet", "--force", "origin", branch);
  return work;
}

test("refresh: a pristine delivery from before the tree was recorded is refreshed (Tech Lead S2 on #296)", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  asLegacy(bare, first.branch, "legacy-pristine");
  const lg = logger();
  const out = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, lg, noPr);
  assert.equal(out.status, "refreshed", lg.lines.join("\n"));
  assert.equal(git(bare, "show", `${out.sha}:.claude/skills/implement-approved-issues/SKILL.md`), "implement v3");
  assert.equal(git(bare, "show", `${out.sha}:.claude/skills/ship/SKILL.md`), "ship v1");
});

test("refresh: a pre-tree delivery a person added a skill to is not overwritten", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const work = asLegacy(bare, first.branch, "legacy-amended");
  put(work, ".claude/skills/team-helper/SKILL.md", "the team's own skill\n");
  git(work, "add", "-A"); git(work, "commit", "--quiet", "--amend", "--no-edit");
  git(work, "push", "--quiet", "--force", "origin", first.branch);
  const tip = git(bare, "rev-parse", first.branch);
  assert.deepEqual(await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), noPr), { status: "exists", branch: first.branch });
  assert.equal(git(bare, "rev-parse", first.branch), tip);
});

test("refresh: a pre-tree delivery a person added a golden skill outside the selection to is not overwritten (Tech Lead S1 on #298)", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves({ skills: ["implement-approved-issues"] });
  const work = asLegacy(bare, first.branch, "legacy-outside-selection");
  put(work, ".claude/skills/revise-pr-feedback/SKILL.md", "the person's copy\n");
  git(work, "add", "-A"); git(work, "commit", "--quiet", "--amend", "--no-edit");
  git(work, "push", "--quiet", "--force", "origin", first.branch);
  const tip = git(bare, "rev-parse", first.branch);
  assert.deepEqual(await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), noPr), { status: "exists", branch: first.branch });
  assert.equal(git(bare, "rev-parse", first.branch), tip);
});

test("refresh: a pristine pre-tree delivery that deleted an obsolete skill file is refreshed (Tech Lead S2 on #298)", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const work = asLegacy(bare, first.branch, "legacy-deletion");
  // The delivery also removed a file the golden had dropped: rewrite it on a base that still carried that file.
  git(work, "reset", "--quiet", "--soft", "HEAD~1");
  git(work, "stash", "--quiet");
  put(work, ".claude/skills/implement-approved-issues/old.md", "obsolete\n");
  git(work, "add", "-A"); git(work, "commit", "--quiet", "-m", "base carried old.md");
  git(work, "push", "--quiet", "origin", "HEAD:develop");
  git(work, "stash", "pop", "--quiet");
  git(work, "rm", "--quiet", ".claude/skills/implement-approved-issues/old.md");
  const legacyMsg = git(bare, "log", "-1", "--format=%B", first.branch);
  const author = git(bare, "log", "-1", "--format=%an <%ae>", first.branch);
  git(work, "add", "-A"); git(work, "commit", "--quiet", "--author", author, "-m", legacyMsg);
  git(work, "push", "--quiet", "--force", "origin", `HEAD:${first.branch}`);
  git(clone, "fetch", "--quiet", "origin");
  const lg = logger();
  const out = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, lg, noPr);
  assert.equal(out.status, "refreshed", lg.lines.join("\n"));
  assert.equal(git(bare, "show", `${out.sha}:.claude/skills/implement-approved-issues/SKILL.md`), "implement v3");
});

test("refresh: a file a person added inside a delivered skill's directory, amended in, is not overwritten", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const work = join(tmp, "skill-editor");
  git(tmp, "clone", "--quiet", "-b", first.branch, bare, work);
  put(work, ".claude/skills/implement-approved-issues/notes.md", "local notes\n");
  git(work, "add", "-A"); git(work, "commit", "--quiet", "--amend", "--no-edit");
  git(work, "push", "--quiet", "--force", "origin", first.branch);
  const tip = git(bare, "rev-parse", first.branch);
  assert.deepEqual(await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), noPr), { status: "exists", branch: first.branch });
  assert.equal(git(bare, "rev-parse", first.branch), tip);
});

test("refresh: the PR lookup omits --base for null and keeps it for a named base (gh is a recorder)", async () => {
  const { allPrsForBranch } = await import(join(root, "dist", "github", "core-reads.js"));
  const bin = mkTmp("skill-deliver-gh-");
  const log = join(bin, "args.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\necho '[{"number":9,"state":"OPEN"}]'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const oldPath = process.env.PATH;
  process.env.FOREMAN_GITHUB_TOKEN ??= "test-token-not-real";
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    assert.deepEqual(await allPrsForBranch("o/r", "feature/1-x", null, tmp), [{ number: 9, state: "OPEN" }]);
    await allPrsForBranch("o/r", "feature/1-x", "develop", tmp);
  } finally { process.env.PATH = oldPath; }
  const [anyBase, named] = readFileSync(log, "utf8").trim().split("\n");
  assert.doesNotMatch(anyBase, /--base/);
  assert.match(anyBase, /--head feature\/1-x/);
  assert.match(named, /--base develop/);
});

test("refresh: the stage asks for a PR from the branch into ANY base, and a PR it finds stops the refresh", async () => {
  const { startGitHubWorkSource } = await import("./agent-plugins.mjs");
  const { codeHost } = await import(join(root, "dist", "plugins", "registry.js"));
  const { trySkillDeliver } = await import(join(root, "dist", "phases", "skill-deliver.js"));
  process.env.FOREMAN_GITHUB_TOKEN ??= "test-token-not-real";
  await startGitHubWorkSource();
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const host = codeHost();
  const real = { getOpenIssues: host.getOpenIssues, hasLabel: host.hasLabel, allPrsForBranch: host.allPrsForBranch };
  const asked = [];
  let prs = [{ number: 7, state: "MERGED" }];
  host.getOpenIssues = async () => [{ number: ISSUE.number, title: ISSUE.title }];
  host.hasLabel = () => true;
  host.allPrsForBranch = async (...args) => { asked.push(args); return prs; };
  try {
    const repoConfig = { ...repoOf(clone), githubRepo: "o/svc", syncOnly: true };
    const config = { skillSync: cfg };
    assert.equal(await trySkillDeliver({ skillSync }, repoConfig, config, logger(), []), 0);
    assert.deepEqual(asked, [["o/svc", first.branch, null, clone]], "any base: null, never the configured base");
    assert.equal(git(bare, "rev-parse", first.branch), first.sha, "a PR into another base still leaves the branch alone");
    prs = [];
    assert.equal(await trySkillDeliver({ skillSync }, repoConfig, config, logger(), []), 1);
    assert.notEqual(git(bare, "rev-parse", first.branch), first.sha, "no PR in any base: refreshed");
  } finally { Object.assign(host, real); }
});

test("refresh: a sync-looking commit by someone else is not the Foreman's", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const out = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), noPr);
  assert.equal(out.status, "refreshed");
  skillSync = new ss.SkillSync();
  const other = { ...env, GIT_AUTHOR_NAME: "Someone", GIT_AUTHOR_EMAIL: "s@s", GIT_COMMITTER_NAME: "Someone", GIT_COMMITTER_EMAIL: "s@s" };
  const work = join(tmp, "person2");
  git(tmp, "clone", "--quiet", "-b", first.branch, bare, work);
  execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "chore(skills): sync x from y@z (#42)", "-m", "Copied byte for byte by the Foreman's skill sync (src/skill-sync.ts) onto this issue's branch,"], { cwd: work, env: other });
  git(work, "push", "--quiet", "origin", first.branch);
  // Make the golden move again so the branch is stale.
  const tip = git(bare, "rev-parse", first.branch);
  const cfg2 = cfgFor(makeGoldenAt(join(tmp, "g2"), "implement v9\n"));
  assert.deepEqual(await skillSync.deliverSkillsForIssue(cfg2, repoOf(clone), ISSUE, logger(), noPr), { status: "exists", branch: first.branch });
  assert.equal(git(bare, "rev-parse", first.branch), tip);
});

test("refresh: a PR from the branch (open, merged or closed), an unreadable PR list, or no PR lookup means it is not touched", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  for (const prs of [async () => [{ number: 7, state: "OPEN" }], async () => [{ number: 7, state: "MERGED" }], async () => { throw new Error("gh down"); }, undefined]) {
    assert.deepEqual(await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), prs), { status: "exists", branch: first.branch });
    assert.equal(git(bare, "rev-parse", first.branch), first.sha);
  }
});

test("refresh: the push is a lease on the sha read, so a commit that lands in between wins", async () => {
  const { cfg, clone, first, bare } = await deliveredThenGoldenMoves();
  const work = join(tmp, "racer");
  git(tmp, "clone", "--quiet", "-b", first.branch, bare, work);
  put(work, "late.txt", "late\n");
  git(work, "add", "-A"); git(work, "commit", "--quiet", "-m", "late human commit");
  const lateSha = git(work, "rev-parse", "HEAD");
  // The PR lookup is the last step before the push: the human pushes during it.
  const prs = async () => { git(work, "push", "--quiet", "origin", first.branch); return []; };
  const out = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger(), prs);
  assert.equal(out.status, "exists");
  assert.equal(git(bare, "rev-parse", first.branch), lateSha);
});

test("deliver: the branch is what the direct-mode skill looks for (feature/<N>-*), and an empty slug still has a dash", async () => {
  const cfg = cfgFor(makeGolden(tmp));
  const clone = makeRepo(tmp, STALE);
  const out = await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), { number: 9, title: "!!!" }, logger());
  assert.equal(out.branch, "feature/9-issue");
  assert.ok(git(clone, "ls-remote", "--heads", "origin", "feature/9-*").includes("refs/heads/feature/9-issue"));
});

test("deliver: an unreadable golden or a failing push is an outcome, not a throw", async () => {
  const bad = cfgFor(join(tmp, "nowhere"));
  const clone = makeRepo(tmp, STALE);
  assert.equal((await skillSync.deliverSkillsForIssue(bad, repoOf(clone), ISSUE, logger())).status, "skipped");
  const cfg = cfgFor(makeGolden(tmp));
  git(clone, "remote", "set-url", "--push", "origin", join(tmp, "no-such.git"));
  assert.equal((await skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger())).status, "failed");
});

// --- The stage ---

test("the skill-deliver stage is its own lane, needs no checkout lock and spawns no session", async () => {
  const { lanesFor, stageNeedsCheckout, stageSpawnsSession } = await import(join(root, "dist", "lanes.js"));
  assert.ok(lanesFor([{ type: "implement" }, { type: "skill-deliver" }]).some((l) => l.name === "skill-deliver" && l.stages.length === 1));
  assert.equal(stageNeedsCheckout({ type: "skill-deliver" }), false);
  assert.equal(stageSpawnsSession({ type: "skill-deliver" }), false);
});

test("syncOnly: read from a repo entry; a repo without it is not sync-only", async () => {
  const dir = mkTmp("skill-sync-cfg-");
  const f = join(dir, "c.json");
  const entry = (name, extra = {}) => ({ name, repoPath: dir, githubRepo: `o/${name}`, ...extra });
  writeFileSync(f, JSON.stringify({ repos: [entry("human", { syncOnly: true }), entry("foreman")] }));
  const c = loadConfig(f);
  assert.equal(c.repos.find((r) => r.name === "human").syncOnly, true);
  assert.ok(!c.repos.find((r) => r.name === "foreman").syncOnly);
});

test("stage wiring: a sync-only repo runs only skill-deliver, others never run it, and a human repo is not onboarded, mirrored or labelled", async () => {
  const orch = readFileSync(join(root, "src", "orchestrator.ts"), "utf8");
  assert.match(orch, /!!repoConfig\.syncOnly !== delivers\) return \{ processed: 0/);
  assert.ok(orch.indexOf("!!repoConfig.syncOnly !== delivers") < orch.indexOf("onboardRepo"), "the sync-only gate runs before onboarding");
  assert.match(orch, /if \(!repoConfig\.syncOnly\) \{\s*if \(config\.onboarding[\s\S]*?importLegacyRecords/, "onboarding and the records import are skipped for a sync-only repo");
  assert.match(orch, /!repoConfig\.syncOnly && \(snapshot === "always"/, "a sync-only lane pass publishes no board snapshot");
  assert.match(readFileSync(join(root, "src", "work-source.ts"), "utf8"), /if \(repoConfig\.syncOnly\) return;/, "publishSnapshot itself refuses a sync-only repo");
  const stage = readFileSync(join(root, "src", "phases", "skill-deliver.ts"), "utf8");
  assert.doesNotMatch(stage, /addLabel|createPR|commentOnIssue|advance\(|emit\(/, "the human lane gets no PR, label, comment or card move");
  assert.match(readFileSync(join(root, "src", "plugins", "paperclip.ts"), "utf8"), /filter\(\(r\) => !r\.syncOnly\)/);
});
