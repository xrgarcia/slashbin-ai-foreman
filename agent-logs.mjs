// Where `npm run status` and `npm run logs` read the daemon's recent log from
// (slashbin-ai-foreman#42).
//
// A daemon run by the systemd user unit logs to journald; `agent.log` is only written by a daemon
// that `agent-manager.mjs start` spawned itself. Tailing the file while systemd runs the daemon
// printed whatever the last file-run ended with (a stale "Shutting down..."), as if it were live.
// So: ask journald when the unit is installed and answers; otherwise read the file, and say how
// old it is when it is not fresh.

/** A log file not written for this long is not what a running daemon is printing. */
export const STALE_LOG_MS = 5 * 60 * 1000;

/** "45s", "12m", "5h", "3d": the largest whole unit. */
export function describeAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** `systemctl --user show -p ActiveState -p MainPID -p ActiveEnterTimestamp` -> the unit's live state. */
export function parseUnitShow(text) {
  const kv = Object.fromEntries(String(text).split("\n").map((l) => { const i = l.indexOf("="); return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1).trim()]; }));
  const mainPid = parseInt(kv.MainPID, 10) || 0;
  return { active: kv.ActiveState === "active" && mainPid > 0, mainPid, startedAt: kv.ActiveEnterTimestamp || "" };
}

/** The time of a `journalctl -o short-iso` line (`2026-11-09T06:03:58-0600 host unit[pid]: msg`), or null. */
export function journalLineTime(line) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:[.,]\d+)?([+-])(\d{2}):?(\d{2})/.exec(line);
  if (!m) return null;
  const t = Date.parse(`${m[1]}${m[2]}${m[3]}:${m[4]}`);
  return Number.isNaN(t) ? null : t;
}

/**
 * The last `count` log lines and where they came from.
 *
 * Journald lines are shown as current only when the unit is active, they are from its current run
 * (`since` its start) and the newest is within STALE_LOG_MS of now. Anything else is still shown
 * but labelled, so an old "Shutting down..." never reads as live.
 *
 * @param {object} o
 * @param {string|null} o.unit      the systemd user unit that manages the daemon, or null when there is none
 * @param {{ active: boolean, mainPid: number, startedAt: string } | null} [o.state]  the unit's live state
 * @param {string} o.logFile        the path `agent-manager.mjs start` logs to
 * @param {number} o.count
 * @param {(unit: string, count: number, since: string | null) => string} o.journal   `-o short-iso` lines; may throw
 * @param {(file: string) => { text: string, mtimeMs: number }} o.readFile   may throw when there is no file
 * @param {number} [o.now]
 * @returns {{ source: string, lines: string[], note: string | null } | null}  null: nothing to show
 */
export function recentLogs({ unit, state = null, logFile, count, journal, readFile, now = Date.now() }) {
  if (unit) {
    try {
      const active = Boolean(state?.active);
      const lines = journal(unit, count, active && state.startedAt ? state.startedAt : null).trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const newest = journalLineTime(lines[lines.length - 1]);
        let note = null;
        if (!active) note = `${unit} is not running: these journal lines are historical${newest ? `, the newest ${describeAge(now - newest)} old` : ""}`;
        else if (newest !== null && now - newest > STALE_LOG_MS) note = `the newest journal line is ${describeAge(now - newest)} old: the daemon has logged nothing since, so these lines may be stale`;
        return { source: `journald (${unit})`, lines, note };
      }
    } catch { /* journald not readable here: fall back to the file, labelled */ }
  }
  let file;
  try {
    file = readFile(logFile);
  } catch {
    return null;
  }
  const lines = file.text.trim().split("\n").filter(Boolean).slice(-count);
  if (lines.length === 0) return null;
  const age = now - file.mtimeMs;
  const note = age > STALE_LOG_MS
    ? `${logFile} was last written ${describeAge(age)} ago${unit ? `; this daemon runs under ${unit} and logs to journald, which could not be read` : ""} — these lines may be stale`
    : null;
  return { source: logFile, lines, note };
}
