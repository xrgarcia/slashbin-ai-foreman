// An EM runner refusal, even behind the EM CLI's own error prefix, spends no
// attempt, records when to try again, and pauses every EM call daemon-wide.
import test from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { tryUnstick, EM_UPSTREAM } from "../dist/phases/unstick.js";
import { isUpstreamBlocked } from "../dist/upstream-backoff.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, seed, recordOf } from "./issue-records.mjs";
import { ForemanRuntime } from "../dist/runtime.js";

await startAgentPlugins();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";
const ghBin = mkTmp("emref-gh-");
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\necho '[{"number":7,"title":"t","labels":[]}]'\n`);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.PATH = `${ghBin}:${process.env.PATH}`;

test("a wrapped refusal in one repo spends nothing and stops EM calls in another until it lifts", async () => {
  setStatePath(mkTmp("emref-state-"));
  const rt = new ForemanRuntime();
  memoryRecords();
  const em = mkTmp("emref-em-");
  mkdirSync(join(em, "bin"));
  const calls = join(em, "calls");
  writeFileSync(join(em, "bin/em.mjs"),
    `require("fs").appendFileSync(${JSON.stringify(calls)}, "x"); console.error("em unstick failed: session ERROR: You've hit your session limit"); process.exit(1);`.replace('require("fs")', '(await import("node:fs"))'));
  const repo = (name) => ({ name, githubRepo: `o/${name}`, repoPath: em, lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" } });
  const a = repo("ra"), b = repo("rb");
  const config = { emRepoPath: em, sessionEnv: [], backoff: { ...DEFAULT_BACKOFF, verifyRetry: { maxAttempts: 3 } }, unstickEscalationOwner: "someone" };
  for (const r of [a, b]) await seed(rt, r, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });

  assert.equal(await tryUnstick(rt, a, config, logger, 1), 1, "the first call is made");
  const e = (await recordOf(rt, a, 7)).unstick["7:verify-exhausted"];
  assert.equal(e.status, "refused");
  assert.equal(e.attempts, 0, "no attempt spent");
  assert.ok(Date.parse(e.waitUntil) > Date.now(), "a wait is recorded");
  assert.ok(isUpstreamBlocked(EM_UPSTREAM), "the EM's runner is paused daemon-wide");

  assert.equal(await tryUnstick(rt, b, config, logger, 2), 0, "another repo's question is not put to the paused runner");
  assert.equal((await recordOf(rt, b, 7)).unstick["7:verify-exhausted"].attempts, 0);
});
