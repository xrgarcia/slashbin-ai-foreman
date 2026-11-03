// Issue-keyed records through the work-source store (EM#1244 f2): the skip, hold, verify hold, unstick
// questions, prod verification and stall notice of an issue live in that issue's record, not in
// `.agent-state.json`. These hold the facade (src/issue-records.ts) and the one-time import of the old file
// (src/legacy-records.ts) to the cutover rules: an import that loses nothing, runs once, and leaves an entry
// it could not save; an unreadable record that reads as unreadable, never as empty; a record that outlives
// the process. The work source is the real GitHub one with its record store swapped for an in-memory one.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeWorkSource, codeHost } from "../dist/plugins/registry.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { mergeLegacy } from "../dist/legacy-records.js";
import { foremanHolds } from "../dist/work-source.js";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { legacyFile, legacyIssueEntries, loadRepoState, saveRepoState } from "./_legacy-state.mjs";
import { repoRecordOf } from "./issue-records.mjs";
import { existsSync } from "node:fs";
import { startGitHubWorkSource } from "./agent-plugins.mjs";
import { mkTmp } from "./tmp-dir.mjs";
import { ForemanRuntime } from "../dist/runtime.js";
let rt = new ForemanRuntime();

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const repo = { name: "r", githubRepo: "example/r", repoPath: mkTmp("issue-records-repo-") };
const NOW = "2026-11-01T12:00:00.000Z";
const skip = { lastSkippedAt: NOW, reason: "needs a decision", skipCount: 1 };
const held = { heldAt: NOW, prNumber: 70, reason: "wait" };
const vheld = { heldAt: NOW, prNumber: 71, reason: "dev-verify-failed", attempts: 1 };
const question = (issue, reason) => ({ issue, kind: "needs-ruling", reason, status: "open", attempts: 1, since: NOW });

let store, failSave;

before(async () => {
  // Issue 2 is the only open issue; the import reads closed issues through the source's `states`.
  const bin = mkTmp("issue-records-gh-");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '[{"number":2,"title":"t","labels":[]}]'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.FOREMAN_GITHUB_TOKEN ??= "test-token-not-real";
  process.env.PATH = `${bin}:${process.env.PATH}`;
  await startGitHubWorkSource();
});

/** A fresh state dir and an empty in-memory store under the active work source; `failSave(n)` makes a save of issue n fail. */
beforeEach(() => {
  setStatePath(mkTmp("issue-records-state-"));
  store = new InMemoryRecordStore();
  failSave = new Set();
  const source = activeWorkSource();
  source.loadRecord = (key, rc) => store.loadRecord(key, rc);
  source.saveRecord = async (key, record, rc) => (failSave.has(key.number) ? false : store.saveRecord(key, record, rc));
  source.states = async (_rc, ns) => new Map(ns.map((n) => [n, n === 5 ? "completed" : "open"]));
  rt = new ForemanRuntime();
});

/** The state file as a pre-f2 Foreman left it. */
function legacyState() {
  saveRepoState("r", {
    implemented: [3],
    skipped: { 1: skip },
    held: { 2: held },
    verifyHeld: { 4: vheld },
    failed: { 5: { count: 4, lastError: "x" } }, // issue 5 reads closed
    prodVerified: { 6: { pr: 9, mergeSha: "abc", at: NOW } },
    promotionStallNoted: [7],
    unstick: { "1:needs-ruling": question(1, "r1"), "0:needs-ruling": question(0, "repo") },
  });
}
/** The issues the state file still holds an issue-keyed entry for. */
const fileIssues = () => [...legacyIssueEntries("r").keys()].sort((a, b) => a - b);

test("merge: what the store holds wins, unstick questions merge by key", () => {
  const merged = mergeLegacy(
    { skipped: { ...skip, reason: "newer" }, unstick: { b: question(1, "b") } },
    { skipped: skip, held, unstick: { a: question(1, "a"), b: question(1, "old b") } },
  );
  assert.equal(merged.skipped.reason, "newer");
  assert.deepEqual(merged.held, held);
  assert.deepEqual(Object.keys(merged.unstick).sort(), ["a", "b"]);
  assert.equal(merged.unstick.b.reason, "b", "the stored copy of a key wins");
});

test("import: every live entry moves to its issue's record, a closed issue's is dropped, the file keeps none", async () => {
  legacyState();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 1), { skipped: skip, unstick: { "1:needs-ruling": question(1, "r1") } });
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 2), { held });
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 4), { verifyHeld: vheld });
  assert.deepEqual((await rt.records.loadIssueRecord(repo, 6)).prodVerified.mergeSha, "abc");
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 7), { promotionStallNoted: true });
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 5), {}, "a closed issue holds nothing: its failure was dropped, not imported");
  assert.deepEqual(fileIssues(), []);
  assert.equal((await repoRecordOf(rt, repo)).unstick["0:needs-ruling"].reason, "repo", "a question about no issue moves to the repo's record");
  assert.equal(existsSync(legacyFile()), false, "everything moved (implemented is derived, not kept): the file is deleted");
});

test("import is idempotent: a second run writes nothing and changes nothing", async () => {
  legacyState();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.equal(existsSync(legacyFile()), false);
  let saves = 0;
  const source = activeWorkSource();
  const save = source.saveRecord;
  source.saveRecord = (...a) => { saves++; return save(...a); };
  rt = new ForemanRuntime();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.equal(saves, 0);
  assert.equal(existsSync(legacyFile()), false);
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 2), { held });
});

test("a failed save leaves the legacy entry, withholds the issue, and the next import finishes it", async () => {
  legacyState();
  failSave.add(2);
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.deepEqual(fileIssues(), [2], "the hold is still in the file: no live hold is lost");
  assert.equal(await rt.records.loadIssueRecord(repo, 2), null, "until it is imported the issue reads as unreadable, never as empty");
  assert.equal(await rt.records.updateIssueRecord(repo, 2, (d) => { d.skipped = skip; }), false, "and nothing is written over it");
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 1), { skipped: skip, unstick: { "1:needs-ruling": question(1, "r1") } }, "the others moved");
  // The store recovers; a later import (here, a restart) moves the rest.
  failSave.clear();
  rt = new ForemanRuntime();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 2), { held });
  assert.deepEqual(fileIssues(), []);
});

test("a lookup that throws during the import leaves every legacy issue unavailable until the import completes", async () => {
  legacyState();
  const host = codeHost();
  const real = host.openIssueLabels;
  host.openIssueLabels = () => { throw new Error("github is down"); };
  try {
    await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  } finally {
    host.openIssueLabels = real;
  }
  assert.deepEqual(fileIssues(), [1, 2, 4, 5, 6, 7], "nothing was removed from the file");
  for (const n of [1, 2, 4, 6, 7]) assert.equal(await rt.records.loadIssueRecord(repo, n), null, `#${n} reads as unreadable, not as empty`);
  assert.equal((await foremanHolds(rt, repo, [1, 2], quiet))(2), true);
  // The source recovers inside the retry window: still withheld, because the import has not run again.
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.equal(await rt.records.loadIssueRecord(repo, 1), null);
  // The retry window passes (a restart stands in for it): the import completes and releases each issue.
  rt = new ForemanRuntime();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 2), { held });
  assert.deepEqual(fileIssues(), []);
});

test("an unavailable record fails closed: unreadable, unwritable, and the Foreman holds the issue", async () => {
  const source = activeWorkSource();
  source.loadRecord = async () => ({ status: "unavailable" });
  assert.equal(await rt.records.loadIssueRecord(repo, 8), null);
  const loaded = await rt.records.loadIssueRecords(repo, [8, 9]);
  assert.deepEqual([...loaded.unavailable].sort(), [8, 9]);
  assert.equal(loaded.records.size, 0);
  assert.equal(await rt.records.updateIssueRecord(repo, 8, (d) => { d.held = held; }), false);
  const holds = await foremanHolds(rt, repo, [8, 9], quiet);
  assert.equal(holds(8), true);
  assert.equal(holds(9), true);
});

test("a record survives a restart: nothing but the store carries it", async () => {
  assert.equal(await rt.records.updateIssueRecord(repo, 8, (d) => { d.held = held; d.skipped = skip; }), true);
  assert.equal(await rt.records.updateIssueRecord(repo, 8, (d) => { delete d.skipped; }), true, "a cleared hold is a save without the field");
  // A restart: the process forgets everything it kept in memory.
  rt = new ForemanRuntime();
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 8), { held });
  assert.deepEqual(fileIssues(), [], "the state file never held it");
  assert.equal(await rt.records.updateIssueRecord(repo, 8, (d) => { delete d.held; }), true);
  assert.deepEqual(await rt.records.loadIssueRecord(repo, 8), {}, "a record with nothing in it is the absent one");
});

test("foremanHolds: any recorded hold, an unfinished release, a branch block, or an unreadable record", async () => {
  await rt.records.updateIssueRecord(repo, 1, (d) => { d.skipped = skip; });
  await rt.records.updateIssueRecord(repo, 2, (d) => { d.verifyHeld = vheld; });
  await rt.records.updateIssueRecord(repo, 3, (d) => { d.unstick = { k: question(3, "r") }; });
  await rt.records.updateIssueRecord(repo, 5, (d) => { d.failed = { count: 1, lastError: "" }; });
  await rt.records.updateIssueRecord(repo, 10, (d) => { d.prodVerified = { pr: 1, mergeSha: "a", at: NOW }; });
  rt.releases.noteReleasePrs(repo.githubRepo, [8, 9]);
  await rt.records.updatePrRecord(repo, 9, (d) => { d.release = { pr: 9, phase: "deploying", issues: [7] }; });
  await rt.records.updatePrRecord(repo, 8, (d) => { d.release = { pr: 8, phase: "merged", issues: [8] }; });
  const h = await foremanHolds(rt, repo, [1, 2, 3, 4, 5, 7, 8, 10], quiet);
  for (const n of [1, 2, 3, 5, 7]) assert.equal(h(n), true, `#${n}`);
  for (const n of [4, 8, 10]) assert.equal(h(n), false, `#${n}`);
  rt.divergence.observe(repo, { ahead: 1, behind: 1, mergeBase: "abc" });
  assert.equal((await foremanHolds(rt, repo, [99], quiet))(99), true);
});

test("no core file reads an issue-keyed field from the state file but the import", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } };
  walk(dir);
  const field = "(?:failed|skipped|held|verifyHeld|prodVerified|promotionStallNoted|unstick)";
  const reads = new RegExp(`(?:loadRepoState\\([^)]*\\)|\\b(?:repoState|rs))\\??\\.${field}\\b`);
  const offenders = [];
  for (const p of files) {
    if (/\/legacy-records\.ts$/.test(p)) continue;
    readFileSync(p, "utf8").split("\n").forEach((line, i) => { if (!/^\s*(\/\/|\*)/.test(line) && reads.test(line)) offenders.push(`${p.slice(dir.length + 1)}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(offenders, []);
});
