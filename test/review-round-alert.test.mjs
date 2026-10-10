// Guards for the review-round alert: a spiral of SUCCESSFUL revisions used to be
// silent because the retry cap counts only failures (slashbin_mcp_services PR 245).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { orchestratorSource } from "./orchestrator-source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const orchestrator = orchestratorSource();

test("a PR sent back REVIEW_ROUNDS_ALERT times emits a notifier event before revising", () => {
  const at = orchestrator.indexOf("rounds >= REVIEW_ROUNDS_ALERT");
  assert.ok(at > 0, "no review-round threshold check");
  const block = orchestrator.slice(at, at + 900);
  assert.match(block, /events\.push/, "the alert must reach the notifier, not just the log");
  assert.match(block, /pending\.pr\.number/, "the alert is useless without the PR it is about");
  assert.ok(at < orchestrator.indexOf("// Invoke the revision skill with specific PR and issue context"),
    "the check must run before the revision is launched");
});

test("the alert does not stop the revision", () => {
  const at = orchestrator.indexOf("rounds >= REVIEW_ROUNDS_ALERT");
  const block = orchestrator.slice(at, orchestrator.indexOf("// Invoke the revision skill with specific PR and issue context"));
  assert.doesNotMatch(block, /return null/, "alert only — a spiral is the EM's call, not an automatic stop");
});

test("the round count is read from GitHub, not kept locally", () => {
  const gh = readFileSync(join(root, "src/github.ts"), "utf-8");
  assert.match(gh, /export function countChangesRequested[\s\S]{0,400}CHANGES_REQUESTED/);
});
