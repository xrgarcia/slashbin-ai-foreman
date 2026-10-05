// An open feature PR queues the next issue; it does not launch a session.
//
// jerky_service #66/#70, 2026-10-05. The skill builds straight on `features`
// and refuses to bundle a second issue into the open PR, so every cycle the
// orchestrator launched a session that could only stop. Each one posted
// "picked up" then "skipped" to Discord and moved the Paperclip card
// implementing → blocked, so normal queueing read as the Foreman failing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/orchestrator.ts"), "utf-8");

const gateAt = src.indexOf("Gate: an open feature PR holds the branch");
const block = src.slice(gateAt, src.indexOf("// Invoke the skill", gateAt));

test("the queue gate runs before any claim, event or session", () => {
  assert.ok(gateAt > 0, "the open-feature-PR gate is gone");
  const claimAt = src.indexOf("await claimWork(itemOf(repoConfig, n)", gateAt);
  const pickedAt = src.indexOf("Picked up ${actionableIssues.length}");
  const sessionAt = src.indexOf("implementApprovedIssues(repoConfig", gateAt);
  assert.ok(pickedAt > gateAt, "\"Picked up\" is posted to Discord before the gate");
  assert.ok(claimAt > gateAt, "the card is claimed (in progress) before the gate");
  assert.ok(sessionAt > gateAt, "a session launches before the gate");
});

test("a queued issue is reported as queued, never blocked, and returns quietly", () => {
  assert.match(block, /notifyObserversState\(itemOf\(repoConfig, n\), "new", "queued"/, "queued issues must reach observers as `queued`");
  assert.doesNotMatch(block, /reportWorkBlocked|notifyWaiting|events\?\.push/,
    "a queued issue must not be blocked, waited, or announced to Discord");
  assert.match(block, /return null;/);
});

test("queued is announced once per hold, not once per cycle", () => {
  assert.match(block, /repoQueue\.get\(n\) !== featurePr!\.number/);
});

test("an old skip on the open feature PR hands over to the gate", () => {
  assert.match(src, /prBlockingSkip\(entry\.reason\) === featurePr\.number/);
});
