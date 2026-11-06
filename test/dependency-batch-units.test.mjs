// Unit tests for each collaborator of the dependency sweep (foreman#230). The scenarios that
// tie them together (Acceptance A1-A5) are in dependency-batch-scenarios.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { DependencyBatch } from "../dist/dependency-batch/batch.js";
import { DependencyBatchFilingPolicy, MAX_FILINGS_PER_WINDOW } from "../dist/dependency-batch/policy.js";
import {
  DependencyDiscovery, SecuritySelection, BatchIssueComposer, BatchIssueFiler, OpenBatchIssueProbe, batchOf,
} from "../dist/dependency-batch/collaborators.js";
import { DependencyBatchLanding } from "../dist/dependency-batch/landing.js";
import { RecordStoreDependencyBatchLedger } from "../dist/dependency-batch/ledger.js";
import { IssueRecordStore } from "../dist/issue-records.js";
import { startGitHubWorkSource } from "./agent-plugins.mjs";
import { memoryRecords } from "./issue-records.mjs";
import { FakeHost, FakeLedger, repoConfig, logs, quiet } from "./dependency-batch-fixtures.mjs";

const T0 = new Date("2026-11-06T00:00:00Z");
const at = (h) => new Date(T0.getTime() + h * 3600_000);

// --- DependencyBatch ---------------------------------------------------------------------------

test("a batch's key is stable: order and duplicates do not matter", () => {
  const a = DependencyBatch.of([{ number: 631, headSha: "b" }, { number: 627, headSha: "a" }, { number: 627, headSha: "a" }]);
  const b = DependencyBatch.of([{ number: 627, headSha: "a" }, { number: 631, headSha: "b" }]);
  assert.equal(a.key, "627@a,631@b");
  assert.ok(a.equals(b));
});

test("a new head SHA is a different batch", () => {
  assert.notEqual(DependencyBatch.of([{ number: 627, headSha: "a" }]).key, DependencyBatch.of([{ number: 627, headSha: "c" }]).key);
});

test("a PR with no head sha keys as unknown, never as an empty string", () => {
  assert.equal(DependencyBatch.of([{ number: 1 }]).key, "1@unknown");
  assert.ok(DependencyBatch.of([]).isEmpty);
});

// --- DependencyBatchFilingPolicy ---------------------------------------------------------------

const policy = new DependencyBatchFilingPolicy();
const hist = (over = {}) => ({ prs: [], filings: [], issues: [], ...over });

test("policy: never filed -> file", () => {
  assert.deepEqual(policy.decide({ history: undefined, batchIssueOpen: false, now: T0 }), { action: "file" });
});
test("policy: an unreadable ledger files nothing", () => {
  assert.deepEqual(policy.decide({ history: null, batchIssueOpen: false, now: T0 }), { action: "skip", reason: "ledger-unavailable" });
});
test("policy: an open batch issue blocks filing", () => {
  assert.deepEqual(policy.decide({ history: undefined, batchIssueOpen: true, now: T0 }), { action: "skip", reason: "issue-open" });
});
test("policy: every outcome is terminal", () => {
  for (const outcome of ["landed", "partial", "refused"]) {
    assert.deepEqual(policy.decide({ history: hist({ outcome }), batchIssueOpen: false, now: T0 }), { action: "skip", reason: "terminal-outcome" });
  }
});
test("policy: the third filing in 24h is the last; the next holds", () => {
  const filings = [at(0), at(1), at(2)].map((d) => d.toISOString());
  assert.equal(MAX_FILINGS_PER_WINDOW, 3);
  assert.deepEqual(policy.decide({ history: hist({ filings: filings.slice(0, 2) }), batchIssueOpen: false, now: at(3) }), { action: "file" });
  assert.deepEqual(policy.decide({ history: hist({ filings }), batchIssueOpen: false, now: at(3) }), { action: "hold", filings: 3 });
});
test("policy: filings older than 24h do not count", () => {
  const filings = [at(0), at(1), at(2)].map((d) => d.toISOString());
  assert.deepEqual(policy.decide({ history: hist({ filings }), batchIssueOpen: false, now: at(27) }), { action: "file" });
});

// --- DependencyDiscovery / SecuritySelection ---------------------------------------------------

test("discovery: finds PRs on the working branches, never on production", () => {
  const host = new FakeHost();
  host.addPr(1, "a"); host.addPr(2, "b", undefined, "main");
  const found = new DependencyDiscovery(host).discover(repoConfig(), quiet);
  assert.deepEqual(found.bases, ["develop", "features"]);
  assert.deepEqual(found.prs.map((p) => p.number), [1]);
});
test("discovery: nothing open -> null", () => {
  assert.equal(new DependencyDiscovery(new FakeHost()).discover(repoConfig(), quiet), null);
});
test("discovery: a repo whose only base is production has no bases", () => {
  const host = new FakeHost(); host.addPr(1, "a");
  assert.equal(new DependencyDiscovery(host).discover(repoConfig({ baseBranch: "main", featureBranch: undefined }), quiet), null);
});

test("security selection: keeps only PRs with an open alert on their package", () => {
  const host = new FakeHost();
  host.addPr(1, "a", "chore(deps): bump vite from 1.0.0 to 2.0.0"); host.addPr(2, "b", "chore(deps): bump lodash from 1.0.0 to 1.0.1");
  host.alerts = new Set(["lodash"]);
  const sel = new SecuritySelection(host).select(repoConfig({ dependabot: { securityOnly: true } }), host.prs, quiet);
  assert.deepEqual(sel.map((p) => p.number), [2]);
});
test("security selection: an unreadable alert list batches nothing", () => {
  const host = new FakeHost(); host.addPr(1, "a"); host.alertsFail = true;
  assert.deepEqual(new SecuritySelection(host).select(repoConfig({ dependabot: { securityOnly: true } }), host.prs, quiet), []);
});
test("security selection: securityOnly off passes everything through", () => {
  const host = new FakeHost(); host.addPr(1, "a"); host.alertsFail = true;
  assert.equal(new SecuritySelection(host).select(repoConfig(), host.prs, quiet).length, 1);
});

// --- composer / filer / probe ------------------------------------------------------------------

test("composer: title and body name every PR; the batch keys on head SHAs", () => {
  const host = new FakeHost(); host.addPr(627, "sha1", "chore(deps): bump @hono/node-server from 1.19.17 to 2.1.6");
  const issue = new BatchIssueComposer(host).compose(repoConfig(), host.prs);
  assert.match(issue.title, /^chore\(deps\): validate and land 1 dependency update on `develop` \(1 major\)$/);
  assert.match(issue.body, /\| #627 \| @hono\/node-server \|/);
  assert.equal(batchOf(host.prs).key, "627@sha1");
});
test("filer: pre-approved repos file with the trigger label, others bare", () => {
  const host = new FakeHost();
  const issue = { title: "t", body: "b", changes: [] };
  new BatchIssueFiler(host).file(repoConfig(), issue, quiet);
  new BatchIssueFiler(host).file(repoConfig({ dependencyPreApproved: false }), issue, quiet);
  assert.deepEqual(host.filed.map((f) => f.label), ["approved", null]);
});
test("probe: sees an open batch issue and ignores a closed one", () => {
  const host = new FakeHost();
  host.issues.push({ number: 1, open: false });
  assert.equal(new OpenBatchIssueProbe(host).isOpen(repoConfig(), quiet), false);
  host.issues.push({ number: 2, open: true });
  assert.equal(new OpenBatchIssueProbe(host).isOpen(repoConfig(), quiet), true);
});

// --- DependencyBatchLanding --------------------------------------------------------------------

async function landingFixture() {
  const host = new FakeHost(); host.addPr(627, "sha1");
  const ledger = new FakeLedger();
  const batch = batchOf(host.prs);
  await ledger.recordFiling(null, batch, T0); await ledger.attachIssue(null, batch, 690);
  return { host, ledger, batch, landing: new DependencyBatchLanding(ledger, new DependencyDiscovery(host), host) };
}

test("landing: an issue that is not a batch issue is left alone", async () => {
  const { landing, host } = await landingFixture();
  assert.deepEqual(await landing.resolve(repoConfig(), 5, "x", quiet), { kind: "not-a-batch" });
  assert.deepEqual(host.retired, []);
});
test("landing: retires each PR with a comment naming why, then records landed", async () => {
  const { landing, host, ledger, batch } = await landingFixture();
  const r = await landing.resolve(repoConfig(), 690, "2.1.6 is in develop via #633 and #637", quiet, at(1));
  assert.equal(r.kind, "landed");
  assert.deepEqual(host.retired.map((x) => x.number), [627]);
  assert.match(host.retired[0].reason, /#633 and #637/);
  assert.equal((await ledger.historyOf(null, batch)).outcome, "landed");
});
test("landing: a PR that moved to a new head since filing is not retired", async () => {
  const { landing, host } = await landingFixture();
  host.addPr(627, "sha2");
  const r = await landing.resolve(repoConfig(), 690, "x", quiet);
  assert.deepEqual(host.retired, []);
  assert.deepEqual(r.newerHead, [627]);
});
test("landing: a failed retirement records no outcome", async () => {
  const { landing, host, ledger, batch } = await landingFixture();
  host.retireFails = true;
  const r = await landing.resolve(repoConfig(), 690, "x", quiet);
  assert.equal(r.kind, "retirement-failed");
  assert.equal((await ledger.historyOf(null, batch)).outcome, undefined);
});
test("landing: an unreadable ledger retires nothing", async () => {
  const { landing, host, ledger } = await landingFixture();
  ledger.broken = true;
  assert.deepEqual(await landing.resolve(repoConfig(), 690, "x", quiet), { kind: "ledger-unavailable" });
  assert.deepEqual(host.retired, []);
});

// --- RecordStoreDependencyBatchLedger (the real implementation, over the in-memory record store) ---

test("record-store ledger: filings, issue and outcome round-trip through the repo record", async () => {
  await startGitHubWorkSource();
  memoryRecords();
  const ledger = new RecordStoreDependencyBatchLedger(new IssueRecordStore());
  const cfg = repoConfig();
  const batch = DependencyBatch.of([{ number: 627, headSha: "a" }]);
  assert.equal(await ledger.historyOf(cfg, batch), undefined);
  assert.ok(await ledger.recordFiling(cfg, batch, T0));
  assert.ok(await ledger.attachIssue(cfg, batch, 690));
  assert.ok(await ledger.recordFiling(cfg, batch, at(1)));
  const found = await ledger.batchOfIssue(cfg, 690);
  assert.equal(found.batch.key, batch.key);
  assert.equal(found.history.filings.length, 2);
  assert.equal(await ledger.batchOfIssue(cfg, 1), undefined);
  assert.ok(await ledger.recordOutcome(cfg, batch, "landed", at(2)));
  const h = await ledger.historyOf(cfg, batch);
  assert.equal(h.outcome, "landed");
  assert.equal("emNotified" in h, false, "the ledger keeps no EM-delivery flag: the unstick entry is the one record of it");
});

test("record-store ledger: an unreadable record is null, never an empty history", async () => {
  await startGitHubWorkSource();
  const store = memoryRecords();
  void store;
  const { activeWorkSource } = await import("../dist/plugins/registry.js");
  activeWorkSource().loadRecord = async () => ({ status: "unavailable" });
  const ledger = new RecordStoreDependencyBatchLedger(new IssueRecordStore());
  const batch = DependencyBatch.of([{ number: 1, headSha: "a" }]);
  assert.equal(await ledger.historyOf(repoConfig(), batch), null);
  assert.equal(await ledger.batchOfIssue(repoConfig(), 5), null);
  assert.equal(await ledger.recordFiling(repoConfig(), batch, T0), false);
});

test("record-store ledger: an open entry untouched for a week is dropped on the next write; a terminal one is kept", async () => {
  await startGitHubWorkSource();
  memoryRecords();
  const ledger = new RecordStoreDependencyBatchLedger(new IssueRecordStore());
  const cfg = repoConfig();
  const old = DependencyBatch.of([{ number: 1, headSha: "a" }]);
  const kept = DependencyBatch.of([{ number: 2, headSha: "b" }]);
  const fresh = DependencyBatch.of([{ number: 3, headSha: "c" }]);
  await ledger.recordFiling(cfg, old, T0);
  await ledger.recordFiling(cfg, kept, T0); await ledger.recordOutcome(cfg, kept, "landed", T0);
  await ledger.recordFiling(cfg, fresh, new Date(T0.getTime() + 8 * 24 * 3600_000));
  assert.equal(await ledger.historyOf(cfg, old), undefined);
  assert.equal((await ledger.historyOf(cfg, kept)).outcome, "landed");
});
