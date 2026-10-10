// The lifecycle (src/lifecycle.ts) is the one state machine the Foreman runs.
// These tests hold it to three promises:
//   1. the table is whole: every move resolves, lands on a real stage, and the
//      GitHub connector has a label write for it;
//   2. a move writes exactly the GitHub labels it wrote before the machine
//      existed — LABELS below was captured from the pre-refactor build
//      (2026-10-10) and matched byte-for-byte, for each move from two
//      starting label sets;
//   3. docs/lifecycle.md is what the generator writes from the tables.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MOVES, STAGES, STATE_STAGE, SESSION_STAGE, SESSION_FALLBACK_STAGE, transition, reviewMove } from "../dist/lifecycle.js";
import { GitHubIssueConnector } from "../dist/github-work-source.js";
import { configureIssueCache } from "../dist/github.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/logger.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- 1. The table is whole -----------------------------------------------------

test("every move resolves to a transition that lands on a known stage", () => {
  for (const move of Object.keys(MOVES)) {
    const t = transition(move);
    assert.equal(t.move, move);
    assert.equal(t.to, MOVES[move].to);
    assert.ok(STAGES.includes(t.stage), `${move} lands on ${t.stage}`);
    assert.equal(t.stage, STATE_STAGE[t.to]);
    assert.ok(MOVES[move].why.length > 0, `${move} says why`);
  }
});

test("a move outside the table throws instead of doing nothing", () => {
  assert.throws(() => transition("teleport"), /no move "teleport"/);
});

test("review outcomes map to their moves", () => {
  assert.equal(reviewMove("approved"), "reviewApproved");
  assert.equal(reviewMove("merged"), "reviewMerged");
  assert.equal(reviewMove("changesRequested"), "changesRequested");
});

test("every session phase holds a stage and falls back to one", () => {
  assert.deepEqual(Object.keys(SESSION_STAGE).sort(), Object.keys(SESSION_FALLBACK_STAGE).sort());
  for (const s of [...Object.values(SESSION_STAGE), ...Object.values(SESSION_FALLBACK_STAGE)]) assert.ok(STAGES.includes(s), s);
});

test("the GitHub connector records every move (and only transitions)", async () => {
  // The 26 rows below cover all of MOVES; a move added to the table without a
  // row here (and a label write in github-work-source.ts) fails this.
  assert.deepEqual([...new Set(LABELS.map(([m]) => m))].sort(), Object.keys(MOVES).sort());
  const c = new GitHubIssueConnector();
  assert.equal(await c.record({ kind: "claim", item: { issueNumber: 1, repo: "x/y" } }, cfg, logger), false);
});

// --- 2. Each move writes the labels it always wrote -----------------------------

// [move, the issue's lifecycle label beside "approved", record() result, the edit flags (null: no edit)]
const LABELS = [
  ["queue", "pr under review", false, null],
  ["queue", "pr merged", false, null],
  ["implemented", "pr under review", true, ["--add-label", "pr under review"]],
  ["implemented", "pr merged", true, ["--add-label", "pr under review"]],
  ["alreadyApproved", "pr under review", true, ["--remove-label", "approved", "--add-label", "pr approved"]],
  ["alreadyApproved", "pr merged", true, ["--remove-label", "approved", "--add-label", "pr approved"]],
  ["alreadyMerged", "pr under review", true, ["--remove-label", "approved", "--add-label", "pr merged"]],
  ["alreadyMerged", "pr merged", true, ["--remove-label", "approved", "--add-label", "pr merged"]],
  ["reviewApproved", "pr under review", true, ["--remove-label", "pr under review", "--add-label", "pr approved"]],
  ["reviewApproved", "pr merged", true, ["--remove-label", "pr under review", "--add-label", "pr approved"]],
  ["reviewMerged", "pr under review", true, ["--remove-label", "pr under review", "--add-label", "pr merged"]],
  ["reviewMerged", "pr merged", true, ["--remove-label", "pr under review", "--add-label", "pr merged"]],
  ["changesRequested", "pr under review", true, ["--remove-label", "pr under review", "--add-label", "pr pending actions"]],
  ["changesRequested", "pr merged", true, ["--remove-label", "pr under review", "--add-label", "pr pending actions"]],
  ["revised", "pr under review", true, ["--remove-label", "pr pending actions", "--add-label", "pr under review"]],
  ["revised", "pr merged", true, ["--remove-label", "pr pending actions", "--add-label", "pr under review"]],
  ["verifyPassed", "pr under review", true, ["--remove-label", "pr merged", "--add-label", "pr approved"]],
  ["verifyPassed", "pr merged", true, ["--remove-label", "pr merged", "--add-label", "pr approved"]],
  ["recoverPassed", "pr under review", true, ["--remove-label", "pr under review", "--add-label", "pr approved"]],
  ["recoverPassed", "pr merged", true, ["--add-label", "pr approved"]],
  ["recoverFailed", "pr under review", true, ["--remove-label", "pr under review", "--add-label", "pr pending actions"]],
  ["recoverFailed", "pr merged", true, ["--add-label", "pr pending actions"]],
  ["recoverMerged", "pr under review", true, ["--remove-label", "pr under review", "--add-label", "pr merged"]],
  // Was a flagless edit (GitHub rejects it: false); fixed 2026-10-10 to make no call.
  ["recoverMerged", "pr merged", false, null],
  ["release", "pr under review", true, ["--remove-label", "pr under review"]],
  ["release", "pr merged", false, null],
];

const tmp = mkdtempSync(join(tmpdir(), "foreman-lifecycle-test-"));
const bin = join(tmp, "bin");
mkdirSync(bin);
const GH_LOG = join(tmp, "gh.log");
const GH_ISSUES = join(tmp, "issues.json");
writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + "\\n");
if (args[0] === "issue" && args[1] === "list") { process.stdout.write(fs.readFileSync(${JSON.stringify(GH_ISSUES)}, "utf8")); process.exit(0); }
process.stdout.write("[]");
`);
chmodSync(join(bin, "gh"), 0o755);
const saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN, EM_GITHUB_TOKEN: process.env.EM_GITHUB_TOKEN };
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
process.env.EM_GITHUB_TOKEN = "test-fake";
configureIssueCache({ ttlMs: 0 });
test.after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const logger = createLogger({ format: "text", level: "error" });
const cfgPath = join(tmp, "cfg.json");
writeFileSync(cfgPath, JSON.stringify({ emRepoPath: tmp, repos: [{ name: "lifecycle", repoPath: tmp, githubRepo: "example/a" }] }));
const cfg = loadConfig(cfgPath).repos[0];

for (const [move, at, ret, flags] of LABELS) {
  test(`${move} from "${at}": ${flags ? flags.join(" ") || "(flagless edit)" : "no edit"}`, async () => {
    writeFileSync(GH_LOG, "");
    writeFileSync(GH_ISSUES, JSON.stringify([{ number: 9, title: "t", labels: [{ name: "approved" }, { name: at }] }]));
    const item = { issueNumber: 9, repo: "example/a" };
    assert.equal(await new GitHubIssueConnector().record({ kind: "transition", item, observed: false, ...transition(move) }, cfg, logger), ret);
    const edits = readFileSync(GH_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((a) => a[0] === "issue" && a[1] === "edit");
    if (flags === null) assert.equal(edits.length, 0);
    else assert.deepEqual(edits, [["issue", "edit", "9", "--repo", "example/a", ...flags]]);
  });
}

// --- 3. The doc is the table ----------------------------------------------------

test("docs/lifecycle.md matches what the generator writes", () => {
  const r = spawnSync(process.execPath, [join(root, "scripts", "docs", "generate-lifecycle.mjs"), "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

// --- 4. The boundary holds ------------------------------------------------------

test("core never imports the Paperclip plugin, and the plugin never imports the GitHub source", async () => {
  const { readdirSync } = await import("node:fs");
  const importsOf = (f) => [...readFileSync(f, "utf8").matchAll(/^(?:import|export)[^;]*?from "([^"]+)"/gm)].map((m) => m[1]);
  for (const f of readdirSync(join(root, "src")).filter((n) => n.endsWith(".ts") && n !== "cli.ts")) {
    const bad = importsOf(join(root, "src", f)).filter((p) => p.startsWith("./paperclip/"));
    assert.deepEqual(bad, [], `src/${f} imports the plugin; only cli.ts wires it in`);
  }
  for (const f of readdirSync(join(root, "src", "paperclip")).filter((n) => n.endsWith(".ts"))) {
    const bad = importsOf(join(root, "src", "paperclip", f)).filter((p) => /^\.\.\/(github|orchestrator|state)/.test(p));
    assert.deepEqual(bad, [], `src/paperclip/${f} reaches into the work source or orchestrator`);
  }
});
