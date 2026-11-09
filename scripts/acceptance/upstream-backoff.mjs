#!/usr/bin/env node
/**
 * Acceptance for the Foreman daemon-wide upstream back-off (GitHub rate limit,
 * Claude session limit) — xrgarcia/slashbin-ai-foreman, filed 2026-10-01.
 *
 * Front door: the BUILT Foreman's own entry points — `gh()` from dist/github.js
 * (the function every phase calls), `detectUpstreamLimit` from dist/refusal.js, and
 * the dist/upstream-backoff.js state API the orchestrator and daemon call. A fake
 * `gh` sits first on PATH: it logs every invocation with a millisecond timestamp
 * and answers from files this script controls. No real GitHub or Claude call, no
 * write anywhere outside a temp dir this script creates and deletes. Each case
 * runs in its own `node` child so module state starts fresh.
 *
 * RED TODAY (features 986a841): dist/upstream-backoff.js does not exist and
 * dist/session/protocol.js exports no detectUpstreamLimit, so every case fails on import;
 * C3 finds no `upstreamLimit` in dist/orchestrator.js.
 *
 *   A1 enter      — rate-limit stderr → gh() throws, fake ran once, one "backing off GitHub" notify
 *   A2 short-circuit — 5 more gh() calls in the window → UpstreamBackoffError, fake NOT run again
 *   A3 extend     — probe says graphql.remaining 0 → one "still limited" notify, next window ≥ 2× base
 *   A4 reset      — probe says reset = now+2s → next probe not before that reset
 *   A5 clear      — probe says remaining > 0 → one "cleared" notify, gh() spawns the fake again
 *   A6 cap        — 5 consecutive failed probes → no gap between probes exceeds capMs (+ tolerance)
 *   A7 classify   — HTTP 429 enters back-off; HTTP 404 does not
 *   A8 one message per transition — notify count = 1 enter + 1 per failed probe + 1 clear
 *   C1 detectUpstreamLimit on the verbatim 2026-10-01 review result event AND the implement/revise plain-text
 *      refusal → reason + reset at 12:10 America/Chicago;
 *      is_error:false → undefined; is_error:true without api_error_status → undefined
 *   C2 claude half-open — blocked in window, a second refusal in it is silent, exactly one acquire after it,
 *      clear on a non-limit result
 *   C3 counters (source-level on dist/orchestrator.js — the phases need a real repo to reach):
 *      in each of tryBatchImplementation / tryRevision / tryReview the counter increment is directly
 *      preceded by `if (result.upstreamLimit || isUpstreamBlocked("github")) return`
 *
 *   node scripts/acceptance/upstream-backoff.mjs
 *   (default ~/code/slashbin-ai-foreman; run `npm run build` there first)
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(DIR, "dist");
if (!existsSync(join(DIST, "github.js"))) {
  console.error(`no build at ${DIST} — run \`npm run build\` in ${DIR}`);
  process.exit(2);
}
const url = (f) => pathToFileURL(join(DIST, f)).href;

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), "foreman-backoff-"));
const binDir = join(tmp, "bin");
spawnSync("mkdir", ["-p", binDir]);
writeFileSync(join(binDir, "package.json"), '{"type":"commonjs"}'); // fakes are CJS; a stray ancestor type:module package.json must not make them ESM
const fakeGh = join(binDir, "gh");
// Fake gh: logs "<ms> <args>" to $FAKE_GH_LOG. `gh api rate_limit` prints
// $FAKE_GH_RATE; anything else exits 1 with $FAKE_GH_ERR when non-empty, else prints [].
// Node, not `date +%s%3N`: uutils `date` (this host) ignores the %3N width and
// prints unpadded nanoseconds, which turned every gap check into a nanosecond compare.
writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, Date.now() + " " + a.join(" ") + "\\n");
if (a[0] === "api" && a[1] === "rate_limit") { process.stdout.write(fs.readFileSync(process.env.FAKE_GH_RATE)); process.exit(0); }
const err = fs.existsSync(process.env.FAKE_GH_ERR) ? fs.readFileSync(process.env.FAKE_GH_ERR, "utf8") : "";
if (err.length) { process.stderr.write(err); process.exit(1); }
process.stdout.write("[]\\n");
`);
chmodSync(fakeGh, 0o755);

/** Run one case body in a fresh node child; it must print one JSON line. */
function runCase(name, body, timeoutMs = 20_000) {
  const dir = mkdtempSync(join(tmp, `${name}-`));
  const files = { log: join(dir, "gh.log"), rate: join(dir, "rate.json"), err: join(dir, "err.txt") };
  writeFileSync(files.log, "");
  writeFileSync(files.rate, "{}");
  writeFileSync(files.err, "");
  const prelude = `
    import { writeFileSync, readFileSync } from "node:fs";
    const F = ${JSON.stringify(files)};
    const CWD = ${JSON.stringify(dir)};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const calls = () => readFileSync(F.log, "utf8").split("\\n").filter(Boolean)
      .map((l) => { const [ts, ...a] = l.split(" "); return { ts: Number(ts), args: a.join(" ") }; });
    const work = () => calls().filter((c) => !c.args.startsWith("api rate_limit"));
    const probes = () => calls().filter((c) => c.args.startsWith("api rate_limit"));
    const rate = (remaining, resetSec) => writeFileSync(F.rate, JSON.stringify({ resources: {
      core: { limit: 5000, remaining, reset: resetSec }, graphql: { limit: 5000, remaining, reset: resetSec } } }));
    const nowSec = () => Math.floor(Date.now() / 1000);
    const notes = [];
    const B = await import(${JSON.stringify(url("upstream-backoff.js"))});
    const G = await import(${JSON.stringify(url("github.js"))});
    // A REST call (gh() was the sync runner and is gone; ghAsync is the Foreman-token entry point the daemon uses): the probe now reads the bucket that tripped (github/gh.ts probeGitHub), and a REST trip probes "api rate_limit".
    const call = async () => { try { await G.ghAsync(["api", "repos/example/acceptance/issues"], CWD); return "ok"; }
      catch (e) { return e instanceof B.UpstreamBackoffError ? "backoff" : "error"; } };
    // The windows are the daemon-wide backoff.upstream setting (src/backoff.ts), no longer a configure option.
    const K = await import(${JSON.stringify(url("backoff.js"))});
    K.configureBackoff({ ...K.DEFAULT_BACKOFF, upstream: { ...K.DEFAULT_BACKOFF.upstream, baseMs: 300, capMs: 2400 } });
    B.configureUpstreamBackoff({ notify: (t, l) => notes.push({ t, l, at: Date.now() }) });
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `${prelude}\n${body}`], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FOREMAN_GITHUB_TOKEN: "acceptance-fake",
      EM_GITHUB_TOKEN: "",
      FAKE_GH_LOG: files.log, FAKE_GH_RATE: files.rate, FAKE_GH_ERR: files.err,
    },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  try {
    return JSON.parse(line);
  } catch {
    const err = (r.stderr || r.stdout || "").split("\n").find((l) => /Error/.test(l));
    return { __error: (err || `exit ${r.status}`).trim() };
  }
}
const why = (o) => (o && o.__error ? o.__error : "");

try {
  // A1, A2, A3, A5, A8 — one episode: enter, refused calls, one failed probe, clear.
  const ep = runCase("episode", `
    writeFileSync(F.err, "HTTP 403: API rate limit exceeded for user ID 1.");
    rate(0, nowSec());
    const first = await call();
    const afterFirst = work().length, notesAfterFirst = notes.map((n) => n.t);
    const refused = []; for (let i = 0; i < 5; i++) refused.push(await call());
    const afterRefused = work().length;
    writeFileSync(F.err, "");
    await sleep(450);                       // first probe at ~300ms → still limited
    const extendNotes = notes.slice(1).map((n) => n.t);
    rate(5000, nowSec() + 3600);
    await sleep(900);                       // second probe at ~300+600ms → clear
    const p = probes().map((c) => c.ts);
    const resumed = await call();
    console.log(JSON.stringify({ first, afterFirst, notesAfterFirst, refused, afterRefused,
      extendNotes, probeTs: p, allNotes: notes.map((n) => n.t), resumed, workAfter: work().length }));
  `);
  check("A1 rate-limit stderr → gh() throws", ep.first === "error" || ep.first === "backoff", `got ${ep.first ?? why(ep)}`);
  check("A1 fake gh ran exactly once", ep.afterFirst === 1, `got ${ep.afterFirst}`);
  check("A1 one enter notify naming GitHub", ep.notesAfterFirst?.length === 1 && /backing off GitHub/.test(ep.notesAfterFirst[0]),
    JSON.stringify(ep.notesAfterFirst ?? null));
  check("A2 refused calls throw UpstreamBackoffError", ep.refused?.every((x) => x === "backoff"), JSON.stringify(ep.refused ?? null));
  check("A2 no gh spawn while backing off", ep.afterRefused === 1, `fake ran ${ep.afterRefused} time(s)`);
  check("A3 one 'still limited' notify on a failed probe",
    ep.extendNotes?.length === 1 && /still limited/.test(ep.extendNotes[0]), JSON.stringify(ep.extendNotes ?? null));
  check("A3 second window ≥ 2× base", ep.probeTs?.length >= 2 && ep.probeTs[1] - ep.probeTs[0] >= 550,
    JSON.stringify(ep.probeTs ?? null));
  check("A5 one 'cleared' notify", ep.allNotes?.filter((t) => /cleared/.test(t)).length === 1, JSON.stringify(ep.allNotes ?? null));
  check("A5 gh() spawns again after clear", ep.resumed === "ok" && ep.workAfter === 2, `resumed=${ep.resumed} work=${ep.workAfter}`);
  check("A8 notify count = enter + failed probes + clear", ep.allNotes?.length === 3, `got ${ep.allNotes?.length}`);

  // A4 — a stated reset later than the computed window is honoured.
  const a4 = runCase("reset", `
    writeFileSync(F.err, "HTTP 403: API rate limit exceeded for user ID 1.");
    const resetSec = nowSec() + 3;
    rate(0, resetSec);
    await call();
    await sleep(400);                       // first probe sees reset in ~2.6s
    rate(5000, nowSec() + 3600);
    await sleep(3400);
    console.log(JSON.stringify({ resetMs: resetSec * 1000, probeTs: probes().map((c) => c.ts) }));
  `);
  check("A4 next probe waits for the stated reset",
    a4.probeTs?.length >= 2 && a4.probeTs[1] >= a4.resetMs - 100, JSON.stringify(a4.__error ? why(a4) : a4));

  // A6 — the window never exceeds the cap.
  const a6 = runCase("cap", `
    writeFileSync(F.err, "HTTP 403: API rate limit exceeded for user ID 1.");
    rate(0, nowSec());
    await call();
    await sleep(300 + 600 + 1200 + 2400 + 2400 + 400);
    const p = probes().map((c) => c.ts);
    console.log(JSON.stringify({ gaps: p.slice(1).map((t, i) => t - p[i]), n: p.length }));
  `, 30_000);
  check("A6 ≥5 probes ran", a6.n >= 5, `got ${a6.n ?? why(a6)}`);
  check("A6 no gap exceeds capMs", Array.isArray(a6.gaps) && a6.gaps.every((g) => g <= 2400 + 250), JSON.stringify(a6.gaps ?? null));

  // A7 — classification of the refusal shapes.
  for (const [label, text, expect] of [
    ["HTTP 429", "HTTP 429: Too Many Requests (https://api.github.com/graphql)", true],
    ["HTTP 404", "HTTP 404: Not Found (https://api.github.com/repos/example/acceptance)", false],
  ]) {
    const r = runCase("classify", `
      writeFileSync(F.err, ${JSON.stringify(text)});
      rate(0, nowSec() + 3600);
      await call();
      console.log(JSON.stringify({ blocked: B.isUpstreamBlocked("github") }));
    `);
    check(`A7 ${label} ${expect ? "enters" : "does not enter"} back-off`, r.blocked === expect, `got ${r.blocked ?? why(r)}`);
  }

  // C1 — Claude session-limit classification from the verbatim result event.
  const verbatim = JSON.stringify({ type: "result", subtype: "success", is_error: true, num_turns: 1, api_error_status: 429,
    result: "You've hit your session limit · resets 12:10pm (America/Chicago)" });
  const c1 = runCase("detect", `
    const A = await import(${JSON.stringify(url("refusal.js"))});
    const hit = A.detectUpstreamLimit('{"type":"system"}\\n' + ${JSON.stringify(verbatim)});
    const plain = A.detectUpstreamLimit("You've hit your session limit · resets 12:10pm (America/Chicago)");
    const ok = A.detectUpstreamLimit(${JSON.stringify(JSON.stringify({ type: "result", is_error: false, result: "session limit mentioned in prose" }))});
    const noStatus = A.detectUpstreamLimit(${JSON.stringify(JSON.stringify({ type: "result", is_error: true, result: "boom" }))});
    const wall = hit?.resetAtMs ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true }).format(hit.resetAtMs) : null;
    const plainWall = plain?.resetAtMs ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true }).format(plain.resetAtMs) : null;
    console.log(JSON.stringify({ plainReason: plain?.reason ?? null, plainWall, reason: hit?.reason ?? null, resetAtMs: hit?.resetAtMs ?? null, wall, now: Date.now(),
      ok: ok === undefined, noStatus: noStatus === undefined }));
  `);
  check("C1 session limit detected", /session limit/.test(c1.reason ?? ""), `got ${c1.reason ?? why(c1)}`);
  check("C1 reset resolves to the next 12:10 PM America/Chicago",
    c1.wall === "12:10 PM" && c1.resetAtMs > c1.now && c1.resetAtMs - c1.now <= 24 * 3600 * 1000, `got ${c1.wall} @ ${c1.resetAtMs}`);
  check("C1 plain-text (implement/revise) refusal detected", /session limit/.test(c1.plainReason ?? ""), `got ${c1.plainReason ?? why(c1)}`);
  check("C1 plain-text reset resolves to 12:10 PM America/Chicago", c1.plainWall === "12:10 PM", `got ${c1.plainWall}`);
  check("C1 is_error:false → not a limit", c1.ok === true, why(c1));
  check("C1 is_error without api_error_status → not a limit", c1.noStatus === true, why(c1));

  // C2 — Claude half-open: one launch per elapsed window is the probe.
  const c2 = runCase("claude", `
    B.reportRunResult("claude", true, "session limit");
    const inWindow = B.tryAcquire("claude");
    B.reportRunResult("claude", true, "session limit");   // a concurrent session refused in the same window
    const notesInWindow = notes.length;
    await sleep(400);
    const probe = B.tryAcquire("claude");
    const second = B.tryAcquire("claude");
    B.reportRunResult("claude", false);
    const afterClear = [B.tryAcquire("claude"), B.tryAcquire("claude")];
    console.log(JSON.stringify({ inWindow, notesInWindow, probe, second, afterClear, notes: notes.map((n) => n.t) }));
  `);
  check("C2 blocked inside the window", c2.inWindow === false, `got ${c2.inWindow ?? why(c2)}`);
  check("C2 a second refusal inside the window sends no message", c2.notesInWindow === 1, `got ${c2.notesInWindow}`);
  check("C2 exactly one acquire after the window", c2.probe === true && c2.second === false, `probe=${c2.probe} second=${c2.second}`);
  check("C2 non-limit result clears", Array.isArray(c2.afterClear) && c2.afterClear.every(Boolean), JSON.stringify(c2.afterClear ?? null));
  check("C2 enter + clear notifies name the runner (claude)",
    c2.notes?.length === 2 && /backing off claude/.test(c2.notes[0]) && /cleared/.test(c2.notes[1]), JSON.stringify(c2.notes ?? null));

  // C3 — a limit-caused failure is returned before the phase's counter increment.
  // The phases moved to dist/phases/*.js and their counters to the runtime's phase memory (rt.memory).
  for (const [fn, file, counter] of [
    ["tryBatchImplementation", "implement.js", "failureCount.set(repoName, newCount)"],
    ["tryRevision", "revise.js", "revisionFailureCount.set(repoName, newCount)"],
    ["tryReview", "review.js", "reviewFailureCount.set(repoName, newCount)"],
  ]) {
    const orchPath = join(DIST, "phases", file);
    const orch = existsSync(orchPath) ? readFileSync(orchPath, "utf8") : "";
    const start = orch.indexOf(`async function ${fn}(`);
    const inc = start < 0 ? -1 : orch.indexOf(counter, start);
    // The guard is an `if (result.upstreamLimit || isUpstreamBlocked("github"))` that returns before the
    // increment. Its body is a block (it emits the Blocked card first, then returns), so allow any
    // statements between the `{` and the `return`; the slice ends at the increment, so the return is before it.
    const before = inc > 0 ? orch.slice(start, inc) : "";
    const guard = /if\s*\(\s*result\.upstreamLimit\s*\|\|\s*(\w+\.)?isUpstreamBlocked\(\s*["']github["']\s*\)\s*\)\s*(\{[\s\S]*?)?\breturn\b/.test(before);
    check(`C3 ${fn}: \`if (result.upstreamLimit || isUpstreamBlocked("github")) return\` precedes ${counter.split(".")[0]} increment`,
      start >= 0 && inc > 0 && guard, `fn@${start} inc@${inc}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
