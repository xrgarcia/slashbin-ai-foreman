// 2026-11-20: an `approved` issue covered by an open Foreman PR with a current CHANGES_REQUESTED review
// was skipped by implement ("all have linked PRs") and never taken by revise (needs `pr pending actions`). Advance it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { githubCodeHost } from "../dist/plugins/github.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { addObserver, drainObservers } from "../dist/work-source.js";
import { PhaseMemory } from "../dist/phase-memory.js";
import { reviseCoveredApproved } from "../dist/phases/implement.js";
import { startAgentPlugins } from "./agent-plugins.mjs";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const dir = mkdtempSync(join(tmpdir(), "foreman-covered-"));
writeFileSync(join(dir, "gh"), `#!/bin/sh\necho '{}'\n`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "test";
await startAgentPlugins();

const events = [];
addObserver({ id: "covered-test", async onEvent(e) { events.push(e); } });
const cfg = { ...loadConfig(), name: "r", githubRepo: "o/r", repoPath: dir, baseBranch: "features", reviewerLogin: "tech-lead" };
const issue = (number, ...labels) => ({ number, labels: labels.map((name) => ({ name })) });

function harness({ issues, requestsChanges = true, pr = { number: 40, headSha: "a".repeat(40), headBranch: "foreman/issue-34", issueNumbers: [34] } }) {
  const base = githubCodeHost();
  setCodeHost({
    ...base,
    findOpenFeaturePR: async () => pr,
    getOpenIssues: async () => issues,
    readPrStanding: async () => ({ requestsChanges, author: "foreman" }),
  });
  events.length = 0;
  const lines = [];
  return { rt: { memory: new PhaseMemory() }, logger: { ...quiet, warn: (m) => lines.push(m) }, lines };
}
const moves = async () => { await drainObservers(); return events.filter((e) => e.kind === "transition"); };

test("approved issue covered by an open Foreman PR with CHANGES_REQUESTED advances to changesRequested, with a log line", async () => {
  const h = harness({ issues: [issue(34, cfg.triggerLabel)] });
  try {
    await reviseCoveredApproved(h.rt, cfg, h.logger);
    const m = await moves();
    assert.deepEqual(m.map((e) => [e.item.issueNumber, e.move]), [[34, "changesRequested"]]);
    assert.match(h.lines[0], /#34 covered by open PR #40.*CHANGES_REQUESTED.*sent to revise/);
  } finally { setCodeHost(null); }
});

test("no current CHANGES_REQUESTED, a lifecycle label, the blocked label, or an unlinked issue: nothing moves", async () => {
  try {
    for (const [name, opts] of [
      ["no verdict", { issues: [issue(34, cfg.triggerLabel)], requestsChanges: false }],
      ["already pending", { issues: [issue(34, cfg.triggerLabel, cfg.lifecycleLabels.prPendingActions)] }],
      ["blocked", { issues: [issue(34, cfg.triggerLabel, cfg.github.blockedLabel)] }],
      ["not linked by the PR", { issues: [issue(35, cfg.triggerLabel)] }],
      ["not approved", { issues: [issue(34)] }],
      ["no open PR", { issues: [issue(34, cfg.triggerLabel)], pr: null }],
    ]) {
      const h = harness(opts);
      await reviseCoveredApproved(h.rt, cfg, h.logger);
      assert.equal((await moves()).length, 0, name);
    }
  } finally { setCodeHost(null); }
});
