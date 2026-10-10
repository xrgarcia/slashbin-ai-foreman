// The implement stage selects work through the work source and hands it to the
// session. Two lists come out of one offer, and which caller gets which is the
// point of these tests:
//   - a skill is handed EVERY offered item (uncapped): it picks by priority, and
//     before the hand-off existed it ran its own query across all of them. A cap
//     would hide an S1 behind three older issues.
//   - the inline prompt keeps the Foreman's own capped, ascending batch.
//
// Drives the BUILT runRepoPass with a fake `gh` and a fake `claude` first on
// PATH. Nothing reaches GitHub or Anthropic, and no token is real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { runRepoPass } from "../dist/orchestrator.js";
import { configureIssueCache, discoveryBatch } from "../dist/github.js";
import { GitHubIssueConnector } from "../dist/github-work-source.js";
import { setStatePath } from "../dist/state.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
let tmp, F, saved;

// Five actionable issues; the highest-numbered one is the S1. gh lists newest first.
const BOARD = [
  { number: 5, title: "prod is down", labels: [{ name: "approved" }, { name: "S1" }] },
  { number: 4, title: "four", labels: [{ name: "approved" }] },
  { number: 3, title: "three", labels: [{ name: "approved" }] },
  { number: 2, title: "two", labels: [{ name: "approved" }] },
  { number: 1, title: "one", labels: [{ name: "approved" }] },
];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-work-source-test-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  F = { claudeLog: join(tmp, "claude.log") };
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") process.stdout.write(${JSON.stringify(JSON.stringify(BOARD))});
else if (args[0] === "ls-files") process.stdout.write(Array.from({ length: 40 }, (_, i) => "f" + i).join("\\n"));
else process.stdout.write("[]");
`);
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(F.claudeLog)}, JSON.stringify({ prompt: process.argv[3] }) + "\\n");
process.stdout.write("done\\n");
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
  process.chdir(tmp);
  setStatePath(tmp);
  configureIssueCache({ ttlMs: 0 });
});

after(() => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.FOREMAN_GITHUB_TOKEN === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.FOREMAN_GITHUB_TOKEN;
  rmSync(tmp, { recursive: true, force: true });
});

function load(repo) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    stages: [{ type: "implement" }],
    repos: [{ name: `ws-${Math.random().toString(36).slice(2)}`, repoPath: tmp, githubRepo: "example/repo", ...repo }],
  }));
  return loadConfig(p);
}

async function implementPrompt(repo) {
  rmSync(F.claudeLog, { force: true });
  const config = load(repo);
  await runRepoPass(config.repos[0], config, logger);
  assert.ok(existsSync(F.claudeLog), "claude was never launched");
  return JSON.parse(readFileSync(F.claudeLog, "utf8").trim().split("\n")[0]).prompt;
}

test("the GitHub connector offers every eligible issue, uncapped, in gh order", async () => {
  const config = load({});
  const items = await new GitHubIssueConnector().selectWork(config.repos[0], config, logger);
  assert.deepEqual(items.map((w) => w.issueNumber), [5, 4, 3, 2, 1]);
  assert.deepEqual(discoveryBatch(config.repos[0], [5, 4, 3, 2, 1], logger), [1, 2, 3],
    "the Foreman's own batch stays ascending and capped at 3");
});

for (const skillPath of [".claude/skills/implement-approved-issues/SKILL.md", "builtin:"]) {
  test(`${skillPath}: the S1 numbered after three older issues is handed to the skill`, async () => {
    const prompt = await implementPrompt({ skillPath });
    assert.ok(prompt.includes("Implement exactly these work items, and no others: #5, #4, #3, #2, #1."),
      `the skill-mode prompt must name all five offered items:\n${prompt.slice(0, 600)}`);
  });
}

test("inline mode keeps the Foreman's capped, ascending batch", async () => {
  const prompt = await implementPrompt({});
  assert.ok(prompt.startsWith("Implement ONLY these issues: #1, #2, #3."), prompt.slice(0, 200));
});
