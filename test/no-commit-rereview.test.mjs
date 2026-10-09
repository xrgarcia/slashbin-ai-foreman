// A declared no-commit revision must actually be re-reviewed.
//
// slashbin-io-worker#694, 2026-10-03. The reviewer requested changes at 18:29:56Z;
// the reviser answered "branch already correct" and the orchestrator relabelled
// #693 `pr under review` at 18:31:13Z — as revision-no-commit.test.mjs requires.
// But hasFreshReview measures a verdict against the last COMMIT, and a no-commit
// answer moves no commit, so the 18:29 verdict stayed "current" and the PR was
// never re-reviewed. The loop stopped one step short and needed a human.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const github = readFileSync(join(root, "src/github.ts"), "utf-8");
const fn = github.slice(github.indexOf("function returnedToReviewSinceVerdict"));
const body = fn.slice(0, fn.indexOf("\n}\n"));

test("a fresh verdict is overridden only when the issue was returned to review after it", () => {
  const find = github.slice(github.indexOf("export function findPRsNeedingReview"));
  const guard = find.slice(find.indexOf("if (hasFreshReview("), find.indexOf("if (hasFreshReview(") + 1600);
  assert.match(guard, /returnedToReviewSinceVerdict\(/,
    "without it a no-commit revision deadlocks: relabelled, never re-reviewed");
  assert.ok(guard.indexOf("returnedToReviewSinceVerdict") < guard.indexOf("return null"),
    "the override must be consulted before the skip");
});

test("only a CHANGES_REQUESTED verdict can be overridden — an APPROVED PR is current", () => {
  assert.match(body, /last\.state !== "CHANGES_REQUESTED"\) return false/);
});

test("the reply is the configured prUnderReview label, applied strictly after the verdict", () => {
  assert.match(body, /config\.lifecycleLabels\.prUnderReview/, "never a hard-coded label (EM#425)");
  assert.match(body, /> verdictMs/);
});

test("lookup failure keeps the old behaviour instead of reviewing every cycle", () => {
  assert.match(body, /catch \(err\)[\s\S]*return false;/);
});

test("paginated label events are parsed line by line, not as one JSON document", () => {
  assert.match(body, /--paginate/);
  assert.match(body, /\.split\("\\n"\)/);
});
