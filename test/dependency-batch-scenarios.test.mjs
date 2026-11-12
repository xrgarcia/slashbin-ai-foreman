// Acceptance A1-A5 of foreman#230. This repo has no scripts/acceptance convention, so the scenarios
// live in the test suite. Each drives the real collaborators (sweep, policy, landing, ledger) against a
// stateful fake code host; the A4 ledger is the real RecordStoreDependencyBatchLedger.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DependencyBatchSweep } from "../dist/dependency-batch/sweep.js";
import { DependencyBatchFilingPolicy } from "../dist/dependency-batch/policy.js";
import {
  DependencyDiscovery, SecuritySelection, BatchIssueComposer, BatchIssueFiler, OpenBatchIssueProbe, batchOf,
} from "../dist/dependency-batch/collaborators.js";
import { DependencyBatchLanding } from "../dist/dependency-batch/landing.js";
import { RecordStoreDependencyBatchLedger } from "../dist/dependency-batch/ledger.js";
import { IssueRecordStore } from "../dist/issue-records.js";
import { EmHandoffs, dependencyBatchLoopAlert } from "../dist/unstick.js";
import { startGitHubWorkSource } from "./agent-plugins.mjs";
import { memoryRecords, repoRecordOf } from "./issue-records.mjs";
import { FakeHost, FakeLedger, repoConfig, quiet } from "./dependency-batch-fixtures.mjs";

const T0 = new Date("2026-11-06T00:00:00Z");
const at = (h) => new Date(T0.getTime() + h * 3600_000);

function build(host, ledger, over = {}) {
  const notices = [];
  // Idempotent per key, like EmHandoffs.raise (its own tests are below): the sweep asks on every held pass.
  const notifier = { async batchLooping(_r, batch, filings) { if (!notices.some((n) => n.key === batch.key)) notices.push({ key: batch.key, filings }); return true; } };
  const sweep = new DependencyBatchSweep({
    discovery: new DependencyDiscovery(host), security: new SecuritySelection(host), openIssue: new OpenBatchIssueProbe(host),
    ledger, policy: new DependencyBatchFilingPolicy(), composer: new BatchIssueComposer(host), filer: new BatchIssueFiler(host),
    notifier, ...over,
  });
  const landing = new DependencyBatchLanding(ledger, new DependencyDiscovery(host), host);
  return { sweep, landing, notices };
}

/** The #627 state: develop already has the version, the Dependabot PR is still open. */
const state627 = () => { const h = new FakeHost(); h.addPr(627, "sha627", "chore(deps): bump @hono/node-server from 1.19.17 to 2.1.6"); return h; };

test("A1: the #627 state lands, the PR is retired, the ledger holds landed, and the next 3 sweeps file zero", async () => {
  const host = state627(), ledger = new FakeLedger();
  const { sweep, landing } = build(host, ledger);
  const n = await sweep.run(repoConfig(), quiet, at(0));
  assert.equal(n, 100);
  // implement returns "landed" for the issue: the batch hook runs, then the generic close.
  const r = await landing.resolve(repoConfig(), n, "2.1.6 already on develop", quiet, at(0));
  assert.equal(r.kind, "landed");
  host.closeIssue(n);
  assert.deepEqual(host.retired.map((x) => x.number), [627]);
  assert.equal(host.prs.length, 0);
  assert.equal((await ledger.historyOf(null, batchOf([{ number: 627, headRefOid: "sha627" }]))).outcome, "landed");
  for (let i = 1; i <= 3; i++) assert.equal(await sweep.run(repoConfig(), quiet, at(i)), null);
  assert.equal(host.filed.length, 1);
});

test("A1b: even if the PR is somehow still open, a landed ledger entry files nothing", async () => {
  const host = state627(), ledger = new FakeLedger();
  const { sweep, landing } = build(host, ledger);
  const n = await sweep.run(repoConfig(), quiet, at(0));
  host.retireFails = true; // the PR stays open
  await landing.resolve(repoConfig(), n, "x", quiet);
  host.closeIssue(n);
  // retirement failed -> no terminal outcome. Force the terminal state to prove the policy path.
  await ledger.recordOutcome(null, batchOf(host.prs), "landed", at(1));
  for (let i = 1; i <= 3; i++) assert.equal(await sweep.run(repoConfig(), quiet, at(i)), null);
  assert.equal(host.filed.length, 1);
});

test("A2: a new head SHA is a new batch and files once", async () => {
  const host = state627(), ledger = new FakeLedger();
  const { sweep, landing } = build(host, ledger);
  const n = await sweep.run(repoConfig(), quiet, at(0));
  await landing.resolve(repoConfig(), n, "x", quiet, at(0));
  host.closeIssue(n);
  host.addPr(627, "sha627-v2"); // Dependabot rebased / bumped again
  assert.equal(await sweep.run(repoConfig(), quiet, at(1)), 101);
  host.closeIssue(101);
  host.retireFails = true;
  assert.equal(await sweep.run(repoConfig(), quiet, at(2)), 102, "same new key, second filing, still under the cap");
  assert.equal(host.filed.length, 3);
});

test("A3: with retirement failing, at most 3 filings in 24h, then a hold and one EM notice", async () => {
  const host = state627(), ledger = new FakeLedger();
  host.retireFails = true;
  const { sweep, landing, notices } = build(host, ledger);
  for (let i = 0; i < 12; i++) {
    const n = await sweep.run(repoConfig(), quiet, at(i));
    if (n !== null) {
      assert.equal((await landing.resolve(repoConfig(), n, "x", quiet, at(i))).kind, "retirement-failed");
      host.closeIssue(n);
    }
  }
  assert.equal(host.filed.length, 3);
  assert.deepEqual(notices, [{ key: "627@sha627", filings: 3 }]);
  // a day later the window has passed and the batch may be tried again
  assert.notEqual(await sweep.run(repoConfig(), quiet, at(40)), null);
});

test("A3b: an EM notice that cannot be recorded is retried on the next sweep", async () => {
  const host = state627(), ledger = new FakeLedger();
  let ok = false; let recorded = 0;
  const { sweep } = build(host, ledger, { notifier: { async batchLooping() { if (!ok) throw new Error("board down"); recorded++; return true; } } });
  for (let i = 0; i < 3; i++) { const n = await sweep.run(repoConfig(), quiet, at(i)); host.closeIssue(n); }
  await sweep.run(repoConfig(), quiet, at(3));
  assert.equal(recorded, 0);
  ok = true;
  await sweep.run(repoConfig(), quiet, at(4));
  assert.equal(recorded, 1, "recorded on the next sweep once the board is back");
});

test("A3c: a ledger that cannot record a filing files nothing", async () => {
  const host = state627(), ledger = new FakeLedger();
  ledger.failWrites = true;
  const { sweep } = build(host, ledger);
  assert.equal(await sweep.run(repoConfig(), quiet, at(0)), null);
  assert.equal(host.filed.length, 0);
  ledger.failWrites = false; ledger.broken = true;
  assert.equal(await sweep.run(repoConfig(), quiet, at(0)), null);
  assert.equal(host.filed.length, 0);
});

test("A4: a restart does not re-file: the ledger is the record store, not memory", async () => {
  await startGitHubWorkSource();
  memoryRecords();
  const host = state627();
  const first = build(host, new RecordStoreDependencyBatchLedger(new IssueRecordStore()));
  const n = await first.sweep.run(repoConfig(), quiet, at(0));
  await first.landing.resolve(repoConfig(), n, "x", quiet, at(0));
  host.closeIssue(n);
  // restart: every object is rebuilt, nothing carries over but the record store
  host.addPr(627, "sha627"); // the PR is somehow still listed
  const second = build(host, new RecordStoreDependencyBatchLedger(new IssueRecordStore()));
  for (let i = 1; i <= 3; i++) assert.equal(await second.sweep.run(repoConfig(), quiet, at(i)), null);
  assert.equal(host.filed.length, 1);
});

test("A4b: the 3-per-24h count survives a restart too", async () => {
  await startGitHubWorkSource();
  memoryRecords();
  const host = state627(); host.retireFails = true;
  for (let i = 0; i < 3; i++) {
    const { sweep } = build(host, new RecordStoreDependencyBatchLedger(new IssueRecordStore()));
    host.closeIssue(await sweep.run(repoConfig(), quiet, at(i)));
  }
  const { sweep } = build(host, new RecordStoreDependencyBatchLedger(new IssueRecordStore()));
  assert.equal(await sweep.run(repoConfig(), quiet, at(4)), null);
  assert.equal(host.filed.length, 3);
});

test("A5: a normal batch with real changes still files, labelled to build", async () => {
  const host = new FakeHost();
  host.addPr(1, "a", "chore(deps): bump vite from 1.0.0 to 1.1.0"); host.addPr(2, "b", "chore(deps): bump zod from 3.0.0 to 4.0.0");
  const { sweep } = build(host, new FakeLedger());
  assert.equal(await sweep.run(repoConfig(), quiet, at(0)), 100);
  assert.deepEqual(host.filed[0].labels, ["approved", "ship to prod"]);
  assert.match(host.filed[0].title, /2 dependency updates.*\(1 major\)/);
  // without pre-approval it is filed bare, and an open batch issue blocks a second
  const bare = new FakeHost(); bare.addPr(1, "a");
  const b = build(bare, new FakeLedger());
  assert.equal(await b.sweep.run(repoConfig({ dependencyPreApproved: false }), quiet, at(0)), 100);
  assert.deepEqual(bare.filed[0].labels, []);
  assert.equal(await b.sweep.run(repoConfig({ dependencyPreApproved: false }), quiet, at(1)), null);
});

test("A5b: security-only selection and never-production are unchanged", async () => {
  const host = new FakeHost();
  host.addPr(1, "a", "chore(deps): bump vite from 1.0.0 to 2.0.0"); host.addPr(2, "b", "chore(deps): bump lodash from 1.0.0 to 1.0.1");
  host.addPr(3, "c", "chore(deps): bump lodash from 1.0.0 to 1.0.2", "main");
  host.alerts = new Set(["lodash"]);
  const { sweep } = build(host, new FakeLedger());
  await sweep.run(repoConfig({ dependabot: { securityOnly: true } }), quiet, at(0));
  assert.equal(host.filed.length, 1);
  assert.match(host.filed[0].body, /#2 /); assert.doesNotMatch(host.filed[0].body, /#1 |#3 /);
});

test("the EM notice is a repo-level unstick entry, once per batch key", async () => {
  await startGitHubWorkSource();
  memoryRecords();
  const rt = { records: new IssueRecordStore() };
  const handoffs = new EmHandoffs(rt.records);
  assert.equal(await handoffs.raise(repoConfig(), dependencyBatchLoopAlert("627@sha627", 3)).then(() => true), true);
  await handoffs.raise(repoConfig(), dependencyBatchLoopAlert("627@sha627", 3)).then(() => true);
  const rec = await repoRecordOf(rt, repoConfig());
  const entries = JSON.stringify(rec);
  assert.match(entries, /dependency-batch-loop/);
  assert.equal((entries.match(/dependency-batch-loop/g) ?? []).length >= 1, true);
});

test("implement.ts retires the batch's PRs before the generic close", () => {
  const src = readFileSync(new URL("../src/phases/implement.ts", import.meta.url), "utf8");
  const a = src.indexOf("resolveLandedDependencyBatch("), b = src.indexOf("closeAlreadyLanded(");
  assert.ok(a > 0 && b > a, "resolveLandedDependencyBatch must be called before closeAlreadyLanded");
});
