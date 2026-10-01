// `npm run labels:install` creates exactly the configured labels a repo is
// missing — trigger plus the five lifecycle names, as loadConfig resolves them —
// never touches an existing one, and keeps going past a repo that fails.
//
// Runs scripts/install-labels.mjs as a child process with a fake `gh` first on
// PATH: it serves a label list per repo (as paginated, back-to-back pages),
// records every call, and appends POSTed names. Nothing reaches GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "install-labels.mjs");
const DEFAULTS = ["approved", "pr under review", "pr pending actions", "pr approved", "ready for prod release", "ready to close"];

const tmp = mkdtempSync(join(tmpdir(), "foreman-install-labels-test-"));
const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args: a, token: process.env.GH_TOKEN ?? null }) + "\\n");
const method = a[a.indexOf("-X") + 1];
const repo = (a.find((x) => x.startsWith("repos/")) || "").match(/^repos\\/([^/]+\\/[^/]+)\\/labels$/)?.[1];
if (a[0] !== "api" || !repo || !Array.isArray(st[repo])) { process.stderr.write("HTTP 404: Not Found\\nmore"); process.exit(1); }
if (method === "GET") {
  // Two pages, back to back, the way gh --paginate prints them.
  const labels = st[repo].map((name) => ({ name, description: "has ] and [ in it" }));
  const half = Math.ceil(labels.length / 2);
  process.stdout.write(JSON.stringify(labels.slice(0, half)) + JSON.stringify(labels.slice(half)));
  process.exit(0);
}
if (method === "POST") {
  const name = a.find((x) => x.startsWith("name=")).slice(5);
  if (st.rejectPost === name) { process.stderr.write("HTTP 422: Validation Failed"); process.exit(1); }
  st[repo].push(name); fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st));
  process.stdout.write("{}"); process.exit(0);
}
process.stderr.write("refused " + method); process.exit(1);
`);
chmodSync(join(bin, "gh"), 0o755);

let n = 0;
function setup(cfg, state) {
  const dir = join(tmp, `case${++n}`);
  mkdirSync(dir);
  const cfgPath = join(dir, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, repos: cfg.repos.map((r) => ({ ...r, repoPath: dir })) }));
  const stateFile = join(dir, "state.json");
  const logFile = join(dir, "gh.log");
  writeFileSync(stateFile, JSON.stringify(state));
  return (extraEnv = {}) => {
    writeFileSync(logFile, "");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile, ...extraEnv };
    for (const k of Object.keys(env)) if (k.startsWith("AI_AGENT_")) delete env[k];
    if (!("FOREMAN_GITHUB_TOKEN" in extraEnv)) delete env.FOREMAN_GITHUB_TOKEN;
    const r = spawnSync("node", [SCRIPT, cfgPath], { cwd: root, env, encoding: "utf8" });
    const calls = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const posts = calls.filter((c) => c.args.includes("POST"))
      .map((c) => `${c.args.find((x) => x.startsWith("repos/")).split("/").slice(1, 3).join("/")}:${c.args.find((x) => x.startsWith("name=")).slice(5)}`);
    return { status: r.status, out: r.stdout + r.stderr, calls, posts };
  };
}

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("creates only the missing configured labels, then nothing on a rerun", () => {
  const run = setup({ repos: [{ name: "a", githubRepo: "acme/a" }, { name: "b", githubRepo: "acme/b" }] },
    { "acme/a": [], "acme/b": ["approved", "bug", "pr approved"] });
  const r1 = run();
  assert.equal(r1.status, 0, r1.out);
  assert.deepEqual(r1.posts.filter((p) => p.startsWith("acme/a:")).map((p) => p.slice(7)).sort(), [...DEFAULTS].sort());
  assert.deepEqual(r1.posts.filter((p) => p.startsWith("acme/b:")).map((p) => p.slice(7)).sort(),
    DEFAULTS.filter((l) => l !== "approved" && l !== "pr approved").sort());
  assert.ok(r1.calls.every((c) => ["GET", "POST"].includes(c.args[c.args.indexOf("-X") + 1])), "only GET and POST");
  assert.match(r1.out, /acme\/a: created 6, present 0/);
  assert.match(r1.out, /acme\/b: created 4, present 2/);

  const r2 = run();
  assert.equal(r2.status, 0, r2.out);
  assert.deepEqual(r2.posts, []);
  assert.match(r2.out, /acme\/a: created 0, present 6/);
});

test("names come from config: per-repo triggerLabel and renamed lifecycle labels", () => {
  const run = setup({ triggerLabel: "go", lifecycleLabels: { prUnderReview: "in-review" },
    repos: [{ name: "c", githubRepo: "acme/c" }, { name: "d", githubRepo: "acme/d", triggerLabel: "build-me" }] },
    { "acme/c": [], "acme/d": [] });
  const r = run();
  assert.equal(r.status, 0, r.out);
  const c = r.posts.filter((p) => p.startsWith("acme/c:")).map((p) => p.slice(7));
  const d = r.posts.filter((p) => p.startsWith("acme/d:")).map((p) => p.slice(7));
  assert.ok(c.includes("go") && c.includes("in-review"));
  assert.ok(!c.includes("approved") && !c.includes("pr under review"));
  assert.ok(d.includes("build-me") && !d.includes("go"));
});

test("a failed repo or label is reported, the rest still run, exit is 1", () => {
  const run = setup({ repos: [{ name: "x", githubRepo: "acme/down" }, { name: "y", githubRepo: "acme/y" }] },
    { "acme/down": "FAIL", "acme/y": [], rejectPost: "ready to close" });
  const r = run();
  assert.equal(r.status, 1);
  assert.equal(r.posts.filter((p) => p.startsWith("acme/y:")).length, DEFAULTS.length);
  assert.match(r.out, /acme\/down: could not read labels — HTTP 404: Not Found\n/);
  assert.match(r.out, /acme\/y: could not create "ready to close" — HTTP 422/);
  assert.match(r.out, /acme\/y: created 5, present 0/);
});

test("gh runs as the Foreman when FOREMAN_GITHUB_TOKEN is set", () => {
  const run = setup({ repos: [{ name: "t", githubRepo: "acme/t" }] }, { "acme/t": DEFAULTS });
  const r = run({ FOREMAN_GITHUB_TOKEN: "test-dummy" });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.calls.length > 0 && r.calls.every((c) => c.token === "test-dummy"));
});
