// Every point where the Foreman stops and waits for a person must put the card
// in the board's Blocked column.
//
// 2026-10-03, slashbin-io-worker#693: the PR stalled and the Paperclip card sat
// in "in review" — the owner could not see that anything needed him. Each stall
// below already logged an error and a Discord event; none told the work source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const o = readFileSync(join(root, "src/orchestrator.ts"), "utf-8");
const after = (anchor, n = 1200) => { const i = o.indexOf(anchor); assert.ok(i >= 0, `anchor gone: ${anchor}`); return o.slice(i, i + n); };

test("reviewer/reviser stalemate reports blocked before stopping", () => {
  const b = after("if (seen > MAX_CONSECUTIVE_NO_COMMIT)", 1600);
  assert.ok(b.indexOf("reportWorkBlocked") >= 0 && b.indexOf("reportWorkBlocked") < b.indexOf("return null"));
});

test("review retries exhausted reports blocked", () => {
  assert.match(after("reviewFailureHitMaxAt.set(repoName, cycleNumber);", 400), /reportWorkBlocked/);
});

test("implementation retries exhausted reports blocked", () => {
  assert.match(after("failureHitMaxAt.set(repoName, cycleNumber);\n        const why", 400), /reportWorkBlocked\(itemOf\(repoConfig, n\)/);
});

test("a configured stage that blocks or fails reports blocked", () => {
  assert.match(after('level: outcome === "blocked" ? "warn" : "error",', 400), /reportWorkBlocked/);
});

test("revision retries exhausted still reports blocked", () => {
  assert.match(after("Revision retries exhausted on PR", 1500), /reportWorkBlocked/);
});
