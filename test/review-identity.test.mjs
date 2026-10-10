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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";

for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];

const tmp = mkdtempSync(join(tmpdir(), "review-identity-"));
const repo = (extra = {}) => ({ name: "svc", repoPath: tmp, githubRepo: "o/svc", ...extra });
function load(cfg) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ reviewCheckoutRoot: join(tmp, "checkouts"), ...cfg }));
  return loadConfig(p);
}

test("only the review-enabled repo needs a skill; the error names the repo", () => {
  assert.doesNotThrow(() => load({ repos: [repo({ reviewEnabled: false }), repo({ name: "b" })] }));
  assert.throws(
    () => load({ repos: [repo(), repo({ name: "b", reviewEnabled: true })] }),
    (e) => /reviewSkillPath/.test(e.message) && /"b"/.test(e.message) && !/emRepoPath/.test(e.message),
  );
});
