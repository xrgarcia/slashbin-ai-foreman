// Regression tests for which branch a Dependabot PR may be merged into.
//
// History: owner decision 2026-09-07 retargeted Dependabot to the shared `features` branch, and the
// batch phase covered BOTH `features` and `develop` while repos flipped one at a time. foreman#208
// retires the shared branch: every change, a dependency bump included, now lands on `baseBranch`
// (`develop`) from its own branch, so the only acceptable base is `baseBranch`.
//
// The risk this file bounds is unchanged: the one outcome the dependency phase must never produce
// is a merge to the production branch, which is the defect `jerky_shipping#237` closed on the
// producing side.
//
// Run with `npm test` (node:test, no dependencies) after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { dependencyBatchBases } from "../dist/github.js";

test("the normal repo covers its base branch only (intentional change, #208: was [features, develop])", () => {
  assert.deepEqual(dependencyBatchBases("develop", "main"), ["develop"]);
});

test("the production branch is never an acceptable base", () => {
  assert.deepEqual(dependencyBatchBases("main", "main"), []);
});

test("a main-only repo yields no acceptable base at all", () => {
  // baseBranch === productionBranch. The caller already skips these;
  // this asserts the phase is safe even if that guard is ever removed.
  assert.deepEqual(dependencyBatchBases("main", "main"), []);
});

test("a missing base drops out rather than producing an empty-string base", () => {
  // An empty string would match no PR, but it would also read as a configured
  // branch in the refusal log. Filter it at the source.
  assert.deepEqual(dependencyBatchBases(undefined, "main"), []);
  assert.deepEqual(dependencyBatchBases("", "main"), []);
});

test("a custom development branch name is honoured, not hardcoded to develop", () => {
  // baseBranch is per-repo config. Nothing here may assume the house names:
  // the guard is "not the production branch", never "one of two known strings".
  assert.deepEqual(dependencyBatchBases("staging", "main"), ["staging"]);
});

test("the configured production branch is the one excluded, not the literal main", () => {
  assert.deepEqual(dependencyBatchBases("release", "release"), []);
  assert.deepEqual(dependencyBatchBases("main", "release"), ["main"]);
});
