#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkAgentOutput, checkDeterministic, checkSkillExamples, usageRows, type Check } from "../contract/conformance.js";
import { readContractUsage, contractUsagePath } from "../contract/usage.js";
import { ROLES, type ResultRole } from "../contract/result-v1.js";
import { checkTitlesParse } from "../github/title-check.js";

/**
 * foreman-conformance (foreman#268): prove an agent speaks contract v1.
 *
 *   foreman-conformance foreman-self-check [--skills <dir>]
 *   foreman-conformance run --role <role> [--pr N] [--runs 2] --cmd "<command>"
 *   foreman-conformance check --role <role> [--pr N] --file <captured-output>
 *   foreman-conformance usage [--json]
 *
 * Exit 0 = every check passed, 1 = a check failed, 2 = bad arguments.
 *
 * Under plugins/ because F1 tests the GitHub plugin's own parser; the checks themselves are core
 * (`contract/conformance.ts`).
 */

/** Run `cmd` in a shell and resolve with its stdout. */
function runShell(cmd: string): Promise<string> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { out += d; });
    child.on("error", () => resolveRun(out));
    child.on("close", () => resolveRun(out));
  });
}
const USAGE = `usage:
  foreman-conformance foreman-self-check [--skills <dir>]
  foreman-conformance run --role <${ROLES.join("|")}> [--pr N] [--runs 2] --cmd "<command>"
  foreman-conformance check --role <role> [--pr N] --file <captured-output>
  foreman-conformance usage [--json]`;

const args = process.argv.slice(2);
const sub = args[0];
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function report(checks: Check[]): never {
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.id}  ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `${failed} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

function roleArg(): ResultRole {
  const role = opt("role");
  if (!role || !(ROLES as readonly string[]).includes(role)) {
    console.error(`--role must be one of ${ROLES.join(", ")}\n${USAGE}`);
    process.exit(2);
  }
  return role as ResultRole;
}

const prArg = (): number | undefined => (opt("pr") ? Number(opt("pr")) : undefined);

if (sub === "foreman-self-check") {
  const skills = opt("skills") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
  report([...checkTitlesParse(), ...checkSkillExamples(skills)]);
} else if (sub === "run") {
  const role = roleArg();
  const cmd = opt("cmd");
  if (!cmd) {
    console.error(USAGE);
    process.exit(2);
  }
  const runs = Math.max(1, Number(opt("runs") ?? 1));
  const outs: string[] = [];
  for (let i = 0; i < runs; i++) {
    outs.push(await runShell(cmd));
  }
  const checks = outs.map((o, i) => ({ ...checkAgentOutput(o, role, prArg()), id: `C1 run ${i + 1}` }));
  if (outs.length > 1) checks.push(checkDeterministic(outs[0], outs[1], role, prArg()));
  report(checks);
} else if (sub === "check") {
  const role = roleArg();
  const file = opt("file");
  if (!file) {
    console.error(USAGE);
    process.exit(2);
  }
  report([checkAgentOutput(readFileSync(file, "utf8"), role, prArg())]);
} else if (sub === "usage") {
  const rows = usageRows(readContractUsage(), Date.now());
  if (args.includes("--json")) {
    console.log(JSON.stringify({ file: contractUsagePath(), rows }, null, 2));
  } else {
    console.log(`# ${contractUsagePath()}`);
    if (!rows.length) console.log("no answers recorded yet");
    for (const r of rows) {
      console.log(`${r.key}  v1=${r.v1} legacy=${r.legacy} invalid=${r.invalid} last-legacy=${r.lastLegacy ?? "never"}  ${r.legacyZero ? "legacy reads zero" : "legacy in use"}`);
    }
  }
  process.exit(0);
} else {
  console.error(USAGE);
  process.exit(2);
}
