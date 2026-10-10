// `npm run doctor` says whether the Foreman can run: PASS on a ready install, a
// FAIL naming the fix for each missing piece, exit 1 on any FAIL — and it only
// ever reads, and never prints a token. The daemon refuses to start with no
// config rather than work on its own checkout.
//
// Runs scripts/doctor.mjs as a child process with a fake `gh` and `claude` first
// on PATH; the fake gh serves each repo's permissions, branches and labels from a
// state file and records every call. Nothing reaches GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findConfigFile } from "../dist/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCTOR = join(root, "scripts", "doctor.mjs");
const LABELS = ["approved", "pr under review", "pr pending actions", "pr merged", "pr approved", "ready for prod release", "ready to close", "blocked"];
const TOKEN = "ghp_doctor_test_value_never_printed";

const tmp = mkdtempSync(join(tmpdir(), "foreman-doctor-test-"));
const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + "\\n");
if (a[0] === "--version") { console.log("gh version 2.0.0"); process.exit(0); }
if (a[0] === "auth" && a[1] === "status") process.exit(0);
const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const m = a[0] === "api" && (a[1] || "").match(/^repos\\/([^/]+\\/[^/]+)(?:\\/(labels|branches\\/(.+)))?$/);
const repo = m && st[m[1]];
if (!repo) { process.stderr.write("HTTP 404: Not Found"); process.exit(1); }
if (!m[2]) { console.log(JSON.stringify({ permissions: { push: repo.push } })); process.exit(0); }
if (m[2] === "labels") { console.log(repo.labels.join("\\n")); process.exit(0); }
if (repo.branches.includes(decodeURIComponent(m[3]))) { console.log("{}"); process.exit(0); }
process.stderr.write("HTTP 404: Branch not found"); process.exit(1);
`);
writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '1.0.0 (Claude Code)'\n");
chmodSync(join(bin, "gh"), 0o755);
chmodSync(join(bin, "claude"), 0o755);

let n = 0;
function arrange(cfg, state) {
  const dir = join(tmp, `case${++n}`);
  const checkout = join(dir, "checkout");
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "-q", checkout]);
  const cfgPath = join(dir, ".ai-agent.json");
  if (cfg) writeFileSync(cfgPath, JSON.stringify({ ...cfg, repos: cfg.repos.map((r) => ({ repoPath: checkout, ...r })) }));
  const stateFile = join(dir, "state.json");
  const logFile = join(dir, "gh.log");
  writeFileSync(stateFile, JSON.stringify(state ?? {}));
  writeFileSync(logFile, "");
  return (extraEnv = {}) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile, ...extraEnv };
    for (const k of Object.keys(env)) if (k.startsWith("AI_AGENT_")) delete env[k];
    for (const k of ["FOREMAN_GITHUB_TOKEN", "TECHLEAD_GITHUB_KEY", "SRE_GITHUB_KEY"]) if (!(k in extraEnv)) delete env[k];
    const r = spawnSync(process.execPath, [DOCTOR, cfgPath], { cwd: dir, env, encoding: "utf8" });
    const calls = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { status: r.status, out: r.stdout + r.stderr, calls };
  };
}
const ready = () => ({ push: true, branches: ["features", "develop", "main"], labels: [...LABELS, "bug"] });

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("a ready install passes every check, exits 0, and never prints the token", () => {
  const run = arrange({ repos: [{ name: "a", githubRepo: "acme/a", skillPath: "builtin:", revisionSkillPath: "builtin:" }] }, { "acme/a": ready() });
  const r = run({ FOREMAN_GITHUB_TOKEN: TOKEN, TECHLEAD_GITHUB_KEY: TOKEN });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /^(FAIL|WARN)/m, r.out);
  for (const check of ["node", "claude", "gh", "config", "FOREMAN_GITHUB_TOKEN", "a: checkout", "a: github", "a: branches", "a: skillPath", "a: labels"]) {
    assert.match(r.out, new RegExp(`^PASS  ${check} — `, "m"), `${check}\n${r.out}`);
  }
  assert.match(r.out, /Ready\. Start it with `npm start`/);
  assert.ok(!r.out.includes(TOKEN), "token value printed");
});

test("only reads: every gh call is a GET, --version or auth status", () => {
  const run = arrange({ repos: [{ name: "a", githubRepo: "acme/a" }] }, { "acme/a": ready() });
  const r = run();
  assert.ok(r.calls.length > 0);
  for (const a of r.calls) {
    assert.ok(a[0] === "--version" || (a[0] === "auth" && a[1] === "status") || (a[0] === "api" && !a.includes("-X") && !a.includes("--method") && !a.some((x) => /^-[fF]$/.test(x))), JSON.stringify(a));
  }
});

test("each missing piece is a FAIL that names its fix; the run exits 1", () => {
  const run = arrange(
    { repos: [{ name: "a", githubRepo: "acme/a", skillPath: ".claude/skills/none/SKILL.md" }, { name: "b", githubRepo: "acme/b", repoPath: join(tmp, "nowhere") }] },
    { "acme/a": { push: false, branches: ["develop", "main"], labels: ["approved"] } },
  );
  const r = run({ FOREMAN_GITHUB_TOKEN: TOKEN });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL  a: github — .*cannot push/m);
  assert.match(r.out, /^FAIL  a: branches — missing on GitHub: feature "features"/m);
  assert.match(r.out, /^FAIL  a: skillPath — .*Use "builtin:"/m);
  assert.match(r.out, /^WARN  a: revisionSkillPath — unset/m);
  assert.match(r.out, /^FAIL  a: labels — missing "pr under review".*npm run labels:install/m);
  assert.match(r.out, /^FAIL  b: checkout — .*does not exist/m);
  assert.match(r.out, /^FAIL  b: github — acme\/b is not readable/m);
  assert.match(r.out, /check\(s\) failed — the Foreman is not ready/);
});

test("renamed labels are the ones checked", () => {
  const labels = ["go", "pr under review", "pr pending actions", "pr merged", "pr approved", "ready for prod release", "ready to close", "on hold"];
  const cfg = { triggerLabel: "go", github: { blockedLabel: "on hold" }, repos: [{ name: "a", githubRepo: "acme/a", skillPath: "builtin:", revisionSkillPath: "builtin:" }] };
  assert.equal(arrange(cfg, { "acme/a": { ...ready(), labels } })().status, 0);
  assert.match(arrange(cfg, { "acme/a": ready() })().out, /^FAIL  a: labels — missing "go", "on hold"/m);
});

test("tokens: review without the reviewer's token fails; an SRE path needs its token", () => {
  const cfg = { reviewEnabled: true, techLeadPath: tmp, srePath: tmp, repos: [{ name: "a", githubRepo: "acme/a" }] };
  const r = arrange(cfg, { "acme/a": ready() })({ FOREMAN_GITHUB_TOKEN: TOKEN });
  assert.equal(r.status, 1);
  assert.match(r.out, /^FAIL  TECHLEAD_GITHUB_KEY — unset, and review is enabled/m);
  assert.match(r.out, /^FAIL  SRE_GITHUB_KEY — unset, and srePath is set/m);
  const w = arrange({ repos: [{ name: "a", githubRepo: "acme/a" }] }, { "acme/a": ready() })();
  assert.match(w.out, /^WARN  FOREMAN_GITHUB_TOKEN — unset/m);
  assert.match(w.out, /^WARN  TECHLEAD_GITHUB_KEY — unset — branch-sync PRs/m);
});

test("no config: one FAIL that says how to create it, and nothing else is tried", () => {
  const r = arrange(null)();
  assert.equal(r.status, 1);
  assert.match(r.out, /^FAIL  config — .*not found\. Create it first: docs\/setup\.md/m);
  assert.equal(r.calls.filter((a) => a[0] === "api").length, 0);
});

test("a config that does not load is a FAIL with the loader's reason", () => {
  const r = arrange({ reviewEnabled: true, repos: [{ name: "a", githubRepo: "acme/a" }] })();
  assert.equal(r.status, 1);
  assert.match(r.out, /^FAIL  config — .*does not load: .*techLeadPath/m);
});

test("findConfigFile: the named path, else .ai-agent.json, else ai-agent.config.json", () => {
  const dir = mkdtempSync(join(tmp, "find-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(findConfigFile(), undefined);
    writeFileSync(join(dir, "ai-agent.config.json"), "{}");
    assert.equal(findConfigFile(), join(dir, "ai-agent.config.json"));
    writeFileSync(join(dir, ".ai-agent.json"), "{}");
    assert.equal(findConfigFile(), join(dir, ".ai-agent.json"));
    assert.equal(findConfigFile("other.json"), undefined, "a named path that is missing is not replaced by a default");
  } finally {
    process.chdir(cwd);
  }
});

test("the daemon refuses to start with no config instead of working on its own checkout", () => {
  const dir = mkdtempSync(join(tmp, "nocfg-"));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AI_AGENT_")) delete env[k];
  const r = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "--once"], { cwd: dir, env, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no \.ai-agent\.json .* AI_AGENT_REPO_PATH is unset/s);
  assert.match(r.stderr, /docs\/setup\.md/);
});
