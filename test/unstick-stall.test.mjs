// The unstick pass reports a handoff that gives up and a due epic nobody answers to the stall clock (dark behind FOREMAN_STALL_CLOCK).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { setStateDir } from "../dist/state-dir.js";
import { tryUnstick, resetDecomposeThrottle, heldEpics } from "../dist/phases/unstick.js";
import { dropIssueSnapshot } from "../dist/github/cache.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, seed, recordOf, repoRecordOf } from "./issue-records.mjs";

await startAgentPlugins();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";
const ghBin = mkTmp("stall-gh-");
const openFile = join(ghBin, "open.json");
writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\ncat ${JSON.stringify(openFile)}\n`);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.PATH = `${ghBin}:${process.env.PATH}`;

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPROVED = iso(Date.now() - 200 * 60_000), CLOSED = iso(Date.now() - 120 * 60_000);

function world({ flag = true, due = [] } = {}) {
  if (flag) process.env.FOREMAN_STALL_CLOCK = "1"; else delete process.env.FOREMAN_STALL_CLOCK;
  setStateDir(mkTmp("stall-state-"));
  memoryRecords();
  resetDecomposeThrottle();
  const em = mkTmp("stall-em-");
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "due.json"), JSON.stringify(due));
  writeFileSync(join(em, "bin/em.mjs"), `import fs from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "decompose-candidates") { console.log(fs.readFileSync(${JSON.stringify(join(em, "due.json"))}, "utf8")); process.exit(0); }
if (a[0] === "unstick") process.exit(1);
console.log("[]");`);
  const repo = { name: "host", githubRepo: "o/host", repoPath: em, lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" }, epicRefLabel: "epic", epicRepo: "o/epics" };
  const config = { emRepoPath: em, sessionEnv: [], repos: [repo], epicRepo: "o/epics", unstickEscalationOwner: "owner-login", backoff: { verifyRetry: { maxAttempts: 3 }, handoff: { baseMs: 1, capMs: 1, factor: 1, maxRecalls: 1 } } };
  let rt = new ForemanRuntime();
  return {
    repo, em, get rt() { return rt; },
    restart() { rt = new ForemanRuntime(); resetDecomposeThrottle(); },
    setDue(d) { writeFileSync(join(em, "due.json"), JSON.stringify(d)); },
    pass: async (i) => { dropIssueSnapshot("o/host"); await sleep(5); resetDecomposeThrottle(); return tryUnstick(rt, repo, config, logger, i, { comment: () => {} }); },
    stall: async (n, cause) => (await recordOf(rt, repo, n)).stalls?.[cause],
  };
}

test("a due epic's stall starts at afterClosedAt, else approvedAt, and a repeat keeps it", async () => {
  const w = world({ due: [{ epic: 11, approvedAt: APPROVED, after: "o/svc#3", afterClosedAt: CLOSED }, { epic: 12, approvedAt: APPROVED }, { epic: 13, approvedAt: APPROVED, after: "o/svc#4", afterClosedAt: null }] });
  await w.pass(1);
  assert.equal((await w.stall(11, "epic-unanswered")).startedAt, CLOSED);
  assert.equal((await w.stall(12, "epic-unanswered")).startedAt, APPROVED);
  assert.equal((await w.stall(13, "epic-unanswered")).startedAt, APPROVED, "a null afterClosedAt falls back to approvedAt");
  assert.deepEqual((await w.stall(11, "epic-unanswered")).affected, ["o/epics#11"]);
  await w.pass(2);
  assert.equal((await w.stall(11, "epic-unanswered")).startedAt, CLOSED);
});

test("a restart between scans never leaves a stale epic stall open", async () => {
  const w = world({ due: [{ epic: 12, approvedAt: APPROVED }] });
  await w.pass(1);
  assert.notEqual((await w.stall(12, "epic-unanswered")).state, "resolved"); // aged past the bound, the sweep may have escalated it
  assert.deepEqual((await repoRecordOf(w.rt, w.repo)).epicStalls, [12]);
  w.restart(); // the in-memory view of the prior scan is gone
  w.setDue([]);
  await w.pass(2);
  assert.equal((await w.stall(12, "epic-unanswered")).state, "resolved");
  assert.equal((await repoRecordOf(w.rt, w.repo)).epicStalls, undefined);
});

test("flag off: nothing is written", async () => {
  const w = world({ flag: false, due: [{ epic: 12, approvedAt: APPROVED }] });
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  assert.equal(await w.stall(12, "epic-unanswered"), undefined);
  assert.equal(await w.stall(7, "handoff-gave-up"), undefined);
  assert.equal((await repoRecordOf(w.rt, w.repo)).epicStalls, undefined);
});

test("a give-up opens one handoff-gave-up stall that resolves when the hold clears", async () => {
  const w = world();
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  const s = await w.stall(7, "handoff-gave-up");
  assert.equal(s.state, "open");
  assert.equal(s.resolver, "owner-login");
  await seed(w.rt, w.repo, 7, { verifyHeld: undefined });
  await w.pass(4);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
});

async function giveUp(w) {
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "open");
}

test("a give-up on an issue that then closes resolves, also after a restart", async () => {
  const w = world();
  await giveUp(w);
  assert.deepEqual((await repoRecordOf(w.rt, w.repo)).handoffStalls, [7]);
  writeFileSync(openFile, "[]");
  w.restart();
  await w.pass(4);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls, undefined);
});

test("a terminal EM answer resolves the give-up while the hold remains", async () => {
  const w = world();
  await giveUp(w);
  await w.rt.records.updateIssueRecord(w.repo, 7, (d) => { for (const e of Object.values(d.unstick ?? {})) e.status = "declined"; });
  await w.pass(4);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
});

test("a give-up with the flag off writes no index", async () => {
  const w = world({ flag: false });
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls, undefined);
});

test("heldEpics reads the index and the asked-about epics, nothing else", () => {
  assert.deepEqual(heldEpics(null), []);
  const unstick = { "0:epic-decompose:21-t": { issue: 0, kind: "epic-decompose", tag: "21-t" } };
  assert.deepEqual(heldEpics({ epicStalls: [12, 21], unstick }).sort(), [12, 21]);
});
