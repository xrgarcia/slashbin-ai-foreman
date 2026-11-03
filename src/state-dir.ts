import { join } from "node:path";

// The directory the Foreman's local files sit in: the GitHub snapshot cache (`.github-state.json`, rebuildable)
// and, until the one-time import has moved it, the legacy `.agent-state.json` (legacy-records.ts).
//
// FOREMAN_STATE_DIR is set by `npm test` only. Without it a test run in the live checkout read and wrote the
// daemon's own state file: on 2026-10-30 a test recorded a skip for its fake repo "ws" there, and
// acceptance-gate R2 failed on it from then on.
let dir = process.env.FOREMAN_STATE_DIR ?? ".";

/** Point the Foreman's local files at `to` (tests, and the CLI when a state directory is configured). */
export function setStateDir(to: string): void {
  dir = to;
}

/** The directory the Foreman's local files live in. */
export function stateDir(): string {
  return dir;
}

/** The legacy state file the one-time import reads and finally deletes. Nothing else may touch it. */
export function legacyStatePath(): string {
  return join(dir, ".agent-state.json");
}
