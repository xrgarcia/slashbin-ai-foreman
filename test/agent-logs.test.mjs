// `npm run status` / `npm run logs` show the log the running daemon actually writes
// (slashbin-ai-foreman#42): journald under the systemd unit, otherwise agent.log with its age
// when it is stale. The bug: agent.log was tailed under systemd and printed an old "Shutting down...".
import { test } from "node:test";
import assert from "node:assert/strict";
import { recentLogs, describeAge, STALE_LOG_MS } from "../agent-logs.mjs";

const NOW = 1_800_000_000_000;
const staleFile = (ageMs) => (f) => ({ text: "a\nShutting down...\n", mtimeMs: NOW - ageMs });
const noJournal = () => { throw new Error("journalctl not available"); };

test("under the systemd unit the lines come from journald, not agent.log", () => {
  let fileRead = false;
  const r = recentLogs({
    unit: "slashbin-foreman.service", logFile: "agent.log", count: 5, now: NOW,
    journal: (u, n) => { assert.equal(u, "slashbin-foreman.service"); assert.equal(n, 5); return "live 1\nlive 2\n"; },
    readFile: () => { fileRead = true; return { text: "Shutting down...", mtimeMs: 0 }; },
  });
  assert.deepEqual(r, { source: "journald (slashbin-foreman.service)", lines: ["live 1", "live 2"], note: null });
  assert.equal(fileRead, false, "the stale file is not consulted when journald answers");
});

test("no unit: the file is the source, and a fresh file has no stale note", () => {
  const r = recentLogs({ unit: null, logFile: "agent.log", count: 5, now: NOW, journal: noJournal, readFile: staleFile(30_000) });
  assert.equal(r.source, "agent.log");
  assert.deepEqual(r.lines, ["a", "Shutting down..."]);
  assert.equal(r.note, null);
});

test("a stale file is labelled with its age", () => {
  const r = recentLogs({ unit: null, logFile: "agent.log", count: 5, now: NOW, journal: noJournal, readFile: staleFile(3 * 86400_000 + 1000) });
  assert.match(r.note, /last written 3d ago/);
  assert.match(r.note, /may be stale/);
  const edge = recentLogs({ unit: null, logFile: "agent.log", count: 5, now: NOW, journal: noJournal, readFile: staleFile(STALE_LOG_MS) });
  assert.equal(edge.note, null, "exactly at the threshold is not yet stale");
});

test("the unit is installed but journald cannot be read: fall back to the file and say why it may be stale", () => {
  const r = recentLogs({ unit: "slashbin-foreman.service", logFile: "agent.log", count: 5, now: NOW, journal: noJournal, readFile: staleFile(2 * 3600_000) });
  assert.equal(r.source, "agent.log");
  assert.match(r.note, /last written 2h ago/);
  assert.match(r.note, /runs under slashbin-foreman\.service and logs to journald/);
});

test("empty journald output also falls back; no file and no journal is null; only the last `count` file lines show", () => {
  const empty = recentLogs({ unit: "u.service", logFile: "f", count: 1, now: NOW, journal: () => "\n", readFile: staleFile(0) });
  assert.equal(empty.source, "f");
  assert.deepEqual(empty.lines, ["Shutting down..."]);
  assert.equal(recentLogs({ unit: null, logFile: "f", count: 5, journal: noJournal, readFile: () => { throw new Error("ENOENT"); } }), null);
  assert.equal(recentLogs({ unit: null, logFile: "f", count: 5, journal: noJournal, readFile: () => ({ text: "  \n", mtimeMs: 0 }) }), null);
});

test("describeAge names the largest whole unit", () => {
  assert.deepEqual([45_000, 12 * 60_000, 5 * 3600_000, 3 * 86400_000, -5].map(describeAge), ["45s", "12m", "5h", "3d", "0s"]);
});
