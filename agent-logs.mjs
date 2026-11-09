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

/**
 * The last `count` log lines and where they came from.
 *
 * @param {object} o
 * @param {string|null} o.unit      the systemd user unit running the daemon, or null when there is none
 * @param {string} o.logFile        the path `agent-manager.mjs start` logs to
 * @param {number} o.count
 * @param {(unit: string, count: number) => string} o.journal   journald's last lines for the unit; may throw
 * @param {(file: string) => { text: string, mtimeMs: number }} o.readFile   may throw when there is no file
 * @param {number} [o.now]
 * @returns {{ source: string, lines: string[], note: string | null } | null}  null: nothing to show
 */
export function recentLogs({ unit, logFile, count, journal, readFile, now = Date.now() }) {
  if (unit) {
    try {
      const lines = journal(unit, count).trim().split("\n").filter(Boolean);
      if (lines.length > 0) return { source: `journald (${unit})`, lines, note: null };
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
