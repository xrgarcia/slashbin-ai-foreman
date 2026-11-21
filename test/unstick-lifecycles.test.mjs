// EM#2501: each unstick kind declares how its question ends. A notice is delivered once: the EM's answer leaves a
// receipt on the repo record, the entry is deleted, and nothing raises it again.
import test from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { tryUnstick } from "../dist/phases/unstick.js";
import { UNSTICK_KINDS, UNSTICK_LIFECYCLES, lifecycleOf, EmHandoffs, unstickKey } from "../dist/unstick.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, repoRecordOf } from "./issue-records.mjs";
import { ForemanRuntime } from "../dist/runtime.js";

await startAgentPlugins();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";
const ghBin = mkTmp("lc-gh-");
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\necho '[]'\n`);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.PATH = `${ghBin}:${process.env.PATH}`;

function setup(exitCode = 0) {
  setStatePath(mkTmp("lc-state-"));
  const rt = new ForemanRuntime();
  memoryRecords();
  const em = mkTmp("lc-em-");
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "bin/em.mjs"), `process.exit(${exitCode});`);
  const repo = { name: "lc", githubRepo: "o/lc", repoPath: em, lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" } };
  const config = { emRepoPath: em, sessionEnv: [], backoff: { verifyRetry: { maxAttempts: 3 } }, unstickEscalationOwner: "owner-login" };
  return { rt, repo, config };
}
const entry = (issue, kind, status, extra = {}) => ({ issue, kind, reason: `r-${kind}`, status, attempts: 1, since: "2026-11-01T00:00:00.000Z", lastCallAt: "2026-11-02T00:00:00.000Z", ...extra });
const noticeAlert = { kind: "unrelated-error", subject: 0, dedupeKey: "o/lc#5:sig", reason: "an unrelated failure" };

test("every kind declares exactly one lifecycle, and the table names no other kind", () => {
  for (const k of UNSTICK_KINDS) assert.ok(["notice", "handoff", "blocker"].includes(lifecycleOf(k)), k);
  assert.deepEqual(Object.keys(UNSTICK_LIFECYCLES).sort(), [...UNSTICK_KINDS].sort());
  assert.deepEqual(UNSTICK_KINDS.filter((k) => lifecycleOf(k) === "notice").sort(), ["epic-ready-to-close", "unrelated-error"]);
  assert.deepEqual(UNSTICK_KINDS.filter((k) => lifecycleOf(k) === "handoff"), ["release-gate"]);
});

for (const [exit, what] of [[0, "invoked"], [3, "declined"], [2, "escalated"]]) {
  test(`a notice the EM ${what} leaves a receipt and no entry, and is never raised again`, async () => {
    const { rt, repo, config } = setup(exit);
    const handoffs = new EmHandoffs(rt.records);
    assert.equal(await handoffs.raise(repo, noticeAlert), true);
    const key = unstickKey(0, "unrelated-error", noticeAlert.dedupeKey);
    assert.equal((await repoRecordOf(rt, repo)).unstick[key].status, "pending");
    assert.equal(await tryUnstick(rt, repo, config, logger, 1, {}), 1);
    const rec = await repoRecordOf(rt, repo);
    assert.equal(rec.unstick?.[key], undefined, "entry deleted");
    assert.ok(Number.isFinite(Date.parse(rec.receipts[key])), "receipt carries a time");
    // The sender raising on every poll costs nothing and brings nothing back.
    assert.equal(await handoffs.raise(repo, noticeAlert), false);
    assert.equal((await repoRecordOf(rt, repo)).unstick?.[key], undefined);
    assert.equal(await tryUnstick(rt, repo, config, logger, 2, {}), 0, "no second call");
  });
}

test("a notice not yet delivered stays standing and is not receipted", async () => {
  const { rt, repo } = setup();
  await new EmHandoffs(rt.records).raise(repo, noticeAlert);
  const rec = await repoRecordOf(rt, repo);
  assert.equal(Object.keys(rec.unstick).length, 1);
  assert.equal(rec.receipts, undefined);
});

test("handled notices stored before receipts existed become receipts in one pass; others are untouched", async () => {
  const { rt, repo, config } = setup(1); // a failing EM: nothing new is delivered this pass
  const inv = unstickKey(0, "unrelated-error", "a");
  const dec = unstickKey(0, "epic-ready-to-close", "b");
  const pend = unstickKey(0, "unrelated-error", "c");
  const blocker = unstickKey(0, "epic-decompose", "d");
  const loop = unstickKey(0, "dependency-batch-loop", "e");
  const escU = unstickKey(0, "unrelated-error", "f");
  const escE = unstickKey(0, "epic-ready-to-close", "g");
  const failed = unstickKey(0, "unrelated-error", "h");
  const refused = unstickKey(0, "epic-ready-to-close", "i");
  await rt.records.updateRepoRecord(repo, (d) => {
    d.unstick = {
      [inv]: entry(0, "unrelated-error", "invoked", { tag: "a", recalls: 0 }),
      [dec]: entry(0, "epic-ready-to-close", "declined", { tag: "b" }),
      [pend]: entry(0, "unrelated-error", "pending", { tag: "c", attempts: 0, lastCallAt: undefined }),
      [blocker]: entry(0, "epic-decompose", "invoked", { tag: "d", recalls: 0 }),
      [loop]: entry(0, "dependency-batch-loop", "declined", { tag: "e" }),
      [escU]: entry(0, "unrelated-error", "escalated", { tag: "f", reason: "why f", detail: "diag f" }),
      [escE]: entry(0, "epic-ready-to-close", "escalated", { tag: "g", reason: "why g", detail: "diag g" }),
      [failed]: entry(0, "unrelated-error", "failed", { tag: "h" }),
      [refused]: entry(0, "epic-ready-to-close", "refused", { tag: "i" }),
    };
  });
  await tryUnstick(rt, repo, config, logger, 1, {});
  const rec = await repoRecordOf(rt, repo);
  assert.deepEqual(Object.keys(rec.receipts).sort(), [dec, inv].sort());
  assert.equal(rec.receipts[inv], "2026-11-02T00:00:00.000Z");
  assert.equal(rec.unstick[inv], undefined);
  assert.equal(rec.unstick[dec], undefined);
  assert.ok(rec.unstick[pend], "undelivered notice kept");
  assert.equal(rec.unstick[blocker].status, "invoked", "blocker kind keeps its entry");
  assert.ok(rec.unstick[loop], "blocker kind keeps its entry");
  // A stored escalation is a control for the escalation chain: it keeps its payload and is never receipted by the move (#384).
  for (const [k, t] of [[escU, "f"], [escE, "g"]]) {
    assert.equal(rec.unstick[k]?.status, "escalated", `stored escalation ${t} kept`);
    assert.equal(rec.unstick[k].reason, `why ${t}`);
    assert.equal(rec.unstick[k].detail, `diag ${t}`);
  }
  assert.ok(rec.unstick[failed], "failed notice kept");
  assert.ok(rec.unstick[refused], "refused notice kept");
  for (const k of [escU, escE, failed, refused]) assert.equal(rec.receipts[k], undefined, `${k} not receipted`);
  // The move is once: a second pass changes nothing.
  const before = JSON.stringify(rec.receipts);
  await tryUnstick(rt, repo, config, logger, 2, {});
  assert.equal(JSON.stringify((await repoRecordOf(rt, repo)).receipts), before);
});

test("a receipt stops raiseAll for its key only", async () => {
  const { rt, repo } = setup();
  const done = unstickKey(0, "unrelated-error", "o/lc#5:sig");
  await rt.records.updateRepoRecord(repo, (d) => { d.receipts = { [done]: "2026-11-02T00:00:00.000Z" }; });
  const other = { ...noticeAlert, dedupeKey: "o/lc#6:other" };
  assert.equal(await new EmHandoffs(rt.records).raiseAll(repo, [noticeAlert, other]), 1);
  const rec = await repoRecordOf(rt, repo);
  assert.deepEqual(Object.keys(rec.unstick), [unstickKey(0, "unrelated-error", other.dedupeKey)]);
});
