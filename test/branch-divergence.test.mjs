// foreman#44: a diverged feature branch is announced once per episode, as
// state, and cleared on reconcile. The end-to-end proof (real git, fake gh,
// several cycles and a restart) is the EM acceptance script
// scripts/slashbin-ai/foreman-44-divergence-announce-acceptance.mjs; these pin
// the shape that must not regress.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const orchestrator = readFileSync(join(root, "src/orchestrator.ts"), "utf-8");
const reconciler = readFileSync(join(root, "src/reconciler.ts"), "utf-8");
const { divergenceNotice } = await import(join(root, "dist/orchestrator.js"));

const block = { featureBranch: "features", baseBranch: "develop", mergeBase: "abc", ahead: 8, behind: 3, since: "", announced: [] };
const repo = { name: "r", githubRepo: "acme/r", repoPath: "/tmp", featureBranch: "features", baseBranch: "develop" };

test("the notice names both counts, both branches and a reconciling command", () => {
  const body = divergenceNotice(repo, block);
  assert.match(body, /8 ahead, 3 behind/);
  assert.match(body, /git merge origin\/develop/);
  assert.match(body, /only notice for this episode/);
});

test("the reconciler no longer warns every cycle — the orchestrator announces once", () => {
  const fn = reconciler.slice(reconciler.indexOf("export function fastForwardFeatureBranch"));
  const diverged = fn.slice(fn.indexOf("ahead > 0 && behind > 0"), fn.indexOf('return "diverged"'));
  assert.doesNotMatch(diverged, /logger\.warn/);
});

test("an episode is keyed on the merge base and an unknown result never clears it", () => {
  assert.match(orchestrator, /prior\.mergeBase === mergeBase/);
  assert.match(orchestrator, /ffOutcome !== "unknown" && repoState\.branchBlock/);
});
