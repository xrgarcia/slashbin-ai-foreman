// foreman#106: an exhausted dev-verify hold whose cause was the environment (a deploy that failed or never
// happened) is released when the merge gains a SUCCESS dev deployment after the hold, or taken as a pass when
// the SRE posted a passing Dev Verification Evidence after it. Unrelated holds stay held.
import test from "node:test";
import assert from "node:assert/strict";
import { registerPlugin, startPlugins, setCodeHost, resetRegistryForTests } from "../dist/plugins/registry.js";
import { registerWorkSource } from "../dist/work-source.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { tryVerify, devDeployRepaired, srePassedSince, isDevEnvironment, SRE_LOGIN } from "../dist/phases/verify.js";
import { UNBLOCK_CHECKS, CHECK_WORDS, passingCheck } from "../dist/unblock.js";
import { seed, recordOf } from "./issue-records.mjs";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
const SHA = "45fb3042c2efac9214bff2ffa42eab88020f4ef3";
const HELD_AT = "2026-10-20T21:23:00Z";
const REPO = {
  name: "r", githubRepo: "o/r", repoPath: "/nonexistent", baseBranch: "develop", productionBranch: "main", featureBranch: "develop",
  lifecycleLabels: { prUnderReview: "pr under review", prPendingActions: "pr pending actions", prMerged: "pr merged", prApproved: "pr approved", readyForProd: "ready for prod release", releasePending: "release pending", prodVerifyHeld: "prod verification held", readyToClose: "ready to close" },
  github: { blockedLabel: "blocked" },
};
const CONFIG = { qaRepos: [], stages: [], paperclip: { enabled: false }, backoff: DEFAULT_BACKOFF, qaGate: false };

const evidence = (result, { at = "2026-10-20T21:28:04Z", author = SRE_LOGIN } = {}) => ({
  id: "comment:1", issue: 225, author, at,
  body: `## Dev Verification Evidence — o/r#225\n\n| Check | Result | Details |\n|---|---|---|\n| **Post-merge verification** | ${result} | form (b): dev health 200 |\n`,
});

/** Drive one verify pass over issue 224 (PR 225) held with `reason`, exhausted. */
async function pass({ reason = "dev-verify-failed", deployments = [], comments = [], heldAt = HELD_AT }) {
  resetRegistryForTests();
  const rt = new ForemanRuntime();
  const store = new InMemoryRecordStore();
  const moves = [];
  const unblocked = [];
  registerWorkSource({
    record: async (e) => { if (e.kind === "transition") moves.push(e.move); if (e.kind === "unblocked") unblocked.push(e.reason); return true; },
    loadRecord: (k, rc) => store.loadRecord(k, rc),
    saveRecord: (k, r, rc) => store.saveRecord(k, r, rc),
  });
  const forced = [];
  let runs = 0;
  registerPlugin({
    id: "fake-sre", roles: ["verifier"], enabled: () => true, fills: (role) => role === "verifier",
    verifier: {
      verifyDev: async (_r, _c, pr, _l, _s, _t, force) => {
        runs++; forced.push(force);
        return { kind: "verdict", pass: true, trailer: { deploy: "SUCCESS" }, summary: "" };
      },
    },
  });
  await startPlugins(CONFIG, { logger, configText: () => null });
  setCodeHost(new Proxy({}, { get: (_, k) => {
    if (k === "then" || typeof k === "symbol") return undefined;
    const impl = {
      findIssuesAwaitingVerify: async () => [224],
      getOpenIssues: async () => [{ number: 224 }],
      findIssuesMergedToBase: async () => [{ issueNumber: 224, prNumber: 225, prUrl: "", mergedAt: "2026-10-20T17:14:30Z" }],
      issueLastEditedAt: async () => null,
      viewReleasePr: async () => ({ number: 225, mergeSha: SHA }),
      issueCommentRows: async () => comments,
      deploymentsForSha: async () => deployments,
    }[k];
    return impl ?? (async () => { throw new Error(`unexpected code host call: ${String(k)}`); });
  } }));
  await seed(rt, REPO, 224, { verifyHeld: { heldAt, prNumber: 225, reason, attempts: 3 } });
  await tryVerify(rt, REPO, CONFIG, logger, 1);
  const held = (await recordOf(rt, REPO, 224)).verifyHeld;
  resetRegistryForTests();
  registerWorkSource(null);
  setCodeHost(null);
  return { moves, unblocked, runs, forced, held };
}

const dev = (state, at) => ({ environment: "o / development", state, at });

test("an exhausted dev-verify-failed hold whose merge gains a SUCCESS dev deployment after heldAt is released and verify runs again, forced", async () => {
  const r = await pass({ deployments: [dev("failure", "2026-10-20T21:00:00Z"), dev("success", "2026-10-20T21:26:02Z")] });
  assert.equal(r.runs, 1, "verify ran again");
  assert.deepEqual(r.forced, [true], "the SRE is told to re-run, not replay its cached failure");
  assert.match(r.unblocked[0], /dev deploy that succeeded or restarted/);
  assert.equal(r.held, undefined, "the hold cleared (the re-run passed)");
  assert.deepEqual(r.moves, ["verifyPassed"]);
});

test("an exhausted deploy-failure hold with a newer PASS evidence comment writes pr approved without a new SRE run", async () => {
  const r = await pass({ reason: "deploy=NONE", comments: [evidence("PASS")] });
  assert.equal(r.runs, 0, "no SRE run");
  assert.deepEqual(r.moves, ["verifyPassed"]);
  assert.equal(r.held, undefined);
});

test("an exhausted acceptance-failed hold with neither fact stays held, and its reads are never made", async () => {
  const r = await pass({ reason: "acceptance-failed", deployments: [dev("success", "2026-10-20T21:26:02Z")], comments: [evidence("PASS")] });
  assert.equal(r.runs, 0);
  assert.deepEqual(r.moves, []);
  assert.equal(r.held.reason, "acceptance-failed");
});

test("a deploy-failure hold with no repaired deployment and no PASS stays held", async () => {
  const r = await pass({ deployments: [dev("failure", "2026-10-20T21:26:02Z")], comments: [evidence("FAIL")] });
  assert.equal(r.runs, 0);
  assert.deepEqual(r.moves, []);
  assert.equal(r.held.reason, "dev-verify-failed");
});

test("devDeployRepaired: newest dev deployment SUCCESS after heldAt only", () => {
  assert.equal(devDeployRepaired([dev("success", "2026-10-20T21:26:00Z")], HELD_AT), true);
  assert.equal(devDeployRepaired([dev("success", "2026-10-20T21:00:00Z")], HELD_AT), false, "succeeded before the hold");
  assert.equal(devDeployRepaired([dev("success", "2026-10-20T21:26:00Z"), dev("failure", "2026-10-20T21:30:00Z")], HELD_AT), false, "the newest failed");
  assert.equal(devDeployRepaired([{ environment: "o / production", state: "success", at: "2026-10-20T21:26:00Z" }], HELD_AT), false, "production is not dev");
  assert.equal(devDeployRepaired([], HELD_AT), false);
  assert.equal(devDeployRepaired([dev("success", "2026-10-20T21:26:00Z")], "garbage"), false);
  assert.ok(isDevEnvironment("jerky-com / development") && isDevEnvironment("dev") && !isDevEnvironment("jerky-com / production"));
});

// SLA-4625 (2026-11-12): Railway reused ONE GitHub deployment for both deploys of a SHA and wrote a stale
// `failure` 4s after it reported the redeploy SUCCESS. The newest status said failure; the hold stayed 6h.
const SLA_HELD_AT = "2026-11-12T18:24:47Z";
const SLA_STATUSES = [
  { state: "failure", at: "2026-11-12T18:29:02Z" }, { state: "failure", at: "2026-11-12T18:29:02Z" },
  { state: "in_progress", at: "2026-11-12T18:28:09Z" }, { state: "failure", at: "2026-11-12T17:49:35Z" },
  { state: "in_progress", at: "2026-11-12T17:48:09Z" },
];
const reused = (statuses) => ({ environment: "cmneb / development", state: statuses[0].state, at: statuses[0].at, statuses });

test("devDeployRepaired: a redeploy that began after the hold releases even when the newest status is a stale failure (SLA-4625)", () => {
  assert.equal(devDeployRepaired([reused(SLA_STATUSES)], SLA_HELD_AT), true);
});

test("devDeployRepaired: failures after the hold with no new attempt, or attempts only before it, never release", () => {
  assert.equal(devDeployRepaired([reused(SLA_STATUSES.slice(3))], SLA_HELD_AT), false, "history ends before the hold");
  assert.equal(devDeployRepaired([reused([{ state: "failure", at: "2026-11-12T18:30:00Z" }, ...SLA_STATUSES.slice(3)])], SLA_HELD_AT), false, "a lone later failure is no new attempt");
  assert.equal(devDeployRepaired([{ environment: "cmneb / development", state: "failure", at: "2026-11-12T18:29:02Z" }], SLA_HELD_AT), false, "no history: unknown");
  assert.equal(devDeployRepaired([{ ...reused(SLA_STATUSES), environment: "cmneb / production" }], SLA_HELD_AT), false, "production is not dev");
  assert.equal(devDeployRepaired([{ ...reused(SLA_STATUSES), at: "" }], SLA_HELD_AT), false, "unreadable time");
});

test("the SLA-4625 sequence releases the exhausted hold and forces the SRE to re-run, which owns the verdict", async () => {
  const r = await pass({ deployments: [reused(SLA_STATUSES)], heldAt: SLA_HELD_AT });
  assert.equal(r.runs, 1);
  assert.deepEqual(r.forced, [true]);
});

test("srePassedSince: the SRE's newest evidence for this merge, after the hold, PASS", () => {
  assert.equal(srePassedSince([evidence("PASS")], HELD_AT), true);
  assert.equal(srePassedSince([evidence("**PASS**")], HELD_AT), true);
  assert.equal(srePassedSince([evidence("PASS", { at: "2026-10-20T21:00:00Z" })], HELD_AT), false, "older than the hold");
  assert.equal(srePassedSince([evidence("PASS", { author: "xrgarcia" })], HELD_AT), false, "not the SRE");
  assert.equal(srePassedSince([evidence("PASS"), evidence("FAIL", { at: "2026-10-20T22:00:00Z" })], HELD_AT), false, "a later FAIL supersedes");
  assert.equal(srePassedSince([evidence("NOT YET ELIGIBLE (2026-10-20T22:00Z)")], HELD_AT), false);
});

test("verify-exhausted lists both checks, each with a card note", () => {
  for (const c of ["deployRepaired", "srePassedSince"]) {
    assert.ok(UNBLOCK_CHECKS["verify-exhausted"].includes(c));
    assert.ok(CHECK_WORDS[c]);
  }
  assert.equal(passingCheck("verify-exhausted", { deployRepaired: true }), "deployRepaired");
  assert.equal(passingCheck("verify-held", { deployRepaired: true }), null);
});
