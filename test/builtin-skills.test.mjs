// `skillPath: "builtin:"` / `revisionSkillPath: "builtin:"` select the generic
// skills shipped in skills/, and an optional overlay file is appended after the
// skill. A repo-local skillPath must keep producing exactly the prompt it did.
//
// Runs the BUILT implement / revise entry points with fake `claude` and `gh`
// first on PATH; the fake claude records the prompt it was given. Nothing
// reaches GitHub or Anthropic.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { implementApprovedIssues, revisePRFeedback } = await import(join(root, "dist/agent.js"));
const { loadConfig } = await import(join(root, "dist/config.js"));
const { createLogger } = await import(join(root, "dist/logger.js"));
const logger = createLogger({ format: "text", level: "error" });

let tmp, capture, repoDir, savedPath, savedToken;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-builtin-skills-"));
  const bin = join(tmp, "bin");
  capture = join(tmp, "prompt.txt");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"),
    `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(capture)}, process.argv[3]);\n` +
    `process.stdout.write("done\\n");\n`);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n");
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  savedPath = process.env.PATH;
  savedToken = process.env.FOREMAN_GITHUB_TOKEN;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-dummy";
  repoDir = join(tmp, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "overlay.md"), "OVERLAY-RULE: run the extra check\n");
});

after(() => {
  process.env.PATH = savedPath;
  if (savedToken === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = savedToken;
  rmSync(tmp, { recursive: true, force: true });
});

const repo = (extra) => {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    repos: [{ name: "t", repoPath: repoDir, githubRepo: "example/t", featureBranch: "work", baseBranch: "trunk", ...extra }],
  }));
  return loadConfig(p).repos[0];
};

const promptOf = async (fn) => {
  rmSync(capture, { force: true });
  const result = await fn();
  return { result, prompt: existsSync(capture) ? readFileSync(capture, "utf8") : null };
};

const firstLine = (file) =>
  readFileSync(join(root, file), "utf8").split("\n").find((l) => l.startsWith("# "));

test("builtin: inlines the shipped implement skill with the repo's branches", async () => {
  const { prompt } = await promptOf(() => implementApprovedIssues(repo({ skillPath: "builtin:" }), logger));
  assert.ok(prompt, "claude was not launched");
  assert.ok(prompt.includes(firstLine("skills/implement/SKILL.md")), "the built-in skill text is not in the prompt");
  assert.match(prompt, /Feature branch: work\. Pull requests target: trunk\./);
  assert.ok(!prompt.includes("Read and follow the skill at builtin:"), "builtin: was passed through as a literal path");
  assert.match(prompt, /FOREMAN_RESULT: skipped issue=/, "the skip protocol must still follow the skill");
});

test("builtin: inlines the shipped revise skill", async () => {
  const { prompt } = await promptOf(() => revisePRFeedback(repo({ revisionSkillPath: "builtin:" }), logger, undefined, 7, [3]));
  assert.ok(prompt.includes(firstLine("skills/revise/SKILL.md")));
  assert.match(prompt, /FOREMAN_REVISION no-commit/, "the no-commit trailer contract must survive");
});

test("an overlay is appended after the skill, before the skip protocol", async () => {
  const { prompt } = await promptOf(() =>
    implementApprovedIssues(repo({ skillPath: "builtin:", skillOverlayPath: "overlay.md" }), logger));
  const skillAt = prompt.indexOf("===== END SKILL =====");
  const overlayAt = prompt.indexOf("OVERLAY-RULE");
  const skipAt = prompt.indexOf("Skip protocol");
  assert.ok(skillAt > -1 && overlayAt > skillAt && skipAt > overlayAt, `skill@${skillAt} overlay@${overlayAt} skip@${skipAt}`);
});

test("a revise overlay is appended too", async () => {
  const { prompt } = await promptOf(() =>
    revisePRFeedback(repo({ revisionSkillPath: "builtin:", revisionSkillOverlayPath: "overlay.md" }), logger, undefined, 7, [3]));
  assert.ok(prompt.indexOf("OVERLAY-RULE") > prompt.indexOf("===== END SKILL ====="));
});

test("a configured overlay that cannot be read stops the run before claude starts", async () => {
  for (const [fn, extra] of [
    [(c) => implementApprovedIssues(c, logger), { skillPath: "builtin:", skillOverlayPath: "missing.md" }],
    [(c) => revisePRFeedback(c, logger, undefined, 7, [3]), { revisionSkillPath: "builtin:", revisionSkillOverlayPath: "missing.md" }],
  ]) {
    const { result, prompt } = await promptOf(() => fn(repo(extra)));
    assert.equal(prompt, null, "claude was launched without the overlay");
    assert.equal(result.success, false);
    assert.match(result.error, /missing\.md/);
  }
});

test("a repo-local skillPath produces the same prompt opening as before", async () => {
  const { prompt } = await promptOf(() =>
    implementApprovedIssues(repo({ skillPath: ".claude/skills/implement-approved-issues/SKILL.md" }), logger));
  assert.ok(prompt.startsWith(
    "Read and follow the skill at .claude/skills/implement-approved-issues/SKILL.md.\n\nImplement all approved issues for this repository."));
  assert.ok(!prompt.includes("===== SKILL ====="));
});

test("the shipped skills name no label and no operator", () => {
  const dir = join(root, "skills");
  const files = readdirSync(dir).map((d) => join(dir, d, "SKILL.md"));
  assert.ok(files.length >= 2);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/--label [^"$]|--label "[^$]/.test(text), `${f} passes a literal label to --label`);
    assert.ok(!/mcp__/.test(text), `${f} names an MCP tool, which only one operator's session has`);
    assert.match(text, /FOREMAN_(TRIGGER_LABEL|LIFECYCLE_LABELS)/, `${f} must read labels from the environment`);
  }
});
