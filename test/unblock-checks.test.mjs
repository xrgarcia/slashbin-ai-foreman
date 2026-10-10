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

test("the card note names the check", () => {
  assert.match(unblockedReason("divergenceCleared"), /^unblocked: .*diverge/);
});

test("every block kind is wired into the orchestrator", () => {
  for (const kind of Object.keys(UNBLOCK_CHECKS)) {
    assert.match(src, new RegExp(`releaseIfResolved\\(\\s*"${kind}"|kind: BlockKind = [^;]*"${kind}"`), kind);
  }
});

test("a stopped revision records the head it stopped on, and resumes before the retry-cap skip", () => {
  assert.equal((src.match(/revisionStoppedHead\.set\(repoName, pending\.pr\.headRefOid\)/g) ?? []).length, 2);
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
