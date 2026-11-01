// The core calls one plugin interface, never GitHub or Paperclip (EM#1150;
// EM docs/architecture.md decision 4). The ratchet listed every core file that
// imported plugin code directly; it only ever shrank, and since f5 (GitHub as the
// code-host plugin) it is empty and must stay so. Nor may the core run `gh`.
// The logic is the pure checkBoundary and ghSpawnProblems in
// plugin-boundary-check.mjs, tested below against fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBoundary, connectorProblems, countViolations, ghSpawnProblems, isAgentPlugin, isPlugin, pluginImportsOf } from "./plugin-boundary-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

const KNOWN_VIOLATORS = {};

const importsOf = (file) => [...readFileSync(file, "utf8").matchAll(/^(?:import|export)[^;]*?from "([^"]+)"/gm)].map((m) => m[1]);
const srcFiles = () => readdirSync(src, { recursive: true }).map((n) => String(n).split("\\").join("/")).filter((n) => n.endsWith(".ts"));
/** Every src file mapped to its import specifiers. */
const realImports = () => Object.fromEntries(srcFiles().map((rel) => [rel, importsOf(join(src, rel))]));

if (process.env.PRINT_PLUGIN_VIOLATIONS) console.log(JSON.stringify(countViolations(realImports()), null, 2));

test("core imports no plugin beyond the shrinking allowlist", () => {
  assert.deepEqual(checkBoundary(realImports(), KNOWN_VIOLATORS), []);
});

test("the ratchet is empty: no core file imports plugin code (EM#1150 f5)", () => {
  assert.deepEqual(KNOWN_VIOLATORS, {});
  assert.deepEqual(countViolations(realImports()), {});
});

test("no core file runs gh; only src/github* and the GitHub plugin may (EM#1150 f5)", () => {
  const sources = Object.fromEntries(srcFiles().map((rel) => [rel, readFileSync(join(src, rel), "utf8")]));
  assert.match(sources["github/gh.ts"], /execFileSync\("gh"/, "the walk sees the GitHub code that does run gh");
  assert.deepEqual(ghSpawnProblems(sources), []);
});

test("no core file constructs the GitHub work-source connector (EM#1150 f4)", () => {
  const sources = Object.fromEntries(srcFiles().map((rel) => [rel, readFileSync(join(src, rel), "utf8")]));
  assert.ok(sources["plugins/github.ts"].includes("new GitHubIssueConnector"), "the GitHub plugin is where it is built");
  assert.deepEqual(connectorProblems(sources), []);
});

test("the contract and the registry import no plugin", () => {
  for (const f of ["plugins/contract.ts", "plugins/registry.ts"]) {
    assert.deepEqual(pluginImportsOf(f, importsOf(join(src, f))), [], `src/${f} must stay plugin-free`);
  }
});

test("the walk sees the core and the plugin code it judges", () => {
  const files = readdirSync(src, { recursive: true }).map((n) => String(n).split("\\").join("/"));
  assert.ok(files.includes("orchestrator.ts") && files.includes("phases/review.ts"), "core reached");
  assert.ok(files.some((f) => f.startsWith("github/")) && files.includes("plugins/paperclip.ts"), "plugins reached");
});

// The ratchet itself, against fixtures: each fails if checkBoundary stops catching it.
test("ratchet: a new unlisted core file importing ./github.js fails", () => {
  const problems = checkBoundary({ "fresh.ts": ["./github.js"] }, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/fresh\.ts imports plugin code directly/);
});

test("ratchet: a listed file whose count grows fails", () => {
  const problems = checkBoundary({ "agent.ts": ["./github.js", "./github-state.js", "./paperclip/client.js"] }, { "agent.ts": 2 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /grew 2 -> 3/);
});

test("ratchet: a listed file whose count drops without the allowlist being lowered fails", () => {
  const problems = checkBoundary({ "agent.ts": ["./github.js"] }, { "agent.ts": 2 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /down to 1 plugin imports from 2/);
  assert.match(checkBoundary({ "agent.ts": ["./logger.js"] }, { "agent.ts": 1 })[0], /delete the line/);
});

test("ratchet: a listed file at exactly its count passes", () => {
  assert.deepEqual(checkBoundary({ "agent.ts": ["./github.js", "./config.js"] }, { "agent.ts": 1 }), []);
});

test("ratchet: core importing plugins/registry.js or plugins/contract.js is allowed", () => {
  assert.deepEqual(checkBoundary({ "orchestrator.ts": ["./plugins/registry.js", "./plugins/contract.js"], "phases/review.ts": ["../plugins/registry.js"] }, {}), []);
});

test("ratchet: core importing plugins/paperclip.js fails; plugins/index.ts may", () => {
  const problems = checkBoundary({ "orchestrator.ts": ["./plugins/paperclip.js"] }, {});
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /src\/orchestrator\.ts imports plugin code directly/.test(p)), problems.join("\n"));
  assert.deepEqual(checkBoundary({ "plugins/index.ts": ["./paperclip.js"] }, {}), []);
  assert.ok(isPlugin("plugins/paperclip.ts") && !isPlugin("plugins/registry.ts"));
});

test("ratchet forbids core importing an agent plugin, even a file the allowlist covers", () => {
  for (const agent of ["tech-lead", "sre", "qa", "em", "agent-cli"]) {
    assert.ok(isAgentPlugin(`plugins/${agent}.ts`), agent);
    const problems = checkBoundary({ "phases/review.ts": [`../plugins/${agent}.js`] }, { "phases/review.ts": 1 });
    assert.equal(problems.length, 1, agent);
    assert.match(problems[0], new RegExp(`src/phases/review\\.ts imports the plugin src/plugins/${agent}\\.ts directly`));
  }
  // The plugins themselves, and the composition root, may.
  assert.deepEqual(checkBoundary({ "plugins/index.ts": ["./tech-lead.js"], "plugins/sre.ts": ["./agent-cli.js"] }, {}), []);
  assert.ok(!isAgentPlugin("plugins/registry.ts") && !isAgentPlugin("plugins/contract.ts"));
});

test("ratchet forbids constructing GitHubIssueConnector in core; the GitHub plugin and src/github* may", () => {
  for (const rel of ["work-source.ts", "phases/implement.ts", "phases/review.ts", "plugins/paperclip.ts"]) {
    const problems = connectorProblems({ [rel]: "const s = new GitHubIssueConnector();" });
    assert.equal(problems.length, 1, rel);
    assert.match(problems[0], new RegExp(`src/${rel.replace(".", "\\.")} constructs GitHubIssueConnector`));
  }
  assert.match(connectorProblems({ "orchestrator.ts": 'import { GitHubIssueConnector } from "./github-work-source.js";' })[0], /imports GitHubIssueConnector/);
  assert.deepEqual(connectorProblems({
    "plugins/github.ts": "readonly workSource = new GitHubIssueConnector();",
    "github-work-source.ts": "new GitHubIssueConnector()",
    "github/x.ts": "new GitHubIssueConnector()",
    "adapters.ts": "// (`GitHubIssueConnector` in github-work-source.ts)\n/* new GitHubIssueConnector() */",
    "index.ts": 'export { GitHubIssueConnector } from "./github-work-source.js";',
  }), []);
});

test("ratchet: core importing src/github* fails against the empty list, in any form", () => {
  for (const [rel, spec] of [["orchestrator.ts", "./github.js"], ["phases/review.ts", "../github/pr.js"], ["daemon.ts", "./github-state.js"], ["work-source.ts", "./github-work-source.js"]]) {
    const problems = checkBoundary({ [rel]: [spec] }, KNOWN_VIOLATORS);
    assert.equal(problems.length, 1, `${rel} -> ${spec}`);
    assert.match(problems[0], /imports plugin code directly/);
  }
  // The code-host interface and the config schema are core: importing them is fine.
  assert.deepEqual(checkBoundary({ "phases/review.ts": ["../code-host.js", "../config-schema/github.js"] }, KNOWN_VIOLATORS), []);
});

test("ratchet: core spawning gh fails, whichever child_process call; src/github* and the GitHub plugin may", () => {
  const spawns = ['execFileSync("gh", ["pr", "list"])', "spawnSync('gh', args)", "spawn(`gh`, [])", 'execFile("gh", a, cb)', 'execSync("gh api user")', 'exec("gh pr view")', 'execFileAsync("gh", args)'];
  for (const call of spawns) {
    for (const rel of ["agent.ts", "phases/release.ts", "upstream-backoff.ts", "plugins/paperclip.ts", "paperclip/client.ts"]) {
      const problems = ghSpawnProblems({ [rel]: `const out = ${call};` });
      assert.equal(problems.length, 1, `${rel}: ${call}`);
      assert.match(problems[0], new RegExp(`src/${rel.replace(/\./g, "\\.")} runs gh directly`));
    }
    for (const rel of ["github/gh.ts", "github.ts", "github-state.ts", "github/core-reads.ts", "plugins/github.ts"]) {
      assert.deepEqual(ghSpawnProblems({ [rel]: call }), [], `${rel} may: ${call}`);
    }
  }
  // Comments, git and other commands are not gh.
  assert.deepEqual(ghSpawnProblems({
    "agent.ts": '// execFileSync("gh", [])\n/* spawnSync("gh") */\nspawnSync("git", ["log"]); execFileSync("ghost"); spawn("claude", []);',
  }), []);
});
