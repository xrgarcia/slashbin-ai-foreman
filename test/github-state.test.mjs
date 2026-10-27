// The fleet GitHub state answers every repo's open issues and PRs from one bulk
// GraphQL query per refresh, delta-only between full syncs. These drive the
// module directly with an injected `run` and clock; no gh, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configureGitHubState, resetGitHubState, stateOpenIssues, stateOpenPrs, closedVersion,
  markRepoDirty, setGitHubStateRepos, isGitHubStateEnabled,
} from "../dist/github-state.js";
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

beforeEach(() => resetGitHubState());

test("off unless configured", () => {
  assert.equal(isGitHubStateEnabled("a/b"), false);
});

test("one query covers every repo; a refresh inside refreshMs costs nothing", () => {
  const h = harness([{ r0: { issues: conn([issue(2, ["approved"])]), pullRequests: conn([pr(5)]) }, r1: { issues: conn([]), pullRequests: conn([]) } }]);
  configureGitHubState({ repos: ["a/x", "a/y"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  assert.deepEqual(stateOpenIssues("a/x").map((i) => i.number), [2]);
  assert.deepEqual(stateOpenPrs("a/x").map((p) => p.number), [5]);
  assert.deepEqual(stateOpenIssues("a/y"), []);
  assert.equal(h.queries.length, 1);
  assert.match(h.queries[0], /r0: repository\(owner: "a", name: "x"\)/);
  assert.match(h.queries[0], /r1: repository\(owner: "a", name: "y"\)/);
  h.tick(10_000);
  stateOpenIssues("a/y");
  assert.equal(h.queries.length, 1);
});

test("a delta upserts changed issues, drops closed ones, and a closed PR bumps closedVersion", () => {
  const h = harness([
    { r0: { issues: conn([issue(1), issue(2)]), pullRequests: conn([pr(5)]) } },
    { r0: { issues: conn([issue(1, ["approved"], "OPEN", iso(T0 + 30_000)), issue(2, [], "CLOSED", iso(T0 + 30_000))]), pullRequests: conn([pr(5, "MERGED", iso(T0 + 30_000))]) } },
  ]);
  configureGitHubState({ repos: ["a/x"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  stateOpenIssues("a/x");
  const v0 = closedVersion("a/x");
  h.tick(31_000);
  assert.deepEqual(stateOpenIssues("a/x").map((i) => [i.number, i.labels.map((l) => l.name)]), [[1, ["approved"]]]);
  assert.match(h.queries[1], /filterBy: \{ since:/);
  assert.doesNotMatch(h.queries[1], /states: OPEN/);
  assert.deepEqual(stateOpenPrs("a/x"), []);
  assert.ok(closedVersion("a/x") > v0);
});

test("a delta that fills its window falls back to a full sync of that repo", () => {
  const h = harness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1)], true), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1), issue(3)]), pullRequests: conn([]) } },
  ]);
  configureGitHubState({ repos: ["a/x"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  stateOpenIssues("a/x");
  h.tick(31_000);
  assert.deepEqual(stateOpenIssues("a/x").map((i) => i.number), [3, 1]);
  assert.equal(h.queries.length, 3);
  assert.match(h.queries[2], /states: OPEN/);
});

test("markRepoDirty re-syncs just that repo on its next read, inside refreshMs", () => {
  const h = harness([
    { r0: { issues: conn([issue(1)]), pullRequests: conn([]) }, r1: { issues: conn([]), pullRequests: conn([]) } },
    { r0: { issues: conn([issue(1, ["pr under review"], "OPEN", iso(T0 + 1))]), pullRequests: conn([]) } },
  ]);
  configureGitHubState({ repos: ["a/x", "a/y"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  stateOpenIssues("a/x");
  markRepoDirty("a/x");
  h.tick(1000);
  stateOpenIssues("a/y");
  assert.equal(h.queries.length, 1, "a clean repo's read does not pay for another's write");
  assert.deepEqual(stateOpenIssues("a/x")[0].labels, [{ name: "pr under review" }]);
  assert.equal(h.queries.length, 2);
  assert.match(h.queries[1], /r0: repository\(owner: "a", name: "x"\)/);
  assert.doesNotMatch(h.queries[1], /name: "y"/);
});

test("a failed refresh is re-thrown, not re-run, for every repo during the cooldown", () => {
  const h = harness([new Error("boom"), { r0: { issues: conn([]), pullRequests: conn([]) }, r1: { issues: conn([]), pullRequests: conn([]) } }]);
  configureGitHubState({ repos: ["a/x", "a/y"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  assert.throws(() => stateOpenIssues("a/x"), /boom/);
  assert.throws(() => stateOpenIssues("a/y"), /boom/);
  assert.equal(h.queries.length, 1);
  h.tick(16_000);
  assert.deepEqual(stateOpenIssues("a/y"), []);
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
    configureGitHubState({ repos: ["a/x"], refreshMs: 30_000, persistPath, run: h.run, logger, now: h.now });
    stateOpenIssues("a/x");
    assert.ok(existsSync(persistPath));
    resetGitHubState();
    h.tick(5_000);
    configureGitHubState({ repos: ["a/x"], refreshMs: 30_000, persistPath, run: h.run, logger, now: h.now });
    assert.deepEqual(stateOpenIssues("a/x").map((i) => i.number), [4]);
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
  configureGitHubState({ repos: ["a/x"], refreshMs: 30_000, run: h.run, logger, now: h.now });
  stateOpenIssues("a/x");
  setGitHubStateRepos(["a/x", "a/z"]);
  assert.equal(isGitHubStateEnabled("a/z"), true);
  assert.deepEqual(stateOpenIssues("a/z").map((i) => i.number), [9]);
  setGitHubStateRepos(["a/z"]);
  assert.equal(isGitHubStateEnabled("a/x"), false);
});
