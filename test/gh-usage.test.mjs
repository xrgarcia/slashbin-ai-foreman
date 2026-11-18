import { test } from "node:test";
import assert from "node:assert/strict";
import { ghResource, recordGhCall, configureGhUsage, restEndpointKey, callerKey } from "../dist/gh-usage.js";

test("ghResource: api is core unless graphql; every other subcommand is graphql", () => {
  assert.equal(ghResource(["issue", "list"]), "graphql");
  assert.equal(ghResource(["pr", "view", "1"]), "graphql");
  assert.equal(ghResource(["api", "repos/a/b/compare/x...y"]), "core");
  assert.equal(ghResource(["api", "graphql", "-f", "query={}"]), "graphql");
  assert.equal(ghResource(["api", "search/issues?q=x", "--jq", ".items"]), "search");
  assert.equal(ghResource(["api", "-X", "GET", "/search/issues?q=x"]), "search");
  assert.equal(ghResource(["api", "-X", "POST", "repos/a/b/issues", "-f", "title=search/x"]), "core");
  // A flag's value is never the endpoint (Tech Lead S3 on PR #344).
  assert.equal(ghResource(["api", "--jq", ".items", "search/issues?q=x"]), "search");
  assert.equal(ghResource(["api", "-H", "Accept: application/vnd.github+json", "search/issues?q=x"]), "search");
  assert.equal(ghResource(["api", "--hostname", "github.com", "search/issues?q=x"]), "search");
  assert.equal(ghResource(["api", "--paginate", "search/issues?q=x"]), "search");
  assert.equal(ghResource(["api", "--method=GET", "/search/issues?q=x"]), "search");
  assert.equal(ghResource(["api", "--jq", "search/x", "repos/a/b"]), "core");
});

test("configureGhUsage: one summary per interval, counters reset on each emit", async () => {
  const lines = [];
  const logger = { debug() {}, warn() {}, error() {}, info: (msg, data) => lines.push(data), child() { return this; } };
  configureGhUsage({ intervalMs: 100, logger });
  recordGhCall(["issue", "list"]);
  recordGhCall(["pr", "list"]);
  recordGhCall(["api", "repos/a/b"]);
  await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(lines.length >= 2);
  assert.deepEqual({ total: lines[0].total, graphql: lines[0].graphql, core: lines[0].core }, { total: 3, graphql: 2, core: 1 });
  assert.ok(typeof lines[0].bySubcommand === "string" && lines[0].bySubcommand.includes("issue list"), "breakdown must survive the text log format");
  assert.equal(JSON.parse(lines[0].bySubcommand)["issue list"], 1);
  assert.equal(JSON.parse(lines[0].bySubcommand)["pr list"], 1);
  assert.equal(JSON.parse(lines[0].restByEndpoint)["GET repos/:repo"], 1, "REST calls must be attributed by endpoint");
  assert.equal(lines[1].total, 0);
  assert.equal(lines[1].restByEndpoint, "{}", "endpoint counts reset with the interval");
  configureGhUsage({ intervalMs: 3_600_000, logger: { info() {} } });
});

test("restEndpointKey: ids, repos, refs and ranges are stripped; method and flags handled", () => {
  assert.equal(restEndpointKey(["api", "repos/acme/foo/issues/123/comments", "--paginate"]), "GET repos/:repo/issues/:n/comments");
  assert.equal(restEndpointKey(["api", "/repos/a/b/compare/main...develop"]), "GET repos/:repo/compare/:range");
  assert.equal(restEndpointKey(["api", "-X", "POST", "repos/a/b/issues/7/labels", "-f", "labels[]=x"]), "POST repos/:repo/issues/:n/labels");
  assert.equal(restEndpointKey(["api", "--jq", ".[0]", "repos/a/b/deployments?sha=abc"]), "GET repos/:repo/deployments");
  assert.equal(restEndpointKey(["api", "repos/a/b/branches/feature/x/protection"]), "GET repos/:repo/branches/:ref");
  assert.equal(restEndpointKey(["api", "repos/a/b/commits/" + "a".repeat(40) + "/status"]), "GET repos/:repo/commits/:sha/status");
});

test("callerKey: names the first two frames outside the gh relay", () => {
  const stack = [
    "Error",
    "    at recordGhCall (file:///x/dist/gh-usage.js:60:5)",
    "    at runGhAsync (file:///x/dist/github/gh.js:96:7)",
    "    at ghAsync (file:///x/dist/github/gh.js:120:10)",
    "    at commentBodies (file:///x/dist/github/pr-comments.js:8:21)",
    "    at Object.commentBodies (file:///x/dist/plugins/github.js:90:3)",
    "    at async failCount (file:///x/dist/qa-report.js:503:20)",
    "    at async tick (file:///x/dist/daemon.js:10:1)",
  ].join("\n");
  assert.equal(callerKey(stack), "github/pr-comments:commentBodies < dist/qa-report:failCount");
  assert.equal(callerKey(undefined), "?");
});

test("configureGhUsage: REST calls are attributed to the code that made them", async () => {
  const lines = [];
  const logger = { debug() {}, warn() {}, error() {}, info: (msg, data) => lines.push(data), child() { return this; } };
  configureGhUsage({ intervalMs: 100, logger });
  (function hotReader() { recordGhCall(["api", "repos/a/b/issues/9/comments"]); })();
  (function prPoller() { recordGhCall(["pr", "view", "5", "--json", "state"]); })();
  await new Promise((r) => setTimeout(r, 150));
  const pr = Object.keys(JSON.parse(lines[0].byCaller)).find((k) => k.startsWith("pr view <- "));
  assert.ok(pr && pr.includes(":prPoller"), "GraphQL subcommands are attributed too: " + pr);
  const byCaller = JSON.parse(lines[0].byCaller);
  const key = Object.keys(byCaller).find((k) => k.startsWith("GET "));
  assert.ok(key.startsWith("GET repos/:repo/issues/:n/comments <- ") && key.includes(":hotReader"), key);
  configureGhUsage({ intervalMs: 3_600_000, logger: { info() {} } });
});
