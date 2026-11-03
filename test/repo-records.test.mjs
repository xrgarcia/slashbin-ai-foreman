// Repo-level records through the work-source store (EM#1244 f4): what no issue or PR owns -- the questions put
// to the EM that name no issue, the divergence rulings already carried out, the Paperclip card blocks -- lives in
// the repo's own record; the branch block is derived from git; and `.agent-state.json` is gone once everything has
// moved. These hold the repo key (a Foreman-owned anchor issue), the facade, the card-block store, and the
// one-time import to the cutover rules: idempotent, an entry leaves the file only after its save, an unreadable
// record reads as unreadable, orphan repos and empty shells go, the file is deleted when nothing is left.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeWorkSource } from "../dist/plugins/registry.js";
import { GitHubRecordStore, REPO_RECORD_TITLE, RECORD_MARKER } from "../dist/github/record-store.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { loadRepoRecord, updateRepoRecord, updateIssueRecord, loadIssueRecord, resetIssueRecordsForTests } from "../dist/issue-records.js";
import { createCardBlockStore } from "../dist/card-blocks.js";
import { standingDivergence, observeDivergence, resetDivergenceForTests } from "../dist/divergence.js";
import { importLegacyRecords, resetLegacyImportForTests } from "../dist/legacy-records.js";
import { foremanHolds } from "../dist/work-source.js";
import { setStateDir } from "../dist/state-dir.js";
import { legacyFile, readLegacy, writeLegacy, removeLegacy } from "./_legacy-state.mjs";
import { startGitHubWorkSource } from "./agent-plugins.mjs";
import { mkTmp } from "./tmp-dir.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const mk = (name) => ({ name, githubRepo: `example/${name}`, repoPath: mkTmp(`repo-records-${name}-`) });
const repoA = mk("a");
const repoB = mk("b");
const NOW = "2026-11-01T12:00:00.000Z";
const question = (kind, reason) => ({ issue: 0, kind, reason, status: "open", attempts: 1, since: NOW });
const block = (reason, at = "approved") => ({ reason, at });

let store, failSave, failLoad;

before(async () => {
  const bin = mkTmp("repo-records-gh-");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '[]'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.FOREMAN_GITHUB_TOKEN ??= "test-token-not-real";
  process.env.PATH = `${bin}:${process.env.PATH}`;
  await startGitHubWorkSource();
});

beforeEach(() => {
  setStateDir(mkTmp("repo-records-state-"));
  store = new InMemoryRecordStore();
  failSave = false;
  failLoad = false;
  const source = activeWorkSource();
  source.loadRecord = async (key, rc) => (failLoad && key.kind === "repo" ? { status: "unavailable" } : store.loadRecord(key, rc));
  source.saveRecord = async (key, record, rc) => (failSave && key.kind === "repo" ? false : store.saveRecord(key, record, rc));
  resetIssueRecordsForTests();
  resetDivergenceForTests();
  resetLegacyImportForTests();
  removeLegacy();
});

// --- the repo key: a Foreman-owned anchor issue --------------------------------------------------------

/** A fake gh over an issue board: search finds an anchor by title, POST creates, PATCH closes, comments hold the records. */
function fakeIo({ failSearch = false } = {}) {
  const calls = [];
  const issues = []; // { number, title, state }
  const comments = new Map(); // issue number -> [{ id, login, body }]
  let next = 900, nextId = 1;
  const io = {
    login: () => "foreman-bot",
    run(args) {
      calls.push(args);
      const url = args.find((a) => a.startsWith("repos/") || a.startsWith("search/")) ?? "";
      const arg = (k) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
      if (url.startsWith("search/")) {
        if (failSearch) throw new Error("search is down");
        return issues.filter((i) => i.title === REPO_RECORD_TITLE).map((i) => i.number).join("\n");
      }
      if (/^repos\/[^/]+\/[^/]+\/issues$/.test(url) && args.includes("POST")) {
        issues.push({ number: next, title: arg("title"), state: "open" });
        return String(next++);
      }
      const patch = url.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/);
      if (patch && args.includes("PATCH")) { issues.find((i) => i.number === Number(patch[1])).state = arg("state"); return ""; }
      const m = url.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/);
      if (m && args.includes("POST")) {
        const row = { id: nextId++, login: "foreman-bot", body: arg("body") };
        comments.set(m[1], [...(comments.get(m[1]) ?? []), row]);
        return String(row.id);
      }
      if (m) return (comments.get(m[1]) ?? []).filter((c) => c.body.startsWith(RECORD_MARKER)).map((c) => JSON.stringify(c)).join("\n");
      const e = url.match(/^repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/);
      if (e && args.includes("PATCH")) { for (const rows of comments.values()) for (const c of rows) if (c.id === Number(e[1])) c.body = arg("body"); return ""; }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  };
  return { io, calls, issues, comments };
}
const repoKey = { repo: "example/a", kind: "repo", number: 0 };

test("repo key: the first save creates one closed anchor issue and keeps the record on it", async () => {
  const f = fakeIo();
  const gh = new GitHubRecordStore(f.io);
  assert.deepEqual(await gh.loadRecord(repoKey, repoA), { status: "absent" });
  assert.equal(f.issues.length, 0, "reading a repo with no record creates nothing");
  assert.equal(await gh.saveRecord(repoKey, { divergenceRuled: ["c:1"] }, repoA), true);
  assert.equal(f.issues.length, 1);
  assert.equal(f.issues[0].title, REPO_RECORD_TITLE);
  assert.equal(f.issues[0].state, "closed", "closed at once: it reaches no board");
  assert.equal(f.comments.get("900").length, 1, "the record is one comment on the anchor");
  assert.equal(await gh.saveRecord(repoKey, { divergenceRuled: ["c:1", "c:2"] }, repoA), true);
  assert.equal(f.issues.length, 1, "a later save edits the comment in place");
  assert.equal(f.comments.get("900").length, 1);
});

test("repo key: a restarted store finds the anchor and its record; none is created again", async () => {
  const f = fakeIo();
  await new GitHubRecordStore(f.io).saveRecord(repoKey, { divergenceRuled: ["c:1"] }, repoA);
  const after = new GitHubRecordStore(f.io);
  assert.deepEqual(await after.loadRecord(repoKey, repoA), { status: "found", record: { divergenceRuled: ["c:1"] } });
  assert.equal(await after.saveRecord(repoKey, { divergenceRuled: ["c:1", "c:2"] }, repoA), true);
  assert.equal(f.issues.length, 1);
});

test("repo key: a search that fails is unavailable on read and a failed save on write, never an empty record", async () => {
  const gh = new GitHubRecordStore(fakeIo({ failSearch: true }).io);
  assert.equal((await gh.loadRecord(repoKey, repoA)).status, "unavailable");
  assert.equal(await gh.saveRecord(repoKey, { divergenceRuled: ["c:1"] }, repoA), false);
});

test("repo key: an issue and a PR numbered 0 never exist, so the repo key cannot collide with an item", async () => {
  const f = fakeIo();
  const gh = new GitHubRecordStore(f.io);
  await gh.saveRecord({ repo: "example/a", kind: "issue", number: 5 }, { promotionStallNoted: true }, repoA);
  await gh.saveRecord(repoKey, { divergenceRuled: ["c:1"] }, repoA);
  assert.deepEqual((await gh.loadRecord({ repo: "example/a", kind: "issue", number: 5 }, repoA)).record, { promotionStallNoted: true });
  assert.deepEqual((await gh.loadRecord(repoKey, repoA)).record, { divergenceRuled: ["c:1"] });
});

// --- the facade -----------------------------------------------------------------------------------------

test("repo record: absent reads as {}, an empty change saves nothing, concurrent changes to different fields both land", async () => {
  assert.deepEqual(await loadRepoRecord(repoA), {});
  assert.equal(await updateRepoRecord(repoA, () => {}), true);
  assert.equal(store.records.size, 0, "no record for nothing to record");
  await Promise.all([
    updateRepoRecord(repoA, (d) => { d.unstick = { "0:x": question("x", "r") }; }),
    updateRepoRecord(repoA, (d) => { d.divergenceRuled = ["c:1"]; }),
    updateRepoRecord(repoA, (d) => { d.cardBlocks = { c1: block("b") }; }),
  ]);
  const r = await loadRepoRecord(repoA);
  assert.deepEqual(Object.keys(r).sort(), ["cardBlocks", "divergenceRuled", "unstick"]);
  assert.deepEqual(await loadRepoRecord(repoB), {}, "another repo's record is its own");
});

test("repo record: an unreadable record reads as null and nothing is written over it", async () => {
  await updateRepoRecord(repoA, (d) => { d.divergenceRuled = ["c:1"]; });
  failLoad = true;
  assert.equal(await loadRepoRecord(repoA), null);
  assert.equal(await updateRepoRecord(repoA, (d) => { d.divergenceRuled = []; }), false);
  failLoad = false;
  assert.deepEqual((await loadRepoRecord(repoA)).divergenceRuled, ["c:1"]);
  failSave = true;
  assert.equal(await updateRepoRecord(repoA, (d) => { d.divergenceRuled = ["c:1", "c:2"]; }), false);
});

// --- the card-block store ---------------------------------------------------------------------------------

test("card blocks: a block is saved in its repo's record, read back merged, and moved when its card's repo is known", async () => {
  const repos = [repoA, repoB];
  const blocks = createCardBlockStore(() => repos);
  assert.deepEqual(await blocks.load(), {});
  assert.equal(await blocks.save("c1", block("one"), "example/a"), true);
  assert.equal(await blocks.save("c2", block("two"), "example/b"), true);
  assert.deepEqual(Object.keys((await loadRepoRecord(repoA)).cardBlocks), ["c1"]);
  assert.deepEqual(Object.keys((await loadRepoRecord(repoB)).cardBlocks), ["c2"]);
  assert.deepEqual(Object.keys(await createCardBlockStore(() => repos).load()).sort(), ["c1", "c2"], "a restart sees both");
  // c1's card turns out to belong to repo b: it is re-filed and leaves a's record.
  assert.equal(await blocks.save("c1", block("one"), "example/b"), true);
  assert.equal((await loadRepoRecord(repoA)).cardBlocks, undefined);
  assert.deepEqual(Object.keys((await loadRepoRecord(repoB)).cardBlocks).sort(), ["c1", "c2"]);
  assert.equal(await blocks.save("c1", null), true, "a release is forgotten from the repo that holds it");
  assert.deepEqual(Object.keys((await loadRepoRecord(repoB)).cardBlocks), ["c2"]);
});

test("card blocks: any repo's record unreadable makes the whole load null, and a failed save says so", async () => {
  const repos = [repoA, repoB];
  const blocks = createCardBlockStore(() => repos);
  await blocks.save("c1", block("one"), "example/a");
  failLoad = true;
  assert.equal(await blocks.load(), null, "never a partial answer");
  failLoad = false;
  failSave = true;
  assert.equal(await blocks.save("c2", block("two"), "example/a"), false);
  assert.equal(await blocks.save("c3", null, "nowhere/else"), true, "forgetting a block no repo holds is done");
  assert.equal(await blocks.save("c3", block("three"), "nowhere/else"), false, "keeping one with no repo to hold it is not");
});

// --- derived: the branch block --------------------------------------------------------------------------

test("branch block: derived from the last git observation, held in memory only, ends when git shows it reconciled", async () => {
  assert.equal(standingDivergence(repoA), null);
  const first = observeDivergence(repoA, { ahead: 2, behind: 1, mergeBase: "abc" });
  assert.equal(first.before, null);
  assert.equal(first.now.mergeBase, "abc");
  assert.equal(standingDivergence(repoA).mergeBase, "abc");
  assert.equal(standingDivergence(repoB), null, "per repo");
  assert.equal((await foremanHolds(repoA, [7], quiet))(7), true, "a standing divergence holds the repo's issues");
  assert.equal((await foremanHolds(repoB, [7], quiet))(7), false);
  assert.equal(observeDivergence(repoA, { ahead: 2, behind: 1, mergeBase: "abc" }).before.mergeBase, "abc", "the same episode");
  observeDivergence(repoA, null);
  assert.equal(standingDivergence(repoA), null);
  assert.equal((await foremanHolds(repoA, [7], quiet))(7), false);
  assert.deepEqual(await loadRepoRecord(repoA), {}, "the block itself was never stored");
});

test("branch block: the issues told and the rulings carried out are the only persisted parts", async () => {
  await updateIssueRecord(repoA, 7, (d) => { d.divergenceTold = "abc"; });
  await updateRepoRecord(repoA, (d) => { d.divergenceRuled = ["comment:1"]; });
  assert.equal((await loadIssueRecord(repoA, 7)).divergenceTold, "abc");
  assert.deepEqual((await loadRepoRecord(repoA)).divergenceRuled, ["comment:1"]);
});

// --- the held note: memory only --------------------------------------------------------------------------

test("promotionHeldNoted is gone from every module but the import's list of dead fields", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } };
  walk(src);
  const using = files.filter((p) => /promotionHeldNoted/.test(readFileSync(p, "utf8"))).map((p) => p.slice(src.length + 1));
  assert.deepEqual(using, ["legacy-records.ts"]);
  const promote = readFileSync(join(src, "phases", "promote.ts"), "utf8");
  assert.match(promote, /resetHeldNotesForTests/);
  assert.match(promote, /heldNoted = new Map/);
});

// --- the one-time import ----------------------------------------------------------------------------------

const cfgs = [repoA, repoB];
const runImport = async () => { for (const r of cfgs) await importLegacyRecords(r, quiet, cfgs); };
const fileState = () => (existsSync(legacyFile()) ? readLegacy() : null);

function legacy() {
  writeLegacy({
    repos: {
      a: {
        implemented: [3, 4], prodReleases: {}, rejectedBranches: {},
        repoUnstick: { "0:needs-ruling": question("needs-ruling", "repo-level"), "0:epic-ready-to-close:e1": question("epic-ready-to-close", "epic") },
        unstick: { "0:unrelated-error:t1": question("unrelated-error", "stray") },
        promotionHeldNoted: [9],
      },
      b: { implemented: [1], repoUnstick: {} },
      ws: { implemented: [1], repoUnstick: { "0:x": question("x", "orphan") } },
      jerky_live: { implemented: [] },
    },
    cardBlocks: { c1: block("blocked: x") },
  });
}

test("import: repo-level entries and card blocks move, dead fields and orphans go, the file is deleted", async () => {
  legacy();
  await runImport();
  const a = await loadRepoRecord(repoA);
  assert.deepEqual(Object.keys(a.unstick).sort(), ["0:epic-ready-to-close:e1", "0:needs-ruling", "0:unrelated-error:t1"]);
  assert.deepEqual(a.cardBlocks, { c1: block("blocked: x") }, "a legacy block names no repo: the first configured repo holds it");
  assert.deepEqual(await loadRepoRecord(repoB), {});
  assert.equal(existsSync(legacyFile()), false, "implemented, promotionHeldNoted, the empty shells and both orphans are dropped; nothing is left");
});

test("import is idempotent: a second run (and a restart with no file) writes nothing", async () => {
  legacy();
  await runImport();
  const snapshot = JSON.stringify([...store.records.entries()].sort());
  let saves = 0;
  const source = activeWorkSource();
  const save = source.saveRecord;
  source.saveRecord = (...a) => { saves++; return save(...a); };
  resetLegacyImportForTests();
  await runImport();
  assert.equal(saves, 0);
  assert.equal(JSON.stringify([...store.records.entries()].sort()), snapshot);
  assert.equal(existsSync(legacyFile()), false);
});

test("import: an entry leaves the file only after its save; a failed save keeps it, withholds the record, and the next import finishes it", async () => {
  legacy();
  failSave = true;
  await runImport();
  const kept = fileState();
  assert.ok(kept, "the file stays while anything is unmoved");
  assert.deepEqual(Object.keys(kept.repos.a.repoUnstick).sort(), ["0:epic-ready-to-close:e1", "0:needs-ruling"], "the questions are still in the file");
  assert.deepEqual(Object.keys(kept.cardBlocks), ["c1"], "and so is the card block");
  assert.equal(await loadRepoRecord(repoA), null, "until its questions are in the record the repo reads as unreadable, not as empty");
  assert.equal(await updateRepoRecord(repoA, (d) => { d.divergenceRuled = ["c:1"]; }), false, "and nothing is written over them");
  failSave = false;
  resetLegacyImportForTests();
  await runImport();
  assert.equal(Object.keys((await loadRepoRecord(repoA)).unstick).length, 3);
  assert.equal(existsSync(legacyFile()), false);
});

test("import: a record that cannot be read counts as live, so nothing in the file is dropped", async () => {
  legacy();
  failLoad = true;
  await runImport();
  assert.ok(fileState().repos.a.repoUnstick["0:needs-ruling"], "an unreadable record: the file keeps the entry");
  assert.ok(fileState().cardBlocks.c1);
  failLoad = false;
  resetLegacyImportForTests();
  await runImport();
  assert.equal(existsSync(legacyFile()), false);
});

test("import: a branch block is carried over only while git still shows its episode", async () => {
  writeLegacy({ repos: { a: { branchBlock: { reason: "diverged", mergeBase: "abc", announced: [7], ruled: ["comment:1"] } }, b: { branchBlock: { reason: "diverged", mergeBase: "old", announced: [8], ruled: ["comment:2"] } } } });
  observeDivergence(repoA, { ahead: 1, behind: 1, mergeBase: "abc" });
  observeDivergence(repoB, null);
  await runImport();
  assert.deepEqual((await loadRepoRecord(repoA)).divergenceRuled, ["comment:1"]);
  assert.equal((await loadIssueRecord(repoA, 7)).divergenceTold, "abc", "an issue already told stays told");
  assert.deepEqual(await loadRepoRecord(repoB), {}, "repo b is reconciled: its block is dropped");
  assert.equal((await loadIssueRecord(repoB, 8)) ?.divergenceTold, undefined);
  assert.equal(existsSync(legacyFile()), false);
});

test("import: a file that cannot be parsed is left alone", async () => {
  writeFileSync(legacyFile(), "{ not json");
  await runImport();
  assert.equal(readFileSync(legacyFile(), "utf8"), "{ not json");
});

test("import: a file with nothing but dead fields and orphans is deleted at once, and a missing file is a no-op", async () => {
  writeLegacy({ repos: { a: { implemented: [1], prodReleases: {}, rejectedBranches: {} }, ws: { implemented: [] } } });
  await runImport();
  assert.equal(existsSync(legacyFile()), false);
  resetLegacyImportForTests();
  await runImport();
  assert.equal(existsSync(legacyFile()), false);
});

test("src/state.ts is gone and nothing but the import reads or writes .agent-state.json", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  assert.equal(existsSync(join(src, "state.ts")), false);
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } };
  walk(src);
  const code = (p) => readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const touching = files.filter((p) => /agent-state\.json/.test(code(p))).map((p) => p.slice(src.length + 1)).sort();
  assert.deepEqual(touching.filter((n) => !["state-dir.ts"].includes(n)), []);
});

// --- review of PR 195: the cutover loses nothing, unknown is never obsolete, pending reads are unavailable -------

test("import: one repo's pass keeps every other configured repo's entries (--repo narrows the lanes, not the file)", async () => {
  legacy();
  writeLegacy({ repos: { a: { repoUnstick: { "0:x": question("x", "a's") } }, b: { repoUnstick: { "0:y": question("y", "b's") }, held: { 5: { reason: "r" } } }, ws: { implemented: [1] } }, cardBlocks: { c1: block("blocked: x") } });
  await importLegacyRecords(repoA, quiet, cfgs); // the daemon narrowed to repo a
  assert.deepEqual(Object.keys(await (async () => (await loadRepoRecord(repoA)).unstick)()), ["0:x"]);
  assert.ok(fileState().repos.b.repoUnstick["0:y"], "b's question is still in the file");
  assert.ok(fileState().repos.b.held, "and its issue hold");
  assert.equal(fileState().repos.ws, undefined, "an orphan (no configured repo of that name) is dropped");
  assert.deepEqual(await loadRepoRecord(repoB), {});
  await importLegacyRecords(repoB, quiet, cfgs); // b's own pass later
  assert.deepEqual(Object.keys((await loadRepoRecord(repoB)).unstick), ["0:y"]);
  assert.equal(existsSync(legacyFile()), false, "the file goes when every configured repo's entries have moved");
  const orch = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "orchestrator.ts"), "utf8");
  assert.match(orch, /importLegacyRecords\(repoConfig, logger, config\.allRepos \?\? config\.repos\)/);
});

// repoG: a repo with a base and a feature branch whose checkout git cannot read.
const repoG = { ...repoA, baseBranch: "main", featureBranch: "features" };
test("import: git unreadable keeps the branch block's history for the retry; unknown is never obsolete", async () => {
  writeLegacy({ repos: { a: { branchBlock: { reason: "diverged", mergeBase: "abc", announced: [7], ruled: ["comment:1"] } } } });
  await importLegacyRecords(repoG, quiet, cfgs); // repoG is no git checkout: readDivergence is undefined
  assert.ok(fileState().repos.a.branchBlock, "the episode stays in the file");
  assert.equal(await loadRepoRecord(repoA), null, "and the repo reads as unreadable until it is settled");
  resetLegacyImportForTests();
  observeDivergence(repoG, { ahead: 1, behind: 1, mergeBase: "abc" }); // git is readable now and still shows it
  await importLegacyRecords(repoG, quiet, cfgs);
  assert.deepEqual((await loadRepoRecord(repoA)).divergenceRuled, ["comment:1"]);
  assert.equal((await loadIssueRecord(repoA, 7)).divergenceTold, "abc");
  assert.equal(existsSync(legacyFile()), false);
});

test("import: a pending card block makes its repo and the block store unavailable, before the import and while a save fails", async () => {
  writeLegacy({ cardBlocks: { c1: block("blocked: x") } });
  const blocks = createCardBlockStore(() => cfgs);
  assert.equal(await blocks.load(), null, "the import has not run: the blocks read now are not the whole set");
  failSave = true;
  await importLegacyRecords(repoA, quiet, cfgs);
  assert.ok(fileState().cardBlocks.c1, "the block stays in the file");
  assert.equal(await loadRepoRecord(repoA), null, "its home repo reads unavailable, not {}");
  assert.equal(await blocks.load(), null);
  failSave = false;
  resetLegacyImportForTests();
  await importLegacyRecords(repoA, quiet, cfgs);
  assert.deepEqual(await blocks.load(), { c1: block("blocked: x") });
  assert.deepEqual(await loadRepoRecord(repoA), { cardBlocks: { c1: block("blocked: x") } });
});

test("card blocks: a cleared imported block stays cleared after a restart, whichever repo the import filed it under", async () => {
  writeLegacy({ cardBlocks: { c1: block("blocked: x") } });
  await importLegacyRecords(repoA, quiet, cfgs);
  const blocks = createCardBlockStore(() => cfgs);
  assert.deepEqual(Object.keys(await blocks.load()), ["c1"]);
  assert.equal(await blocks.save("c1", null, "example/b"), true, "the card belongs to repo b");
  assert.equal((await loadRepoRecord(repoA)).cardBlocks, undefined, "and the first repo's copy is gone");
  assert.deepEqual(await createCardBlockStore(() => cfgs).load(), {});
});

test("issue-records: issue, PR and repo records go through one mutation pipeline", () => {
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "issue-records.ts"), "utf8");
  assert.equal((text.match(/source\.saveRecord\(/g) ?? []).length, 1);
  assert.equal((text.match(/mutateRecord</g) ?? []).length, 4, "the definition and the three kinds");
});
