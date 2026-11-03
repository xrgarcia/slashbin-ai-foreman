import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Session secret gate: the PreToolUse hook every Claude session runs under.

/**
 * The PreToolUse hook every session runs under (hooks/session-secret-gate.mjs).
 * Resolved from this file's location for the same reason as FOREMAN_OVERRIDES.
 */
export const SESSION_SECRET_GATE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "session-secret-gate.mjs"
);

/**
 * The `--settings` JSON passed to every Claude session: a Bash PreToolUse hook
 * that blocks commands printing an environment or credential value. Sessions
 * hold GH_TOKEN and run with --dangerously-skip-permissions inside the service
 * repo, so neither a permission prompt nor that repo's own hooks stand between
 * a session and `env` — and what a session prints lands in its transcript,
 * which the Foreman's log redaction never sees. Passed with --settings so it
 * applies whatever the service repo's settings say (they merge; this adds).
 * The node binary is absolute: a systemd PATH may not carry it.
 */
/** Bash, plus every tool that returns file content to the transcript. */
export const SESSION_SECRET_GATE_TOOLS = "Bash|Read|Grep|Edit|MultiEdit|NotebookEdit|NotebookRead";
export function sessionSettings(): string {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(SESSION_SECRET_GATE)}`;
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: SESSION_SECRET_GATE_TOOLS, hooks: [{ type: "command", command }] }] },
  });
}
