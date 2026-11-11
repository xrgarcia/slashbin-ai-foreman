// The Paperclip mirror and the card-block store (EM#1244 f4, review of PR 195): the mirror may start before the
// legacy import, so blocks it reads are only ever read from a load taken after the import has moved them, and an
// unreadable block set moves no card.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PaperclipClient } from "../dist/paperclip/client.js";
import { PaperclipMirror } from "../dist/paperclip/mirror.js";
import { activeWorkSource } from "../dist/plugins/registry.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { createCardBlockStore } from "../dist/card-blocks.js";
import { setStateDir } from "../dist/state-dir.js";
import { writeLegacy, removeLegacy } from "./_legacy-state.mjs";
import { startGitHubWorkSource } from "./agent-plugins.mjs";
import { mkTmp } from "./tmp-dir.mjs";
import { ForemanRuntime } from "../dist/runtime.js";
let rt = new ForemanRuntime();

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const repoA = { name: "a", githubRepo: "example/a", repoPath: mkTmp("mirror-blocks-a-") };
const cfgs = [repoA];
const cfg = { identityKeyFormat: "{repo}#{N}", enabled: true, url: "http://pc.test", companyId: "c", agentId: "agent", agentName: "Foreman", comments: { enabled: false } };

before(async () => {
  const bin = mkTmp("mirror-blocks-gh-");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '[]'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.FOREMAN_GITHUB_TOKEN ??= "test-token-not-real";
  process.env.PATH = `${bin}:${process.env.PATH}`;
  await startGitHubWorkSource();
});

beforeEach(() => {
  setStateDir(mkTmp("mirror-blocks-state-"));
  const store = new InMemoryRecordStore();
  const source = activeWorkSource();
  source.loadRecord = (k, rc) => store.loadRecord(k, rc);
  source.saveRecord = (k, r, rc) => store.saveRecord(k, r, rc);
  rt = new ForemanRuntime();
  removeLegacy();
});

function mirrorWith(blockStore) {
  const calls = [];
  const fetch = async (url, init = {}) => { calls.push({ method: init.method ?? "GET", path: new URL(url).pathname }); return new Response("{}", { status: 200 }); };
  const client = new PaperclipClient({ url: cfg.url, companyId: "c", fetch });
  return { mirror: new PaperclipMirror(client, cfg, [], quiet, {}, blockStore), calls };
}

test("mirror: started before the import, it holds no blocks until a load taken after the import, then restores them", async () => {
  writeLegacy({ cardBlocks: { c1: { reason: "blocked: x", owner: "sre", at: "merged" } } });
  const { mirror } = mirrorWith(createCardBlockStore(() => cfgs, rt.records, rt.legacy));
  assert.equal(await mirror.ensureBlocks(), false, "the legacy block is not in any record yet: nothing is loaded, nothing is guessed");
  assert.equal(mirror.blockedReason.has("c1"), false);
  await rt.legacy.importLegacyRecords(repoA, quiet, cfgs);
  assert.equal(await mirror.ensureBlocks(), true, "the next load is taken after the import");
  assert.equal(mirror.blockedReason.get("c1"), "blocked: x");
  assert.equal(mirror.blockedOwner.get("c1"), "sre");
  assert.equal(mirror.blockedAt.get("c1"), "merged");
});

test("mirror: with the blocks unreadable no card is moved, and a later readable load restores the hold first", async () => {
  let readable = false;
  const real = { c1: { reason: "needs a ruling", owner: "em", at: "changesRequested", ruling: true } };
  const { mirror, calls } = mirrorWith({ load: async () => (readable ? real : null), save: async () => true });
  assert.equal(await mirror.move("c1", "approved"), false, "a transition on a card whose hold is unknown moves nothing");
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
  readable = true;
  assert.equal(await mirror.ensureBlocks(), true);
  assert.equal(mirror.rulingHeld.has("c1"), true);
  assert.equal(mirror.blockedOwner.get("c1"), "em");
});

// Review round 2 (PR 195): block readiness is one gate ahead of every hold decision, so holdOutranks only ever sees
// restored blocks. The probes drive the real importer, card-block store and mirror; only the board boundary is stubbed.
function stubbed(mirror) {
  const moves = [];
  mirror.resolve = async () => "c1";
  mirror.refreshRow = async () => {};
  mirror.note = async () => {};
  mirror.move = async (id, to) => { moves.push(to); return true; };
  return moves;
}
const item = { repo: "example/a", issueNumber: 1, number: 1 };

test("mirror R8/R6: plugin-before-import, an approved-stage EM ruling hold survives the first same-stage queued event", async () => {
  const hold = { reason: "needs a ruling", owner: "em", at: "approved", ruling: true };
  writeLegacy({ cardBlocks: { c1: hold } });
  const store = createCardBlockStore(() => cfgs, rt.records, rt.legacy);
  const { mirror } = mirrorWith(store);
  const moves = stubbed(mirror);
  mirror.ghStage.set("c1", "approved");
  await mirror.onState(item, "x", "queued"); // before the import: the hold is unknown, so nothing moves
  assert.deepEqual(moves, []);
  await rt.legacy.importLegacyRecords(repoA, quiet, cfgs);
  await mirror.onState(item, "x", "queued");
  assert.deepEqual(moves, [], "the restored ruling outranks the same-stage update: the card is not moved");
  assert.equal(mirror.rulingHeld.has("c1"), true);
  assert.deepEqual((await store.load()).c1, hold, "reason, owner, anchor and ruling flag are all still durable");
});

test("mirror R5/R3: unreadable blocks defer the event; the first readable event honours the restored ruling", async () => {
  let readable = false;
  const real = { c1: { reason: "needs a ruling", owner: "em", at: "changesRequested", ruling: true } };
  const { mirror } = mirrorWith({ load: async () => (readable ? real : null), save: async () => true });
  const moves = stubbed(mirror);
  mirror.ghStage.set("c1", "changesRequested");
  await mirror.onState(item, "x", "changesRequested");
  assert.deepEqual(moves, [], "unreadable records release no card");
  readable = true;
  await mirror.onState(item, "x", "changesRequested"); // the first readable load happens at this very event
  assert.deepEqual(moves, [], "the ruling is restored before holdOutranks decides");
  await mirror.onState(item, "x", "queued"); // genuine advancement (a different stage) still releases
  assert.deepEqual(moves, ["approved"]);
});

test("mirror R4: an SRE hold anchored at merged is restored before the first event after a failed-save retry", async () => {
  writeLegacy({ cardBlocks: { c1: { reason: "deploy failed", owner: "sre", at: "merged" } } });
  const store = createCardBlockStore(() => cfgs, rt.records, rt.legacy);
  const { mirror } = mirrorWith(store);
  assert.equal(await mirror.ensureBlocks(), false);
  await rt.legacy.importLegacyRecords(repoA, quiet, cfgs);
  const moves = stubbed(mirror);
  await mirror.onUnblocked(item, "why"); // restores first, so a clear can never be undone by a later load
  assert.equal(mirror.blockedOwner.get("c1"), "sre");
  assert.equal(mirror.blockedAt.get("c1"), "merged");
  void moves;
});

test("card blocks: a clear that succeeded stays cleared whichever repo the import filed it under", async () => {
  const repoB = { name: "b", githubRepo: "example/b", repoPath: mkTmp("mirror-blocks-b-") };
  const both = [repoA, repoB];
  writeLegacy({ cardBlocks: { c1: { reason: "x", at: "approved", repo: "example/b" } } });
  await rt.legacy.importLegacyRecords(repoA, quiet, both);
  await rt.legacy.importLegacyRecords(repoB, quiet, both);
  const store = createCardBlockStore(() => both, rt.records, rt.legacy);
  assert.ok((await store.load()).c1);
  assert.equal(await store.save("c1", null, "example/b"), true);
  assert.equal((await createCardBlockStore(() => both, rt.records, rt.legacy).load()).c1, undefined, "a fresh store sees it cleared");
});
