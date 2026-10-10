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
import { orchestratorSource } from "./source-text.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = orchestratorSource();

const gateAt = src.indexOf("Gate: an open feature PR holds the branch");
// The gate itself: from its comment to the end of the `if (featurePr && queued…)`
// branch. Ending at "// Invoke the skill" swept in the post-gate "Picked up" push.
const block = src.slice(gateAt, src.indexOf("\n  }\n", src.indexOf("if (featurePr && queued.length > 0)", gateAt)) + 4);

test("the queue gate runs before any claim, event or session", () => {
  assert.ok(gateAt > 0, "the open-feature-PR gate is gone");
  const claimAt = src.indexOf('await emit({ kind: "claim", item: itemOf(repoConfig, n) }', gateAt);
  const pickedAt = src.indexOf("Picked up ${actionableIssues.length}");
  const sessionAt = src.indexOf("implementApprovedIssues(repoConfig", gateAt);
  assert.ok(pickedAt > gateAt, "\"Picked up\" is posted to Discord before the gate");
  assert.ok(claimAt > gateAt, "the card is claimed (in progress) before the gate");
  assert.ok(sessionAt > gateAt, "a session launches before the gate");
});

test("a queued issue is reported as queued, never blocked, and returns quietly", () => {
  assert.match(block, /advance\(itemOf\(repoConfig, n\), "queue"/, "queued issues must reach observers as `queued`");
  assert.doesNotMatch(block, /kind: "blocked"|kind: "waiting"|events\?\.push/,
    "a queued issue must not be blocked, waited, or announced to Discord");
  assert.match(block, /return null;/);
});

test("queued is announced once per hold, not once per cycle", () => {
  assert.match(block, /repoQueue\.get\(n\) !== featurePr!\.number/);
});

test("an old skip on the open feature PR hands over to the gate", () => {
  assert.match(src, /prBlockingSkip\(entry\.reason\) === featurePr\.number/);
});
