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
import { resetIssueRecordsForTests } from "../dist/issue-records.js";
import { createCardBlockStore } from "../dist/card-blocks.js";
import { importLegacyRecords, resetLegacyImportForTests } from "../dist/legacy-records.js";
import { setStateDir } from "../dist/state-dir.js";
import { writeLegacy, removeLegacy } from "./_legacy-state.mjs";
import { startGitHubWorkSource } from "./agent-plugins.mjs";
import { mkTmp } from "./tmp-dir.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const repoA = { name: "a", githubRepo: "example/a", repoPath: mkTmp("mirror-blocks-a-") };
const cfgs = [repoA];
const cfg = { enabled: true, url: "http://pc.test", companyId: "c", agentId: "agent", agentName: "Foreman", comments: { enabled: false } };

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
  resetIssueRecordsForTests();
  resetLegacyImportForTests();
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
  const { mirror } = mirrorWith(createCardBlockStore(() => cfgs));
  assert.equal(await mirror.ensureBlocks(), false, "the legacy block is not in any record yet: nothing is loaded, nothing is guessed");
  assert.equal(mirror.blockedReason.has("c1"), false);
  await importLegacyRecords(repoA, quiet, cfgs);
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
