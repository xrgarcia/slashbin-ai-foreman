// trackRelease: a release PR is announced open once, then merged or closed once.
import test from "node:test";
import assert from "node:assert/strict";
import { trackRelease, releaseIssues } from "../dist/release-tracker.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, prRecordOf } from "./issue-records.mjs";
import { ForemanRuntime } from "../dist/runtime.js";
let rt = new ForemanRuntime();

function harness({ open = null, state = "MERGED", saved = null } = {}) {
  const h = { open, state, saved, events: [], reads: 0, failSave: false };
  h.run = () => trackRelease({
    repo: "o/r",
    productionBranch: "main",
    saved: h.saved,
    findOpenRelease: () => h.open,
    releaseState: () => { h.reads++; return h.state; },
    save: async (_pr, v) => { if (h.failSave) return false; h.saved = v; return true; },
    emit: async (e) => { h.events.push([e.state, e.pr, e.issues.map((i) => i.issueNumber)]); },
  });
  return h;
}

test("releaseIssues: each carried line once, in order", () => {
  assert.deepEqual(releaseIssues("- #5: a\n- #3: b\n- #5: again"), [5, 3]);
});

test("releaseIssues: a #N inside a carried title is a mention, not a carried issue (foreman#86)", () => {
  const body = [
    "## Production Promotion", "", "### Issues included",
    "- #491: Bound tokens read documents by audience (EM#1284 F1a)",
    "- #18: Departments landing pages (follow-up to #11)",
    "- #7: Port the fix from xrgarcia/other#12",
    "", "Closes nothing; see #99", "PR 40: unlinked work",
  ].join("\n");
  assert.deepEqual(releaseIssues(body), [491, 18, 7]);
});

test("open once, then merged once; no GitHub read while it is open", async () => {
  const h = harness({ open: { number: 9, url: "u", body: "- #5: a" } });
  await h.run();
  await h.run();
  assert.deepEqual(h.events, [["open", 9, [5]]]);
  assert.equal(h.reads, 0);
  h.open = null;
  await h.run();
  await h.run();
  assert.deepEqual(h.events, [["open", 9, [5]], ["merged", 9, [5]]]);
  assert.equal(h.saved, null);
});

test("closed unmerged; a failed read keeps the saved PR for the next cycle", async () => {
  const h = harness({ saved: { pr: 9, issues: [5] }, state: null });
  await h.run();
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.saved, { pr: 9, issues: [5] });
  h.state = "CLOSED";
  await h.run();
  assert.deepEqual(h.events, [["closed", 9, [5]]]);
});

test("an issue added to the open PR re-announces it; a new PR settles the old one first", async () => {
  const h = harness({ saved: { pr: 9, issues: [5] }, open: { number: 9, url: "u", body: "- #5: a\n- #6: b" } });
  await h.run();
  assert.deepEqual(h.events, [["open", 9, [5, 6]]]);
  h.open = { number: 10, url: "u", body: "- #7: c" };
  await h.run();
  assert.deepEqual(h.events.slice(1), [["merged", 9, [5, 6]], ["open", 10, [7]]]);
});

// A failed save means nothing is announced: the pass retries, so the open announcement is never sent twice
// and an end is never sent without the saved PR having been cleared.
test("a save that fails announces nothing, and the next pass announces once", async () => {
  const h = harness({ open: { number: 9, url: "u", body: "- #5: a" } });
  h.failSave = true;
  await h.run();
  assert.deepEqual(h.events, []);
  assert.equal(h.saved, null);
  h.failSave = false;
  await h.run();
  await h.run();
  assert.deepEqual(h.events, [["open", 9, [5]]]);
  h.open = null;
  h.failSave = true;
  await h.run();
  assert.deepEqual(h.events, [["open", 9, [5]]], "the end is not announced until the pointer is cleared");
  h.failSave = false;
  await h.run();
  assert.deepEqual(h.events, [["open", 9, [5]], ["merged", 9, [5]]]);
});

// The saved release must survive a reload, or every promotion pass re-announces
// an open release PR (SLA-514 got "waiting on release PR #371" four times). It lives on the
// release PR's own record in the work source's store (EM#1244 f3).
test("the saved release is on the PR's record, so an open release is announced once across passes", async () => {
  await startAgentPlugins();
  rt = new ForemanRuntime();
  memoryRecords();
  const rc = { githubRepo: "o/r" };
  const events = [];
  const pass = async () => trackRelease({
    repo: "o/r", productionBranch: "main",
    saved: (await prRecordOf(rt, rc, 371)).tracked ?? null,
    findOpenRelease: () => ({ number: 371, url: "u", body: "- #368: a\n- #367: b" }),
    releaseState: () => "OPEN",
    save: (pr, v) => rt.records.updatePrRecord(rc, pr, (d) => { if (v) d.tracked = v; else delete d.tracked; }),
    emit: async (e) => { events.push(e.state); },
  });
  for (let i = 0; i < 4; i++) await pass();
  assert.deepEqual((await prRecordOf(rt, rc, 371)).tracked, { pr: 371, url: "u", issues: [368, 367] });
  assert.deepEqual(events, ["open"]);
  // A restart forgets everything in memory; the store still has it.
  rt = new ForemanRuntime();
  await pass();
  assert.deepEqual(events, ["open"]);
});
