// The fleet GitHub state answers every repo's open issues and PRs from one bulk
// GraphQL query per refresh, delta-only between full syncs. These drive the
// module directly with an injected `run` and clock; no gh, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubState } from "../dist/github-state.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
const T0 = Date.parse("2026-10-02T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

function issue(number, labels = [], state = "OPEN", updatedAt = iso(T0 - 1000)) {
  return { number, title: `#${number}`, state, updatedAt, labels: { nodes: labels.map((name) => ({ name })) } };
}
function pr(number, state = "OPEN", updatedAt = iso(T0 - 1000)) {
  return { number, url: `https://x/pull/${number}`, title: `pr ${number}`, body: "", state, headRefName: "features", baseRefName: "develop", headRefOid: "h", updatedAt };
}
const conn = (nodes, hasNextPage = false) => ({ pageInfo: { hasNextPage, endCursor: null }, nodes });

// A scripted run(): each call takes the next response; queries are recorded.
function harness(responses) {
  const queries = [];
  let clock = T0;
  const run = (args) => {
    queries.push(args.find((a) => a.startsWith("query=")).slice(6));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return JSON.stringify({ data: next });
  };
  return { queries, run, now: () => clock, tick: (ms) => { clock += ms; } };
}

// Each test gets its own fleet state; a restart is a new one.
let s;
beforeEach(() => { s = new GitHubState(); });

test("off unless configured", () => {
  assert.equal(s.isEnabled("a/b"), false);
});

test("one query covers every repo; a refresh inside refreshMs costs nothing", () => {
  const h = harness([{ r0: { issues: conn([issue(2, ["approved"])]), pullRequests: conn([pr(5)]) }, r1: { issues: conn([]), pullRequests: conn([]) } }]);
  s.configure({ repos: ["a/x", "a/y"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  assert.deepEqual(s.openIssues("a/x").map((i) => i.number), [2]);
  assert.deepEqual(s.openPrs("a/x").map((p) => p.number), [5]);
  assert.deepEqual(s.openIssues("a/y"), []);
  assert.equal(h.queries.length, 1);
  assert.match(h.queries[0], /r0: repository\(owner: "a", name: "x"\)/);
  assert.match(h.queries[0], /r1: repository\(owner: "a", name: "y"\)/);
  h.tick(10_000);
  s.openIssues("a/y");
  assert.equal(h.queries.length, 1);
});

test("a delta upserts changed issues, drops closed ones, and a closed PR bumps closedVersion", () => {
  const h = harness([
    { r0: { issues: conn([issue(1), issue(2)]), pullRequests: conn([pr(5)]) } },
    { r0: { issues: conn([issue(1, ["approved"], "OPEN", iso(T0 + 30_000)), issue(2, [], "CLOSED", iso(T0 + 30_000))]), pullRequests: conn([pr(5, "MERGED", iso(T0 + 30_000))]) } },
  ]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  s.openIssues("a/x");
  const v0 = s.closedVersion("a/x");
  h.tick(31_000);
  assert.deepEqual(s.openIssues("a/x").map((i) => [i.number, i.labels.map((l) => l.name)]), [[1, ["approved"]]]);
  assert.match(h.queries[1], /filterBy: \{ since:/);
  assert.doesNotMatch(h.queries[1], /states: OPEN/);
  assert.deepEqual(s.openPrs("a/x"), []);
  assert.ok(s.closedVersion("a/x") > v0);
});

test("a delta that fills its window falls back to a full sync of that repo", () => {
  const h = harness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1)], true), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1), issue(3)]), pullRequests: conn([]) } },
  ]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  s.openIssues("a/x");
  h.tick(31_000);
  assert.deepEqual(s.openIssues("a/x").map((i) => i.number), [3, 1]);
  assert.equal(h.queries.length, 3);
  assert.match(h.queries[2], /states: OPEN/);
});

test("markRepoDirty re-syncs just that repo on its next read, inside refreshMs", () => {
  const h = harness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) }, r1: { issues: conn([]), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1, ["pr under review"], "OPEN", iso(T0 + 1))]), pullRequests: conn([]) } },
  ]);
  s.configure({ repos: ["a/x", "a/y"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  s.openIssues("a/x");
  s.markRepoDirty("a/x");
  h.tick(1000);
  s.openIssues("a/y");
  assert.equal(h.queries.length, 1, "a clean repo's read does not pay for another's write");
  assert.deepEqual(s.openIssues("a/x")[0].labels, [{ name: "pr under review" }]);
  assert.equal(h.queries.length, 2);
  assert.match(h.queries[1], /r0: repository\(owner: "a", name: "x"\)/);
  assert.doesNotMatch(h.queries[1], /name: "y"/);
});

test("a failed refresh is re-thrown, not re-run, for every repo during the cooldown", () => {
  const h = harness([new Error("boom"), { r0: { issues: conn([]), pullRequests: conn([]) }, r1: { issues: conn([]), pullRequests: conn([]) } }]);
  s.configure({ repos: ["a/x", "a/y"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  assert.throws(() => s.openIssues("a/x"), /boom/);
  assert.throws(() => s.openIssues("a/y"), /boom/);
  assert.equal(h.queries.length, 1);
  h.tick(16_000);
  assert.deepEqual(s.openIssues("a/y"), []);
  assert.equal(h.queries.length, 2);
});

test("state persists and a restart resumes with a delta", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-state-test-"));
  try {
    const persistPath = join(dir, ".github-state.json");
    const h = harness([
      { r0: { issues: conn([issue(4, ["approved"])]), pullRequests: conn([]) } },
      { r0: { issues: conn([]), pullRequests: conn([]) } },
    ]);
    s.configure({ repos: ["a/x"], refreshMs: 30_000, persistPath, run: h.run, logger, now: h.now });
    s.openIssues("a/x");
    assert.ok(existsSync(persistPath));
    s = new GitHubState(); // the daemon restarts
    h.tick(5_000);
    s.configure({ repos: ["a/x"], refreshMs: 30_000, persistPath, run: h.run, logger, now: h.now });
    assert.deepEqual(s.openIssues("a/x").map((i) => i.number), [4]);
    assert.match(h.queries[1], /filterBy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hot-reloaded repo list adds and drops repos", () => {
  const h = harness([
    { r0: { issues: conn([]), pullRequests: conn([]) } },
    // Full syncs go first in the query: the new repo is r0, the known one's delta r1.
    { r0: { issues: conn([issue(9)]), pullRequests: conn([]) }, r1: { issues: conn([]), pullRequests: conn([]) } },
  ]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  s.openIssues("a/x");
  s.setRepos(["a/x", "a/z"]);
  assert.equal(s.isEnabled("a/z"), true);
  assert.deepEqual(s.openIssues("a/z").map((i) => i.number), [9]);
  s.setRepos(["a/z"]);
  assert.equal(s.isEnabled("a/x"), false);
});

// ---- one unreachable repo must not fail the fleet (2026-11-03 incident) ----

// What `gh api graphql` does when an alias is NOT_FOUND: prints the body, exits 1.
function ghPartial(data, errors) {
  const e = new Error("gh: Could not resolve to a Repository (HTTP 200)");
  e.stdout = JSON.stringify({ data, errors });
  e.status = 1;
  return e;
}
const notFound = (alias, name) => ({ type: "NOT_FOUND", path: [alias], message: `Could not resolve to a Repository with the name '${name}'.` });
function spyLogger() {
  const warns = [];
  return { warns, debug() {}, info() {}, error() {}, warn: (m, d) => warns.push({ m, d }) };
}
const empty = () => ({ issues: conn([]), pullRequests: conn([]) });

test("a NOT_FOUND alias fails only that repo; the others resolve from the partial body", () => {
  const h = harness([ghPartial({ r0: { issues: conn([issue(2)]), pullRequests: conn([pr(5)]) }, r1: null, r2: empty() }, [notFound("r1", "a/gone")])]);
  const log = spyLogger();
  s.configure({ repos: ["a/x", "a/gone", "a/z"], refreshMs: 30_000, run: h.run, logger: log, now: h.now });
  assert.deepEqual(s.openIssues("a/x").map((i) => i.number), [2]);
  assert.deepEqual(s.openPrs("a/x").map((p) => p.number), [5]);
  assert.deepEqual(s.openIssues("a/z"), []);
  assert.throws(() => s.openIssues("a/gone"), /a\/gone unreachable \(NOT_FOUND\)/);
  assert.equal(h.queries.length, 1);
  assert.equal(log.warns.length, 1);
  assert.equal(log.warns[0].d.repo, "a/gone");
  assert.equal(log.warns[0].d.type, "NOT_FOUND");
});

test("an unreachable repo is left out of the next queries and warned about once, then retried after the back-off", () => {
  const h = harness([
    ghPartial({ r0: empty(), r1: null }, [notFound("r1", "a/gone")]),
    { r0: empty() },
    ghPartial({ r0: null, r1: empty() }, [notFound("r0", "a/gone")]), // retry: a/gone (full) is r0, a/x (delta) r1
  ]);
  const log = spyLogger();
  s.configure({ repos: ["a/x", "a/gone"], refreshMs: 30_000, run: h.run, logger: log, now: h.now });
  s.openIssues("a/x");
  h.tick(31_000);
  s.openIssues("a/x");
  assert.doesNotMatch(h.queries[1], /gone/);
  assert.throws(() => s.openIssues("a/gone"), /unreachable/);
  assert.equal(h.queries.length, 2, "no query for the unreachable repo inside the back-off");
  h.tick(10 * 60_000);
  s.openIssues("a/x");
  assert.match(h.queries[2], /gone/, "retried after the back-off");
  assert.throws(() => s.openIssues("a/gone"), /unreachable/);
  assert.equal(log.warns.length, 1, "the same failure is not logged again");
});

test("a repo that becomes reachable again is read normally", () => {
  const h = harness([
    ghPartial({ r0: empty(), r1: null }, [notFound("r1", "a/back")]),
    { r0: { issues: conn([issue(9)]), pullRequests: conn([]) }, r1: empty() }, // the full read (a/back) is r0, a/x delta r1
  ]);
  s.configure({ repos: ["a/x", "a/back"], refreshMs: 30_000, run: h.run, logger: spyLogger(), now: h.now });
  s.openIssues("a/x");
  h.tick(11 * 60_000);
  assert.deepEqual(s.openIssues("a/back").map((i) => i.number), [9]);
});

test("a gh failure with no data in its body is still a whole-query failure", () => {
  const e = new Error("gh: HTTP 401");
  e.stdout = JSON.stringify({ errors: [{ message: "Bad credentials" }] });
  const h = harness([e]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  assert.throws(() => s.openIssues("a/x"), /HTTP 401/);
});

// foreman#236: the async warm. A deferred runAsync lets a test hold a refresh open
// and act while it is in flight, as a lane or an observer would.
function asyncHarness(responses) {
  const h = harness(responses);
  const pending = [];
  const runAsync = (args) => new Promise((resolve, reject) => {
    pending.push(() => { try { resolve(h.run(args)); } catch (e) { reject(e); } });
  });
  const release = async () => { while (pending.length) pending.shift()(); await new Promise((r) => setImmediate(r)); };
  return { ...h, runAsync, pending, release };
}

test("warm refreshes off the loop; concurrent warms share one query; the reads that follow cost nothing", async () => {
  const h = asyncHarness([{ r0: { issues: conn([issue(3)]), pullRequests: conn([]) } }]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run: () => { throw new Error("sync run used"); }, runAsync: h.runAsync, logger, now: h.now });
  const a = s.warm();
  const b = s.warm();
  assert.equal(a, b, "a second warm joins the one in flight");
  assert.equal(h.pending.length, 1);
  await h.release();
  await a;
  assert.deepEqual(s.openIssues("a/x").map((i) => i.number), [3], "the read is served by the warm, never the sync runner");
  assert.equal(h.queries.length, 1);
  assert.equal(await s.warm(), undefined, "fresh and clean: nothing to do");
  assert.equal(h.queries.length, 1);
});

test("while a warm is in flight a merely stale view is served as is, not refreshed synchronously", async () => {
  const h = asyncHarness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1, ["approved"], "OPEN", iso(T0 + 31_000))]), pullRequests: conn([]) } },
  ]);
  let syncCalls = 0;
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run: (args) => { syncCalls++; return h.run(args); }, runAsync: h.runAsync, logger, now: h.now });
  s.openIssues("a/x");
  assert.equal(syncCalls, 1);
  h.tick(31_000);
  const w = s.warm();
  assert.deepEqual(s.openIssues("a/x").map((i) => i.labels.length), [0], "served from the view during the warm");
  assert.equal(syncCalls, 1, "no second, blocking query");
  await h.release();
  await w;
  assert.deepEqual(s.openIssues("a/x").map((i) => i.labels.map((l) => l.name)), [["approved"]]);
});

test("a write during an async refresh is not overwritten by the older answer; the repo stays dirty", async () => {
  const h = asyncHarness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) } },
    // The warm's answer, read before the write: issue 1 without its new label.
    { r0: { issues: conn([issue(1, [], "OPEN", iso(T0 + 31_000))]), pullRequests: conn([]) } },
  ]);
  const syncAnswers = [
    { r0: { issues: conn([issue(1, ["approved"], "OPEN", iso(T0 + 32_000))]), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1, ["approved"], "OPEN", iso(T0 + 32_000))]), pullRequests: conn([]) } },
  ];
  let first = true;
  const run = (args) => {
    if (first) { first = false; return h.run(args); }
    return JSON.stringify({ data: syncAnswers.shift() });
  };
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run, runAsync: h.runAsync, logger, now: h.now });
  s.openIssues("a/x");
  h.tick(31_000);
  const w = s.warm();
  s.markRepoDirty("a/x"); // the Foreman labels issue 1 while the warm's query is out
  assert.deepEqual(s.openIssues("a/x")[0].labels.map((l) => l.name), ["approved"], "a dirty repo still reads its write");
  await h.release();
  await w;
  assert.deepEqual(s.openIssues("a/x")[0].labels.map((l) => l.name), ["approved"], "the warm's pre-write answer was not applied");
});

test("a failed warm rejects, and is re-thrown, not re-run, inside the cooldown", async () => {
  const h = asyncHarness([new Error("TLS handshake timeout")]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run: () => { throw new Error("sync run used"); }, runAsync: h.runAsync, logger, now: h.now });
  const failed = assert.rejects(s.warm(), /TLS handshake timeout/);
  await h.release();
  await failed;
  await assert.rejects(s.warm(), /TLS handshake timeout/);
  assert.equal(h.queries.length, 1);
});

// Tech Lead review of PR #237: the cooldown was stamped at the refresh's start, so a
// warm that failed after a 30 s gh timeout had already used it up, and the lane's
// next read ran the blocking query again. It is stamped when the failure lands.
for (const [snapshot, slowMs] of [["cold", 31_000], ["cold", 93_000], ["stale", 30_000], ["stale", 93_000]]) {
  test(`a warm that fails after ${slowMs / 1000} s (${snapshot} snapshot): the next reads re-throw it for 15 s, with no blocking query`, async () => {
    const answers = snapshot === "stale" ? [{ r0: { issues: conn([issue(1)]), pullRequests: conn([]) } }] : [];
    const h = asyncHarness([...answers, new Error("TLS handshake timeout")]);
    let syncCalls = 0;
    s.configure({ repos: ["a/x"], refreshMs: 30_000, run: (args) => { syncCalls++; return h.run(args); }, runAsync: h.runAsync, logger, now: h.now });
    if (snapshot === "stale") { s.openIssues("a/x"); syncCalls = 0; h.tick(31_000); }
    const failed = assert.rejects(s.warm(), /TLS handshake timeout/);
    h.tick(slowMs); // the hung gh call times out
    await h.release();
    await failed;
    assert.throws(() => s.openIssues("a/x"), /TLS handshake timeout/);
    h.tick(14_000);
    assert.throws(() => s.openIssues("a/x"), /TLS handshake timeout/);
    await assert.rejects(s.warm(), /TLS handshake timeout/);
    assert.equal(syncCalls, 0, "no synchronous query inside the cooldown");
  });
}

test("a slow synchronous failure is also stamped when it lands", () => {
  const h = harness([new Error("TLS handshake timeout")]);
  let syncCalls = 0;
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run: (args) => { syncCalls++; h.tick(31_000); return h.run(args); }, logger, now: h.now });
  assert.throws(() => s.openIssues("a/x"), /TLS handshake timeout/);
  h.tick(1_000);
  assert.throws(() => s.openIssues("a/x"), /TLS handshake timeout/);
  assert.equal(syncCalls, 1);
});

test("without runAsync, warm is a no-op and reads refresh through run", async () => {
  const h = harness([{ r0: { issues: conn([issue(4)]), pullRequests: conn([]) } }]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  await s.warm();
  assert.equal(h.queries.length, 0);
  assert.deepEqual(s.openIssues("a/x").map((i) => i.number), [4]);
});
