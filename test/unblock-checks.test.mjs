// The blocked queue's way out (Ray, 2026-10-05): every kind of block has a
// fixed list of checks, any passing check resolves it, unknown never does,
// and a resolution moves the card out of Blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UNBLOCK_CHECKS, passingCheck, unblockedReason } from "../dist/unblock.js";
import { orchestratorSource } from "./source-text.mjs";

const src = orchestratorSource();

test("every block kind has at least one check", () => {
  for (const [kind, checks] of Object.entries(UNBLOCK_CHECKS)) assert.ok(checks.length > 0, kind);
});

test("a passing check resolves; false and unknown keep the block", () => {
  assert.equal(passingCheck("revision-exhausted", { prHeadMoved: true }), "prHeadMoved");
  assert.equal(passingCheck("revision-exhausted", { prHeadMoved: false }), null);
  assert.equal(passingCheck("verify-exhausted", { baseAdvanced: undefined }), null);
  assert.equal(passingCheck("divergence", {}), null);
});

test("a check only releases the kinds it is listed for", () => {
  assert.equal(passingCheck("verify-no-pr", { prHeadMoved: true }), null);
  assert.equal(passingCheck("verify-no-pr", { mergedPrFound: true }), "mergedPrFound");
});

test("an edited spec releases a failed verify, held or exhausted; unknown keeps it", () => {
  assert.equal(passingCheck("verify-held", { specEdited: true }), "specEdited");
  assert.equal(passingCheck("verify-exhausted", { specEdited: true, baseAdvanced: false }), "specEdited");
  assert.equal(passingCheck("verify-exhausted", { specEdited: undefined, baseAdvanced: true }), "baseAdvanced");
  assert.equal(passingCheck("verify-held", { specEdited: undefined }), null);
  assert.equal(passingCheck("verify-held", { baseAdvanced: true }), null);
});

test("the card note names the check", () => {
  assert.match(unblockedReason("divergenceCleared"), /^unblocked: .*diverge/);
});

test("every block kind is wired into the orchestrator", () => {
  for (const kind of Object.keys(UNBLOCK_CHECKS)) {
    assert.match(src, new RegExp(`releaseIfResolved\\(\\s*"${kind}"|kind: BlockKind = [^;]*"${kind}"`), kind);
  }
});

test("a stopped revision records the head it stopped on, and resumes before the retry-cap skip", () => {
  // Retries exhausted: in memory. A no-commit stalemate: its persisted streak's head (src/no-commit-streak.ts).
  assert.equal((src.match(/revisionStoppedHead\.set\(repoName, pending\.pr\.headRefOid\)/g) ?? []).length, 1);
  assert.match(src, /revisionStoppedHead\.get\(repoName\) \?\? stalemateHead\(repoName, prNumber\)/);
  const resume = src.indexOf("A stopped revision resumes when someone pushes");
  const cap = src.indexOf("Check if this repo has exceeded revision failure retries");
  assert.ok(resume > 0 && resume < cap);
});

test("the mirror moves only a Foreman-blocked card on unblock", () => {
  const m = readFileSync(new URL("../src/paperclip/mirror.ts", import.meta.url), "utf8");
  const body = m.slice(m.indexOf("async onUnblocked"), m.indexOf("async onSnapshot"));
  assert.match(body, /this\.holds\.has\(id\)/);
  assert.match(body, /statusName\("blocked"\)/);
  assert.match(body, /this\.blockedAt\.delete\(id\)/);
});

test("an exhausted hold dev could not observe is not reopened by new commits on base", async () => {
  const { reopensOnBaseAdvance } = await import("../dist/phases/verify.js");
  // jerky_service #110: dev has no classifier key and drafting off, so every reopen re-ran the same hold.
  assert.equal(reopensOnBaseAdvance("acceptance-not-verified"), false);
  assert.equal(reopensOnBaseAdvance("acceptance-failed"), true);
});
