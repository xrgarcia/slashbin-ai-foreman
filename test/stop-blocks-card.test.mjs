// Every stop moves the card to Blocked with a reason the board can show:
// the first failure, a Claude usage limit, a GitHub rate limit. (2026-10-05:
// Ray — "when the Foreman is up and it runs into an error, or Claude
// subscription maxes out … it should move it to blocked.")
import { test } from "node:test";
import assert from "node:assert/strict";
import { stoppedReason } from "../dist/orchestrator.js";

test("Claude usage limit names the limit and when work resumes", () => {
  const r = stoppedReason("Implementation", { upstreamLimit: { reason: "5-hour limit reached", resetAtMs: Date.parse("2026-10-05T21:00:00Z") } }, false);
  assert.equal(r, "Implementation stopped: Claude usage limit (5-hour limit reached) — resumes after 21:00Z");
});

test("Claude usage limit without a reset time", () => {
  assert.match(stoppedReason("Review of PR #9", { upstreamLimit: { reason: "weekly" } }, false), /Claude usage limit \(weekly\) — resumes when the limit lifts$/);
});

test("GitHub rate limit", () => {
  assert.equal(stoppedReason("Implementation", { error: "x" }, true), "Implementation stopped: GitHub rate limit — resumes when it lifts");
});

test("first failure carries the error and the attempt count", () => {
  assert.equal(stoppedReason("Revision of PR #4", { error: "tsc failed" }, false, "1/2"), "Revision of PR #4 failed (1/2): tsc failed — retrying next cycle");
});
