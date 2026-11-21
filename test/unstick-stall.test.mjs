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
import { releaseGateReason } from "../dist/unstick.js";
import { report as reportStall } from "../dist/stall-clock.js";
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
    epicStall: async (n) => (await recordOf(rt, { ...repo, githubRepo: "o/epics" }, n)).stalls?.["epic-unanswered"],
    stall: async (n, cause) => (await recordOf(rt, repo, n)).stalls?.[cause],
  };
}

test("a due epic's stall starts at afterClosedAt, else approvedAt, and a repeat keeps it", async () => {
  const w = world({ due: [{ epic: 11, approvedAt: APPROVED, after: "o/svc#3", afterClosedAt: CLOSED }, { epic: 12, approvedAt: APPROVED }, { epic: 13, approvedAt: APPROVED, after: "o/svc#4", afterClosedAt: null }] });
  await w.pass(1);
  assert.equal((await w.epicStall(11)).startedAt, CLOSED);
  assert.equal((await w.epicStall(12)).startedAt, APPROVED);
  assert.equal((await w.epicStall(13)).startedAt, APPROVED, "a null afterClosedAt falls back to approvedAt");
  assert.deepEqual((await w.epicStall(11)).affected, ["o/epics#11"]);
  await w.pass(2);
  assert.equal((await w.epicStall(11)).startedAt, CLOSED);
});

test("a restart between scans never leaves a stale epic stall open", async () => {
  const w = world({ due: [{ epic: 12, approvedAt: APPROVED }] });
  await w.pass(1);
  assert.notEqual((await w.epicStall(12)).state, "resolved"); // aged past the bound, the sweep may have escalated it
  assert.deepEqual((await repoRecordOf(w.rt, w.repo)).epicStalls, [12]);
  w.restart(); // the in-memory view of the prior scan is gone
  w.setDue([]);
  await w.pass(2);
  assert.equal((await w.epicStall(12)).state, "resolved");
  assert.equal((await repoRecordOf(w.rt, w.repo)).epicStalls, undefined);
});

test("flag off: nothing is written", async () => {
  const w = world({ flag: false, due: [{ epic: 12, approvedAt: APPROVED }] });
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  assert.equal(await w.epicStall(12), undefined);
  assert.equal(await w.stall(7, "handoff-gave-up"), undefined);
  assert.equal((await repoRecordOf(w.rt, w.repo)).epicStalls, undefined);
});

test("an epic's stall lives under the epic's repo and number, survives a restart and escalates there", async () => {
  const w = world({ due: [{ epic: 900, approvedAt: APPROVED }] });
  await w.pass(1);
  assert.equal((await recordOf(w.rt, w.repo, 900)).stalls, undefined, "nothing is written under the host's number 900");
  assert.equal(w.epicStall ? (await w.epicStall(900)).id : "", "o/epics#900:epic-unanswered");
  w.restart();
  await w.pass(2);
  const s = await w.epicStall(900);
  assert.equal(s.startedAt, APPROVED);
  assert.equal(s.state, "escalated", "aged past the bound, the sweep raised it from the durable index");
  const q = Object.values((await recordOf(w.rt, { ...w.repo, githubRepo: "o/epics" }, 900)).unstick ?? {});
  assert.deepEqual(q.map((e) => e.kind), ["stalled"]);
  assert.equal((await recordOf(w.rt, w.repo, 900)).unstick, undefined);
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
  await w.rt.records.updateIssueRecord(w.repo, 7, (d) => { for (const e of Object.values(d.unstick ?? {})) { e.status = "declined"; e.lastCallAt = iso(Date.now() + 60_000); } });
  await w.pass(4);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
});

test("a give-up with the flag off writes no index", async () => {
  const w = world({ flag: false });
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls, undefined);
});

test("flag off: a closed issue's open stall and its index are left alone, and resolve once tracking is back", async () => {
  const w = world();
  await giveUp(w);
  writeFileSync(openFile, "[]");
  delete process.env.FOREMAN_STALL_CLOCK;
  w.restart();
  await w.pass(4);
  assert.deepEqual((await repoRecordOf(w.rt, w.repo)).handoffStalls, [7]);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "open");
  process.env.FOREMAN_STALL_CLOCK = "1";
  w.restart();
  await w.pass(5);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
});

test("an escalation after the Foreman's own give-up notice is the EM's answer; the notice itself is not", async () => {
  const w = world();
  await giveUp(w);
  const entry = async () => Object.values((await recordOf(w.rt, w.repo, 7)).unstick ?? {}).find((e) => e.status === "escalated");
  const local = await entry();
  assert.equal(local.status, "escalated");
  assert.ok(local.gaveUpAt, "the local notice stamps gaveUpAt");
  await w.pass(4);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "open", "the local notice alone resolves nothing");
  await w.rt.records.updateIssueRecord(w.repo, 7, (d) => { for (const e of Object.values(d.unstick ?? {})) e.lastCallAt = iso(Date.now() + 60_000); });
  await w.pass(5);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
});

test("a batch of give-ups widens the index in one write, not one per issue", async () => {
  const w = world();
  const issues = Array.from({ length: 40 }, (_, i) => i + 100);
  writeFileSync(openFile, JSON.stringify(issues.map((number) => ({ number, title: "t", labels: [] }))));
  for (const n of issues) await seed(w.rt, w.repo, n, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  await w.pass(1);
  await w.pass(2);
  let saves = 0;
  const real = w.rt.records.updateRepoRecord.bind(w.rt.records);
  w.rt.records.updateRepoRecord = (...args) => { saves++; return real(...args); };
  await w.pass(3);
  assert.ok(saves < 10, `repo-record writes in the giving-up pass (40 issues): ${saves}`);
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls.length, 40);
  for (const n of issues) assert.equal((await w.stall(n, "handoff-gave-up")).state, "open");
});

test("failed recalls of handed-off questions are indexed in one write too", async () => {
  const w = world();
  const issues = Array.from({ length: 40 }, (_, i) => i + 100);
  writeFileSync(openFile, JSON.stringify(issues.map((number) => ({ number, title: "t", labels: [] }))));
  for (const n of issues) await seed(w.rt, w.repo, n, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  await w.pass(1);
  for (const n of issues) await w.rt.records.updateIssueRecord(w.repo, n, (d) => { for (const e of Object.values(d.unstick ?? {})) { e.status = "invoked"; e.attempts = 2; e.recalls = 0; e.lastCallAt = iso(Date.now() - 3_600_000); } });
  let saves = 0;
  const real = w.rt.records.updateRepoRecord.bind(w.rt.records);
  w.rt.records.updateRepoRecord = (...args) => { saves++; return real(...args); };
  await w.pass(2);
  assert.ok(saves < 10, `repo-record writes (40 failed recalls): ${saves}`);
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls?.length, 40);
});

test("heldEpics reads the index and the asked-about epics, nothing else", () => {
  assert.deepEqual(heldEpics(null), []);
  const unstick = { "0:epic-decompose:21-t": { issue: 0, kind: "epic-decompose", tag: "21-t" } };
  assert.deepEqual(heldEpics({ epicStalls: [12, 21], unstick }).sort(), [12, 21]);
});

// #385: a release-gate the EM took is delivered, not a stall. The give-up stalls the old watch opened are closed on deploy.
test("a release gate taken by the EM is never given up on, and a handoff-gave-up stall open at deploy resolves", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[{"name":"pr approved"}]}]');
  const reason = releaseGateReason(["pr approved"], "[]");
  const old = iso(Date.now() - 48 * 3_600_000);
  // What the old build left: the gate taken, recalled to its cap, given up on, one open stall.
  await seed(w.rt, w.repo, 7, { unstick: { "7:release-gate": { issue: 7, kind: "release-gate", reason, status: "invoked", attempts: 4, recalls: 3, since: old, lastCallAt: old, gaveUpAt: old } } });
  await reportStall(w.rt, w.repo, { issue: 7, cause: "handoff-gave-up", eventAt: old, affected: ["o/host#7"], resolver: "owner-login", nextAction: "take release-gate: the EM handoff gave up", resumptionCondition: "x", evidence: "e" });
  await w.rt.records.updateRepoRecord(w.repo, (d) => { d.handoffStalls = [7]; });
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "open");
  assert.equal(await w.pass(1), 0, "no EM call on the unchanged reason");
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved", "the delivered handoff is not a stall");
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls, undefined);
  const e = (await recordOf(w.rt, w.repo, 7)).unstick["7:release-gate"];
  assert.equal(e.status, "invoked", "the entry stands, so the card keeps its wait reason");
  for (let i = 2; i <= 5; i++) assert.equal(await w.pass(i), 0);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved", "and no new stall opens");
});

test("a legacy escalated release gate (recalled, then given up on) resolves its stall on deploy; a never-delivered one keeps it", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[{"name":"pr approved"}]}]');
  const reason = releaseGateReason(["pr approved"], "[]");
  const old = iso(Date.now() - 48 * 3_600_000);
  const gaveUp = iso(Date.now() - 24 * 3_600_000);
  await seed(w.rt, w.repo, 7, { unstick: { "7:release-gate": { issue: 7, kind: "release-gate", reason, status: "escalated", attempts: 4, recalls: 3, since: old, lastCallAt: old, gaveUpAt: gaveUp } } });
  await reportStall(w.rt, w.repo, { issue: 7, cause: "handoff-gave-up", eventAt: gaveUp, affected: ["o/host#7"], resolver: "owner-login", nextAction: "take release-gate", resumptionCondition: "x", evidence: "e" });
  await w.rt.records.updateRepoRecord(w.repo, (d) => { d.handoffStalls = [7]; });
  assert.equal(await w.pass(1), 0, "no EM call on the unchanged reason");
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls, undefined, "the index clears");
});
