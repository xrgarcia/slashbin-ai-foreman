// EM#1150 f3: the Tech Lead, SRE, QA and EM are plugins, and the phases reach a
// role only through the registry. What these hold:
//   - each agent plugin is on exactly when its path key is set, and fills its roles
//     with the agent's own functions;
//   - QA and unstick run whatever registered plugin fills the role (a fake here);
//   - with no reviewer, a PR a person merged moves to `pr merged`, then (no
//     verifier) to approved, then (no deployer, no promote) its issue closes, each
//     step a lifecycle move; a verifier stops it at `pr merged`, a promote stage at approved.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPlugin, roleFor, qaFor, enabledFor } from "../dist/plugins/registry.js";
import { TechLeadPlugin, reviewViaTechLead, approvePromotionViaTechLead } from "../dist/plugins/tech-lead.js";
import { SrePlugin, verifyViaSre, verifyProdViaSre, deployViaSre } from "../dist/plugins/sre.js";
import { QaPlugin } from "../dist/plugins/qa.js";
import { EmPlugin, unstickViaEm } from "../dist/plugins/em.js";
import { realQaDeps, realQaLocalDeps } from "../dist/qa-report.js";
import { tryUnstick } from "../dist/phases/unstick.js";
import { settleHumanMerge } from "../dist/phases/reconcile.js";
import { registerWorkSource } from "../dist/work-source.js";
import { setStatePath, loadRepoState, saveRepoState } from "../dist/state.js";
import { startAgentPlugins } from "./agent-plugins.mjs";

await startAgentPlugins();
setStatePath(mkdtempSync(join(tmpdir(), "plugin-roles-")));

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
const NONE = { qaRepos: [], stages: [], paperclip: { enabled: false } };

test("each agent plugin is on exactly when its path key is set, and fills its roles with the agent's own functions", () => {
  const cases = [
    [new TechLeadPlugin(), "techLeadPath", ["reviewer"]],
    [new SrePlugin(), "srePath", ["verifier", "deployer"]],
    [new QaPlugin(), "qaPath", ["qa"]],
    [new EmPlugin(), "emRepoPath", ["unstick"]],
  ];
  for (const [p, key, roles] of cases) {
    assert.deepEqual([...p.roles], roles, `${p.id} roles`);
    assert.equal(p.enabled({ ...NONE }), false, `${p.id} off without ${key}`);
    assert.equal(p.enabled({ ...NONE, [key]: "/x" }), true, `${p.id} on with ${key}`);
    for (const r of roles) {
      assert.equal(enabledFor(r, { ...NONE }), false, `${r} not enabled without ${key}`);
      assert.equal(enabledFor(r, { ...NONE, [key]: "/x" }), true, `${r} enabled with ${key}`);
    }
  }
  const tl = new TechLeadPlugin(), sre = new SrePlugin(), em = new EmPlugin();
  assert.equal(tl.reviewer.reviewPr, reviewViaTechLead);
  assert.equal(tl.reviewer.approvePromotion, approvePromotionViaTechLead);
  assert.equal(sre.verifier.verifyDev, verifyViaSre);
  assert.equal(sre.verifier.verifyProd, verifyProdViaSre);
  assert.equal(sre.deployer.deploy, deployViaSre);
  assert.equal(em.unstick.unstick, unstickViaEm);
  // The registry resolves the started plugins by the same keys.
  assert.equal(roleFor("reviewer", { ...NONE }), undefined);
  assert.equal(roleFor("reviewer", { ...NONE, techLeadPath: "/x" })?.reviewPr, reviewViaTechLead);
  assert.equal(roleFor("deployer", { ...NONE, srePath: "/x" })?.deploy, deployViaSre);
  assert.equal(roleFor("unstick", { ...NONE, emRepoPath: "/x" })?.unstick, unstickViaEm);
  const repo = { githubRepo: "o/qa" };
  assert.equal(qaFor(repo, { ...NONE, qaPath: "/x" }), undefined, "QA covers only qaRepos");
  assert.ok(qaFor(repo, { ...NONE, qaPath: "/x", qaRepos: ["o/qa"] }));
  assert.equal(qaFor(repo, { ...NONE, qaRepos: ["o/qa"] }), undefined, "QA off without qaPath");
});

// A fake QA and a fake unstick plugin, each on only under its own config flag.
const qaRuns = [];
const unstickRuns = [];
registerPlugin({
  id: "fake-qa",
  roles: ["qa"],
  enabled: (c) => c.fakeQa === true,
  qa: {
    covers: (r) => r.githubRepo === "o/fake",
    check: async (_r, _c, args) => { qaRuns.push(args); return { kind: "errored", detail: "fake ran" }; },
  },
});
registerPlugin({
  id: "fake-unstick",
  roles: ["unstick"],
  enabled: (c) => c.fakeUnstick === true,
  unstick: { unstick: async (_r, _c, issue, kind) => { unstickRuns.push([issue, kind]); return { kind: "invoked", detail: "fake" }; } },
});
const { startPlugins } = await import("../dist/plugins/registry.js");
await startPlugins({ ...NONE, fakeQa: true, fakeUnstick: true }, { logger, configText: () => null });

test("QA runs the registered plugin that covers the repo, on dev and locally", async () => {
  const repo = { name: "fake", githubRepo: "o/fake" };
  const config = { ...NONE, fakeQa: true };
  assert.deepEqual(await realQaDeps(repo, config, logger).run({ repo: "o/fake", pr: 9, out: "/o" }), { kind: "errored", detail: "fake ran" });
  assert.deepEqual(await realQaLocalDeps(repo, config, logger).run({ repo: "o/fake", pr: 9, out: "/o" }), { kind: "errored", detail: "fake ran" });
  assert.deepEqual(qaRuns, [{ repo: "o/fake", pr: 9, out: "/o", local: false }, { repo: "o/fake", pr: 9, out: "/o", local: true }]);
  const none = await realQaDeps({ name: "x", githubRepo: "o/other" }, config, logger).run({ repo: "o/other", pr: 1, out: "/o" });
  assert.equal(none.kind, "errored");
  assert.match(none.detail, /no enabled QA plugin covers o\/other/);
  assert.equal(qaRuns.length, 2, "a repo no plugin covers runs nothing");
});

test("stuck work goes to the registered unstick plugin, never the EM CLI", async () => {
  const repo = { name: "un", githubRepo: "o/un", repoPath: "/nonexistent", lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" } };
  const config = { ...NONE, sessionEnv: [], backoff: { verifyRetry: { maxAttempts: 3 } }, fakeUnstick: true };
  saveRepoState("un", { ...loadRepoState("un"), verifyHeld: { 7: { heldAt: "t", prNumber: 5, reason: "acceptance-not-verified", attempts: 3 } } });
  assert.equal(await tryUnstick(repo, config, logger, 1, { comment: () => {} }), 1);
  assert.deepEqual(unstickRuns, [[7, "verify-exhausted"]]);
  assert.equal(await tryUnstick(repo, { ...config, fakeUnstick: false }, logger, 2, { comment: () => {} }), 0, "no unstick plugin enabled: nothing runs");
});

// --- No reviewer: the human-merge end state ---

const REPO = { name: "hm", githubRepo: "o/hm", baseBranch: "develop", productionBranch: "main", featureBranch: "develop" };
function recordMoves() {
  const moves = [];
  registerWorkSource({ record: async (e) => { if (e.kind === "transition") moves.push(e.move); return true; } });
  return moves;
}

test("no reviewer, verifier, deployer or promote stage: a human-merged PR moves to merged, then approved, then its issue closes with a comment", async () => {
  const moves = recordMoves();
  const comments = [];
  try {
    const r = await settleHumanMerge(REPO, { ...NONE }, { issueNumber: 12, prNumber: 34 }, logger, { comment: (_r, n, body) => comments.push([n, body]) });
    assert.equal(r, "closed");
    assert.deepEqual(moves, ["humanMerged", "humanMergedApproved", "closedNoRelease"]);
    assert.equal(comments.length, 1);
    assert.equal(comments[0][0], 12);
    assert.match(comments[0][1], /PR #34 was merged to `develop` by a person/);
  } finally {
    registerWorkSource(null);
  }
});

test("no reviewer, with a verifier: the human merge stops at `pr merged` for dev verification", async () => {
  const moves = recordMoves();
  const comments = [];
  try {
    const r = await settleHumanMerge(REPO, { ...NONE, srePath: "/x" }, { issueNumber: 12, prNumber: 34 }, logger, { comment: (...a) => comments.push(a) });
    assert.equal(r, "merged");
    assert.deepEqual(moves, ["humanMerged"]);
    assert.equal(comments.length, 0);
  } finally {
    registerWorkSource(null);
  }
});

test("no reviewer or verifier, with a promote stage: the human merge stops at approved for the promotion", async () => {
  const moves = recordMoves();
  const comments = [];
  try {
    const r = await settleHumanMerge(REPO, { ...NONE, stages: [{ type: "promote" }] }, { issueNumber: 12, prNumber: 34 }, logger, { comment: (...a) => comments.push(a) });
    assert.equal(r, "approved");
    assert.deepEqual(moves, ["humanMerged", "humanMergedApproved"]);
    assert.equal(comments.length, 0);
  } finally {
    registerWorkSource(null);
  }
});

test("a move the source refuses stops the human merge where it is", async () => {
  registerWorkSource({ record: async () => false });
  try {
    assert.equal(await settleHumanMerge(REPO, { ...NONE }, { issueNumber: 12, prNumber: 34 }, logger, { comment: () => assert.fail("no comment") }), null);
  } finally {
    registerWorkSource(null);
  }
});
