// Review skill + reviewer identity per repo, with no built-in defaults (EM#425).
// Run with `npm test` after `npm run build`.
//
// The contract: a review-enabled repo needs a reviewSkillPath (from its entry or
// the global), not an EM repo; and a relative reviewSkillPath resolves against
// the directory the review session runs in — emRepoPath when set (unchanged
// behaviour), else the repo's review checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { resolveReviewSkillPath, reviewSessionCwd } from "../dist/agent.js";

for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];

const tmp = mkdtempSync(join(tmpdir(), "review-identity-"));
const repo = (extra = {}) => ({ name: "svc", repoPath: tmp, githubRepo: "o/svc", ...extra });
function load(cfg) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ reviewCheckoutRoot: join(tmp, "checkouts"), ...cfg }));
  return loadConfig(p);
}

test("a relative skill path resolves against emRepoPath when it is set", () => {
  const c = load({ reviewEnabled: true, emRepoPath: join(tmp, "em"), reviewSkillPath: ".claude/skills/review/SKILL.md", repos: [repo()] });
  assert.equal(reviewSessionCwd(c, c.repos[0]), join(tmp, "em"));
  assert.equal(resolveReviewSkillPath(c, c.repos[0]), join(tmp, "em", ".claude/skills/review/SKILL.md"));
});

test("without emRepoPath the session and a relative skill path use the repo's review checkout", () => {
  const c = load({ reviewEnabled: true, reviewSkillPath: ".claude/skills/review/SKILL.md", repos: [repo()] });
  assert.equal(c.emRepoPath, undefined);
  assert.equal(reviewSessionCwd(c, c.repos[0]), join(tmp, "checkouts", "svc"));
  assert.equal(resolveReviewSkillPath(c, c.repos[0]), join(tmp, "checkouts", "svc", ".claude/skills/review/SKILL.md"));
});

test("absolute and ~/ skill paths are taken as given", () => {
  const c = load({ reviewEnabled: true, reviewSkillPath: "/opt/review/SKILL.md",
    repos: [repo(), repo({ name: "other", reviewSkillPath: "~/skills/r/SKILL.md" })] });
  assert.equal(resolveReviewSkillPath(c, c.repos[0]), "/opt/review/SKILL.md");
  assert.equal(resolveReviewSkillPath(c, c.repos[1]), join(homedir(), "skills/r/SKILL.md"));
});

test("only the review-enabled repo needs a skill; the error names the repo", () => {
  assert.doesNotThrow(() => load({ repos: [repo({ reviewEnabled: false }), repo({ name: "b" })] }));
  assert.throws(
    () => load({ repos: [repo(), repo({ name: "b", reviewEnabled: true })] }),
    (e) => /reviewSkillPath/.test(e.message) && /"b"/.test(e.message) && !/emRepoPath/.test(e.message),
  );
});
