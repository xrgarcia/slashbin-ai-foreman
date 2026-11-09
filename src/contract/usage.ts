import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../state-dir.js";

/**
 * Which path each agent's answer took: `v1` (a valid FOREMAN_RESULT_V1 line),
 * `legacy` (no v1 line, the old trailer read instead) or `invalid` (a v1 line
 * that failed its schema). The legacy trailers sunset per agent 30 days after
 * that agent ships v1, and only once its `legacy` entry has a last time more than 30 days old; this
 * file is what that decision reads (`foreman-conformance usage`).
 *
 * Kept in `<stateDir>/contract-usage.json`. A lost file only resets the counts:
 * it is evidence for a person, never an input to a release decision.
 */
export type ContractPath = "v1" | "legacy" | "invalid";

export interface PathCount { count: number; last: string }
export type ContractUsage = Record<string, Partial<Record<ContractPath, PathCount>>>;

const FILE = "contract-usage.json";
const loggedLegacy = new Set<string>();

export function contractUsagePath(): string {
  return join(stateDir(), FILE);
}

export function readContractUsage(): ContractUsage {
  try {
    const v = JSON.parse(readFileSync(contractUsagePath(), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as ContractUsage) : {};
  } catch {
    return {};
  }
}

/**
 * Count one answer from `agent` in `role` by the path it took. Logs the first
 * legacy answer per agent and role in this process, so the log shows who has
 * not moved without repeating it every poll. Never throws: a metric write that
 * fails must not fail a release.
 */
export function recordContractPath(
  agent: string,
  role: string,
  path: ContractPath,
  log?: (msg: string) => void,
  now = new Date(),
): void {
  const key = `${agent}:${role}`;
  if (path === "legacy" && !loggedLegacy.has(key)) {
    loggedLegacy.add(key);
    log?.(`contract: ${agent} answered as ${role} on the legacy trailer (no FOREMAN_RESULT_V1 line)`);
  }
  try {
    const usage = readContractUsage();
    const entry = (usage[key] ??= {});
    const prev = entry[path];
    entry[path] = { count: (prev?.count ?? 0) + 1, last: now.toISOString() };
    const file = contractUsagePath();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(usage, null, 2) + "\n");
    renameSync(tmp, file);
  } catch {
    // best effort: see above
  }
}
