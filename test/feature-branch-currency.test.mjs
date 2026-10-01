// Guards for keeping `features` current with its base before an implement session.
//
// Source-level assertions, matching reconciler-rejection.test.mjs: the function
// shells out to `git` against a real shared clone, so exercising it here would
// need a fixture repo and a remote double. What matters — and what would be
// catastrophic to regress — is the SHAPE: fast-forward only, never a force-push,
// never an auto-resolved conflict, and an in-flight feature PR is not a fault.
//
// Origin (2026-09-10): the implement skill's Phase 0 only ever pulled `features`.
// Nothing merged the base in, and Dependabot lands on the base — so the session
// that is supposed to prove a dependency upgrade BOOTS was booting a tree behind
// by 3 to 300 commits across all twenty managed repos.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reconciler = readFileSync(join(root, "src/reconciler.ts"), "utf-8");
const orchestrator = readFileSync(join(root, "src/orchestrator.ts"), "utf-8");

const fn = (() => {
  const i = reconciler.indexOf("export function fastForwardFeatureBranch");
  assert.notEqual(i, -1, "fastForwardFeatureBranch is gone — features goes stale again");
  return reconciler.slice(i);
})();

test("the merge is fast-forward only — it can never rewrite or invent history", () => {
  assert.match(fn, /"merge",\s*"--ff-only"/, "a plain merge would create a merge commit on a shared branch");
  assert.doesNotMatch(fn, /"--force"|"-f"|"--force-with-lease"/, "a force-push to the shared clone is the documented dead-zone cause");
  assert.doesNotMatch(fn, /"reset",\s*"--hard"/, "a hard reset silently discards unmerged commits");
  assert.doesNotMatch(fn, /"rebase"/, "a rebase rewrites commits other clones already have");
});

test("an in-flight feature PR is reported, not treated as a failure", () => {
  // features ahead of base is the NORMAL mid-cycle state. Failing there would
  // halt implementation every time a feature PR is open.
  assert.match(fn, /if \(ahead > 0\) return "work-in-flight"/, "features ahead must not be an error");
  const flightIdx = fn.indexOf('"work-in-flight"');
  const divergedIdx = fn.indexOf('return "diverged"');
  assert.ok(divergedIdx < flightIdx, "divergence must be checked before the ahead-only shortcut");
});

test("only true divergence stops the session, and it is never auto-resolved", () => {
  assert.match(fn, /ahead > 0 && behind > 0/, "divergence is both sides carrying unique commits");
  assert.match(
    orchestrator,
    /ffOutcome === "diverged"[\s\S]{0,400}?return null;/,
    "a diverged features branch must skip implementation — the tree is unknown",
  );
  assert.doesNotMatch(fn, /checkout",\s*"--theirs|"--ours"|-X\s*ours|-X\s*theirs/, "never resolve a conflict unattended");
});

test("an unknown git result never advances the branch", () => {
  assert.match(fn, /if \(Number\.isNaN\(ahead\) \|\| Number\.isNaN\(behind\)\) return "unknown"/);
  assert.match(fn, /catch \(err\)[\s\S]{0,300}?return "unknown"/, "a failed git call must not read as success");
});

test("the fast-forward runs BEFORE the implement session, not after", () => {
  const ffCall = orchestrator.indexOf("fastForwardFeatureBranch(repoConfig");
  const implCall = orchestrator.indexOf("await implementApprovedIssues(");
  assert.notEqual(ffCall, -1, "the orchestrator no longer freshens features");
  assert.notEqual(implCall, -1);
  assert.ok(ffCall < implCall, "freshening after the session would build the stale tree anyway");
});

test("a repo whose base and feature branch are the same is left alone", () => {
  // Docs-site style repos run main-only; there is nothing to fast-forward.
  assert.match(fn, /baseBranch === featureBranch/, "main-only repos must short-circuit");
});
