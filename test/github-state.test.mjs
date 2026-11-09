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

// A scripted runner: each call takes the next response; queries are recorded. It is
// the async runner (`runAsync`), the only one the fleet state has: a scripted Error rejects.
function harness(responses) {
  const queries = [];
  let clock = T0;
  const run = async (args) => {
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

test("off unless configured", async () => {
  assert.equal(s.isEnabled("a/b"), false);
});

test("one query covers every repo; a refresh inside refreshMs costs nothing", async () => {
  const h = harness([{ r0: { issues: conn([issue(2, ["approved"])]), pullRequests: conn([pr(5)]) }, r1: { issues: conn([]), pullRequests: conn([]) } }]);
  s.configure({ repos: ["a/x", "a/y"], refreshMs: 30_000, runAsync: h.run, logger, now: h.now });
  assert.deepEqual((await s.openIssues("a/x")).map((i) => i.number), [2]);
  assert.deepEqual((await s.openPrs("a/x")).map((p) => p.number), [5]);
  assert.deepEqual(await s.openIssues("a/y"), []);
  assert.equal(h.queries.length, 1);
  assert.match(h.queries[0], /r0: repository\(owner: "a", name: "x"\)/);
  assert.match(h.queries[0], /r1: repository\(owner: "a", name: "y"\)/);
  h.tick(10_000);
  await s.openIssues("a/y");
  assert.equal(h.queries.length, 1);
});

test("a delta upserts changed issues, drops closed ones, and a closed PR bumps closedVersion", async () => {
  const h = harness([
    { r0: { issues: conn([issue(1), issue(2)]), pullRequests: conn([pr(5)]) } },
    { r0: { issues: conn([issue(1, ["approved"], "OPEN", iso(T0 + 30_000)), issue(2, [], "CLOSED", iso(T0 + 30_000))]), pullRequests: conn([pr(5, "MERGED", iso(T0 + 30_000))]) } },
  ]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.run, logger, now: h.now });
  await s.openIssues("a/x");
  const v0 = await s.closedVersion("a/x");
  h.tick(31_000);
  assert.deepEqual((await s.openIssues("a/x")).map((i) => [i.number, i.labels.map((l) => l.name)]), [[1, ["approved"]]]);
  assert.match(h.queries[1], /filterBy: \{ since:/);
  assert.doesNotMatch(h.queries[1], /states: OPEN/);
  assert.deepEqual(await s.openPrs("a/x"), []);
  assert.ok(await s.closedVersion("a/x") > v0);
});

test("a delta that fills its window falls back to a full sync of that repo", async () => {
  const h = harness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1)], true), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1), issue(3)]), pullRequests: conn([]) } },
  ]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.run, logger, now: h.now });
  await s.openIssues("a/x");
  h.tick(31_000);
  assert.deepEqual((await s.openIssues("a/x")).map((i) => i.number), [3, 1]);
  assert.equal(h.queries.length, 3);
  assert.match(h.queries[2], /states: OPEN/);
});

test("markRepoDirty re-syncs just that repo on its next read, inside refreshMs", async () => {
  const h = harness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) }, r1: { issues: conn([]), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1, ["pr under review"], "OPEN", iso(T0 + 1))]), pullRequests: conn([]) } },
  ]);
  s.configure({ repos: ["a/x", "a/y"], refreshMs: 30_000, runAsync: h.run, logger, now: h.now });
  await s.openIssues("a/x");
  s.markRepoDirty("a/x");
  h.tick(1000);
  await s.openIssues("a/y");
  assert.equal(h.queries.length, 1, "a clean repo's read does not pay for another's write");
  assert.deepEqual((await s.openIssues("a/x"))[0].labels, [{ name: "pr under review" }]);
  assert.equal(h.queries.length, 2);
  assert.match(h.queries[1], /r0: repository\(owner: "a", name: "x"\)/);
  assert.doesNotMatch(h.queries[1], /name: "y"/);
});

test("a failed refresh is re-thrown, not re-run, for every repo during the cooldown", async () => {
  const h = harness([new Error("boom"), { r0: { issues: conn([]), pullRequests: conn([]) }, r1: { issues: conn([]), pullRequests: conn([]) } }]);
  s.configure({ repos: ["a/x", "a/y"], refreshMs: 30_000, runAsync: h.run, logger, now: h.now });
  await assert.rejects(s.openIssues("a/x"), /boom/);
  await assert.rejects(s.openIssues("a/y"), /boom/);
  assert.equal(h.queries.length, 1);
  h.tick(16_000);
  assert.deepEqual(await s.openIssues("a/y"), []);
  assert.equal(h.queries.length, 2);
});

test("state persists and a restart resumes with a delta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-state-test-"));
  try {
    const persistPath = join(dir, ".github-state.json");
    const h = harness([
      { r0: { issues: conn([issue(4, ["approved"])]), pullRequests: conn([]) } },
      { r0: { issues: conn([]), pullRequests: conn([]) } },
    ]);
    s.configure({ repos: ["a/x"], refreshMs: 30_000, persistPath, runAsync: h.run, logger, now: h.now });
    await s.openIssues("a/x");
    assert.ok(existsSync(persistPath));
    s = new GitHubState(); // the daemon restarts
    h.tick(5_000);
    s.configure({ repos: ["a/x"], refreshMs: 30_000, persistPath, runAsync: h.run, logger, now: h.now });
    assert.deepEqual((await s.openIssues("a/x")).map((i) => i.number), [4]);
    assert.match(h.queries[1], /filterBy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hot-reloaded repo list adds and drops repos", async () => {
  const h = harness([
    { r0: { issues: conn([]), pullRequests: conn([]) } },
    // Full syncs go first in the query: the new repo is r0, the known one's delta r1.
    { r0: { issues: conn([issue(9)]), pullRequests: conn([]) }, r1: { issues: conn([]), pullRequests: conn([]) } },
  ]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.run, logger, now: h.now });
  await s.openIssues("a/x");
  s.setRepos(["a/x", "a/z"]);
  assert.equal(s.isEnabled("a/z"), true);
  assert.deepEqual((await s.openIssues("a/z")).map((i) => i.number), [9]);
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

test("a NOT_FOUND alias fails only that repo; the others resolve from the partial body", async () => {
  const h = harness([ghPartial({ r0: { issues: conn([issue(2)]), pullRequests: conn([pr(5)]) }, r1: null, r2: empty() }, [notFound("r1", "a/gone")])]);
  const log = spyLogger();
  s.configure({ repos: ["a/x", "a/gone", "a/z"], refreshMs: 30_000, runAsync: h.run, logger: log, now: h.now });
  assert.deepEqual((await s.openIssues("a/x")).map((i) => i.number), [2]);
  assert.deepEqual((await s.openPrs("a/x")).map((p) => p.number), [5]);
  assert.deepEqual(await s.openIssues("a/z"), []);
  await assert.rejects(s.openIssues("a/gone"), /a\/gone unreachable \(NOT_FOUND\)/);
  assert.equal(h.queries.length, 1);
  assert.equal(log.warns.length, 1);
  assert.equal(log.warns[0].d.repo, "a/gone");
  assert.equal(log.warns[0].d.type, "NOT_FOUND");
});

test("an unreachable repo is left out of the next queries and warned about once, then retried after the back-off", async () => {
  const h = harness([
    ghPartial({ r0: empty(), r1: null }, [notFound("r1", "a/gone")]),
    { r0: empty() },
    ghPartial({ r0: null, r1: empty() }, [notFound("r0", "a/gone")]), // retry: a/gone (full) is r0, a/x (delta) r1
  ]);
  const log = spyLogger();
  s.configure({ repos: ["a/x", "a/gone"], refreshMs: 30_000, runAsync: h.run, logger: log, now: h.now });
  await s.openIssues("a/x");
  h.tick(31_000);
  await s.openIssues("a/x");
  assert.doesNotMatch(h.queries[1], /gone/);
  await assert.rejects(s.openIssues("a/gone"), /unreachable/);
  assert.equal(h.queries.length, 2, "no query for the unreachable repo inside the back-off");
  h.tick(10 * 60_000);
  await s.openIssues("a/x");
  assert.match(h.queries[2], /gone/, "retried after the back-off");
  await assert.rejects(s.openIssues("a/gone"), /unreachable/);
  assert.equal(log.warns.length, 1, "the same failure is not logged again");
});

test("a repo that becomes reachable again is read normally", async () => {
  const h = harness([
    ghPartial({ r0: empty(), r1: null }, [notFound("r1", "a/back")]),
    { r0: { issues: conn([issue(9)]), pullRequests: conn([]) }, r1: empty() }, // the full read (a/back) is r0, a/x delta r1
  ]);
  s.configure({ repos: ["a/x", "a/back"], refreshMs: 30_000, runAsync: h.run, logger: spyLogger(), now: h.now });
  await s.openIssues("a/x");
  h.tick(11 * 60_000);
  assert.deepEqual((await s.openIssues("a/back")).map((i) => i.number), [9]);
});

test("a gh failure with no data in its body is still a whole-query failure", async () => {
  const e = new Error("gh: HTTP 401");
  e.stdout = JSON.stringify({ errors: [{ message: "Bad credentials" }] });
  const h = harness([e]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.run, logger, now: h.now });
  await assert.rejects(s.openIssues("a/x"), /HTTP 401/);
});


// foreman#236: reads go through the async runner only. A deferred runner lets a test
// hold a refresh open and act while it is in flight, as a lane or an observer would.
function asyncHarness(responses) {
  const h = harness(responses);
  const pending = [];
  const runAsync = (args) => new Promise((resolve, reject) => {
    pending.push(() => { h.run(args).then(resolve, reject); });
  });
  const release = async () => { while (pending.length) pending.shift()(); await new Promise((r) => setImmediate(r)); };
  // Release answers until `p` settles (a read may need several queries).
  const drain = async (p) => {
    let done = false;
    const settled = p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 20 && !done; i++) await release();
    await settled;
  };
  return { ...h, runAsync, pending, release, drain };
}

test("warm refreshes off the loop; concurrent warms share one query; the reads that follow cost nothing", async () => {
  const h = asyncHarness([{ r0: { issues: conn([issue(3)]), pullRequests: conn([]) } }]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.runAsync, logger, now: h.now });
  const a = s.warm();
  const b = s.warm();
  assert.equal(a, b, "a second warm joins the one in flight");
  assert.equal(h.pending.length, 1);
  await h.release();
  await a;
  assert.deepEqual((await s.openIssues("a/x")).map((i) => i.number), [3]);
  assert.equal(h.queries.length, 1);
  assert.equal(await s.warm(), undefined, "fresh and clean: nothing to do");
  assert.equal(h.queries.length, 1);
});

test("a cold read waits on the shared refresh and never blocks the event loop", async () => {
  const h = asyncHarness([{ r0: { issues: conn([issue(5)]), pullRequests: conn([]) } }]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.runAsync, logger, now: h.now });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  const read = s.openIssues("a/x");
  await new Promise((r) => setTimeout(r, 60)); // gh is hung: the query is out and unanswered
  clearInterval(timer);
  assert.ok(ticks >= 5, `the loop kept turning while the read waited (${ticks} ticks)`);
  assert.equal(h.pending.length, 1);
  await h.drain(read);
  assert.deepEqual((await read).map((i) => i.number), [5]);
});

test("while a refresh is in flight a merely stale view is served as is, without a second query", async () => {
  const h = asyncHarness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1, ["approved"], "OPEN", iso(T0 + 31_000))]), pullRequests: conn([]) } },
  ]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.runAsync, logger, now: h.now });
  await h.drain(s.openIssues("a/x"));
  h.tick(31_000);
  const w = s.warm();
  assert.deepEqual((await s.openIssues("a/x")).map((i) => i.labels.length), [0], "served from the view during the warm");
  assert.equal(h.pending.length, 1, "one query out, no second");
  await h.release();
  await w;
  assert.deepEqual((await s.openIssues("a/x")).map((i) => i.labels.map((l) => l.name)), [["approved"]]);
});

test("a write during an async refresh is not overwritten by the older answer; the repo stays dirty", async () => {
  const h = asyncHarness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) } },
    // The warm's answer, read before the write: issue 1 without its new label.
    { r0: { issues: conn([issue(1, [], "OPEN", iso(T0 + 31_000))]), pullRequests: conn([]) } },
    // The re-query after the write.
    { r0: { issues: conn([issue(1, ["approved"], "OPEN", iso(T0 + 32_000))]), pullRequests: conn([]) } },
  ]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.runAsync, logger, now: h.now });
  await h.drain(s.openIssues("a/x"));
  h.tick(31_000);
  const w = s.warm();
  s.markRepoDirty("a/x"); // the Foreman labels issue 1 while the warm's query is out
  const read = s.openIssues("a/x");
  await h.drain(read);
  await w;
  assert.deepEqual((await read)[0].labels.map((l) => l.name), ["approved"], "the pre-write answer was not applied; the read waited for a newer one");
  assert.equal(h.queries.length, 3);
});

test("a failed warm rejects, and is re-thrown, not re-run, inside the cooldown", async () => {
  const h = asyncHarness([new Error("TLS handshake timeout")]);
  s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.runAsync, logger, now: h.now });
  const failed = assert.rejects(s.warm(), /TLS handshake timeout/);
  await h.release();
  await failed;
  await assert.rejects(s.warm(), /TLS handshake timeout/);
  assert.equal(h.queries.length, 1);
});

// Tech Lead review of PR #237: the cooldown is stamped when the failure lands, not when
// the refresh starts, so a warm that failed after a 30 s gh timeout still holds the next
// reads off for 15 s.
for (const [snapshot, slowMs] of [["cold", 31_000], ["cold", 93_000], ["stale", 30_000], ["stale", 93_000]]) {
  test(`a warm that fails after ${slowMs / 1000} s (${snapshot} snapshot): the next reads re-throw it for 15 s, with no new query`, async () => {
    const answers = snapshot === "stale" ? [{ r0: { issues: conn([issue(1)]), pullRequests: conn([]) } }] : [];
    const h = asyncHarness([...answers, new Error("TLS handshake timeout")]);
    s.configure({ repos: ["a/x"], refreshMs: 30_000, runAsync: h.runAsync, logger, now: h.now });
    if (snapshot === "stale") { await h.drain(s.openIssues("a/x")); h.tick(31_000); }
    const queriesBefore = h.queries.length;
    const failed = assert.rejects(s.warm(), /TLS handshake timeout/);
    h.tick(slowMs); // the hung gh call times out
    await h.release();
    await failed;
    await assert.rejects(s.openIssues("a/x"), /TLS handshake timeout/);
    h.tick(14_000);
    await assert.rejects(s.openIssues("a/x"), /TLS handshake timeout/);
    await assert.rejects(s.warm(), /TLS handshake timeout/);
    assert.equal(h.queries.length, queriesBefore + 1, "no query inside the cooldown");
  });
}
