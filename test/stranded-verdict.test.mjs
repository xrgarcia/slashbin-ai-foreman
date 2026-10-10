// A review that posts CHANGES_REQUESTED and then dies must still reach revise.
//
// slashbin_mcp_services#240, 2026-10-09. The Tech Lead submitted CHANGES_REQUESTED
// at 05:43:45Z, then its next `gh api` call hit a TLS handshake timeout and the
// run failed before moving #235 to `pr pending actions`. The verdict was current,
// so findPRsNeedingReview skipped the PR; the label was never applied, so the
// revise phase never saw it. Seven hours parked, with an approved issue queued
// behind it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { githubSource, orchestratorSource } from "./source-text.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const github = githubSource();
const orchestrator = orchestratorSource();
const fn = github.slice(github.indexOf("function currentVerdictRequestsChanges"));
const body = fn.slice(0, fn.indexOf("\n}\n"));

test("a current verdict is checked for CHANGES_REQUESTED before the PR is skipped", () => {
  const find = github.slice(github.indexOf("export function findPRsNeedingReview"));
  const guard = find.slice(find.indexOf("if (hasFreshReview("), find.indexOf("if (hasFreshReview(") + 1600);
  const check = guard.indexOf("currentVerdictRequestsChanges(");
  assert.ok(check > 0, "without it a review that died after its verdict parks the PR forever");
  assert.ok(check > guard.indexOf("returnedToReviewSinceVerdict("), "a return to review still wins: that is a re-review");
  assert.ok(check < guard.indexOf("return null"), "consulted before the skip");
  assert.match(guard, /stranded: true/);
});

test("only the latest verdict counts, and only CHANGES_REQUESTED strands", () => {
  assert.match(body, /\.sort\(/);
  assert.match(body, /verdicts\[verdicts\.length - 1\]\?\.state === "CHANGES_REQUESTED"/);
  assert.match(body, /byReviewer\(r, reviewerLogin\)/);
});

test("lookup failure keeps the skip instead of sending work to revise blind", () => {
  assert.match(body, /catch \(err\)[\s\S]*return false;/);
});

test("the review phase reports stranded issues inReview → changesRequested and does not review", () => {
  const phase = orchestrator.slice(orchestrator.indexOf("if (candidate.stranded)"));
  const block = phase.slice(0, phase.indexOf("\n  }\n"));
  assert.match(block, /advance\(itemOf\(repoConfig, n\), "changesRequested"/);
  assert.match(block, /return false;/);
  assert.ok(orchestrator.indexOf("if (candidate.stranded)") < orchestrator.indexOf("getPRCheckVerdict(repoConfig, candidate.prNumber"),
    "before the CI gate and the review run");
});
