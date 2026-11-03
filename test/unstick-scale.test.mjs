// The unstick pass groups its candidates by issue once: a scan of every candidate for each issue is
// O(issues x candidates) (EM#1244 f2, Tech Lead review of Foreman#190).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { tryUnstick } from "../dist/phases/unstick.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords } from "./issue-records.mjs";
import { mkTmp } from "./tmp-dir.mjs";
import { ForemanRuntime } from "../dist/runtime.js";
let rt = new ForemanRuntime();

await startAgentPlugins();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const N = 150;
const ghBin = mkTmp("scale-gh-");
const list = Array.from({ length: N }, (_, i) => ({ number: i + 1, title: "t", labels: [{ name: "pr approved" }] }));
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\ncat <<'EOF2'\n${JSON.stringify(list)}\nEOF2\n`);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";
process.env.PATH = `${ghBin}:${process.env.PATH}`;

test("one release-gate candidate per open issue: no array of that size is filtered once per issue", async () => {
  setStatePath(mkTmp("scale-state-"));
  rt = new ForemanRuntime();
  memoryRecords();
  const em = mkTmp("scale-em-");
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "bin/em.mjs"), "process.exit(0);");
  const repo = { name: "sc", githubRepo: "o/sc", repoPath: em, lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" } };
  const config = { emRepoPath: em, sessionEnv: [], backoff: { verifyRetry: { maxAttempts: 3 } } };
  const realFilter = Array.prototype.filter;
  let big = 0;
  Array.prototype.filter = function (...a) { if (this.length >= N) big++; return realFilter.apply(this, a); };
  try {
    await tryUnstick(rt, repo, config, logger, 1);
  } finally {
    Array.prototype.filter = realFilter;
  }
  assert.ok(big < 20, `${big} filters over arrays of ${N}+ elements`);
});
