import { test } from "node:test";
import assert from "node:assert/strict";
import { rulingAnswersStalemate } from "../dist/no-commit-streak.js";

test("a whole-second ruling older than a millisecond round does not release", () => {
  assert.equal(rulingAnswersStalemate("2026-11-05T12:15:47Z", "2026-11-05T12:15:47.600Z"), false);
});

test("a ruling equal to the round does not release", () => {
  assert.equal(rulingAnswersStalemate("2026-11-05T12:15:47Z", "2026-11-05T12:15:47.000Z"), false);
});

test("a ruling after the round releases", () => {
  assert.equal(rulingAnswersStalemate("2026-11-05T12:15:48Z", "2026-11-05T12:15:47.600Z"), true);
});

test("no ruling never releases", () => {
  assert.equal(rulingAnswersStalemate(null, "2026-11-05T12:15:47Z"), false);
  assert.equal(rulingAnswersStalemate(null, null), false);
});

test("a legacy streak on a PR with no review: any ruling releases", () => {
  assert.equal(rulingAnswersStalemate("2026-11-05T12:15:47Z", null), true);
});
