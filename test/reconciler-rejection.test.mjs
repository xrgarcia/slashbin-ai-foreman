// Guards for the reconciler's rejection handling and its git error reporting.
//
// Source-level assertions on purpose: reconcileRepo shells out to `git` and `gh`
// against a real clone, so exercising it here would need a fixture repo and a
// GitHub double. What actually regressed in the incidents these guard was the
// SHAPE of the code — a lookup that only saw open PRs, and a catch block that
// threw away the reason — and that is what these pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ForemanRuntime } from "../dist/runtime.js";
let rt = new ForemanRuntime();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reconciler = readFileSync(join(root, "src/reconciler.ts"), "utf-8");

test("the reconciler looks up closed-unmerged PRs, not only open ones", () => {
  assert.match(
    reconciler,
    /function readClosedPrs/,
    "no closed-unmerged lookup — a rejected PR is invisible again",
  );
  const fn = reconciler.slice(reconciler.indexOf("function readClosedPrs"));
  assert.match(fn.slice(0, 900), /codeHost\(\)\.closedPrsForBranch\(/, "the lookup must query closed PRs");
  const host = readFileSync(join(root, "src/github/core-reads.ts"), "utf-8");
  const closed = host.slice(host.indexOf("function closedPrsForBranch"));
  assert.match(closed.slice(0, 600), /"--state", "closed"/, "the code host's lookup must query closed PRs");
  assert.match(fn.slice(0, 900), /!p\.mergedAt/, "a merged PR is a delivery, not a rejection");
});

test("a branch unchanged since its rejection does not get a new PR", () => {
  const guard = reconciler.slice(reconciler.indexOf("const lastRejected"));
  assert.match(guard.slice(0, 1200), /headSha === lastRejected\.headSha/,
    "the guard must compare the branch head against the rejected head");
  const beforeCreate = guard.slice(0, guard.indexOf("createReconciliationPR"));
  assert.match(beforeCreate, /continue;/,
    "on a match it must skip the branch, not fall through to PR creation");
});

test("new commits on top of a rejection still reconcile, but say the bundle is dirty", () => {
  const guard = reconciler.slice(reconciler.indexOf("const lastRejected"));
  assert.match(guard.slice(0, 2000), /has new commits on top of a rejected PR/,
    "moving on without a warning is how a rejected diff rides along unnoticed");
});

test("git failures carry stderr and distinguish a shutdown from a fault", () => {
  assert.match(reconciler, /function formatGitError/, "no git error formatter");
  assert.match(reconciler, /cancelled: !timedOut && \(signal === "SIGTERM" \|\| signal === "SIGINT"\)/,
    "a signal-killed fetch must be reported as cancelled, not failed — unless our own timeout killed it");
  assert.match(reconciler, /timedOut = e\?\.code === "ETIMEDOUT"/,
    "Node's execFileSync timeout also sends SIGTERM; ETIMEDOUT is what tells it apart (foreman#61)");
  const fetchCatch = reconciler.slice(reconciler.indexOf('gitAsync(["fetch", "origin", "--prune"]'));
  assert.match(fetchCatch.slice(0, 900), /if \(failure\.cancelled\)/,
    "the fetch catch must branch on cancellation");
  assert.doesNotMatch(
    fetchCatch.slice(0, 900),
    /logger\.warn\("git fetch failed[^]*?error: err instanceof Error \? err\.message/,
    "the message-only warn is what masked the cause",
  );
});

test("a rejected branch is announced once per head SHA, recorded on the rejected PR's record before the alert", () => {
  const phase = readFileSync(join(root, "src/phases/reconcile.ts"), "utf-8");
  assert.doesNotMatch(readFileSync(join(root, "src/legacy-records.ts"), "utf-8"), /rejectedBranches\?: Record<string, string>/,
    "the persisted record moved out of the state file (EM#1244 f3); src/state.ts is gone (f4)");
  const block = phase.slice(phase.indexOf("for (const r of result.rejected"));
  assert.match(block.slice(0, 900), /record\.rejectedHead === r\.headSha/,
    "dedup must key on the head SHA so new commits re-alert");
  const save = block.indexOf("rt.records.updatePrRecord(");
  const alert = block.indexOf("events.push");
  assert.ok(save > 0 && save < alert, "the head is recorded before the alert goes out; a failed save sends nothing");
  assert.match(block.slice(0, save), /loadPrRecord\(/, "an unreadable record is not 'never told'");
  assert.match(block.slice(0, save), /branchUnresolved\(/, "a branch whose legacy entry is not imported yet waits");
});

test("the reconciler never force-pushes or resets a shared branch on its own", () => {
  assert.doesNotMatch(reconciler, /force-with-lease|--force|force=true|reset --hard/,
    "clearing pollution is destructive and stays a human decision (foreman#24)");
});
