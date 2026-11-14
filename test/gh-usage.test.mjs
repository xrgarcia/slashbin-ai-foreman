import { test } from "node:test";
import assert from "node:assert/strict";
import { ghResource, recordGhCall, configureGhUsage, restEndpointKey } from "../dist/gh-usage.js";

test("ghResource: api is core unless graphql; every other subcommand is graphql", () => {
  assert.equal(ghResource(["issue", "list"]), "graphql");
  assert.equal(ghResource(["pr", "view", "1"]), "graphql");
  assert.equal(ghResource(["api", "repos/a/b/compare/x...y"]), "core");
  assert.equal(ghResource(["api", "graphql", "-f", "query={}"]), "graphql");
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
  assert.equal(restEndpointKey(["api", "repos/xrgarcia/foo/issues/123/comments", "--paginate"]), "GET repos/:repo/issues/:n/comments");
  assert.equal(restEndpointKey(["api", "/repos/a/b/compare/main...develop"]), "GET repos/:repo/compare/:range");
  assert.equal(restEndpointKey(["api", "-X", "POST", "repos/a/b/issues/7/labels", "-f", "labels[]=x"]), "POST repos/:repo/issues/:n/labels");
  assert.equal(restEndpointKey(["api", "--jq", ".[0]", "repos/a/b/deployments?sha=abc"]), "GET repos/:repo/deployments");
  assert.equal(restEndpointKey(["api", "repos/a/b/branches/feature/x/protection"]), "GET repos/:repo/branches/:ref");
  assert.equal(restEndpointKey(["api", "repos/a/b/commits/" + "a".repeat(40) + "/status"]), "GET repos/:repo/commits/:sha/status");
});
