// foreman#230 R2/R3: the dependency-batch-loop notice is delivered or it is retried; it is never lost, never doubled.
//
// R2: the queued notice meets three failed EM calls, then the EM recovers and the Foreman restarts. The unstick watch
// leaves a spent (failed at the cap) entry alone for good, and the ledger used to hold its own "told" flag, so the
// notice was lost silently. The unstick entry is now the one record of delivery; a spent one is asked afresh.
// R3: an accepted notice is never asked again by the held sweep, across polls and restarts.
import test from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { tryUnstick } from "../dist/phases/unstick.js";
import { UNSTICK_MAX_ATTEMPTS, SPENT_QUESTION_REARM_MS, deliverySpent } from "../dist/unstick.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, repoRecordOf } from "./issue-records.mjs";
import { ForemanRuntime } from "../dist/runtime.js";

await startAgentPlugins();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";
const ghBin = mkTmp("dbd-gh-");
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\necho '[]'\n`);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.PATH = `${ghBin}:${process.env.PATH}`;

const KEY = "627@sha627";
const HOUR = 3600_000;

function setup() {
  setStatePath(mkTmp("dbd-state-"));
  memoryRecords();
  const em = mkTmp("dbd-em-");
  mkdirSync(join(em, "bin"));
  const up = join(em, "up"), calls = join(em, "calls.log");
  // The EM consumer: exits 1 (a failed call) until `up` exists, then accepts the kind (exit 0).
  writeFileSync(join(em, "bin/em.mjs"), `import { existsSync, appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n"); process.exit(existsSync(${JSON.stringify(up)}) ? 0 : 1);`);
  const repo = { name: "dbd", githubRepo: "o/dbd", repoPath: em, lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" } };
  const handoff = { baseMs: 2 * HOUR, capMs: 24 * HOUR, factor: 2, maxRecalls: 3 };
  const config = { emRepoPath: em, sessionEnv: [], backoff: { verifyRetry: { maxAttempts: 3 }, handoff, upstream: { baseMs: 1000, capMs: 10000, factor: 2 } } };
  return {
    repo, config,
    recover: () => writeFileSync(up, ""),
    emCalls: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0),
    entry: async (rt) => Object.values((await repoRecordOf(rt, repo)).unstick ?? {}).find((e) => e.kind === "dependency-batch-loop"),
  };
}
const pass = (rt, s, n) => tryUnstick(rt, s.repo, s.config, logger, n);

test("R2: three failed EM calls, the EM recovers, the Foreman restarts: the notice is re-opened and delivered", async () => {
  const s = setup();
  let rt = new ForemanRuntime();
  const t0 = new Date();
  assert.equal(await rt.handoffs.noteDependencyBatchLoop(s.repo, KEY, 3, t0), true);
  for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) assert.equal(await pass(rt, s, i), 1);
  let e = await s.entry(rt);
  assert.deepEqual([e.status, e.attempts], ["failed", UNSTICK_MAX_ATTEMPTS], "spent: the watch alone never asks again");
  assert.equal(await pass(rt, s, 9), 0);

  s.recover();
  rt = new ForemanRuntime(); // restart: new runtime objects over the same record backend
  // An immediate sweep does not hammer a spent notice: it waits out the re-arm window.
  await rt.handoffs.noteDependencyBatchLoop(s.repo, KEY, 3, new Date(t0.getTime() + 60_000));
  assert.equal(await pass(rt, s, 10), 0);
  // After the window the held sweep re-opens it, and the next unstick pass delivers it.
  assert.equal(await rt.handoffs.noteDependencyBatchLoop(s.repo, KEY, 3, new Date(Date.now() + SPENT_QUESTION_REARM_MS + 1000)), true);
  assert.equal(await pass(rt, s, 11), 1);
  e = await s.entry(rt);
  assert.equal(e.status, "invoked", "an accepted EM answer");
  assert.equal(s.emCalls(), UNSTICK_MAX_ATTEMPTS + 1);
  assert.match(readFileSync(join(s.repo.repoPath, "calls.log"), "utf8").trim().split("\n").pop(), /--kind dependency-batch-loop/);
});

test("R3: a delivered notice is not re-asked by later held sweeps, polls or restarts", async () => {
  const s = setup();
  s.recover();
  let rt = new ForemanRuntime();
  const t0 = Date.now();
  await rt.handoffs.noteDependencyBatchLoop(s.repo, KEY, 3, new Date(t0));
  assert.equal(await pass(rt, s, 1), 1);
  const delivered = await s.entry(rt);
  assert.equal(delivered.status, "invoked");
  for (let k = 0; k < 4; k++) {
    rt = new ForemanRuntime(); // each poll after a restart
    assert.equal(await rt.handoffs.noteDependencyBatchLoop(s.repo, KEY, 3, new Date(t0 + (k + 1) * 10 * HOUR)), true);
    assert.deepEqual(await s.entry(rt), delivered, "the entry is untouched");
  }
  assert.equal(Object.keys((await repoRecordOf(rt, s.repo)).unstick).length, 1, "one question, never a second");
  assert.equal(s.emCalls(), 1, "the sweep itself made no EM call");
});

test("deliverySpent: only a failed entry at the cap past the re-arm window", () => {
  const e = (o) => ({ issue: 0, kind: "dependency-batch-loop", reason: "r", status: "failed", attempts: 3, since: "2026-11-06T00:00:00Z", lastCallAt: "2026-11-06T00:00:00Z", ...o });
  const at = (h) => Date.parse("2026-11-06T00:00:00Z") + h * HOUR;
  assert.equal(deliverySpent(e({}), at(2)), true);
  assert.equal(deliverySpent(e({}), at(0.5)), false, "inside the window");
  assert.equal(deliverySpent(e({ attempts: 2 }), at(5)), false, "calls left");
  for (const status of ["invoked", "declined", "escalated", "pending", "refused"]) assert.equal(deliverySpent(e({ status }), at(99)), false, status);
});
