// Regression tests for the review phase's wall-clock budget (issue #41).
//
// Origin: jerky_skuvault_service, 2026-09-22, cycle 13577. A review dispatched at
// 22:03:03Z merged PR #362 at 22:08:36Z, ran `npm run verify` and the acceptance
// script, and had finished its actual work by 22:11. It then spent the next 52
// minutes polling a data backfill converging in dev — five consecutive 9-minute
// watches, each making real progress — until the 60-minute ceiling SIGTERMed it
// at 23:03:04Z.
//
// Two defects compounded:
//
//   1. Nothing in the prompt named the budget. `reviewMaxDurationMs` was passed
//      to the spawner and enforced by a setTimeout; the agent was never told the
//      number, so it could not know a 75-minute job would not fit in the time it
//      had. The `hold=` trailer already existed as the correct escape and there
//      was no trigger pointing at it.
//
//   2. Every post-condition check lived inside `if (result.success)`. A run that
//      merged and then died skipped label reconciliation entirely, so #360 sat
//      dead-zoned for 55 minutes waiting for the recovery sweep to notice what
//      tryReview already knew — and was charged a retry for work that succeeded.
//
// Run with `npm test` (node:test, no dependencies) after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { reviewBudget } from "../dist/agent.js";
import { planFailedReviewOutcome } from "../dist/github.js";

// --- 1. The budget the run is told about ----------------------------------

test("the deadline is absolute, because an agent cannot subtract time it never measured", () => {
  const now = new Date("2026-09-22T22:03:03.000Z");
  const { deadlineIso } = reviewBudget(3_600_000, now);
  assert.equal(deadlineIso, "2026-09-22T23:03:03.000Z");
});

test("the deadline is the instant the run was actually killed", () => {
  // The real numbers: dispatch 22:03:03Z, SIGTERM 23:03:04Z. Had the run been
  // given this string it could have compared its 9-minute watch against it.
  const { deadlineIso } = reviewBudget(3_600_000, new Date("2026-09-22T22:03:03.459Z"));
  assert.equal(deadlineIso.slice(0, 16), "2026-09-22T23:03");
});

test("minutes are rounded for human reading, not truncated", () => {
  assert.equal(reviewBudget(3_600_000).minutes, 60);
  assert.equal(reviewBudget(1_800_000).minutes, 30);
  // 90s rounds to 2, not floors to 1 — understating a budget is the wrong error.
  assert.equal(reviewBudget(90_000).minutes, 2);
});

// --- 2. What a FAILED run earned ------------------------------------------

test("nothing merged — a plain failure, retry charged exactly as before", () => {
  const plan = planFailedReviewOutcome([], [360]);
  assert.equal(plan.workLanded, false);
  assert.equal(plan.chargeRetry, true, "a run that achieved nothing must still back off");
  assert.deepEqual(plan.mergedPrs, []);
  assert.deepEqual(plan.toReconcile, []);
});

test("merged then killed — the work landed, so no retry is charged", () => {
  // The incident: PR #362 merged, issues #359/#360 left at `pr under review`.
  const plan = planFailedReviewOutcome(
    [{ issueNumber: 360, prNumber: 362 }, { issueNumber: 359, prNumber: 362 }],
    [360, 359],
  );
  assert.equal(plan.workLanded, true);
  assert.equal(plan.chargeRetry, false, "the next cycle has nothing to retry — the PR is merged");
  assert.deepEqual(plan.mergedPrs, [362], "one PR, deduped across both issues");
  assert.deepEqual(plan.toReconcile.sort(), [359, 360]);
});

test("merged AND labelled before dying — nothing to reconcile, still no retry", () => {
  const plan = planFailedReviewOutcome([{ issueNumber: 360, prNumber: 362 }], []);
  assert.equal(plan.workLanded, true);
  assert.equal(plan.chargeRetry, false);
  assert.deepEqual(plan.toReconcile, [], "the run finished its own labeling; leave it alone");
});

test("an unmerged issue under review is NOT relabelled just because a sibling merged", () => {
  // #359's PR merged; #400's did not. Relabelling #400 would be exactly the
  // overreach the dead-zone guard exists to prevent — it is correctly under
  // review, and its review has not happened yet.
  const plan = planFailedReviewOutcome([{ issueNumber: 359, prNumber: 361 }], [359, 400]);
  assert.deepEqual(plan.toReconcile, [359]);
  assert.ok(!plan.toReconcile.includes(400), "an open PR's issue belongs under review");
});

test("merged PRs come back deduped and ordered, so the log line is stable", () => {
  const plan = planFailedReviewOutcome(
    [
      { issueNumber: 3, prNumber: 362 },
      { issueNumber: 1, prNumber: 361 },
      { issueNumber: 2, prNumber: 362 },
    ],
    [],
  );
  assert.deepEqual(plan.mergedPrs, [361, 362]);
});
