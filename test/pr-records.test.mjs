// PR-keyed and release records through the work-source store (EM#1244 f3): a release's progress, a PR's
// no-commit streak, the head of a rejected branch and the release pointer live on the PR's own record
// (src/issue-records.ts), not in `.agent-state.json`. These hold the one-time import of the old file
// (src/legacy-records.ts) to the cutover rules, and every reader to "unavailable is not absent".
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeWorkSource, codeHost } from "../dist/plugins/registry.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { foremanHolds } from "../dist/work-source.js";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { legacyFile, legacyPrEntries, saveRepoState } from "./_legacy-state.mjs";
import { existsSync } from "node:fs";
import { startGitHubWorkSource } from "./agent-plugins.mjs";
import { mkTmp } from "./tmp-dir.mjs";
import { ForemanRuntime } from "../dist/runtime.js";
const withoutAt = (s) => { if (!s) return s; const { at, ...rest } = s; return rest; };
let rt = new ForemanRuntime();

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const repo = { name: "r", githubRepo: "example/r", repoPath: mkTmp("pr-records-repo-"), baseBranch: "develop", productionBranch: "main" };
const NOW = "2026-11-01T12:00:00.000Z";
const rel = (pr, phase = "soaking", extra = {}) => ({ pr, headSha: "a".repeat(40), issues: [pr + 1000], phase, attempts: 0, since: NOW, ...extra });

let store, failSave, breakLoad, prStates, closedByBranch, throwClosed, releasePrs, throwAll, realHost;

before(async () => {
  const bin = mkTmp("pr-records-gh-");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '[]'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.FOREMAN_GITHUB_TOKEN ??= "test-token-not-real";
  process.env.PATH = `${bin}:${process.env.PATH}`;
  await startGitHubWorkSource();
});

beforeEach(() => {
  setStatePath(mkTmp("pr-records-state-"));
  store = new InMemoryRecordStore();
  failSave = new Set();
  breakLoad = new Set();
  prStates = new Map();
  closedByBranch = new Map();
  throwClosed = false;
  releasePrs = [];
  throwAll = false;
  const source = activeWorkSource();
  source.loadRecord = async (key, rc) => (key.kind === "pr" && breakLoad.has(key.number) ? { status: "unavailable" } : store.loadRecord(key, rc));
  source.saveRecord = async (key, record, rc) => (key.kind === "pr" && failSave.has(key.number) ? false : store.saveRecord(key, record, rc));
  const host = codeHost();
  realHost = { getPrState: host.getPrState, closedPrsForBranch: host.closedPrsForBranch, allPrsForBranch: host.allPrsForBranch };
  host.getPrState = (_r, n) => prStates.get(n) ?? null;
  host.closedPrsForBranch = (_r, head) => { if (throwClosed) throw new Error("github is down"); return closedByBranch.get(head) ?? []; };
  host.allPrsForBranch = () => { if (throwAll) throw new Error("github is down"); return releasePrs.map((number) => ({ number, state: "MERGED" })); };
  rt = new ForemanRuntime();
});

afterEach(() => Object.assign(codeHost(), realHost));

/** The state file as a pre-f3 Foreman left it. */
function legacyState() {
  prStates.set(10, "OPEN"); prStates.set(11, "CLOSED"); prStates.set(12, "MERGED");
  prStates.set(20, "OPEN"); prStates.set(21, "MERGED"); prStates.set(22, "CLOSED");
  closedByBranch.set("feat-a", [{ number: 30, headRefOid: "h1", mergedAt: null, closedAt: "2026-10-01T00:00:00Z" }, { number: 29, headRefOid: "old", mergedAt: null, closedAt: "2026-09-01T00:00:00Z" }]);
  closedByBranch.set("feat-b", [{ number: 31, headRefOid: "h-moved", mergedAt: null, closedAt: "2026-10-01T00:00:00Z" }]);
  saveRepoState("r", {
    implemented: [3],
    prodReleases: { 10: rel(10, "deploying"), 11: rel(11, "held"), 12: rel(12, "soaking") },
    noCommitStreaks: { 20: { head: "s1", count: 1 }, 21: { head: "s2", count: 2 }, 22: { head: "s3", count: 1 } },
    rejectedBranches: { "feat-a": "h1", "feat-b": "h-was", "feat-gone": "h9" },
    release: { pr: 10, url: "u", issues: [1010] },
  });
}
const filePrs = () => {
  const l = legacyPrEntries("r");
  return { releases: [...l.releases.keys()], streaks: [...l.streaks.keys()], rejected: [...l.rejected.keys()], tracked: l.tracked?.pr };
};

test("import: every live entry moves to its PR's record; a finished one is dropped; the file keeps none", async () => {
  legacyState();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.equal((await rt.records.loadPrRecord(repo, 10)).release.phase, "deploying", "an unfinished release moves");
  assert.deepEqual((await rt.records.loadPrRecord(repo, 10)).tracked, { pr: 10, url: "u", issues: [1010] }, "the release pointer rides on the release PR");
  assert.equal((await rt.records.loadPrRecord(repo, 11)).release, undefined, "a release whose PR closed unmerged is finished");
  assert.equal((await rt.records.loadPrRecord(repo, 12)).release.phase, "soaking", "a merged release not yet verified and soaked is not finished");
  assert.deepEqual(withoutAt((await rt.records.loadPrRecord(repo, 20)).noCommit), { head: "s1", count: 1 });
  assert.equal((await rt.records.loadPrRecord(repo, 21)).noCommit, undefined, "a streak on a merged PR is finished");
  assert.equal((await rt.records.loadPrRecord(repo, 22)).noCommit, undefined, "a streak on a closed PR is finished");
  assert.equal((await rt.records.loadPrRecord(repo, 30)).rejectedHead, "h1", "the branch is stored on its last closed-unmerged PR");
  assert.equal((await rt.records.loadPrRecord(repo, 31)).rejectedHead, undefined, "a branch whose head moved since the alert has nothing to remember");
  assert.deepEqual(filePrs(), { releases: [], streaks: [], rejected: [], tracked: undefined });
  assert.equal(existsSync(legacyFile()), false, "everything moved: the file is deleted");
});

test("import is idempotent: a second run writes nothing and changes nothing", async () => {
  legacyState();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.equal(existsSync(legacyFile()), false);
  const snapshot = JSON.stringify(await Promise.all([10, 12, 20, 30].map((n) => rt.records.loadPrRecord(repo, n))));
  let saves = 0;
  const source = activeWorkSource();
  const save = source.saveRecord;
  source.saveRecord = (...a) => { saves++; return save(...a); };
  rt = new ForemanRuntime();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.equal(saves, 0);
  assert.equal(existsSync(legacyFile()), false);
  assert.equal(JSON.stringify(await Promise.all([10, 12, 20, 30].map((n) => rt.records.loadPrRecord(repo, n)))), snapshot);
});

test("what the store already holds wins over the legacy copy", async () => {
  legacyState();
  await rt.records.updatePrRecord(repo, 10, (d) => { d.release = rel(10, "merged"); });
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.equal((await rt.records.loadPrRecord(repo, 10)).release.phase, "merged");
  assert.deepEqual(filePrs().releases, []);
});

test("a failed save leaves the legacy entry, withholds the PR, and the next import finishes it", async () => {
  legacyState();
  failSave.add(12); failSave.add(20); failSave.add(30);
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.deepEqual(filePrs(), { releases: [12], streaks: [20], rejected: ["feat-a"], tracked: undefined }, "nothing live is lost");
  assert.equal(await rt.records.loadPrRecord(repo, 12), null, "until imported the PR reads as unreadable, never as empty");
  assert.equal(await rt.records.loadPrRecord(repo, 20), null);
  assert.equal(rt.records.branchUnresolved(repo, "feat-a"), true, "and the branch's alert waits");
  assert.equal(await rt.records.updatePrRecord(repo, 12, (d) => { d.noCommit = { head: "x", count: 1 }; }), false, "nothing is written over it");
  assert.equal((await rt.records.loadPrRecord(repo, 10)).release.phase, "deploying", "the others moved");
  failSave.clear();
  rt = new ForemanRuntime();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.equal((await rt.records.loadPrRecord(repo, 12)).release.phase, "soaking");
  assert.equal((await rt.records.loadPrRecord(repo, 30)).rejectedHead, "h1");
  assert.equal(rt.records.branchUnresolved(repo, "feat-a"), false);
  assert.deepEqual(filePrs(), { releases: [], streaks: [], rejected: [], tracked: undefined });
});

test("an unreadable PR state counts as live, and a failed branch lookup leaves the entry", async () => {
  legacyState();
  prStates.delete(11); prStates.delete(22); // GitHub cannot say
  throwClosed = true;
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.equal((await rt.records.loadPrRecord(repo, 11)).release.phase, "held", "unknown is not finished");
  assert.deepEqual(withoutAt((await rt.records.loadPrRecord(repo, 22)).noCommit), { head: "s3", count: 1 });
  assert.deepEqual(filePrs().rejected.sort(), ["feat-a", "feat-b", "feat-gone"], "no lookup, no decision");
  assert.equal(rt.records.branchUnresolved(repo, "feat-b"), true);
  throwClosed = false;
  rt = new ForemanRuntime();
  await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
  assert.deepEqual(filePrs().rejected, []);
  assert.equal(rt.records.branchUnresolved(repo, "feat-b"), false);
});

test("an unavailable PR record fails closed everywhere it is read", async () => {
  await rt.releases.putRelease(repo, rel(10, "deploying"));
  await rt.releases.putRelease(repo, rel(11, "merged"));
  rt = new ForemanRuntime();
  releasePrs = [10, 11]; // the sweep's listing of the release PRs
  breakLoad.add(11); breakLoad.add(20);
  assert.equal(await rt.records.loadPrRecord(repo, 11), null);
  const many = await rt.records.loadPrRecords(repo, [10, 11]);
  assert.deepEqual([...many.unavailable], [11]);
  const releases = await rt.releases.loadReleases(repo, quiet);
  assert.deepEqual(releases.releases.map((r) => r.pr), [10], "an unreadable release is never acted on");
  assert.deepEqual([...releases.unreadable], [11], "and is named, so the caller can hold its issues");
  assert.deepEqual(await rt.streaks.read(repo, 20), { ok: false });
  assert.equal(await rt.streaks.record(repo, 20, "h", undefined), null);
  assert.equal(await rt.streaks.clear(repo, 20), false);
  assert.equal((await foremanHolds(rt, repo, [1011], quiet))(1011), true, "an issue of an unreadable release stays held");
});

test("a listing that fails means no release is known: nothing acts, and the failure is not cached", async () => {
  await rt.releases.putRelease(repo, rel(10, "merged"));
  rt = new ForemanRuntime();
  throwAll = true;
  assert.equal(await rt.releases.loadReleases(repo, quiet), null);
  assert.equal((await foremanHolds(rt, repo, [5], quiet))(5), true);
  throwAll = false; releasePrs = [10];
  assert.deepEqual((await rt.releases.loadReleases(repo, quiet)).releases.map((r) => r.pr), [10], "the next call lists again and recovers it");
});

test("discovery lists every release PR, with no window: a stored release behind any number of newer ones is recovered", async () => {
  await rt.releases.putRelease(repo, rel(101, "held"));
  rt = new ForemanRuntime();
  releasePrs = Array.from({ length: 400 }, (_, k) => 102 + k).concat([101]);
  assert.deepEqual((await rt.releases.loadReleases(repo, quiet)).releases.map((r) => r.pr), [101]);
  const host = readFileSync(join(srcDir, "github", "core-reads.ts"), "utf8");
  const fn = host.slice(host.indexOf("export function allPrsForBranch"));
  assert.match(fn.slice(0, 700), /"--state", "all"/, "closed, merged and open alike");
  assert.doesNotMatch(fn.slice(0, 700), /--search|merged:>=|"--limit", "20"/, "no date window and no 20-record cut");
  assert.match(fn.slice(0, 900), /prs\.length >= ALL_PRS_LIMIT\) throw/, "a listing that may have been cut short fails instead of passing as complete");
  const tracker = readFileSync(join(srcDir, "release-tracker.ts"), "utf8");
  const sweep = tracker.slice(tracker.indexOf("private async swept("), tracker.indexOf("  /**", tracker.indexOf("private async swept(")));
  assert.match(sweep, /allPrsForBranch\(/);
  assert.doesNotMatch(sweep, /findOpenPromotionPR\(|closedPrsForBranch\(/, "no listing that swallows its failure or cuts at 20 feeds the sweep");
});

test("a record survives a restart: nothing but the store carries it", async () => {
  await rt.releases.putRelease(repo, rel(10, "merged", { mergeSha: "m" }));
  assert.equal(await rt.streaks.record(repo, 20, "h", undefined), 1);
  rt = new ForemanRuntime();
  assert.equal((await rt.records.loadPrRecord(repo, 10)).release.mergeSha, "m");
  const { at, ...kept } = (await rt.streaks.read(repo, 20)).streak;
  assert.deepEqual(kept, { head: "h", count: 1 });
  assert.ok(Number.isFinite(Date.parse(at)), "the round's time is kept: a later ruling releases the stalemate");
  assert.deepEqual(legacyPrEntries("r").releases.size, 0, "the state file never held it");
});

// --- The audits ---------------------------------------------------------------

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const sources = () => {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } };
  walk(srcDir);
  return files;
};

test("src/state.ts is gone: no module declares a RepoState", () => {
  assert.equal(existsSync(join(srcDir, "state.ts")), false);
  for (const p of sources()) assert.doesNotMatch(readFileSync(p, "utf8"), /interface RepoState\b/, p);
});

test("only the import touches the legacy PR accessors, and no core file reads the old fields from state", () => {
  const offenders = [];
  const reads = /(?:loadRepoState\([^)]*\)|\b(?:repoState|rs|st))\??\.(?:prodReleases|noCommitStreaks|rejectedBranches|release)\b/;
  for (const p of sources()) {
    const rel = p.slice(srcDir.length + 1);
    const text = readFileSync(p, "utf8");
    if (rel !== "legacy-records.ts" && /\b(?:legacyPrEntries|dropLegacyPrEntries)\b/.test(text)) offenders.push(`${rel}: legacy accessor`);
    text.split("\n").forEach((line, i) => { if (!/^\s*(\/\/|\*)/.test(line) && reads.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(offenders, []);
});

test("no new core file holds these records", () => {
  const names = sources().map((p) => p.slice(srcDir.length + 1));
  assert.ok(!names.some((n) => /pr-records|release-records/.test(n)));
});
