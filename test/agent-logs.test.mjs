// `npm run status` / `npm run logs` show the log and the identity of the daemon that is actually running
// (slashbin-ai-foreman#42). The bug: agent.log was tailed under systemd and printed an old "Shutting down...",
// and status named the PID file's process rather than the unit's.
//
// Unit cases drive recentLogs() with injected readers; the CLI cases copy agent-manager.mjs to a temp dir
// with a fake `systemctl` and `journalctl` first on PATH and run `status` / `logs` as the operator does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { recentLogs, describeAge, parseUnitShow, journalLineTime, STALE_LOG_MS } from "../agent-logs.mjs";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const UNIT = "slashbin-foreman.service";
const ACTIVE = { active: true, mainPid: 3011437, startedAt: "Mon 2026-11-09 05:00:00 CST" };
const STOPPED = { active: false, mainPid: 0, startedAt: "" };
const fileAged = (ageMs) => () => ({ text: "a\nShutting down...\n", mtimeMs: NOW - ageMs });
const noJournal = () => { throw new Error("journalctl not available"); };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "+0000");
const line = (ms, msg) => `${iso(ms)} host node[1]: ${msg}`;

test("an active unit: journald from the unit's current run, and the file is never read", () => {
  let since = null;
  let fileRead = false;
  const r = recentLogs({
    unit: UNIT, state: ACTIVE, logFile: "agent.log", count: 5, now: NOW,
    journal: (u, n, s) => { since = s; return `${line(NOW - 5000, "live 1")}\n${line(NOW - 1000, "live 2")}\n`; },
    readFile: () => { fileRead = true; return { text: "Shutting down...", mtimeMs: 0 }; },
  });
  assert.equal(since, ACTIVE.startedAt, "asks only for this run's lines");
  assert.equal(r.source, `journald (${UNIT})`);
  assert.equal(r.lines.length, 2);
  assert.equal(r.note, null);
  assert.equal(fileRead, false);
});

test("an active unit whose newest journal line is old is labelled stale", () => {
  const r = recentLogs({ unit: UNIT, state: ACTIVE, logFile: "f", count: 5, now: NOW, journal: () => line(NOW - 54 * 3600_000, "Shutting down..."), readFile: fileAged(0) });
  assert.match(r.note, /newest journal line is 2d old/);
  assert.match(r.note, /may be stale/);
});

test("a stopped unit: retained journal lines are labelled historical, never presented as current", () => {
  const r = recentLogs({ unit: UNIT, state: STOPPED, logFile: "f", count: 5, now: NOW, journal: (u, n, s) => { assert.equal(s, null); return line(NOW - 54 * 3600_000, "Shutting down..."); }, readFile: fileAged(0) });
  assert.match(r.note, /is not running: these journal lines are historical, the newest 2d old/);
});

test("no unit: the file is the source; fresh is unlabelled, stale carries its age", () => {
  const fresh = recentLogs({ unit: null, logFile: "agent.log", count: 5, now: NOW, journal: noJournal, readFile: fileAged(30_000) });
  assert.equal(fresh.source, "agent.log");
  assert.equal(fresh.note, null);
  const stale = recentLogs({ unit: null, logFile: "agent.log", count: 5, now: NOW, journal: noJournal, readFile: fileAged(3 * 86400_000 + 1000) });
  assert.match(stale.note, /last written 3d ago/);
  assert.equal(recentLogs({ unit: null, logFile: "f", count: 5, now: NOW, journal: noJournal, readFile: fileAged(STALE_LOG_MS) }).note, null, "the threshold itself is not yet stale");
});

test("unit installed but journald unreadable: fall back to the file and say why it may be stale", () => {
  const r = recentLogs({ unit: UNIT, state: ACTIVE, logFile: "agent.log", count: 5, now: NOW, journal: noJournal, readFile: fileAged(2 * 3600_000) });
  assert.equal(r.source, "agent.log");
  assert.match(r.note, /last written 2h ago/);
  assert.match(r.note, /logs to journald, which could not be read/);
});

test("empty journald falls back; no file and no journal is null; only the last `count` file lines show", () => {
  const empty = recentLogs({ unit: UNIT, state: ACTIVE, logFile: "f", count: 1, now: NOW, journal: () => "\n", readFile: fileAged(0) });
  assert.deepEqual(empty.lines, ["Shutting down..."]);
  assert.equal(recentLogs({ unit: null, logFile: "f", count: 5, journal: noJournal, readFile: () => { throw new Error("ENOENT"); } }), null);
  assert.equal(recentLogs({ unit: null, logFile: "f", count: 5, journal: noJournal, readFile: () => ({ text: "  \n", mtimeMs: 0 }) }), null);
});

test("parsers: systemctl show, journal line time, age", () => {
  assert.deepEqual(parseUnitShow("ActiveState=active\nMainPID=3011437\nActiveEnterTimestamp=Fri 2026-09-25 12:46:29 CDT\n"), { active: true, mainPid: 3011437, startedAt: "Fri 2026-09-25 12:46:29 CDT" });
  assert.equal(parseUnitShow("ActiveState=inactive\nMainPID=0\nActiveEnterTimestamp=\n").active, false);
  assert.equal(journalLineTime("2026-11-09T06:00:00-0600 host node[1]: x"), Date.parse("2026-11-09T12:00:00Z"));
  assert.equal(journalLineTime("no timestamp here"), null);
  assert.deepEqual([45_000, 12 * 60_000, 5 * 3600_000, 3 * 86400_000, -5].map(describeAge), ["45s", "12m", "5h", "3d", "0s"]);
});

// --- The CLI, as the operator runs it ----------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

/** A fresh copy of the manager with fake systemctl/journalctl; `unitActive` toggles the unit, the PID file is left to the caller. */
function cli({ unitActive, journal, pidFile }) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-status-"));
  for (const f of ["agent-manager.mjs", "agent-logs.mjs"]) copyFileSync(join(here, "..", f), join(dir, f));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
case "$*" in
  *is-enabled*) echo enabled ;;
  *show*) if [ "${unitActive}" = yes ]; then printf 'ActiveState=active\\nMainPID=3011437\\nActiveEnterTimestamp=Fri 2026-09-25 12:46:29 CDT\\n'; else printf 'ActiveState=inactive\\nMainPID=0\\nActiveEnterTimestamp=\\n'; fi ;;
esac
`);
  writeFileSync(join(bin, "journalctl"), `#!/bin/sh\ncat <<'EOF'\n${journal}\nEOF\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "journalctl"), 0o755);
  // An agent.log that has not changed in days, as in the report.
  writeFileSync(join(dir, "agent.log"), "[old] Shutting down...\n");
  const old = new Date(Date.now() - 3 * 86400_000);
  utimesSync(join(dir, "agent.log"), old, old);
  if (pidFile !== undefined) writeFileSync(join(dir, ".agent.pid"), String(pidFile));
  const run = (cmd) => spawnSync(process.execPath, [join(dir, "agent-manager.mjs"), cmd], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  return { run };
}

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "+0000");

test("CLI status, unit active, PID file names a different process: reports the unit's MainPID and start time and live lines", () => {
  const { run } = cli({ unitActive: "yes", journal: `${nowIso()} host node[1]: live line`, pidFile: process.pid });
  const out = run("status").stdout;
  assert.match(out, /running under slashbin-foreman\.service \(MainPID 3011437\)/);
  assert.match(out, /Started: Fri 2026-09-25 12:46:29 CDT/);
  assert.match(out, /live line/);
  assert.doesNotMatch(out, /Shutting down/);
  assert.doesNotMatch(out, new RegExp(`PID ${process.pid}`));
});

test("CLI status, unit active, PID file absent: still reports the unit", () => {
  const { run } = cli({ unitActive: "yes", journal: `${nowIso()} host node[1]: live line` });
  assert.match(run("status").stdout, /running under slashbin-foreman\.service \(MainPID 3011437\)/);
});

test("CLI status, unit stopped and no PID file: not running, no stale line shown as current", () => {
  const { run } = cli({ unitActive: "no", journal: "2026-09-25T17:45:24+0000 host node[1]: Shutting down..." });
  const out = run("status").stdout;
  assert.match(out, /is not running \(slashbin-foreman\.service is not active\)/);
  assert.doesNotMatch(out, /Recent logs/);
});

test("CLI logs, unit stopped: the retained journal line is labelled historical on stdout", () => {
  const { run } = cli({ unitActive: "no", journal: "2026-09-25T17:45:24+0000 host node[1]: Shutting down..." });
  const out = run("logs").stdout;
  assert.match(out, /# \[stale\] slashbin-foreman\.service is not running: these journal lines are historical/);
  assert.match(out, /Shutting down/);
});
