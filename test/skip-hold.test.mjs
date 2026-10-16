// A skipped issue is held in Blocked, not retried on a timer.
//
// jerky_service#127, 2026-10-14. The session skipped it about ten times in one
// day for the same reason — refund_policy.md sat on another repo's unmerged PR —
// because the skip back-off only hid it for a window and every expiry bought a
// full session to rediscover the same answer. A held issue runs again only when
// a cheap GitHub read says something moved: the issue changed after the skip, or
// the issue or PR its trailer named in `waiting_on` closed or merged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectDeclaredSkip } from "../dist/agent.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { loadConfig } from "../dist/config.js";
import { UNBLOCK_CHECKS, passingCheck } from "../dist/unblock.js";
import { changedSince, escalatedReason, heldReason, holdStatus, parseWaitingOn, skipGate } from "../dist/github/skip-hold.js";
import { orchestratorSource } from "./source-text.mjs";

const REPO = "xrgarcia/jerky_service";
const SKIPPED = "2026-10-14T13:12:40Z";
const entry = (waitingOn) => ({ lastSkippedAt: SKIPPED, reason: "refund_policy.md not on main", skipCount: 9, ...(waitingOn ? { waitingOn } : {}) });

/** Reads that count their calls; `ref` and `activity` stand in for GitHub. */
function reads({ ref = { open: true, isPr: true, merged: false }, activity = [], self = "slashbin-foreman" } = {}) {
  const calls = { ref: 0, activity: 0 };
  return {
    calls,
    refState: () => { calls.ref++; if (ref instanceof Error) throw ref; return ref; },
    activitySince: () => { calls.activity++; if (activity instanceof Error) throw activity; return activity; },
    self,
  };
}

test("trailer: waiting_on is read as a structured field, in any order, quoted or bare", () => {
  const a = detectDeclaredSkip('FOREMAN_RESULT: skipped issue=127 waiting_on="xrgarcia/jerky_com_marketing#166" reason="file not merged"');
  assert.deepEqual([a.issue, a.waitingOn, a.reason], [127, "xrgarcia/jerky_com_marketing#166", "file not merged"]);
  const b = detectDeclaredSkip('FOREMAN_RESULT: skipped reason="x" issue=5 waiting_on=#4');
  assert.equal(b.waitingOn, "#4");
});

test("trailer: never parsed out of the prose reason", () => {
  const a = detectDeclaredSkip('FOREMAN_RESULT: skipped issue=127 reason="waiting on acme/site#166 to merge"');
  assert.equal(a.waitingOn, undefined);
  const b = detectDeclaredSkip('FOREMAN_RESULT: skipped issue=127 reason="set waiting_on=#9 next time"');
  assert.equal(b.waitingOn, undefined, "a reason that quotes the field does not set it");
  const c = detectDeclaredSkip('FOREMAN_RESULT: skipped issue=127 waiting_on="the marketing PR" reason="x"');
  assert.equal(c.waitingOn, undefined, "a non-reference is not a guess");
});

test("parseWaitingOn: owner/repo#N, or #N in this repo", () => {
  assert.deepEqual(parseWaitingOn("xrgarcia/jerky_com_marketing#166", REPO), { repo: "xrgarcia/jerky_com_marketing", number: 166 });
  assert.deepEqual(parseWaitingOn("#12", REPO), { repo: REPO, number: 12 });
  assert.equal(parseWaitingOn("166", REPO), undefined);
  assert.equal(parseWaitingOn(undefined, REPO), undefined);
});

test("held: nothing moved keeps the hold, with no session", () => {
  const r = reads();
  const s = holdStatus(entry("xrgarcia/jerky_com_marketing#166"), REPO, r);
  assert.equal(s.held, true);
  assert.equal(s.refIsPr, true);
  assert.deepEqual(r.calls, { ref: 1, activity: 1 }, "two cheap reads, nothing else");
});

test("release: the waited-on PR merged or closed", () => {
  for (const ref of [{ open: false, isPr: true, merged: true }, { open: false, isPr: true, merged: false }]) {
    const s = holdStatus(entry("xrgarcia/jerky_com_marketing#166"), REPO, reads({ ref }));
    assert.deepEqual([s.held, s.releasedBy], [false, "waitedOnDone"]);
  }
});

test("release: the waited-on issue closed", () => {
  const s = holdStatus(entry("#120"), REPO, reads({ ref: { open: false, isPr: false, merged: false } }));
  assert.deepEqual([s.held, s.releasedBy], [false, "waitedOnDone"]);
});

test("release: someone other than the Foreman changed the issue after the skip", () => {
  const s = holdStatus(entry(), REPO, reads({ activity: [{ at: "2026-10-14T15:00:00Z", login: "xrgarcia" }] }));
  assert.deepEqual([s.held, s.releasedBy], [false, "issueChanged"]);
});

test("held: the Foreman's own writes, and anything before the skip, never release it", () => {
  const activity = [
    { at: "2026-10-14T15:00:00Z", login: "slashbin-foreman" },
    { at: "2026-10-14T13:12:35Z", login: "xrgarcia" },
  ];
  assert.equal(holdStatus(entry(), REPO, reads({ activity })).held, true);
  assert.equal(changedSince(activity, SKIPPED, "Slashbin-Foreman"), false, "the login match ignores case");
});

test("held: a read that fails keeps the hold — unknown never releases", () => {
  const errors = [];
  const s = holdStatus(entry("#166"), REPO, reads({ ref: new Error("404"), activity: new Error("timeout") }), (what) => errors.push(what));
  assert.equal(s.held, true);
  assert.equal(errors.length, 2);
});

test("the blocked reason says what releases it", () => {
  const ref = parseWaitingOn("xrgarcia/jerky_com_marketing#166", REPO);
  assert.equal(heldReason("refund_policy.md not on main\nmore", REPO, ref, true),
    "refund_policy.md not on main — held until jerky_com_marketing#166 merges or this issue changes");
  assert.equal(heldReason("spec unclear", REPO), "spec unclear — held until this issue changes");
  assert.match(heldReason("x", REPO, parseWaitingOn("#3", REPO), false), /held until #3 closes or this issue changes$/);
});

test("the skip block is released by the new checks; the transient check still comes first", () => {
  assert.deepEqual(UNBLOCK_CHECKS.skip, ["transientCauseGone", "waitedOnDone", "issueChanged"]);
  assert.equal(passingCheck("skip", { waitedOnDone: true }), "waitedOnDone");
  assert.equal(passingCheck("skip", { issueChanged: true }), "issueChanged");
});

test("migration: an existing entry with no waiting_on is held, baselined at lastSkippedAt", () => {
  const old = { lastSkippedAt: SKIPPED, reason: "x", skipCount: 9 };
  const r = reads({ activity: [] });
  assert.equal(holdStatus(old, REPO, r).held, true);
  assert.deepEqual(r.calls, { ref: 0, activity: 1 }, "no reference to read; only the issue");
});

test("config: hold is the default; false opts back into the timed retry, from the file or env", () => {
  assert.equal(DEFAULT_BACKOFF.skip.hold, true);
  assert.equal(DEFAULT_BACKOFF.skip.maxAttempts, 3);
  assert.equal(load({ backoff: { skip: { maxAttempts: 5 } } }).backoff.skip.maxAttempts, 5);
  assert.equal(load({}).backoff.skip.hold, true);
  assert.equal(load({ backoff: { skip: { hold: false } } }).backoff.skip.hold, false);
  process.env.AI_AGENT_BACKOFF_SKIP_HOLD = "false";
  try {
    assert.equal(load({}).backoff.skip.hold, false, "the string \"false\" turns it off, not on");
  } finally {
    delete process.env.AI_AGENT_BACKOFF_SKIP_HOLD;
  }
});

test("no session while held: a held issue leaves the hand-off before any session starts", () => {
  const src = orchestratorSource();
  const filterAt = src.indexOf("const gate = skipGate(entry");
  const sessionAt = src.indexOf("implementApprovedIssues(repoConfig", filterAt);
  assert.ok(filterAt > 0, "the hold check is gone from the implement phase");
  assert.ok(sessionAt > filterAt, "a session launches before the hold check");
  const branch = src.slice(filterAt, src.indexOf("const age = now", filterAt));
  assert.match(branch, /stillBackedOff\.push\([^]*?\);\s*return false;\s*\}/, "a held issue must be filtered out of the hand-off");
  // The timed re-run is gone under hold: the age check only runs after the hold branch returned.
  assert.ok(src.indexOf("const age = now", filterAt) > filterAt);
});

// Ray, 2026-10-14: "put it in blocked and leave it there. Needs to escalate and
// assign it to the EM after it exhausts its attempts, but leave it in blocked."
const gate = (e, r, transient = false) => skipGate(e, REPO, 3, r, () => transient);
const changed = { activity: [{ at: "2026-10-14T15:00:00Z", login: "xrgarcia" }] };

test("cap: under it, a cheap release buys one session and keeps the count", () => {
  for (const [r, transient, by] of [[reads(changed), false, "issueChanged"], [reads({ ref: { open: false, isPr: true, merged: true } }), false, "waitedOnDone"], [reads(), true, "transientCauseGone"]]) {
    const g = gate({ ...entry("#166"), skipCount: 2 }, r, transient);
    assert.deepEqual(g, { run: true, by, reset: false });
  }
});

test("cap: a released entry runs until a session ends on it, with no further reads", () => {
  const r = reads();
  assert.deepEqual(gate({ ...entry(), skipCount: 1, releasedAt: "2026-10-14T15:01:00Z" }, r), { run: true, reset: false });
  assert.deepEqual(r.calls, { ref: 0, activity: 0 });
});

test("cap: out of attempts, it is escalated once and stays held, with no session", () => {
  const r = reads({ ref: { open: false, isPr: true, merged: true } });
  const g = gate({ ...entry("#166"), skipCount: 3 }, r, true);
  assert.equal(g.run, false);
  assert.equal(g.escalate, true);
  assert.equal(g.reason, escalatedReason("refund_policy.md not on main", 3));
  assert.match(g.reason, /skipped 3 times in a row; held for the EM until this issue changes$/);
  assert.deepEqual(r.calls, { ref: 0, activity: 1 }, "a merged reference or a cleared transient no longer releases it");
  const again = gate({ ...entry("#166"), skipCount: 3, escalatedAt: "2026-10-14T13:13:00Z" }, reads(), true);
  assert.deepEqual([again.run, again.escalate], [false, false], "escalated once, not every cycle");
});

test("cap: an escalated issue is released only by a person changing it, and the count resets", () => {
  const e = { ...entry(), skipCount: 4, escalatedAt: "2026-10-14T13:13:00Z", releasedAt: "2026-10-14T12:00:00Z" };
  assert.deepEqual(gate(e, reads(changed)), { run: true, by: "issueChanged", reset: true });
  assert.equal(gate(e, reads({ activity: [{ at: "2026-10-14T15:00:00Z", login: "slashbin-foreman" }] })).run, false, "the Foreman's own write is not a release");
  assert.equal(gate(e, reads({ activity: new Error("timeout") })).run, false, "unknown never releases");
});

test("migration: an entry already past the cap (jerky_service#127, skipped 8 times) is escalated", () => {
  const g = gate({ lastSkippedAt: SKIPPED, reason: "x", skipCount: 8 }, reads());
  assert.deepEqual([g.run, g.escalate], [false, true]);
});

test("escalation: the skip phase escalates at the cap, anchored at approved", () => {
  const src = orchestratorSource();
  assert.match(src, /kind: "escalated", item: itemOf\(repoConfig, n\), reason, at: "approved"/);
  assert.match(src, />= skip\.maxAttempts/);
});

function load(extra) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-skip-hold-"));
  const p = join(dir, ".ai-agent.json");
  writeFileSync(p, JSON.stringify({ repos: [{ name: "a", repoPath: dir, githubRepo: "example/a" }], ...extra }));
  try {
    return loadConfig(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// SLA-1559, 2026-10-16: the EM bot answered each "clear this hold" with a
// "nothing has changed, the hold stays" comment. Every comment by an account
// that is not the Foreman counted as the issue changing, so at the cap it reset
// the count and the two agents could restart each other without end.
const AGENTS = ["Agent-Manager", "agent-ops"];
const escalated = { ...entry(), skipCount: 3, escalatedAt: "2026-10-14T13:13:00Z" };
const at = "2026-10-14T15:00:00Z";
const agentReads = (activity) => ({ ...reads({ activity }), agents: AGENTS });

test("cap: another agent's comment does not release an escalated issue", () => {
  const g = gate(escalated, agentReads([{ at, login: "agent-manager", kind: "comment" }]));
  assert.equal(g.run, false, "an agent's comment is talk, not a change");
  assert.equal(g.escalate, false);
});

test("cap: another agent's label or edit buys one session and keeps the count", () => {
  for (const kind of ["event", "edit"]) {
    assert.deepEqual(gate(escalated, agentReads([{ at, login: "agent-ops", kind }])), { run: true, by: "issueChanged", reset: false });
  }
});

test("cap: a person's comment still releases it and resets the count, agents' comments around it or not", () => {
  const g = gate(escalated, agentReads([{ at, login: "agent-manager", kind: "comment" }, { at, login: "xrgarcia", kind: "comment" }]));
  assert.deepEqual(g, { run: true, by: "issueChanged", reset: true });
});

test("under the cap an agent's comment still buys a session: the cap is what bounds it", () => {
  assert.deepEqual(gate({ ...entry(), skipCount: 1 }, agentReads([{ at, login: "agent-manager", kind: "comment" }])), { run: true, by: "issueChanged", reset: false });
});

test("config: agentLogins defaults to none, from the file as a list or the env comma-separated", () => {
  assert.deepEqual(DEFAULT_BACKOFF.skip.agentLogins, []);
  assert.deepEqual(load({ backoff: { skip: { agentLogins: ["a", "b"] } } }).backoff.skip.agentLogins, ["a", "b"]);
  process.env.AI_AGENT_BACKOFF_SKIP_AGENT_LOGINS = "a, b";
  try {
    assert.deepEqual(load({}).backoff.skip.agentLogins, ["a", "b"]);
  } finally {
    delete process.env.AI_AGENT_BACKOFF_SKIP_AGENT_LOGINS;
  }
});
