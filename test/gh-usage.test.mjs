import { test } from "node:test";
import assert from "node:assert/strict";
import { ghResource, recordGhCall, configureGhUsage } from "../dist/gh-usage.js";

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
  assert.equal(lines[0].bySubcommand["issue list"], 1);
  assert.equal(lines[0].bySubcommand["pr list"], 1);
  assert.equal(lines[1].total, 0);
  configureGhUsage({ intervalMs: 3_600_000, logger: { info() {} } });
});
