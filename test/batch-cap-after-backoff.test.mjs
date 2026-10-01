// slashbin-ai-foreman#49: the batch cap ran inside findActionableIssues, before
// the orchestrator's skip back-off filter. Three backed-off issues took every
// slot, the filter emptied the batch, and eligible approved issues starved for
// the whole back-off window (Slashbin-console #1162/#1161/#1154, 2026-10-01).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const orch = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");

test("the implement gate discovers uncapped and caps after the back-off filter", () => {
  const discover = orch.indexOf("findActionableIssues(repoConfig, repoLogger, { uncapped: true })");
  const backoff = orch.indexOf("Backing off ${stillBackedOff.length}");
  const cap = orch.indexOf("actionableIssues = capBatch(actionableIssues, repoConfig, repoLogger)");
  assert.ok(discover > 0, "the implement gate must ask for the uncapped list");
  assert.ok(backoff > discover, "back-off filter must follow discovery");
  assert.ok(cap > backoff, "the cap must be applied after the back-off filter, never before it");
});

test("capBatch keeps the first N in order", async () => {
  const { capBatch } = await import("../dist/github.js");
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  // The greenfield probe throws here (no FOREMAN_GITHUB_TOKEN under test, and no
  // repo at this path), which keeps the default size of 3.
  const batch = capBatch([1162, 1168, 1154, 1107], { repoPath: "/nonexistent", githubRepo: "x/y" }, logger);
  assert.deepEqual(batch, [1162, 1168, 1154]);
});
