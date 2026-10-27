// An approved issue waits for its GitHub "blocked by" issues to merge
// (jerky_service #108 → #109, 2026-10-12): order is a structured link, never prose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockerRef, unmetBlockers } from "../dist/github/blockers.js";

const L = { prUnderReview: "pr under review", prMerged: "pr merged", prPendingActions: "pr pending actions",
  prApproved: "pr approved", readyForProd: "ready for prod release", releasePending: "release pending",
  prodVerifyHeld: "prod verification held", readyToClose: "ready to close" };
const b = (number, state, ...labels) => ({ number, state, labels: labels.map((name) => ({ name })) });

test("a blocker holds until it merges; merged, later or closed releases it", () => {
  assert.deepEqual(unmetBlockers([b(108, "open", "approved")], L).map((x) => x.number), [108]);
  assert.deepEqual(unmetBlockers([b(108, "open", "approved", "pr under review")], L).map((x) => x.number), [108]);
  assert.deepEqual(unmetBlockers([b(108, "open", "pr pending actions")], L).map((x) => x.number), [108]);
  for (const l of ["pr merged", "pr approved", "ready for prod release", "release pending", "prod verification held"]) {
    assert.deepEqual(unmetBlockers([b(108, "open", l)], L), [], l);
  }
  assert.deepEqual(unmetBlockers([b(108, "closed")], L), []);
  assert.deepEqual(unmetBlockers([], L), []);
});

test("a blocker in another repo is named with its repo", () => {
  const here = { ...b(5, "open"), repository_url: "https://api.github.com/repos/o/here" };
  const there = { ...b(9, "open"), repository_url: "https://api.github.com/repos/o/there" };
  assert.equal(blockerRef(here, "o/here"), "#5");
  assert.equal(blockerRef(there, "o/here"), "o/there#9");
});
