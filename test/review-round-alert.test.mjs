// A PR that is not converging under review goes to the EM for a scope ruling
// instead of being revised again. slashbin_mcp_services PR 245 (2026-10-09)
// spiralled silently; jerky_service PR #125 (2026-10-13) went 13 rounds with an
// alert that only logged, because the spec question under it reached no one who
// owned the spec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rulingState, EM_RULING_PATTERN } from "../dist/github/reports.js";
import { githubSource, orchestratorSource } from "./source-text.mjs";

const orchestrator = orchestratorSource();
const cr = (id, at, escalate = false) => ({ id, state: "CHANGES_REQUESTED", at, escalate });
const ok = (id, at) => ({ id, state: "APPROVED", at, escalate: false });
const ruling = (at) => ({ at, head: "**EM scope ruling: name redaction.** This PR" });

test("rounds count every CHANGES_REQUESTED review when no ruling was posted", () => {
  const s = rulingState([cr(1, "2026-10-01T00:00:00Z"), cr(2, "2026-10-02T00:00:00Z"), ok(3, "2026-10-03T00:00:00Z")], []);
  assert.equal(s.roundsSinceRuling, 2);
  assert.equal(s.latestReviewId, 3);
  assert.equal(s.rulingAt, null);
});

test("a ruling resets the count: only reviews after it count", () => {
  const reviews = [cr(1, "2026-10-01T00:00:00Z"), cr(2, "2026-10-02T00:00:00Z"), cr(3, "2026-10-04T00:00:00Z")];
  const s = rulingState(reviews, [{ at: "2026-10-01T12:00:00Z", head: "thanks" }, ruling("2026-10-03T00:00:00Z")]);
  assert.equal(s.roundsSinceRuling, 1);
  assert.equal(s.rulingAt, "2026-10-03T00:00:00Z");
});

test("only a comment OPENING with the ruling marker is a ruling", () => {
  assert.ok(EM_RULING_PATTERN.test("  **EM scope ruling: x"));
  assert.ok(!EM_RULING_PATTERN.test("as the **EM scope ruling** said"));
  const s = rulingState([cr(1, "2026-10-02T00:00:00Z")], [{ at: "2026-10-01T00:00:00Z", head: "per the **EM scope ruling" }]);
  assert.equal(s.rulingAt, null);
});

test("the Tech Lead's escalate marker on the newest review asks for a ruling at once", () => {
  assert.equal(rulingState([cr(1, "2026-10-01T00:00:00Z", true)], []).escalateRequested, true);
  assert.equal(rulingState([cr(1, "2026-10-01T00:00:00Z", true), cr(2, "2026-10-02T00:00:00Z")], []).escalateRequested, false,
    "an older marked review is answered once a newer one is not marked");
  assert.equal(rulingState([cr(1, "2026-10-01T00:00:00Z", true)], [ruling("2026-10-01T06:00:00Z")]).escalateRequested, false,
    "a ruling after the marked review answers it");
});

test("a non-converging PR stops before the revision launches, and the card is escalated", () => {
  const at = orchestrator.indexOf("ruling.roundsSinceRuling >= REVIEW_ROUNDS_ALERT || ruling.escalateRequested");
  assert.ok(at > 0, "no ruling check in revise");
  const block = orchestrator.slice(at, orchestrator.indexOf("// Invoke the revision skill with specific PR and issue context"));
  assert.match(block, /kind: "escalated"/, "the card must reach the EM, not just the log");
  assert.match(block, /events\.push/, "the notifier hears of it too");
  assert.match(block, /return null;\s*\}\s*$/, "revision must not run while a ruling is awaited");
  assert.ok(at < orchestrator.indexOf("// Invoke the revision skill with specific PR and issue context"));
});

test("the escalation is made once per newest review, so a new round re-escalates", () => {
  assert.match(orchestrator, /roundsKey = `\$\{repoConfig\.githubRepo\}#\$\{pending\.pr\.number\}@\$\{ruling\.latestReviewId/);
});

test("the round count and ruling are read from GitHub, not kept locally", () => {
  const gh = githubSource();
  assert.match(gh, /export function readRulingState[\s\S]{0,400}pulls\/\$\{pr\}\/reviews/);
  assert.match(gh, /issues\/\$\{pr\}\/comments/);
});
