// foreman#105: a hold whose EM calls all fail is surfaced once, on the issue.
import test from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { loadRepoState, saveRepoState } from "./_legacy-state.mjs";
import { tryUnstick } from "../dist/phases/unstick.js";
import { UNSTICK_MAX_ATTEMPTS } from "../dist/unstick.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, seed, recordOf } from "./issue-records.mjs";
import { slashbinProfile } from "../dist/profiles/slashbin.js";
import { ForemanRuntime } from "../dist/runtime.js";
let rt = new ForemanRuntime();

await startAgentPlugins();

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
// The pass looks at the repo's open issues (their records hold the questions): a gh that lists #7 as open.
const ghBin = mkTmp("giveup-gh-");
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\necho '[{"number":7,"title":"t","labels":[]}]'\n`);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";
process.env.PATH = `${ghBin}:${process.env.PATH}`;

function setup(exitCode = 1) {
  setStatePath(mkTmp("giveup-state-"));
  rt = new ForemanRuntime();
  memoryRecords();
  const em = mkTmp("giveup-em-");
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "bin/em.mjs"), `console.error("${"x".repeat(900)} session PARSE_ERROR"); process.exit(${exitCode});`);
  const repo = { name: "gr", githubRepo: "o/gr", repoPath: em, lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" } };
  // Slashbin's owner, from its profile: the comment mentions exactly today's login.
  const config = { emRepoPath: em, sessionEnv: [], backoff: { verifyRetry: { maxAttempts: 3 } }, unstickEscalationOwner: slashbinProfile.unstickEscalationOwner };
  const hold = (reason) => seed(rt, repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason, attempts: 3 } });
  return { repo, config, hold };
}
const entry = async () => (await recordOf(rt, { name: "gr", githubRepo: "o/gr" }, 7)).unstick["7:verify-exhausted"];

test("three failed calls -> exactly one comment mentioning the owner, status escalated", async () => {
  const { repo, config, hold } = setup();
  const comments = [];
  const comment = (_r, n, body) => { comments.push({ n, body }); };
  await hold("acceptance-not-verified");
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) {
    assert.equal(await tryUnstick(rt, repo, config, logger, i, { comment }), 1, `call ${i}`);
    assert.equal(comments.length, i < UNSTICK_MAX_ATTEMPTS ? 0 : 1);
  }
  assert.equal(comments[0].n, 7);
  assert.match(comments[0].body, /^\*\*Foreman: the EM could not be reached for this hold\*\*/);
  assert.match(comments[0].body, /@xrgarcia/);
  assert.match(comments[0].body, /verify-exhausted/);
  assert.match(comments[0].body, /acceptance-not-verified/);
  assert.match(comments[0].body, /PARSE_ERROR/);
  assert.ok(comments[0].body.length < 2000);
  assert.equal((await entry()).status, "escalated");
  // Further cycles, same reason: no call, no comment.
  assert.equal(await tryUnstick(rt, repo, config, logger, 9, { comment }), 0);
  assert.equal(comments.length, 1);
});

test("a changed reason calls the EM again", async () => {
  const { repo, config, hold } = setup();
  const comment = () => {};
  await hold("acceptance-not-verified");
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) await tryUnstick(rt, repo, config, logger, i, { comment });
  await hold("dev-verify-other");
  assert.equal(await tryUnstick(rt, repo, config, logger, 9, { comment }), 1);
});

test("the owner is configurable", async () => {
  const { repo, config, hold } = setup();
  const bodies = [];
  await hold("r");
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) await tryUnstick(rt, repo, { ...config, unstickEscalationOwner: "someone" }, logger, i, { comment: (_r, _n, b) => bodies.push(b) });
  assert.match(bodies[0], /@someone/);
});

test("no unstickEscalationOwner: nobody is mentioned, no comment is posted, the log says so, and it is not retried", async () => {
  const { repo, config, hold } = setup();
  const warned = [];
  const log = { ...logger, warn: (m) => warned.push(m), child() { return this; } };
  let posts = 0;
  const comment = () => { posts++; };
  await hold("r");
  const neutral = { ...config, unstickEscalationOwner: undefined };
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) await tryUnstick(rt, repo, neutral, log, i, { comment });
  assert.equal(posts, 0);
  assert.equal((await entry()).status, "failed");
  assert.equal(warned.filter((m) => /no unstickEscalationOwner configured/.test(m)).length, 1);
  assert.equal(await tryUnstick(rt, repo, neutral, log, 9, { comment }), 0);
  assert.equal(posts, 0);
});

test("a failing comment post does not throw, stays failed at the cap and is not retried", async () => {
  const { repo, config, hold } = setup();
  let posts = 0;
  const comment = () => { posts++; throw new Error("gh down"); };
  await hold("r");
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) await tryUnstick(rt, repo, config, logger, i, { comment });
  assert.equal(posts, 1);
  assert.equal((await entry()).status, "failed");
  assert.equal(await tryUnstick(rt, repo, config, logger, 9, { comment }), 0);
  assert.equal(posts, 1);
});

test("an answered call (exit 0) never comments", async () => {
  const { repo, config, hold } = setup(0);
  let posts = 0;
  await hold("r");
  await tryUnstick(rt, repo, config, logger, 1, { comment: () => { posts++; } });
  assert.equal(posts, 0);
  assert.equal((await entry()).status, "invoked");
});
