// foreman#104: the Foreman carries out the EM's divergence ruling. Real git against
// a fixture repo and a bare "remote" in a temp dir; the GitHub reads and comments are injected.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStatePath, loadRepoState, saveRepoState } from "../dist/state.js";
import {
  repairDivergence, pickRuling, EM_DIVERGENCE_RULER, EM_DIVERGENCE_ISSUE_TITLE, EM_DIVERGENCE_RULING_PATTERN,
} from "../dist/divergence-repair.js";
import { divergenceNotice, divergenceReason } from "../dist/phases/common.js";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
});
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

/** A bare remote plus the Foreman's clone, with `features` and `develop` diverged. */
function fixture({ rejectFeaturePush = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "div-repair-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  git(root, "init", "--bare", "-b", "develop", remote);
  git(root, "init", "-b", "develop", seed);
  git(seed, "remote", "add", "origin", remote);
  writeFileSync(join(seed, "a.txt"), "base\n");
  git(seed, "add", "."); git(seed, "commit", "-m", "init");
  git(seed, "push", "origin", "develop");
  git(seed, "checkout", "-b", "features");
  writeFileSync(join(seed, "f.txt"), "feature work\n");
  git(seed, "add", "."); git(seed, "commit", "-m", "feature commit");
  git(seed, "push", "origin", "features");
  const featureHead = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "develop");
  writeFileSync(join(seed, "b.txt"), "base moved\n");
  git(seed, "add", "."); git(seed, "commit", "-m", "base commit");
  git(seed, "push", "origin", "develop");
  const baseHead = git(seed, "rev-parse", "HEAD");
  const mergeBase = git(seed, "merge-base", "develop", "features");
  git(root, "clone", remote, clone);
  git(clone, "checkout", "features");
  if (rejectFeaturePush) {
    const hook = join(remote, "hooks/pre-receive");
    writeFileSync(hook, '#!/bin/sh\nwhile read o n ref; do [ "$ref" = refs/heads/features ] && { echo "rejected by fixture hook" >&2; exit 1; }; done\nexit 0\n');
    chmodSync(hook, 0o755);
  }
  setStatePath(mkdtempSync(join(tmpdir(), "div-state-")));
  const repo = { name: "dr", githubRepo: "o/dr", repoPath: clone, baseBranch: "develop", featureBranch: "features" };
  saveRepoState("dr", { implemented: [], failed: {}, branchBlock: {
    featureBranch: "features", baseBranch: "develop", mergeBase, ahead: 1, behind: 1,
    since: "2026-10-24T00:00:00Z", announced: [7],
  } });
  return { repo, remote, clone, featureHead, baseHead, mergeBase };
}
const ruling = (winner, mergeBase, over = {}) => ({
  id: "comment:1", issue: 7, author: EM_DIVERGENCE_RULER, at: "2026-10-24T01:00:00Z",
  body: `Looked at it.\n**EM divergence ruling** winner=${winner} mergeBase=${mergeBase}\n`, ...over,
});
const run = (f, cands, extra = {}) => {
  const comments = [];
  const p = repairDivergence(f.repo, logger, {
    readCandidates: () => cands, comment: (_r, n, body) => comments.push({ n, body }),
    now: () => new Date("2026-10-24T13:05:09Z"), ...extra,
  });
  return p.then((outcome) => ({ outcome, comments }));
};
const remoteRef = (f, ref) => git(f.remote, "rev-parse", ref);

test("base wins: feature == base, backup ref holds the old head, block releasable", async () => {
  const f = fixture();
  const { outcome, comments } = await run(f, [ruling("base", f.mergeBase)]);
  assert.equal(outcome, "repaired");
  assert.equal(remoteRef(f, "refs/heads/features"), f.baseHead);
  assert.equal(remoteRef(f, "refs/heads/backup/features-20261024-1305"), f.featureHead);
  assert.equal(git(f.clone, "rev-parse", "features"), f.baseHead);
  assert.equal(comments.length, 0);
  const { divergenceStillHolds } = await import("../dist/reconciler.js");
  assert.equal(divergenceStillHolds(f.repo), false);
});

test("branch wins: base merged into the feature branch, no force, feature work kept", async () => {
  const f = fixture();
  const { outcome } = await run(f, [ruling("branch", f.mergeBase)]);
  assert.equal(outcome, "repaired");
  const head = remoteRef(f, "refs/heads/features");
  git(f.remote, "merge-base", "--is-ancestor", f.baseHead, head);
  git(f.remote, "merge-base", "--is-ancestor", f.featureHead, head);
  assert.throws(() => git(f.remote, "rev-parse", "--verify", "refs/heads/backup/features-20261024-1305"));
});

test("no ruling: nothing happens", async () => {
  const f = fixture();
  const { outcome, comments } = await run(f, [ruling("base", f.mergeBase, { body: "just a comment" })]);
  assert.equal(outcome, "none");
  assert.equal(remoteRef(f, "refs/heads/features"), f.featureHead);
  assert.equal(comments.length, 0);
});

test("a ruling with a stale mergeBase is ignored", async () => {
  const f = fixture();
  const { outcome } = await run(f, [ruling("base", "0".repeat(40))]);
  assert.equal(outcome, "none");
  assert.equal(remoteRef(f, "refs/heads/features"), f.featureHead);
});

test("a ruling by anyone else, or from before the episode, is ignored", async () => {
  const f = fixture();
  assert.equal((await run(f, [ruling("base", f.mergeBase, { author: "xrgarcia" })])).outcome, "none");
  assert.equal((await run(f, [ruling("base", f.mergeBase, { at: "2026-10-23T23:59:59Z" })])).outcome, "none");
  assert.equal(remoteRef(f, "refs/heads/features"), f.featureHead);
});

test("repair failure: one comment, block kept, the same ruling is not retried", async () => {
  const f = fixture({ rejectFeaturePush: true });
  const cands = [ruling("base", f.mergeBase)];
  const first = await run(f, cands);
  assert.equal(first.outcome, "failed");
  assert.equal(first.comments.length, 1);
  assert.equal(first.comments[0].n, 7);
  assert.match(first.comments[0].body, /^\*\*Foreman: divergence repair failed\*\*/);
  assert.match(first.comments[0].body, /rejected by fixture hook/);
  assert.ok(loadRepoState("dr").branchBlock, "block kept");
  assert.deepEqual(loadRepoState("dr").branchBlock.ruled, ["comment:1"]);
  const again = await run(f, cands);
  assert.equal(again.outcome, "none");
  assert.equal(again.comments.length, 0);
  assert.equal(remoteRef(f, "refs/heads/features"), f.featureHead, "remote feature untouched");
});

test("a merge conflict on branch-wins fails once and leaves the clone clean", async () => {
  const f = fixture();
  // Make the two sides conflict: both touch c.txt.
  const other = mkdtempSync(join(tmpdir(), "div-other-"));
  git(other, "clone", f.remote, "w");
  const w = join(other, "w");
  git(w, "checkout", "features"); writeFileSync(join(w, "c.txt"), "feature\n"); git(w, "add", "."); git(w, "commit", "-m", "f c"); git(w, "push", "origin", "features");
  git(w, "checkout", "develop"); writeFileSync(join(w, "c.txt"), "base\n"); git(w, "add", "."); git(w, "commit", "-m", "b c"); git(w, "push", "origin", "develop");
  const { outcome, comments } = await run(f, [ruling("branch", f.mergeBase)]);
  assert.equal(outcome, "failed");
  assert.equal(comments.length, 1);
  assert.equal(git(f.clone, "status", "--porcelain"), "");
});

test("a repo-level ruling is read from the body of the EM's titled issue", async () => {
  const f = fixture();
  saveRepoState("dr", { ...loadRepoState("dr"), branchBlock: { ...loadRepoState("dr").branchBlock, announced: [] } });
  const issue = { ...ruling("base", f.mergeBase, { id: "issue:42", issue: 42 }), title: EM_DIVERGENCE_ISSUE_TITLE, body: `**EM divergence ruling** winner=base mergeBase=${f.mergeBase}` };
  assert.equal(pickRuling([{ ...issue, title: "something else" }], loadRepoState("dr").branchBlock), null, "wrong title");
  assert.equal(pickRuling([{ ...issue, author: "mallory" }], loadRepoState("dr").branchBlock), null, "wrong author");
  const { outcome } = await run(f, [issue]);
  assert.equal(outcome, "repaired");
  assert.equal(remoteRef(f, "refs/heads/features"), f.baseHead);
});

test("a repo-level failure comments on the ruling issue", async () => {
  const f = fixture({ rejectFeaturePush: true });
  saveRepoState("dr", { ...loadRepoState("dr"), branchBlock: { ...loadRepoState("dr").branchBlock, announced: [] } });
  const issue = { ...ruling("base", f.mergeBase, { id: "issue:42", issue: 42 }), title: EM_DIVERGENCE_ISSUE_TITLE, body: `**EM divergence ruling** winner=base mergeBase=${f.mergeBase}` };
  const { outcome, comments } = await run(f, [issue]);
  assert.equal(outcome, "failed");
  assert.deepEqual(comments.map((c) => c.n), [42]);
});

test("grammar: exact line only", () => {
  const sha = "a".repeat(40);
  assert.ok(EM_DIVERGENCE_RULING_PATTERN.test(`x\n**EM divergence ruling** winner=base mergeBase=${sha}  \ny`));
  assert.ok(!EM_DIVERGENCE_RULING_PATTERN.test(`**EM divergence ruling** winner=both mergeBase=${sha}`));
  assert.ok(!EM_DIVERGENCE_RULING_PATTERN.test(`**EM divergence ruling** winner=base mergeBase=${"a".repeat(39)}`));
  assert.ok(!EM_DIVERGENCE_RULING_PATTERN.test(`> **EM divergence ruling** winner=base mergeBase=${sha}`));
});

test("the notice and the unstick reason name the ruling flow and the full merge base", () => {
  const block = { featureBranch: "features", baseBranch: "develop", mergeBase: "b".repeat(40), ahead: 2, behind: 3, since: "", announced: [] };
  const notice = divergenceNotice({ githubRepo: "o/r" }, block);
  assert.doesNotMatch(notice, /does not resolve divergence/);
  assert.match(notice, /EM is asked for a ruling/);
  assert.match(divergenceReason(block), new RegExp(`merge base ${"b".repeat(40)}`));
});

test("the divergence reason the EM is asked on stays the same as commits pile up (no re-ask per commit)", async () => {
  const { divergenceReason } = await import("../dist/phases/common.js");
  const block = { featureBranch: "features", baseBranch: "develop", mergeBase: "a".repeat(40), ahead: 1, behind: 2 };
  const first = divergenceReason(block);
  assert.equal(divergenceReason({ ...block, ahead: 5, behind: 9 }), first);
  assert.match(first, /merge base a{40}/);
});
