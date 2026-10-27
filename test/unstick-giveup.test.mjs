// foreman#105: a hold whose EM calls all fail is surfaced once, on the issue.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStatePath, loadRepoState, saveRepoState } from "../dist/state.js";
import { tryUnstick } from "../dist/phases/unstick.js";
import { UNSTICK_MAX_ATTEMPTS } from "../dist/unstick.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";

function setup(exitCode = 1) {
  setStatePath(mkdtempSync(join(tmpdir(), "giveup-state-")));
  const em = mkdtempSync(join(tmpdir(), "giveup-em-"));
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "bin/em.mjs"), `console.error("${"x".repeat(900)} session PARSE_ERROR"); process.exit(${exitCode});`);
  const repo = { name: "gr", githubRepo: "o/gr", repoPath: join(em, "no-such-clone"), lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" } };
  const config = { emRepoPath: em, sessionEnv: [], backoff: { verifyRetry: { maxAttempts: 3 } } };
  const hold = (reason) => saveRepoState("gr", { ...loadRepoState("gr"), verifyHeld: { 7: { heldAt: "t", prNumber: 5, reason, attempts: 3 } } });
  return { repo, config, hold };
}
const entry = () => loadRepoState("gr").unstick["7:verify-exhausted"];

test("three failed calls -> exactly one comment mentioning the owner, status escalated", async () => {
  const { repo, config, hold } = setup();
  const comments = [];
  const comment = (_r, n, body) => { comments.push({ n, body }); };
  hold("acceptance-not-verified");
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) {
    assert.equal(await tryUnstick(repo, config, logger, i, { comment }), 1, `call ${i}`);
    assert.equal(comments.length, i < UNSTICK_MAX_ATTEMPTS ? 0 : 1);
  }
  assert.equal(comments[0].n, 7);
  assert.match(comments[0].body, /^\*\*Foreman: the EM could not be reached for this hold\*\*/);
  assert.match(comments[0].body, /@xrgarcia/);
  assert.match(comments[0].body, /verify-exhausted/);
  assert.match(comments[0].body, /acceptance-not-verified/);
  assert.match(comments[0].body, /PARSE_ERROR/);
  assert.ok(comments[0].body.length < 2000);
  assert.equal(entry().status, "escalated");
  // Further cycles, same reason: no call, no comment.
  assert.equal(await tryUnstick(repo, config, logger, 9, { comment }), 0);
  assert.equal(comments.length, 1);
});

test("a changed reason calls the EM again", async () => {
  const { repo, config, hold } = setup();
  const comment = () => {};
  hold("acceptance-not-verified");
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) await tryUnstick(repo, config, logger, i, { comment });
  hold("dev-verify-other");
  assert.equal(await tryUnstick(repo, config, logger, 9, { comment }), 1);
});

test("the owner is configurable", async () => {
  const { repo, config, hold } = setup();
  const bodies = [];
  hold("r");
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) await tryUnstick(repo, { ...config, unstickEscalationOwner: "someone" }, logger, i, { comment: (_r, _n, b) => bodies.push(b) });
  assert.match(bodies[0], /@someone/);
});

test("a failing comment post does not throw, stays failed at the cap and is not retried", async () => {
  const { repo, config, hold } = setup();
  let posts = 0;
  const comment = () => { posts++; throw new Error("gh down"); };
  hold("r");
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) await tryUnstick(repo, config, logger, i, { comment });
  assert.equal(posts, 1);
  assert.equal(entry().status, "failed");
  assert.equal(await tryUnstick(repo, config, logger, 9, { comment }), 0);
  assert.equal(posts, 1);
});

test("an answered call (exit 0) never comments", async () => {
  const { repo, config, hold } = setup(0);
  let posts = 0;
  hold("r");
  await tryUnstick(repo, config, logger, 1, { comment: () => { posts++; } });
  assert.equal(posts, 0);
  assert.equal(entry().status, "invoked");
});
