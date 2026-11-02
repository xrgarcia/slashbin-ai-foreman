// Test helper: the legacy `.agent-state.json`, as a plain file. src/state.ts is gone (EM#1244 f4); the one-time
// import (src/legacy-records.ts) is the only code that reads the file, so tests write fixtures and read results
// through the file itself.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../dist/state-dir.js";

export const legacyFile = () => join(stateDir(), ".agent-state.json");

/** The parsed file; `{ version: 2, repos: {} }` when absent. */
export function readLegacy() {
  return existsSync(legacyFile()) ? JSON.parse(readFileSync(legacyFile(), "utf-8")) : { version: 2, repos: {} };
}

export function writeLegacy(file) {
  writeFileSync(legacyFile(), JSON.stringify({ version: 2, repos: {}, ...file }, null, 2) + "\n");
}

export function removeLegacy() {
  rmSync(legacyFile(), { force: true });
}

/** What the file holds for one repo ({} when none). */
export function loadRepoState(name) {
  return readLegacy().repos[name] ?? {};
}

/** Replace one repo's entry in the file. */
export function saveRepoState(name, state) {
  const file = readLegacy();
  file.repos[name] = state;
  writeLegacy(file);
}

/** The issue numbers the file still holds an entry for, in `name`. */
export function legacyIssueEntries(name) {
  const repo = loadRepoState(name);
  const out = new Map();
  const entry = (n) => out.get(n) ?? out.set(n, {}).get(n);
  for (const f of ["failed", "skipped", "held", "verifyHeld", "prodVerified"]) {
    for (const k of Object.keys(repo[f] ?? {})) if (Number(k) > 0) entry(Number(k))[f] = repo[f][k];
  }
  for (const [k, e] of Object.entries(repo.unstick ?? {})) if (e.issue > 0) entry(e.issue).unstick = { ...(entry(e.issue).unstick ?? {}), [k]: e };
  for (const n of repo.promotionStallNoted ?? []) entry(n).promotionStallNoted = true;
  return out;
}

/** What the file still holds that a PR or branch keys, in `name`. */
export function legacyPrEntries(name) {
  const repo = loadRepoState(name);
  return {
    releases: new Map(Object.entries(repo.prodReleases ?? {}).map(([k, v]) => [Number(k), v])),
    streaks: new Map(Object.entries(repo.noCommitStreaks ?? {}).map(([k, v]) => [Number(k), v])),
    rejected: new Map(Object.entries(repo.rejectedBranches ?? {})),
    ...(repo.release ? { tracked: repo.release } : {}),
  };
}
