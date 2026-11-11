// Nothing blocks the Foreman's main loop (slashbin-ai-foreman#253, category "daemon health").
//
// A synchronous child process holds the whole event loop: timers, sockets, Paperclip and registry
// callbacks all wait for it. Every git and subprocess call in `src/` is async with a timeout
// (src/git-exec.ts for git; src/github/gh.ts for gh). This fails the build when a synchronous
// process call appears, in the style of plugin-boundary.test.mjs. The allow-list is empty; an
// entry needs a written reason a subprocess cannot be async there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { git, gitBytes, gitResult } from "../dist/git-exec.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

/** file (relative to src/) -> why a synchronous subprocess call is unavoidable there. */
const ALLOWED = {};

const SYNC_CALL = /\b(?:spawnSync|execFileSync|execSync)\b/;

/** The code with comments removed, so prose that names a call is not one. */
function codeOf(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");
}

function syncCallsIn(files) {
  return Object.entries(files)
    .filter(([rel]) => !(rel in ALLOWED))
    .flatMap(([rel, text]) => codeOf(text).split("\n").flatMap((l, i) => (SYNC_CALL.test(l) ? [`src/${rel}:${i + 1}: ${l.trim()}`] : [])));
}

const srcFiles = () => readdirSync(src, { recursive: true }).map((n) => String(n).split("\\").join("/")).filter((n) => n.endsWith(".ts"));

test("src/ holds no synchronous subprocess call (spawnSync, execFileSync, execSync)", () => {
  const files = Object.fromEntries(srcFiles().map((rel) => [rel, readFileSync(join(src, rel), "utf8")]));
  assert.ok(Object.keys(files).length > 50, "the walk sees the source tree");
  assert.deepEqual(syncCallsIn(files), []);
});

test("the allow-list is empty, or every entry says why", () => {
  for (const [rel, why] of Object.entries(ALLOWED)) assert.ok(String(why).length > 20, `${rel} needs a reason`);
  assert.deepEqual(ALLOWED, {});
});

test("the guard catches each synchronous form and ignores comments", () => {
  for (const call of ['execFileSync("git", a)', 'spawnSync("git", a)', 'execSync("git x")', 'import { spawnSync } from "node:child_process";']) {
    assert.equal(syncCallsIn({ "x.ts": `const r = ${call};` }).length, 1, call);
  }
  assert.deepEqual(syncCallsIn({ "x.ts": "// execFileSync is gone\n/* spawnSync\n execSync */\nconst a = 1; // spawnSync" }), []);
  assert.deepEqual(syncCallsIn({ "x.ts": 'const re = "https://x"; execFile("git", a, cb);' }), []);
});

/** Runs `body` with a `git` on PATH that is `script`. */
async function withFakeGit(script, body) {
  const bin = mkdtempSync(join(tmpdir(), "foreman-fakegit-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try { return await body(); } finally { process.env.PATH = saved; }
}

test("git runs off the loop: timers keep turning while a slow git call is in flight", async () => {
  await withFakeGit("sleep 0.6; echo done", async () => {
    let ticks = 0;
    const t = setInterval(() => ticks++, 20);
    const out = await git(["fetch"], tmpdir());
    clearInterval(t);
    assert.equal(out, "done");
    assert.ok(ticks >= 10, `the loop kept turning while git ran (${ticks} ticks)`);
  });
});

test("git: a timeout rejects with ETIMEDOUT and does not hang", async () => {
  await withFakeGit("sleep 5", async () => {
    const started = performance.now();
    await assert.rejects(() => git(["fetch"], tmpdir(), { timeoutMs: 200 }), (e) => e.code === "ETIMEDOUT");
    assert.ok(performance.now() - started < 3000, "killed at the timeout, not at the end of the sleep");
    assert.equal((await gitResult(["fetch"], tmpdir(), { timeoutMs: 200 })).timedOut, true);
  });
});

test("git: a non-zero exit carries stderr; success is trimmed stdout; stdin is written; a missing cwd resolves as a failure", async () => {
  await withFakeGit('if [ "$1" = fail ]; then echo "fatal: nope" >&2; exit 3; fi; cat', async () => {
    await assert.rejects(() => git(["fail"], tmpdir()), (e) => e.stderr.includes("fatal: nope") && e.code === 3 && /nope/.test(e.message));
    assert.equal(await git(["x"], tmpdir(), { input: "  piped in \n" }), "piped in");
    assert.deepEqual([...(await gitBytes(["x"], tmpdir(), { input: Buffer.from([0, 255, 1]) }))], [0, 255, 1]);
  });
  const dead = await gitResult(["rev-parse", "HEAD"], join(tmpdir(), "no-such-dir-253"));
  assert.notEqual(dead.status, 0);
});

test("config infers githubRepo from origin without running a subprocess: plain clone, linked worktree, ssh url, no remote", async () => {
  const { loadConfig } = await import("../dist/config.js");
  const { spawnSync } = await import("node:child_process");
  const tmp = mkdtempSync(join(tmpdir(), "foreman-infer-"));
  const run = (cwd, ...a) => assert.equal(spawnSync("git", a, { cwd }).status, 0, a.join(" "));
  const infer = (path) => {
    const cfg = join(tmp, `c-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(cfg, JSON.stringify({ repoPath: path }));
    return loadConfig(cfg).repos[0].githubRepo;
  };
  const main = join(tmp, "main");
  run(tmp, "init", "-q", "-b", "develop", main);
  assert.throws(() => infer(main), /could not be inferred/, "no origin: unknown");
  run(main, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  assert.equal(infer(main), "acme/widgets");
  run(main, "remote", "set-url", "origin", "git@github.com:acme/gadgets.git");
  assert.equal(infer(main), "acme/gadgets");
  run(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  const wt = join(tmp, "wt");
  run(main, "worktree", "add", "-q", "-b", "side", wt);
  assert.equal(infer(wt), "acme/gadgets", "a linked worktree reads the common config");
});
