// Every point where the Foreman stops and waits for a person must put the card
// in the board's Blocked column.
//
// 2026-10-03, slashbin-io-worker#693: the PR stalled and the Paperclip card sat
// in "in review" — the owner could not see that anything needed him. Each stall
// below already logged an error and a Discord event; none told the work source.
// The blocked report is `emit({ kind: "blocked", ... })` (work-source.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { orchestratorSource } from "./source-text.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const o = orchestratorSource();
const after = (anchor, n = 1200) => { const i = o.indexOf(anchor); assert.ok(i >= 0, `anchor gone: ${anchor}`); return o.slice(i, i + n); };

test("reviewer/reviser stalemate reports blocked before stopping", () => {
  const b = after("if (seen > MAX_CONSECUTIVE_NO_COMMIT)", 1600);
  assert.ok(b.indexOf('kind: "blocked"') >= 0 && b.indexOf('kind: "blocked"') < b.indexOf("return null"));
});

test("review retries exhausted reports blocked", () => {
  assert.match(after("const pause = reviewFailurePause.start(repoName, repoFailure);", 400), /kind: "blocked"/);
});

test("implementation retries exhausted reports blocked", () => {
  assert.match(after("const pause = failurePause.start(repoName, repoFailure);\n        const why", 400), /emit\(\{ kind: "blocked", item: itemOf\(repoConfig, n\)/);
});

test("a configured stage that blocks or fails reports blocked", () => {
  assert.match(after('level: outcome === "blocked" ? "warn" : "error",', 400), /kind: "blocked"/);
});

test("revision retries exhausted still reports blocked", () => {
  assert.match(after("Revision retries exhausted on PR", 1500), /kind: "blocked"/);
});
