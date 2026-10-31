// docs/em-coordination.md is the EM's map of what to do at every state the
// Foreman can put work in. It is hand-written, so this test holds it to the
// source: every stage, lifecycle stage, hold code, block kind, unstick kind
// and deploy stop must be named in it (in backticks), or the EM meets a state
// its map does not cover (slashbin-engineering-manager, 2026-10-30).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_STAGES } from "../dist/stages.js";
import { STAGES } from "../dist/lifecycle.js";
import { UNSTICK_KINDS, UNSTICK_MAX_ATTEMPTS } from "../dist/unstick.js";
import { UNBLOCK_CHECKS } from "../dist/unblock.js";
import { TOOLING_HOLDS, verifyHoldPlan } from "../dist/phases/verify.js";
import { DEPLOY_STOPS } from "../dist/phases/release.js";
import { HANDOFF_VARIANTS } from "../dist/paperclip/handoff.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const map = readFileSync(join(root, "docs", "em-coordination.md"), "utf8");

function missing(names) {
  return [...names].filter((n) => !map.includes(`\`${n}\``));
}

const groups = {
  "lifecycle stage (src/lifecycle.ts STAGES)": STAGES,
  "unstick kind (src/unstick.ts UNSTICK_KINDS)": UNSTICK_KINDS,
  "block kind (src/unblock.ts UNBLOCK_CHECKS)": Object.keys(UNBLOCK_CHECKS),
  "unblock check (src/unblock.ts UNBLOCK_CHECKS)": [...new Set(Object.values(UNBLOCK_CHECKS).flat())],
  "tooling hold (src/phases/verify.ts TOOLING_HOLDS)": TOOLING_HOLDS,
  "deploy stop (src/phases/release.ts DEPLOY_STOPS)": Object.keys(DEPLOY_STOPS),
  "handoff variant (src/paperclip/handoff.ts HANDOFF_VARIANTS)": Object.keys(HANDOFF_VARIANTS),
};

for (const [what, names] of Object.entries(groups)) {
  test(`docs/em-coordination.md names every ${what}`, () => {
    assert.ok(names.length > 0, `${what}: nothing read from the source`);
    assert.deepEqual(missing(names), [], `add a row for each to docs/em-coordination.md`);
  });
}

test("docs/em-coordination.md names every pipeline stage the EM can be handed", () => {
  // Stages that never hand the EM a card are covered by the lifecycle table.
  assert.deepEqual(missing(BUILTIN_STAGES.filter((s) => s === "unstick")), []);
});

test("the visual QA hold the map hands to the EM is still the EM-decides path", () => {
  assert.equal(verifyHoldPlan("visual-qa-failed").kind, "decide");
  assert.ok(map.includes("`visual-qa-failed`"));
});

test("the unstick give-up count in the map matches the source", () => {
  assert.ok(map.includes(`After ${UNSTICK_MAX_ATTEMPTS} failed calls`), `map must say "After ${UNSTICK_MAX_ATTEMPTS} failed calls"`);
});
