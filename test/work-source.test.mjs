// The implement stage selects work through the work source and decides the
// build before the session: priority tier first, then oldest, `buildBatchSize`
// of them (default 1). The session is handed exactly that batch and only it is
// claimed; the rest stay queued (todo), never claimed, never Blocked. An open
// feature PR holds the branch: the pick waits as queued and is built the pass
// after the PR leaves (jerky_service #131-#133, 2026-10-14).
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
import { addObserver, drainObservers } from "../dist/work-source.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
let tmp, F, saved;
// Every event the implement stage emits, for the claim/queue/blocked assertions.
const events = [];
addObserver({ onEvent: (e) => { events.push(e); } });

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
  // The fakes are CommonJS: pin it, so a stray "type": "module" package.json above the temp dir cannot make them ESM.
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  F = { claudeLog: join(tmp, "claude.log") };
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") process.stdout.write(${JSON.stringify(JSON.stringify(BOARD))});
else if (args[0] === "pr" && args[1] === "list" && args.includes("--head") && process.env.FAKE_FEATURE_PR) process.stdout.write(process.env.FAKE_FEATURE_PR);
else if (args[0] === "api" && args[1] === "repos/example/ordered/issues/3/dependencies/blocked_by") process.stdout.write(JSON.stringify([{ number: 2, state: "open", labels: [{ name: "approved" }] }]));
else if (args[0] === "api" && /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+$/.test(args[1])) { process.stdout.write("## Acceptance\\n- **Script:** scripts/x/x-acceptance.mjs"); }
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

function load(repo, top = {}) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    ...top,
    stages: [{ type: "implement" }],
    repos: [{ name: `ws-${Math.random().toString(36).slice(2)}`, repoPath: tmp, githubRepo: "example/repo", ...repo }],
  }));
  return loadConfig(p);
}

// One pass of the repo; the prompt the session got (null: no session) and the events.
async function pass(config) {
  rmSync(F.claudeLog, { force: true });
  events.length = 0;
  await runRepoPass(config.repos[0], config, logger);
  await drainObservers();
  const prompt = existsSync(F.claudeLog) ? JSON.parse(readFileSync(F.claudeLog, "utf8").trim().split("\n")[0]).prompt : null;
  return { prompt, events: [...events] };
}

async function implementPrompt(repo, top = {}) {
  const { prompt } = await pass(load(repo, top));
  assert.ok(prompt !== null, "claude was never launched");
  return prompt;
}

const numbersOf = (kind, evs) => evs.filter((e) => e.kind === kind && e.item).map((e) => e.item.issueNumber);

test("the GitHub connector offers every eligible issue, uncapped, in gh order", async () => {
  const config = load({});
  const items = await new GitHubIssueConnector().selectWork(config.repos[0], config, logger);
  assert.deepEqual(items.map((w) => w.issueNumber), [5, 4, 3, 2, 1]);
  assert.deepEqual(discoveryBatch(config.repos[0], [5, 4, 3, 2, 1], logger), [1, 2, 3],
    "unranked, the batch is oldest first, capped at the size asked for");
});

test("an issue whose GitHub blocker has not merged is not offered (jerky_service #108 → #109)", async () => {
  const config = load({ githubRepo: "example/ordered" });
  const items = await new GitHubIssueConnector().selectWork(config.repos[0], config, logger);
  assert.deepEqual(items.map((w) => w.issueNumber), [5, 4, 2, 1], "#3 is blocked by #2, still only approved");
});

for (const skillPath of [".claude/skills/implement-approved-issues/SKILL.md", "builtin:"]) {
  test(`${skillPath}: 5 approved → the S1 alone is handed, claimed and built; 4 stay queued`, async () => {
    const { prompt, events: evs } = await pass(load({ skillPath }));
    assert.ok(prompt?.includes("Implement exactly these work items, and no others: #5."),
      `the session is handed the one issue it builds:\n${prompt?.slice(0, 600)}`);
    assert.deepEqual(numbersOf("claim", evs), [5], "only the issue being built is claimed");
    // The fake session opens no PR, so the built issue may end Blocked as a failure; the queued never do.
    assert.deepEqual(numbersOf("blocked", evs).filter((n) => n !== 5), [], "the queued issues are never Blocked");
  });
}

test("4 approved → 1 claimed + 3 left todo: the highest tier, else the oldest", async () => {
  const { prompt, events: evs } = await pass(load({ skillPath: "builtin:", githubRepo: "example/ordered" }));
  // example/ordered offers 5, 4, 2, 1 (#3 waits on its blocker); #5 is the S1.
  assert.ok(prompt?.includes("no others: #5."), prompt?.slice(0, 300));
  assert.deepEqual(numbersOf("claim", evs), [5]);
  const unranked = discoveryBatch(load({}).repos[0], [4, 2, 1, 7], logger, 1, () => []);
  assert.deepEqual(unranked, [1], "with no priority labels, the oldest is built");
  const ranked = discoveryBatch(load({}).repos[0], [4, 2, 1, 7], logger, 1, (n) => (n === 7 ? ["bug"] : []));
  assert.deepEqual(ranked, [7], "a higher tier goes before an older issue");
});

test("buildBatchSize is configurable: 3 hands and claims three, in priority order", async () => {
  const { prompt, events: evs } = await pass(load({ skillPath: "builtin:" }, { buildBatchSize: 3 }));
  assert.ok(prompt?.includes("no others: #5, #1, #2."), prompt?.slice(0, 300));
  assert.deepEqual(numbersOf("claim", evs), [5, 1, 2]);
});

test("branch occupied by an open feature PR → the pick is queued (todo), not blocked; built the pass after the PR leaves", async () => {
  const config = load({ skillPath: "builtin:" });
  process.env.FAKE_FEATURE_PR = JSON.stringify([{ number: 9, title: "feat: other (#8)", body: "", commits: [], headRefOid: "abc" }]);
  try {
    const held = await pass(config);
    assert.equal(held.prompt, null, "no session while the PR holds the branch");
    assert.deepEqual(numbersOf("claim", held.events), [], "nothing claimed");
    assert.deepEqual(numbersOf("blocked", held.events), [], "nothing Blocked");
    const queued = held.events.filter((e) => e.kind === "transition" && e.to === "queued").map((e) => e.item.issueNumber);
    assert.deepEqual(queued, [5], "the one it will build next shows as queued, once");
    const again = await pass(config);
    assert.equal(again.events.filter((e) => e.kind === "transition").length, 0, "no note per cycle while it waits");
  } finally {
    delete process.env.FAKE_FEATURE_PR;
  }
  const next = await pass(config);
  assert.ok(next.prompt?.includes("no others: #5."), "built the pass after the PR merged or closed");
  assert.deepEqual(numbersOf("claim", next.events), [5]);
});

test("inline mode builds the same one-issue batch", async () => {
  const prompt = await implementPrompt({});
  assert.ok(prompt.startsWith("Implement ONLY these issues: #5."), prompt.slice(0, 200));
});
