// Lanes: every stage group runs on its own loop per repo (src/lanes.ts). A long
// build on a repo must not hold that repo's release; stages that change the
// repo's working clone must never overlap on one repo; a lane runs one item per
// repo at a time but every repo at once; and the shutdown drain waits for every
// lane, not only for the Claude sessions.
//
// The pass-level cases drive the BUILT orchestrator with a fake `gh` and a fake
// `claude` first on PATH, as stages.test.mjs does. The fake `claude` blocks
// while a hold file exists, so a test can keep a session open and look at what
// else runs meanwhile. Nothing reaches GitHub or Anthropic.
//
// This file calls requestShutdown(), which is process-wide: the drain cases run
// last, and node --test gives every test file its own process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { lanesFor, withCheckoutLock, withLaneLock, withSessionSlot, setSessionLimit, stageNeedsCheckout } from "../dist/lanes.js";
import { runRepoPass, runLanePass, requestShutdown, drainInFlight, getActiveLanePasses, getActiveRunCount } from "../dist/orchestrator.js";
import { configureIssueCache } from "../dist/github.js";
import { setStatePath, loadRepoState, saveRepoState } from "../dist/state.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp, F, saved;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-lanes-test-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  F = {
    ghLog: join(tmp, "gh.log"),
    ghState: join(tmp, "gh-state.json"),
    claudeLog: join(tmp, "claude.log"),
    claudeOut: join(tmp, "claude-out.txt"),
    hold: join(tmp, "claude.hold"),
  };
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(F.ghLog)}, JSON.stringify(args) + "\\n");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(F.ghState)}, "utf8"));
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(args.includes("--head") ? st.featurePrs : st.openPrs));
} else {
  process.stdout.write("[]");
}
`);
  // Logs a start line, blocks while the hold file exists, then logs an end line.
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
const who = { stage: process.env.FOREMAN_STAGE_ID, repo: process.env.FOREMAN_STAGE_REPO };
const log = (event) => fs.appendFileSync(${JSON.stringify(F.claudeLog)}, JSON.stringify({ ...who, event, t: Date.now() }) + "\\n");
log("start");
const nap = new Int32Array(new SharedArrayBuffer(4));
while (fs.existsSync(${JSON.stringify(F.hold)})) Atomics.wait(nap, 0, 0, 20);
log("end");
process.stdout.write(fs.readFileSync(${JSON.stringify(F.claudeOut)}, "utf8"));
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
  if (existsSync(F.hold)) rmSync(F.hold);
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.FOREMAN_GITHUB_TOKEN === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.FOREMAN_GITHUB_TOKEN;
  rmSync(tmp, { recursive: true, force: true });
});

function load(cfg, repos) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    repos: repos.map((r) => ({ repoPath: tmp, githubRepo: `example/${r.name}`, ...r })),
    ...cfg,
  }));
  return loadConfig(p);
}

const SHA = "a".repeat(40);
const prAt = (sha) => ({ number: 7, title: "feat: x (#3)", body: "", commits: [], headRefOid: sha });

function arrange({ featurePrs = [prAt(SHA)], claudeOut = "FOREMAN_STAGE pass\n", hold = false } = {}) {
  writeFileSync(F.ghLog, "");
  writeFileSync(F.claudeLog, "");
  writeFileSync(F.ghState, JSON.stringify({ featurePrs, openPrs: [] }));
  writeFileSync(F.claudeOut, claudeOut);
  if (hold) writeFileSync(F.hold, "");
  else if (existsSync(F.hold)) rmSync(F.hold);
}
const lines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const claudeEvents = () => lines(F.claudeLog);
const starts = () => claudeEvents().filter((e) => e.event === "start");
const promoteRan = () => lines(F.ghLog).some((a) => a[0] === "issue" && a[1] === "list");
const release = () => rmSync(F.hold);

async function until(cond, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Session intervals from the claude log, in start order. */
function intervals() {
  const ev = claudeEvents();
  const out = [];
  for (const s of ev.filter((e) => e.event === "start")) {
    const end = ev.find((e) => e.event === "end" && e.stage === s.stage && e.repo === s.repo && e.t >= s.t);
    out.push({ ...s, end: end?.t });
  }
  return out.sort((a, b) => a.t - b.t);
}

// --- Lane grouping ----------------------------------------------------------

test("default stages form eight lanes: build = revise→implement, release = promote→release", () => {
  const lanes = lanesFor(load({}, [{ name: "defaults" }]).stages);
  assert.deepEqual(lanes.map((l) => [l.name, l.stages.map((s) => s.type)]), [
    ["reconcile", ["reconcile"]],
    ["review", ["review"]],
    ["verify", ["verify"]],
    ["release", ["promote", "release"]],
    ["build", ["revise", "implement"]],
    ["branch-sync", ["branch-sync"]],
    ["dependabot", ["dependabot"]],
    ["unstick", ["unstick"]],
  ]);
});

test("a custom stage joins the lane of the built-in after it; trailing, it is its own lane", () => {
  const lanes = lanesFor([
    { type: "implement" }, { id: "sec", skillPath: "/s" }, { type: "promote" }, { id: "tail", skillPath: "/t" },
  ]);
  assert.deepEqual(lanes.map((l) => [l.name, l.stages.map((s) => s.type ?? s.id)]), [
    ["build", ["implement"]],
    ["release", ["sec", "promote"]],
    ["tail", ["tail"]],
  ]);
});

test("only clone-changing stages take the checkout lock", () => {
  const needs = ["reconcile", "review", "verify", "promote", "release", "revise", "implement", "branch-sync", "dependabot"]
    .filter((type) => stageNeedsCheckout({ type }));
  assert.deepEqual(needs, ["reconcile", "revise", "implement"]);
  assert.equal(stageNeedsCheckout({ id: "x", skillPath: "/x" }), true, "a custom stage's cwd is the clone");
});

// --- Locks --------------------------------------------------------------------

test("checkout lock: one holder per repo, FIFO; another repo is not blocked", async () => {
  const order = [];
  let freeA;
  const a1 = withCheckoutLock("lockrepo", () => new Promise((r) => { order.push("a1"); freeA = r; }));
  const a2 = withCheckoutLock("lockrepo", async () => { order.push("a2"); });
  const b1 = withCheckoutLock("otherrepo", async () => { order.push("b1"); });
  await b1;
  await sleep(30);
  assert.deepEqual(order, ["a1", "b1"], "a2 waits for a1; b1 does not");
  freeA();
  await Promise.all([a1, a2]);
  assert.deepEqual(order, ["a1", "b1", "a2"]);
});

test("lane lock: one pass per (repo, lane); other lanes and other repos run alongside", async () => {
  const running = new Set();
  let maxSame = 0;
  const pass = (repo, lane, ms) => withLaneLock(repo, lane, async () => {
    const k = `${repo}/${lane}`;
    assert.ok(!running.has(k), `${k} entered twice`);
    running.add(k);
    maxSame = Math.max(maxSame, running.size);
    await sleep(ms);
    running.delete(k);
  });
  await Promise.all([pass("r1", "build", 60), pass("r1", "build", 10), pass("r1", "release", 30), pass("r2", "build", 30)]);
  assert.equal(maxSame, 3, "r1/build, r1/release and r2/build overlapped; the second r1/build did not");
});

test("maxConcurrentSessions: 0 is unbounded; N caps concurrent sessions at N", async () => {
  let now = 0, peak = 0;
  const session = () => withSessionSlot(async () => { now++; peak = Math.max(peak, now); await sleep(20); now--; });
  setSessionLimit(2);
  await Promise.all(Array.from({ length: 6 }, session));
  assert.equal(peak, 2);
  peak = 0;
  setSessionLimit(0);
  await Promise.all(Array.from({ length: 6 }, session));
  assert.equal(peak, 6);
});

// --- State written by concurrent lanes ------------------------------------------

test("state: two lanes saving one repo keep each other's fields", () => {
  const build = loadRepoState("statesafe");
  const rel = loadRepoState("statesafe");
  build.implemented.push(41);
  saveRepoState("statesafe", build);
  // The release lane loaded before the build saved, and saves a field of its own.
  saveRepoState("statesafe", { ...rel, prodVerified: { 41: { pr: 9, mergeSha: SHA, at: "2026-10-14T00:00:00Z" } } });
  const after = loadRepoState("statesafe");
  assert.deepEqual(after.implemented, [41], "the release lane's stale copy did not erase the build's record");
  assert.equal(after.prodVerified[41].pr, 9);
  // A copy saved twice diffs from its own last save.
  build.implemented.push(42);
  saveRepoState("statesafe", build);
  assert.deepEqual(loadRepoState("statesafe").implemented, [41, 42]);
  assert.equal(loadRepoState("statesafe").prodVerified[41].pr, 9);
});

// --- (a) a long build does not delay the same repo's release --------------------

test("(a) a build session in flight on repo A does not hold repo A's release lane", async () => {
  arrange({ hold: true });
  const config = load({ stages: [{ id: "slow", skillPath: "/opt/slow/SKILL.md" }, { type: "implement" }, { type: "promote" }] }, [{ name: "lanes-a" }]);
  const pass = runRepoPass(config.repos[0], config, logger);
  await until(() => starts().length === 1, "the build session to start");
  await until(promoteRan, "promote to run beside the build");
  assert.ok(!claudeEvents().some((e) => e.event === "end"), "the build session was still running when promote ran");
  assert.ok(getActiveLanePasses().includes("lanes-a/build"));
  assert.ok(!getActiveLanePasses().includes("lanes-a/release"), "the release lane finished while the build ran");
  release();
  await pass;
});

// --- (b) clone-changing lanes never overlap on one repo -------------------------

test("(b) two lanes that change the clone never overlap on one repo", async () => {
  arrange({ hold: true });
  const config = load({ stages: [
    { id: "lockA", skillPath: "/opt/a/SKILL.md" }, { type: "implement" }, { type: "promote" }, { id: "lockB", skillPath: "/opt/b/SKILL.md" },
  ] }, [{ name: "lanes-b" }]);
  assert.deepEqual(lanesFor(config.stages).map((l) => l.name), ["build", "release", "lockB"]);
  const pass = runRepoPass(config.repos[0], config, logger);
  await until(() => starts().length === 1, "the first clone session");
  await until(promoteRan, "promote to run while the clone is locked");
  await sleep(300);
  assert.equal(starts().length, 1, "the second clone session waits for the checkout");
  release();
  await pass;
  const iv = intervals();
  assert.equal(iv.length, 2);
  assert.ok(iv[0].end <= iv[1].t, `sessions overlapped: ${JSON.stringify(iv)}`);
});

// --- (c) one item per repo per lane; the lane is as wide as the fleet ------------

test("(c) one lane runs on every repo at once", async () => {
  arrange({ hold: true });
  const config = load({ stages: [{ id: "wide", skillPath: "/opt/w/SKILL.md" }] }, [{ name: "lanes-c1" }, { name: "lanes-c2" }]);
  const passes = config.repos.map((r) => runRepoPass(r, config, logger));
  await until(() => starts().length === 2, "both repos' sessions in the same lane at once");
  assert.deepEqual(new Set(starts().map((s) => s.repo)), new Set(["example/lanes-c1", "example/lanes-c2"]));
  release();
  await Promise.all(passes);
});

test("(c) a second pass of the same (repo, lane) waits for the first, then takes the next item", async () => {
  arrange({ hold: true });
  const config = load({ stages: [{ id: "one", skillPath: "/opt/o/SKILL.md" }] }, [{ name: "lanes-c3" }]);
  const [lane] = lanesFor(config.stages);
  const first = runLanePass(config.repos[0], config, lane, logger, "never");
  await until(() => starts().length === 1, "the first pass's session");
  // New work lands while the first item is in flight.
  writeFileSync(F.ghState, JSON.stringify({ featurePrs: [prAt("b".repeat(40))], openPrs: [] }));
  const second = runLanePass(config.repos[0], config, lane, logger, "never");
  await sleep(300);
  assert.equal(starts().length, 1, "no second item while the first is in flight");
  release();
  await Promise.all([first, second]);
  const iv = intervals();
  assert.equal(iv.length, 2, "the second pass took the next item once the first finished");
  assert.ok(iv[0].end <= iv[1].t);
});

// --- (d) the shutdown drain waits for every lane -------------------------------
// requestShutdown() is process-wide: these run last.

test("(d) drain waits for a lane pass that holds no session (the release lane after a deploy)", async () => {
  arrange();
  const config = load({ stages: [{ id: "drainA", skillPath: "/opt/d/SKILL.md" }] }, [{ name: "lanes-d1" }]);
  const [lane] = lanesFor(config.stages);
  // Stand in for work a lane does outside any session: hold the clone, so the
  // pass is in flight with no run registered.
  let free;
  const held = withCheckoutLock("lanes-d1", () => new Promise((r) => { free = r; }));
  const pass = runLanePass(config.repos[0], config, lane, logger, "never");
  await until(() => getActiveLanePasses().includes("lanes-d1/drainA"), "the lane pass to be in flight");
  assert.equal(getActiveRunCount(), 0, "no session registered");
  requestShutdown();
  let drained = false;
  const drain = drainInFlight(10_000, logger, 20, 1000).then((ok) => { drained = ok; return ok; });
  await sleep(200);
  assert.equal(drained, false, "the drain waits for the lane pass, not just for sessions");
  free();
  await held;
  assert.equal(await drain, true);
  await pass;
  assert.equal(starts().length, 0, "a session stage does not start once a shutdown is under way");
});

test("(d) drain waits for every lane's session; none starts after the shutdown", async () => {
  // Shutdown is already requested (previous test), so sessions cannot start
  // here; check the drain's other half — runs in flight — directly instead.
  const ac = new AbortController();
  const { activeRuns } = await import("../dist/phases/common.js");
  activeRuns.set(ac, "lanes-d2");
  const ac2 = new AbortController();
  activeRuns.set(ac2, "lanes-d2"); // a second lane of the SAME repo
  let drained = false;
  const drain = drainInFlight(10_000, logger, 20, 1000).then((ok) => { drained = ok; });
  activeRuns.delete(ac);
  await sleep(150);
  assert.equal(drained, false, "one lane finishing does not end the drain while another lane of the repo runs");
  activeRuns.delete(ac2);
  await drain;
  assert.equal(drained, true);
});
