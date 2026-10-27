// Skill sync: a repo's skill copies follow a golden source, brought current in
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

/** A service repo: bare origin with `features`, and the Foreman's clone on it. */
function makeRepo(tmp, files) {
  const bare = join(tmp, "svc.git");
  git(tmp, "init", "--quiet", "--bare", "-b", "features", bare);
  const seed = join(tmp, "seed");
  git(tmp, "clone", "--quiet", bare, seed);
  git(seed, "checkout", "--quiet", "-b", "features");
  put(seed, "README.md", "svc\n");
  for (const [p, t] of Object.entries(files)) put(seed, p, t);
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", "origin", "features");
  const clone = join(tmp, "svc");
  git(tmp, "clone", "--quiet", "-b", "features", bare, clone);
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
beforeEach(() => {
  ss.resetSkillSyncCache();
  tmp = mkdtempSync(join(tmpdir(), "skill-sync-"));
});

// --- Drift detection ---

test("the golden reads committed skills only: a README beside them is not a skill", () => {
  const g = ss.readGolden(cfgFor(makeGolden(tmp)));
  assert.deepEqual([...g.skills.keys()].sort(), ["clean-code", "implement-approved-issues", "revise-pr-feedback"]);
  assert.equal(g.origin.get("clean-code"), ".claude/skill-templates/shared/clean-code");
});

test("the golden is the committed ref, never the working tree", () => {
  const golden = makeGolden(tmp);
  put(golden, ".claude/skill-templates/shared/clean-code/SKILL.md", "an unreviewed edit\n");
  const g = ss.readGolden(cfgFor(golden));
  assert.equal(g.skills.get("clean-code").get("SKILL.md").toString(), "clean v1\n");
});

test("drift: equal, stale, missing, and an extra file in the copy", () => {
  const g = ss.readGolden(cfgFor(makeGolden(tmp)));
  const names = ["implement-approved-issues", "revise-pr-feedback", "clean-code"];
  const files = (o) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
  const drift = ss.compareSkills(g, names, new Map([
    ["implement-approved-issues", files({ "SKILL.md": "implement v2\n" })],
    ["revise-pr-feedback", files({ "SKILL.md": "revise v0\n" })],
  ]));
  assert.deepEqual(drift, [
    { skill: "implement-approved-issues", state: "current" },
    { skill: "revise-pr-feedback", state: "stale" },
    { skill: "clean-code", state: "missing" },
  ]);
  const extra = ss.compareSkills(g, ["clean-code"], new Map([["clean-code", files({ "SKILL.md": "clean v1\n", "notes.md": "x" })]]));
  assert.deepEqual(extra, [{ skill: "clean-code", state: "stale" }], "a file the golden lacks makes the copy stale");
});

test("drift is read from the feature branch on origin, and logged once per golden version", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, { ...CURRENT, ".claude/skills/implement-approved-issues/SKILL.md": "implement v1\n" });
  const drift = ss.driftAt(repo, "origin/features", cfg, ss.readGolden(cfg), ["implement-approved-issues", "clean-code"]);
  assert.equal(ss.describeDrift(drift), "implement-approved-issues (stale)");

  const log = logger();
  const r = { name: "svc", repoPath: repo, featureBranch: "features" };
  ss.noticeSkillDrift(cfg, r, log);
  ss.noticeSkillDrift(cfg, r, log);
  assert.equal(log.lines.filter((l) => l.includes("Skill drift")).length, 1, "a poll that sees the same drift says nothing new");
});

// --- The sync ---

test("a stale copy is synced in one local commit naming the issue, byte for byte", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, {
    ".claude/skills/implement-approved-issues/SKILL.md": "implement v1\n",
    ".claude/skills/implement-approved-issues/old-notes.md": "gone after sync\n",
    ".claude/skills/revise-pr-feedback/SKILL.md": "revise v1\n",
    ".claude/skills/local-only/SKILL.md": "not in the golden — left alone\n",
  });
  const before = git(repo, "rev-parse", "HEAD");
  const out = ss.syncSkillsForIssue(cfg, { name: "svc", repoPath: repo, featureBranch: "features" }, [42], logger());

  assert.equal(out.status, "synced");
  assert.deepEqual(out.skills, ["clean-code", "implement-approved-issues"]);
  assert.match(out.subject, /^chore\(skills\): sync clean-code, implement-approved-issues from em@[0-9a-f]{7,} \(#42\)$/);
  assert.equal(git(repo, "rev-parse", "HEAD~1"), before, "exactly one commit");
  assert.equal(git(repo, "log", "-1", "--format=%s"), out.subject);
  assert.equal(git(repo, "rev-parse", "origin/features"), before, "the sync is not pushed alone — it rides the issue's push");
  assert.equal(readFileSync(join(repo, ".claude/skills/implement-approved-issues/SKILL.md"), "utf8"), "implement v2\n");
  assert.equal(readFileSync(join(repo, ".claude/skills/clean-code/SKILL.md"), "utf8"), "clean v1\n");
  assert.ok(!existsSync(join(repo, ".claude/skills/implement-approved-issues/old-notes.md")), "the copy is the golden: extras go");
  assert.ok(existsSync(join(repo, ".claude/skills/local-only/SKILL.md")), "a skill the golden does not carry is not touched");
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=no"), "");
});

test("no commit when the copy is already current", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, CURRENT);
  const before = git(repo, "rev-parse", "HEAD");
  const out = ss.syncSkillsForIssue(cfg, { name: "svc", repoPath: repo, featureBranch: "features" }, [7], logger());
  assert.equal(out.status, "current");
  assert.equal(git(repo, "rev-parse", "HEAD"), before);
});

test("a batch of several issues names none: a guessed number would mislink the PR", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, {});
  const out = ss.syncSkillsForIssue(cfg, { name: "svc", repoPath: repo, featureBranch: "features" }, [1, 2], logger());
  assert.equal(out.status, "synced");
  assert.doesNotMatch(out.subject, /#\d/);
});

test("a repo's own list narrows the sync; [] opts it out", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, {});
  const r = { name: "svc", repoPath: repo, featureBranch: "features" };
  assert.equal(ss.syncSkillsForIssue(cfg, { ...r, skillSyncSkills: [] }, [3], logger()).status, "current");
  const out = ss.syncSkillsForIssue(cfg, { ...r, skillSyncSkills: ["clean-code"] }, [3], logger());
  assert.deepEqual(out.skills, ["clean-code"]);
});

test("the sync builds on origin's tip: a clone behind origin is fast-forwarded first", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, CURRENT);
  const seed = join(tmp, "seed");
  put(seed, "src.txt", "someone else's work\n");
  put(seed, ".claude/skills/clean-code/SKILL.md", "clean v0\n");
  git(seed, "commit", "--quiet", "-am", "x");
  git(seed, "add", "-A"); git(seed, "commit", "--quiet", "-m", "y", "--allow-empty");
  git(seed, "push", "--quiet", "origin", "features");
  const out = ss.syncSkillsForIssue(cfg, { name: "svc", repoPath: repo, featureBranch: "features" }, [9], logger());
  assert.equal(out.status, "synced");
  assert.equal(git(repo, "rev-parse", "HEAD~1"), git(repo, "rev-parse", "origin/features"));
  assert.ok(existsSync(join(repo, "src.txt")));
});

// --- Failure proceeds without a sync ---

test("an unreadable golden skips the sync and never throws", () => {
  const repo = makeRepo(tmp, {});
  const before = git(repo, "rev-parse", "HEAD");
  const log = logger();
  const cfg = cfgFor(join(tmp, "nowhere"));
  const out = ss.syncSkillsForIssue(cfg, { name: "svc", repoPath: repo, featureBranch: "features" }, [5], log);
  assert.equal(out.status, "skipped");
  assert.equal(git(repo, "rev-parse", "HEAD"), before);
  assert.ok(log.lines.some((l) => l.startsWith("warn: Skill sync: golden source unreadable")));
});

test("a checkout with someone's uncommitted change is left alone", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, {});
  put(repo, "README.md", "uncommitted\n");
  const before = git(repo, "rev-parse", "HEAD");
  const out = ss.syncSkillsForIssue(cfg, { name: "svc", repoPath: repo, featureBranch: "features" }, [5], logger());
  assert.equal(out.status, "skipped");
  assert.equal(git(repo, "rev-parse", "HEAD"), before);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "uncommitted\n");
});

test("a git failure mid-sync is a failed outcome, not a thrown one, and the index is clean", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, {});
  rmSync(join(tmp, "svc.git"), { recursive: true, force: true }); // origin gone: the fetch fails
  const log = logger();
  const out = ss.syncSkillsForIssue(cfg, { name: "svc", repoPath: repo, featureBranch: "features" }, [5], log);
  assert.equal(out.status, "failed");
  assert.ok(log.lines.some((l) => l.startsWith("warn: Skill sync failed — implementing on the existing skill")));
  assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
});

// --- After the session ---

test("a sync the session did not push is taken back off the local branch", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, {});
  const before = git(repo, "rev-parse", "HEAD");
  const r = { name: "svc", repoPath: repo, featureBranch: "features" };
  const out = ss.syncSkillsForIssue(cfg, r, [5], logger());
  ss.settleSkillSync(r, out, logger());
  assert.equal(git(repo, "rev-parse", "HEAD"), before, "no stray (#5) headline is left for another issue's push");
  assert.ok(!existsSync(join(repo, ".claude/skills/clean-code/SKILL.md")));
});

test("a sync pushed with the work stays", () => {
  const cfg = cfgFor(makeGolden(tmp));
  const repo = makeRepo(tmp, {});
  const r = { name: "svc", repoPath: repo, featureBranch: "features" };
  const out = ss.syncSkillsForIssue(cfg, r, [5], logger());
  put(repo, "work.txt", "the issue's work\n");
  git(repo, "add", "work.txt"); git(repo, "commit", "--quiet", "-m", "feat: work (#5)");
  git(repo, "push", "--quiet", "origin", "features");
  ss.settleSkillSync(r, out, logger());
  assert.equal(git(repo, "rev-parse", "HEAD~1"), out.sha);
});

// --- Default off ---

test("default config: skill sync is off, and an off config touches nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-sync-cfg-"));
  const repo = makeRepo(tmp, {});
  const cfgPath = join(dir, ".ai-agent.json");
  writeFileSync(cfgPath, JSON.stringify({ repoPath: repo, githubRepo: "o/svc" }));
  const saved = { e: process.env.AI_AGENT_SKILL_SYNC_ENABLED, p: process.env.AI_AGENT_SKILL_SYNC_REPO_PATH };
  delete process.env.AI_AGENT_SKILL_SYNC_ENABLED; delete process.env.AI_AGENT_SKILL_SYNC_REPO_PATH;
  try {
    const config = loadConfig(cfgPath);
    assert.equal(config.skillSync.enabled, false);
    assert.equal(config.skillSync.source, "builtin");
    const log = logger();
    const before = git(repo, "rev-parse", "HEAD");
    ss.noticeSkillDrift(config.skillSync, config.repos[0], log);
    assert.deepEqual(log.lines, []);
    assert.equal(git(repo, "rev-parse", "HEAD"), before);
  } finally {
    if (saved.e !== undefined) process.env.AI_AGENT_SKILL_SYNC_ENABLED = saved.e;
    if (saved.p !== undefined) process.env.AI_AGENT_SKILL_SYNC_REPO_PATH = saved.p;
  }
});

test("the implement phase calls the sync only when enabled, before the session, and settles it after", () => {
  const src = readFileSync(join(root, "src/phases/implement.ts"), "utf8");
  const sync = src.indexOf("if (config.skillSync?.enabled) skillSync = syncSkillsForIssue(");
  const session = src.indexOf("await implementApprovedIssues(");
  const settle = src.indexOf("if (skillSync) settleSkillSync(");
  assert.ok(sync > 0 && sync < session, "the copy must be fresh before the session reads it");
  assert.ok(settle > session, "settled once the session ends");
  const revise = readFileSync(join(root, "src/phases/revise.ts"), "utf8");
  assert.doesNotMatch(revise, /skill-sync|syncSkills/, "no sync in revise: a revision answers review on the skill it was built with");
});

test("a git source without a checkout or directories is refused at load", () => {
  const base = { enabled: true, source: "git", ref: "origin/develop", dirs: [], skills: [], targetDir: ".claude/skills", refreshMs: 1 };
  assert.throws(() => ss.resolveSkillSync(base), /repoPath/);
  assert.throws(() => ss.resolveSkillSync({ ...base, repoPath: "/x" }), /dirs/);
  assert.equal(ss.resolveSkillSync({ ...base, enabled: false }).enabled, false, "an off block is never checked");
});

test("the builtin source reads the package's own skills", () => {
  const g = ss.readGolden(ss.resolveSkillSync({ enabled: true, source: "builtin", ref: "x", dirs: [], skills: [], targetDir: ".claude/skills", refreshMs: 1 }));
  assert.ok(g.skills.has("implement") && g.skills.has("revise"));
  assert.equal(g.label, "slashbin-ai-agent");
});
