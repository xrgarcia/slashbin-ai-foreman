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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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

test("deliver: a stale repo gets ONE commit on feature/<N>-<slug> cut from origin/<base>, pushed, with no PR and no checkout change", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const clone = makeRepo(tmp, { ...STALE, ".claude/skills/implement-approved-issues/old.md": "gone\n" });
  const base = git(clone, "rev-parse", "origin/develop");
  put(clone, "scratch.txt", "someone's untracked file\n");
  const out = skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger());

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

test("deliver: a dirty checkout does not matter, a current repo gets nothing", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const clone = makeRepo(tmp, CURRENT);
  put(clone, "README.md", "uncommitted\n");
  const out = skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger());
  assert.equal(out.status, "current");
  assert.equal(git(join(tmp, "svc.git"), "branch", "--list", "feature/*"), "");
});

test("deliver: an existing feature/<N>-* branch (the person's, or an earlier delivery) is left alone, never pushed over", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const clone = makeRepo(tmp, STALE);
  const first = skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger());
  assert.equal(first.status, "delivered");
  // Same issue again, even with a re-worded title: the branch exists under another slug.
  const again = skillSync.deliverSkillsForIssue(cfg, repoOf(clone), { number: 42, title: "Quiz popup, reworded" }, logger());
  assert.deepEqual(again, { status: "exists", branch: first.branch });
  assert.equal(git(join(tmp, "svc.git"), "rev-parse", first.branch), first.sha, "no force, no second commit");
  // Issue 4 is not issue 42: `feature/4-*` must not match `feature/42-...`.
  assert.equal(skillSync.deliverSkillsForIssue(cfg, repoOf(clone), { number: 4, title: "Other" }, logger()).status, "delivered");
});

test("deliver: the branch is what the direct-mode skill looks for (feature/<N>-*), and an empty slug still has a dash", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const clone = makeRepo(tmp, STALE);
  const out = skillSync.deliverSkillsForIssue(cfg, repoOf(clone), { number: 9, title: "!!!" }, logger());
  assert.equal(out.branch, "feature/9-issue");
  assert.ok(git(clone, "ls-remote", "--heads", "origin", "feature/9-*").includes("refs/heads/feature/9-issue"));
});

test("deliver: an unreadable golden or a failing push is an outcome, not a throw", () => {
  const bad = cfgFor(join(tmp, "nowhere"));
  const clone = makeRepo(tmp, STALE);
  assert.equal(skillSync.deliverSkillsForIssue(bad, repoOf(clone), ISSUE, logger()).status, "skipped");
  const cfg = cfgFor(makeGolden(tmp));
  git(clone, "remote", "set-url", "--push", "origin", join(tmp, "no-such.git"));
  assert.equal(skillSync.deliverSkillsForIssue(cfg, repoOf(clone), ISSUE, logger()).status, "failed");
});

// --- The stage ---

test("the skill-deliver stage is its own lane, needs no checkout lock and spawns no session", async () => {
  const { lanesFor, stageNeedsCheckout, stageSpawnsSession } = await import(join(root, "dist", "lanes.js"));
  assert.ok(lanesFor([{ type: "implement" }, { type: "skill-deliver" }]).some((l) => l.name === "skill-deliver" && l.stages.length === 1));
  assert.equal(stageNeedsCheckout({ type: "skill-deliver" }), false);
  assert.equal(stageSpawnsSession({ type: "skill-deliver" }), false);
});

test("syncOnly: read from a repo entry; a repo without it is not sync-only", () => {
  const dir = mkTmp("skill-sync-cfg-");
  const f = join(dir, "c.json");
  const entry = (name, extra = {}) => ({ name, repoPath: dir, githubRepo: `o/${name}`, ...extra });
  writeFileSync(f, JSON.stringify({ repos: [entry("human", { syncOnly: true }), entry("foreman")] }));
  const c = loadConfig(f);
  assert.equal(c.repos.find((r) => r.name === "human").syncOnly, true);
  assert.ok(!c.repos.find((r) => r.name === "foreman").syncOnly);
});

test("stage wiring: a sync-only repo runs only skill-deliver, others never run it, and a human repo is not onboarded, mirrored or labelled", () => {
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
