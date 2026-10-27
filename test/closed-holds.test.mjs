// A closed issue holds nothing (jerky_ops#138, 2026-10-26): the Foreman's skip,
// hold, failure and unstick entries for an issue GitHub reads closed are dropped;
// an open or unreadable issue keeps its own.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneClosedHolds } from "../dist/closed-holds.js";
import { foremanHolds } from "../dist/work-source.js";
import { loadRepoState, saveRepoState, setStatePath } from "../dist/state.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
const repoConfig = { name: "r", githubRepo: "o/r", repoPath: "/nowhere" };
const skip = { lastSkippedAt: "2026-10-26T00:00:00Z", reason: "no change needed", skipCount: 1 };

function seed() {
  setStatePath(mkdtempSync(join(tmpdir(), "closed-holds-")));
  saveRepoState("r", {
    implemented: [], failed: { 5: { count: 4, lastError: "x" }, 6: { count: 1, lastError: "y" } },
    skipped: { 1: skip, 2: skip, 3: skip },
    held: { 4: { reason: "r", at: "2026-10-26T00:00:00Z" } },
    unstick: { "1:needs-ruling": { issue: 1, kind: "needs-ruling", reason: "r" }, "2:needs-ruling": { issue: 2, kind: "needs-ruling", reason: "r" } },
  });
}

test("entries of closed issues are dropped; open and unreadable ones stay", async () => {
  seed();
  // 1, 4, 5 closed; 2 is open (in the open view); 3 unreadable; 6 reads open.
  const states = async (_rc, ns) => new Map(ns.flatMap((n) => ({ 1: "completed", 4: "not_planned", 5: "completed", 6: "open" })[n] ? [[n, { 1: "completed", 4: "not_planned", 5: "completed", 6: "open" }[n]]] : []));
  const dropped = await pruneClosedHolds(repoConfig, { states }, logger, () => [2]);
  assert.deepEqual(dropped.sort(), [1, 4, 5]);
  const s = loadRepoState("r");
  assert.deepEqual(Object.keys(s.skipped).sort(), ["2", "3"]);
  assert.deepEqual(Object.keys(s.held ?? {}), []);
  assert.deepEqual(Object.keys(s.failed), ["6"]);
  assert.deepEqual(Object.keys(s.unstick), ["2:needs-ruling"]);
});

test("nothing is read when every entry's issue is open, and a failed read drops nothing", async () => {
  seed();
  let reads = 0;
  const states = async () => { reads++; return new Map(); };
  assert.deepEqual(await pruneClosedHolds(repoConfig, { states }, logger, () => [1, 2, 3, 4, 5, 6]), []);
  assert.equal(reads, 0);
  assert.deepEqual(await pruneClosedHolds(repoConfig, { states }, logger, () => []), []);
  assert.equal(Object.keys(loadRepoState("r").skipped).length, 3);
});

test("foremanHolds: any recorded hold, an unfinished release, or a branch block", () => {
  const h = foremanHolds({ implemented: [], failed: { 5: { count: 1, lastError: "" } }, skipped: { 1: skip }, verifyHeld: { 2: {} },
    unstick: { "3:k": { issue: 3 } }, prodReleases: { 9: { phase: "deploying", issues: [7] }, 8: { phase: "merged", issues: [8] } } });
  for (const n of [1, 2, 3, 5, 7]) assert.equal(h(n), true, `#${n}`);
  for (const n of [4, 8]) assert.equal(h(n), false, `#${n}`);
  assert.equal(foremanHolds({ implemented: [], failed: {}, branchBlock: {} })(99), true);
});
