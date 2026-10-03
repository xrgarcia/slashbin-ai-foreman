// trackRelease: a release PR is announced open once, then merged or closed once.
import test from "node:test";
import assert from "node:assert/strict";
import { trackRelease, releaseIssues } from "../dist/release-tracker.js";

function harness({ open = null, state = "MERGED", saved = null } = {}) {
  const h = { open, state, saved, events: [], reads: 0 };
  h.run = () => trackRelease({
    repo: "o/r",
    productionBranch: "main",
    saved: h.saved,
    findOpenRelease: () => h.open,
    releaseState: () => { h.reads++; return h.state; },
    save: (v) => { h.saved = v; },
    emit: async (e) => { h.events.push([e.state, e.pr, e.issues.map((i) => i.issueNumber)]); },
  });
  return h;
}

test("releaseIssues: each #N once, in order", () => {
  assert.deepEqual(releaseIssues("- #5: a\n- #3: b\n#5 again"), [5, 3]);
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
  const h = harness({ saved: { pr: 9, issues: [5] }, open: { number: 9, url: "u", body: "#5 #6" } });
  await h.run();
  assert.deepEqual(h.events, [["open", 9, [5, 6]]]);
  h.open = { number: 10, url: "u", body: "#7" };
  await h.run();
  assert.deepEqual(h.events.slice(1), [["merged", 9, [5, 6]], ["open", 10, [7]]]);
});
