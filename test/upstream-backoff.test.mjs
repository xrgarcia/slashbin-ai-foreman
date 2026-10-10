// Daemon-wide upstream back-off (GitHub rate limit, Claude session limit).
//
// The bug these pin down: a rate limit is a property of the ACCOUNT, but the
// Foreman treated it as a property of one call. On 2026-10-01 it logged 4,526
// `RATE LIMIT EXHAUSTED` lines in under four hours, and 393 Claude session-limit
// refusals were charged to per-repo retry counters until one repo deadlocked.
//
// Each case runs in its own `node` child so the module's process-wide state
// starts fresh. A fake `gh` (a node script, first on PATH) logs every call and
// answers from files the case controls — no real GitHub or Claude call.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { detectUpstreamLimit, parseClaudeReset } from "../dist/agent.js";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const url = (f) => pathToFileURL(join(DIST, f)).href;

const tmp = mkdtempSync(join(tmpdir(), "foreman-upstream-test-"));
const binDir = join(tmp, "bin");
mkdirSync(binDir);
writeFileSync(join(binDir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, Date.now() + " " + args.join(" ") + "\\n");
if (args[0] === "api" && args[1] === "rate_limit") { process.stdout.write(fs.readFileSync(process.env.FAKE_GH_RATE)); process.exit(0); }
// The GraphQL endpoint answers from the same graphql bucket (#69: a GraphQL trip is probed there).
if (args[0] === "api" && args[1] === "graphql") {
  const g = JSON.parse(fs.readFileSync(process.env.FAKE_GH_RATE, "utf8"))?.resources?.graphql ?? {};
  process.stdout.write(JSON.stringify({ data: { rateLimit: { remaining: g.remaining,
    resetAt: typeof g.reset === "number" ? new Date(g.reset * 1000).toISOString() : null } } }));
  process.exit(0);
}
const err = fs.readFileSync(process.env.FAKE_GH_ERR, "utf8");
if (err) { process.stderr.write(err); process.exit(1); }
process.stdout.write("[]");
`);
chmodSync(join(binDir, "gh"), 0o755);
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/** Run `body` in a fresh child with the module configured; returns its last JSON line. */
function runCase(body, { baseMs = 200, capMs = 1600 } = {}) {
  const dir = mkdtempSync(join(tmp, "case-"));
  const F = { log: join(dir, "gh.log"), rate: join(dir, "rate.json"), err: join(dir, "err.txt") };
  writeFileSync(F.log, "");
  writeFileSync(F.rate, "{}");
  writeFileSync(F.err, "");
  const prelude = `
    import { writeFileSync, readFileSync } from "node:fs";
    const F = ${JSON.stringify(F)};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const calls = () => readFileSync(F.log, "utf8").split("\\n").filter(Boolean)
      .map((l) => { const [ts, ...a] = l.split(" "); return { ts: Number(ts), args: a.join(" ") }; });
    const isProbe = (c) => c.args.startsWith("api rate_limit") || c.args.startsWith("api graphql");
    const work = () => calls().filter((c) => !isProbe(c)).length;
    const probes = () => calls().filter(isProbe).map((c) => c.ts);
    const rate = (remaining, resetSec, graphqlRemaining = remaining) => writeFileSync(F.rate, JSON.stringify({ resources: {
      core: { remaining, reset: resetSec }, graphql: { remaining: graphqlRemaining, reset: resetSec } } }));
    const nowSec = () => Math.floor(Date.now() / 1000);
    const notes = [];
    const B = await import(${JSON.stringify(url("upstream-backoff.js"))});
    const G = await import(${JSON.stringify(url("github.js"))});
    const call = () => { try { G.gh(["issue", "list", "--repo", "example/test"], ${JSON.stringify(dir)}); return "ok"; }
      catch (e) { return e instanceof B.UpstreamBackoffError ? "backoff" : "error"; } };
    B.configureUpstreamBackoff({ baseMs: ${baseMs}, capMs: ${capMs}, notify: (t, l) => notes.push({ t, l }) });
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `${prelude}\n${body}`], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FOREMAN_GITHUB_TOKEN: "test-fake",
      EM_GITHUB_TOKEN: "",
      FAKE_GH_LOG: F.log, FAKE_GH_RATE: F.rate, FAKE_GH_ERR: F.err,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`case produced no JSON (exit ${r.status}): ${r.stderr}`);
  }
}

const LIMIT_ERR = "HTTP 403: API rate limit exceeded for user ID 1.";

test("a GitHub rate limit enters the back-off once and stops every later gh spawn", () => {
  const r = runCase(`
    writeFileSync(F.err, ${JSON.stringify(LIMIT_ERR)});
    rate(0, nowSec() + 3600);
    const first = call();
    const refused = [call(), call(), call()];
    console.log(JSON.stringify({ first, refused, work: work(), notes, blocked: B.isUpstreamBlocked("github") }));
  `);
  assert.equal(r.first, "error");
  assert.deepEqual(r.refused, ["backoff", "backoff", "backoff"]);
  assert.equal(r.work, 1, "only the first call may spawn gh");
  assert.equal(r.blocked, true);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].l, "warn");
  assert.match(r.notes[0].t, /^Foreman backing off GitHub for \S+ \w+ — HTTP 403: API rate limit exceeded/);
});

test("the entry window renders as 2 minutes at the default base", () => {
  const r = runCase(`
    writeFileSync(F.err, ${JSON.stringify(LIMIT_ERR)});
    call();
    console.log(JSON.stringify({ notes }));
  `, { baseMs: 120_000, capMs: 3_600_000 });
  assert.match(r.notes[0].t, /^Foreman backing off GitHub for 2 minutes — /);
});

test("a failed probe extends with a doubled window; a passing probe clears and resumes", () => {
  const r = runCase(`
    writeFileSync(F.err, ${JSON.stringify(LIMIT_ERR)});
    rate(5000, nowSec(), 0);                // graphql exhausted, reset already past
    call();
    writeFileSync(F.err, "");
    await sleep(300);                       // probe at ~200ms → still limited
    const afterFirstProbe = notes.length;
    rate(5000, nowSec() + 3600);
    await sleep(600);                       // probe at ~200+400ms → clear
    const resolved = await Promise.race([B.whenUpstreamClear("github").then(() => true), sleep(50).then(() => false)]);
    console.log(JSON.stringify({ afterFirstProbe, notes, probes: probes(), resumed: call(), work: work(), resolved }));
  `);
  assert.equal(r.afterFirstProbe, 2);
  assert.match(r.notes[1].t, /^Foreman still limited by GitHub — backing off .+ \(until \d\d:\d\d\)$/);
  assert.ok(r.probes[1] - r.probes[0] >= 360, `second window doubled: ${r.probes}`);
  assert.equal(r.notes.length, 3, "enter + one extend + clear, no per-call messages");
  assert.equal(r.notes[2].t, "Foreman GitHub back-off cleared — resuming");
  assert.equal(r.notes[2].l, "info");
  assert.equal(r.resumed, "ok");
  assert.equal(r.work, 2);
  assert.equal(r.resolved, true);
});

test("a stated GitHub reset later than the doubled window is honoured", () => {
  const r = runCase(`
    writeFileSync(F.err, ${JSON.stringify(LIMIT_ERR)});
    const resetSec = nowSec() + 2;
    rate(0, resetSec);
    call();
    await sleep(300);
    rate(5000, nowSec() + 3600);
    await sleep(2300);
    console.log(JSON.stringify({ resetMs: resetSec * 1000, probes: probes() }));
  `);
  assert.ok(r.probes.length >= 2);
  assert.ok(r.probes[1] >= r.resetMs - 50, `probe at ${r.probes[1]} before reset ${r.resetMs}`);
});

test("the window doubles up to the cap and never past it", () => {
  const r = runCase(`
    writeFileSync(F.err, ${JSON.stringify(LIMIT_ERR)});
    rate(0, nowSec());
    call();
    await sleep(100 + 200 + 400 + 400 + 400 + 150);
    const p = probes();
    console.log(JSON.stringify({ gaps: p.slice(1).map((t, i) => t - p[i]) }));
  `, { baseMs: 100, capMs: 400 });
  assert.ok(r.gaps.length >= 4, JSON.stringify(r.gaps));
  assert.ok(r.gaps.every((g) => g <= 400 + 150), JSON.stringify(r.gaps));
  assert.ok(r.gaps[1] >= 350, `reached the cap: ${r.gaps}`);
});

test("HTTP 429 enters the back-off; HTTP 404 does not", () => {
  for (const [text, expect] of [
    ["HTTP 429: Too Many Requests (https://api.github.com/graphql)", true],
    ["HTTP 404: Not Found (https://api.github.com/repos/example/test)", false],
  ]) {
    const r = runCase(`
      writeFileSync(F.err, ${JSON.stringify(text)});
      call();
      console.log(JSON.stringify({ blocked: B.isUpstreamBlocked("github") }));
    `);
    assert.equal(r.blocked, expect, text);
  }
});

test("a re-entry soon after a clear continues the doubling; a later one starts at the base", () => {
  // A secondary limit is invisible to rate_limit, so the probe can clear while
  // one is still active. Rendered windows: 1000ms "1 second", 2000ms "2 seconds".
  const reentry = (gapMs) => runCase(`
    writeFileSync(F.err, ${JSON.stringify(LIMIT_ERR)});
    rate(5000, nowSec() + 3600);
    call();                                  // enter at the base, 1000ms
    await sleep(1050);                       // the probe clears
    await sleep(${gapMs});
    call();
    console.log(JSON.stringify({ notes: notes.map((n) => n.t) }));
  `, { baseMs: 1000, capMs: 8000 });
  const soon = reentry(0);
  assert.match(soon.notes[2], /^Foreman backing off GitHub for 2 seconds — /);
  const late = reentry(1100);
  assert.match(late.notes[2], /^Foreman backing off GitHub for 1 second — /);
});

test("Claude: blocked in the window, silent on concurrent refusals, one probe after, clear on success", () => {
  const r = runCase(`
    B.reportClaudeResult(true, "You've hit your session limit");
    const inWindow = [B.tryAcquire("claude"), B.isUpstreamBlocked("claude")];
    B.reportClaudeResult(true, "You've hit your session limit");
    const notesInWindow = notes.length;
    await sleep(260);
    const halfOpenBlocked = B.isUpstreamBlocked("claude");
    const probe = B.tryAcquire("claude");
    const second = B.tryAcquire("claude");
    const probeOutBlocked = B.isUpstreamBlocked("claude");
    B.reportClaudeResult(false);
    console.log(JSON.stringify({ inWindow, notesInWindow, halfOpenBlocked, probe, second, probeOutBlocked,
      after: B.tryAcquire("claude"), notes }));
  `);
  assert.deepEqual(r.inWindow, [false, true]);
  assert.equal(r.notesInWindow, 1);
  assert.equal(r.halfOpenBlocked, false, "half-open with the probe unclaimed lets one phase through");
  assert.equal(r.probe, true);
  assert.equal(r.second, false);
  assert.equal(r.probeOutBlocked, true);
  assert.equal(r.after, true);
  assert.deepEqual(r.notes.map((n) => n.t), [
    "Foreman backing off Claude for 1 second — You've hit your session limit",
    "Foreman Claude back-off cleared — resuming",
  ]);
});

test("Claude: a refused half-open probe extends; a stated reset holds the probe back until it passes", () => {
  const r = runCase(`
    B.reportClaudeResult(true, "limit");
    await sleep(260);
    B.tryAcquire("claude");
    const resetAt = Date.now() + 900;
    B.reportClaudeResult(true, "limit", resetAt);    // probe refused → extend to the reset
    await sleep(500);
    const beforeReset = B.tryAcquire("claude");
    await sleep(600);
    const afterReset = B.tryAcquire("claude");
    console.log(JSON.stringify({ beforeReset, afterReset, notes: notes.map((n) => n.t) }));
  `);
  assert.equal(r.beforeReset, false);
  assert.equal(r.afterReset, true);
  assert.equal(r.notes.length, 2);
  assert.match(r.notes[1], /^Foreman still limited by Claude — backing off .+ \(until \d\d:\d\d\)$/);
});

test("Claude: a later reset stated while blocked extends to it at window end", () => {
  const r = runCase(`
    B.reportClaudeResult(true, "limit");
    B.reportClaudeResult(true, "limit", Date.now() + 700);   // concurrent refusal names a reset
    await sleep(300);
    const atWindowEnd = B.tryAcquire("claude");
    await sleep(600);
    console.log(JSON.stringify({ atWindowEnd, afterReset: B.tryAcquire("claude"), notes: notes.map((n) => n.t) }));
  `);
  assert.equal(r.atWindowEnd, false);
  assert.equal(r.afterReset, true);
  assert.equal(r.notes.length, 2);
  assert.match(r.notes[1], /^Foreman still limited by Claude — backing off until \d\d:\d\d$/);
});

// --- Claude classification --------------------------------------------------

const VERBATIM = JSON.stringify({
  type: "result", subtype: "success", is_error: true, num_turns: 1, api_error_status: 429,
  result: "You've hit your session limit · resets 12:10pm (America/Chicago)",
});

const wall = (ms, zone) => new Intl.DateTimeFormat("en-US", {
  timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true,
}).format(ms);

test("detectUpstreamLimit reads the stream-json result event of a refused review", () => {
  const hit = detectUpstreamLimit(`{"type":"system"}\n${VERBATIM}`);
  assert.match(hit.reason, /session limit/);
  assert.equal(wall(hit.resetAtMs, "America/Chicago"), "12:10 PM");
  assert.ok(hit.resetAtMs > Date.now() && hit.resetAtMs - Date.now() <= 24 * 3600_000);
});

test("detectUpstreamLimit reads the plain-text refusal of implement and revise", () => {
  const hit = detectUpstreamLimit("You've hit your session limit · resets 12:10pm (America/Chicago)\n");
  assert.match(hit.reason, /session limit/);
  assert.equal(wall(hit.resetAtMs, "America/Chicago"), "12:10 PM");
});

test("detectUpstreamLimit ignores non-limit results and prose that merely mentions a limit", () => {
  assert.equal(detectUpstreamLimit(JSON.stringify({ type: "result", is_error: false, result: "session limit in prose" })), undefined);
  assert.equal(detectUpstreamLimit(JSON.stringify({ type: "result", is_error: true, result: "boom" })), undefined);
  assert.equal(detectUpstreamLimit("Implemented #12. Note: we are near the session limit."), undefined);
  assert.equal(detectUpstreamLimit(""), undefined);
});

test("parseClaudeReset resolves the next wall-clock occurrence in the stated zone", () => {
  // 2026-03-08 07:00 UTC = 01:00 CST, the morning US DST starts at 02:00.
  const now = Date.UTC(2026, 2, 8, 7, 0);
  const at = parseClaudeReset("resets 9am (America/Chicago)", now);
  assert.equal(at, Date.UTC(2026, 2, 8, 14, 0), "09:00 CDT, after the DST jump, is 14:00 UTC");
  // Already past today → tomorrow.
  const later = parseClaudeReset("resets 12:30am (America/Chicago)", now);
  assert.equal(later, Date.UTC(2026, 2, 9, 5, 30));
  assert.equal(parseClaudeReset("resets 9am (Not/AZone)", now), undefined);
  assert.equal(parseClaudeReset("no reset stated", now), undefined);
});

// --- Retry counters ---------------------------------------------------------

test("each phase returns before its retry counter when the failure was an upstream limit", () => {
  const orch = readFileSync(join(DIST, "orchestrator.js"), "utf8");
  for (const [fn, counter] of [
    ["tryBatchImplementation", "failureCount.set(repoName, newCount)"],
    ["tryRevision", "revisionFailureCount.set(repoName, newCount)"],
    ["tryReview", "reviewFailureCount.set(repoName, newCount)"],
  ]) {
    const start = orch.indexOf(`async function ${fn}(`);
    const inc = orch.indexOf(counter, start);
    assert.ok(start >= 0 && inc > start, fn);
    const before = orch.slice(Math.max(start, inc - 900), inc);
    // Returns before the counter — and moves the card to Blocked first (2026-10-05).
    assert.match(before, /if \(result\.upstreamLimit \|\| isUpstreamBlocked\("github"\)\)\s*\{[\s\S]{0,500}?kind: "blocked"[\s\S]{0,200}?return\b/, fn);
  }
});
