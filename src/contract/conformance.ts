import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readResultV1, RESULT_V1_TOKEN, ROLES, type ResultRole } from "./result-v1.js";
import type { ContractUsage } from "./usage.js";

/**
 * The conformance kit (foreman#268): checks that prove an agent, or the Foreman
 * itself, speaks contract v1. Pure apart from reading the skills directory;
 * the CLI (`foreman-conformance`) runs agents and prints.
 *
 * - F1 lives with the parser it tests (`github/title-check.ts`).
 * - F2: every `FOREMAN_RESULT_V1` example in a shipped skill parses.
 * - C1: an agent's output ends in a valid line for its role.
 * - C2: two runs on the same input give the same non-text fields, the error
 *   `signature` included (the agent owns it, so it must be deterministic).
 */
/** One check's result; every kit check returns these. */
export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

/** F2. Every example line in `skillsDir/<name>/SKILL.md` must read as valid for the role it names. */
export function checkSkillExamples(skillsDir: string): Check[] {
  const out: Check[] = [];
  if (!existsSync(skillsDir)) return [{ id: "F2", ok: false, detail: `no skills directory at ${skillsDir}` }];
  for (const name of readdirSync(skillsDir).sort()) {
    const file = join(skillsDir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trimStart().startsWith(`${RESULT_V1_TOKEN} `));
    lines.forEach((line, i) => {
      const role = /"role"\s*:\s*"([a-z]+)"/.exec(line)?.[1] as ResultRole | undefined;
      if (!role || !(ROLES as readonly string[]).includes(role)) {
        out.push({ id: `F2 ${name}#${i + 1}`, ok: false, detail: `no known role in: ${line.trim()}` });
        return;
      }
      const prMatch = /"pr"\s*:\s*(\d+)/.exec(line);
      const r = readResultV1(line, role, prMatch ? Number(prMatch[1]) : undefined);
      out.push({ id: `F2 ${name}#${i + 1}`, ok: r.status === "ok", detail: r.status === "invalid" ? r.problem : `${role} ${r.status}` });
    });
  }
  if (!out.length) out.push({ id: "F2", ok: false, detail: `no ${RESULT_V1_TOKEN} example in any skill under ${skillsDir}` });
  return out;
}

/** C1. One agent run's output, read as the Foreman reads it. */
export function checkAgentOutput(stdout: string, role: ResultRole, pr?: number): Check {
  const r = readResultV1(stdout, role, pr);
  if (r.status === "ok") return { id: "C1", ok: true, detail: `${role}: valid` };
  return { id: "C1", ok: false, detail: r.status === "absent" ? `${role}: no ${RESULT_V1_TOKEN} line` : `${role}: ${r.problem}` };
}

/** Fields that describe one run and decide nothing: prose, links, and an error's own time and count. */
const RUN_FIELDS = new Set(["text", "evidence", "first_seen", "count"]);

/** The fields that decide: everything but `*_text` and the run fields above. */
export function decidingFields(result: Record<string, unknown>): unknown {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !k.endsWith("_text") && !RUN_FIELDS.has(k))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, strip(x)]),
      );
    }
    return v;
  };
  return strip(result);
}

/** C2. Two runs on the same input must agree on every deciding field. */
export function checkDeterministic(a: string, b: string, role: ResultRole, pr?: number): Check {
  const ra = readResultV1(a, role, pr);
  const rb = readResultV1(b, role, pr);
  if (ra.status !== "ok" || rb.status !== "ok") return { id: "C2", ok: false, detail: "both runs must pass C1 first" };
  const ja = JSON.stringify(decidingFields(ra.result as Record<string, unknown>));
  const jb = JSON.stringify(decidingFields(rb.result as Record<string, unknown>));
  return { id: "C2", ok: ja === jb, detail: ja === jb ? "deciding fields match across runs" : `run 1 ${ja} ≠ run 2 ${jb}` };
}

/** One `contract-usage.json` entry's legacy state: zero once its last legacy answer is over 30 days old. */
export interface UsageRow {
  key: string;
  v1: number;
  legacy: number;
  invalid: number;
  lastLegacy: string | null;
  legacyZero: boolean;
}

export const LEGACY_ZERO_DAYS = 30;

export function usageRows(usage: ContractUsage, nowMs: number): UsageRow[] {
  return Object.keys(usage).sort().map((key) => {
    const e = usage[key] ?? {};
    const lastLegacy = e.legacy?.last ?? null;
    const age = lastLegacy ? nowMs - Date.parse(lastLegacy) : Infinity;
    return {
      key,
      v1: e.v1?.count ?? 0,
      legacy: e.legacy?.count ?? 0,
      invalid: e.invalid?.count ?? 0,
      lastLegacy,
      legacyZero: age > LEGACY_ZERO_DAYS * 86_400_000,
    };
  });
}
