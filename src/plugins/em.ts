import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { pickEnv, SESSION_ENV_ESSENTIALS } from "../session/env.js";
import { cliTail, lastLine, runAgentCli, type CliRun } from "./agent-cli.js";
import { detectRefusal } from "../refusal.js";
import type { ForemanPlugin, Unsticker, UnstickOutcome, PluginCatalogEntry } from "./contract.js";

/**
 * The EM (`<emRepoPath>/bin/em.mjs`) as the unstick plugin (#103, EM#1150 f3):
 * stuck work goes to it. On when `emRepoPath` is set.
 */

/**
 * The EM unstick call's environment (#103). The EM acts as itself: it receives
 * the existing EM_GITHUB_TOKEN by name (never the Foreman's, the Tech Lead's or
 * the SRE's) plus the session essentials and any configured sessionEnv.
 */
export function buildEmEnv(agentConfig: AgentConfig): Record<string, string> {
  const env = pickEnv([...SESSION_ENV_ESSENTIALS, ...(agentConfig.sessionEnv ?? [])]);
  pickEnv(["EM_GITHUB_TOKEN"], env);
  return env;
}

/** How long one `em.mjs unstick` call may run before it is killed (#103). */
export const EM_UNSTICK_MAX_DURATION_MS = 20 * 60_000;
/**
 * A rework decision files and approves a corrective, so the EM gives it a 38-minute session
 * (`sessionBudget`, bin/em.mjs). 20 minutes killed Slashbin-console#1552's on 2026-10-31.
 */
export const EM_UNSTICK_REWORK_MAX_DURATION_MS = 40 * 60_000;
export function emUnstickMaxDurationMs(kind: string): number {
  return kind === "rework-decision" ? EM_UNSTICK_REWORK_MAX_DURATION_MS : EM_UNSTICK_MAX_DURATION_MS;
}

/**
 * Whether an exit-3 run is the EM refusing the KIND (bin/em.mjs, before any session: `unknown kind '<kind>'; nothing
 * written`) rather than ruling out of scope. The line must be exactly that, for the kind this call sent, so a
 * session's own prose can never pass for it.
 */
export function rejectedAsUnknownKind(r: Pick<CliRun, "stdout" | "stderr">, kind: string): boolean {
  const line = `unknown kind '${kind}'; nothing written`;
  return !r.stdout.trim() && r.stderr.split("\n").some((l) => l.trim() === line);
}

/**
 * Ask the EM to unstick `issue` (`em.mjs unstick --repo --issue --kind --reason`),
 * cwd the EM checkout. Exit 2 escalated, 3 declined; otherwise a run whose
 * output ends in the runner's refusal (out of tokens, rate-limited) is `refused`
 * whatever its exit code, since a seat that never looked has not acted; else
 * exit 0 invoked, anything else failed.
 */
export async function unstickViaEm(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  issue: number,
  kind: string,
  reason: string,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
): Promise<UnstickOutcome> {
  const em = agentConfig.emRepoPath;
  if (!em) return { kind: "failed", detail: "emRepoPath not configured" };
  if (!process.env.EM_GITHUB_TOKEN) return { kind: "failed", detail: "EM_GITHUB_TOKEN not set" };
  logger.info(`Asking the EM to unstick ${repoConfig.githubRepo}#${issue} (${kind})`);
  const r = await runAgentCli(em, "bin/em.mjs",
    ["unstick", "--repo", repoConfig.githubRepo, "--issue", String(issue), "--kind", kind, "--reason", reason],
    buildEmEnv(agentConfig), agentConfig, emUnstickMaxDurationMs(kind), abortSignal, transcriptPath);
  const last = lastLine(r);
  if (!r.timedOut && r.code === 2) return { kind: "escalated", detail: last };
  if (!r.timedOut && r.code === 3) {
    // Exit 3 is also what the EM says for an unknown kind. That is a contract break, not a decision: failed, so it is
    // retried and re-armed until the EM knows the kind (foreman#232). A genuine decline stays final.
    return rejectedAsUnknownKind(r, kind)
      ? { kind: "failed", detail: `the EM rejected the kind as unknown (the Foreman and the EM disagree on the kind list): ${last}` }
      : { kind: "declined", detail: last };
  }
  const refusal = detectRefusal({ stdout: r.stdout, stderr: r.stderr, exitCode: r.code });
  if (refusal) return { kind: "refused", detail: refusal.reason, ...(refusal.resetAtMs !== undefined ? { resetAtMs: refusal.resetAtMs } : {}) };
  if (r.timedOut) return { kind: "failed", detail: "EM unstick timed out" };
  if (r.code === 0) return { kind: "invoked", detail: last };
  return { kind: "failed", detail: `exit ${r.code}: ${cliTail(r)}` };
}

/** How long one `em.mjs grant-state` read may run (a few gh reads). */
export const EM_GRANT_STATE_MAX_DURATION_MS = 2 * 60_000;

/**
 * The EM's answer to where a production grant stands for `issue` (`em.mjs grant-state --repo --issue`): exit 0 and
 * one JSON line on stdout, returned trimmed and uninterpreted. Null on any failure, timeout, or a missing
 * `emRepoPath` / `EM_GITHUB_TOKEN`. Never throws.
 */
export async function grantStateViaEm(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  issue: number,
  logger: Logger,
): Promise<string | null> {
  const em = agentConfig.emRepoPath;
  if (!em || !process.env.EM_GITHUB_TOKEN) return null;
  try {
    const r = await runAgentCli(em, "bin/em.mjs", ["grant-state", "--repo", repoConfig.githubRepo, "--issue", String(issue)],
      buildEmEnv(agentConfig), agentConfig, EM_GRANT_STATE_MAX_DURATION_MS);
    const out = r.stdout.trim();
    if (r.timedOut || r.code !== 0 || !out) {
      logger.warn(`EM grant-state ${repoConfig.githubRepo}#${issue} unreadable (${r.timedOut ? "timed out" : `exit ${r.code}`})`);
      return null;
    }
    return out;
  } catch (err) {
    logger.warn(`EM grant-state ${repoConfig.githubRepo}#${issue} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** How long `em.mjs kinds --json` may run (it reads a constant). */
export const EM_KINDS_MAX_DURATION_MS = 30_000;

/**
 * The kinds the EM says it accepts (`em.mjs kinds --json`: a JSON array of strings). Null on any failure, a missing
 * `emRepoPath`, or an EM too old to have the subcommand. Never throws.
 */
export async function publishedKindsViaEm(agentConfig: AgentConfig, logger: Logger): Promise<readonly string[] | null> {
  const em = agentConfig.emRepoPath;
  if (!em) return null;
  try {
    const r = await runAgentCli(em, "bin/em.mjs", ["kinds", "--json"], buildEmEnv(agentConfig), agentConfig, EM_KINDS_MAX_DURATION_MS);
    const kinds: unknown = r.timedOut || r.code !== 0 ? null : JSON.parse(r.stdout);
    if (Array.isArray(kinds) && kinds.every((k) => typeof k === "string")) return kinds;
    logger.warn(`EM kinds --json unreadable (${r.timedOut ? "timed out" : r.code !== 0 ? `exit ${r.code}` : "not a JSON array of strings"})`);
  } catch (err) {
    logger.warn(`EM kinds --json failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

export class EmPlugin implements ForemanPlugin {
  readonly id = "em";
  readonly roles = ["unstick"] as const;
  readonly catalog: PluginCatalogEntry = {
    name: "Unstick (EM)",
    purpose: "An agent is called when work is stuck or held, to clear it or escalate it to a named owner.",
    onWhen: "`emRepoPath` is set",
    requires: { config: ["emRepoPath", "unstickEscalationOwner"], env: ["EM_GITHUB_TOKEN"] },
    whenOff: "Stuck or held work stays where it is until a person clears it; nothing escalates it.",
  };
  readonly unstick: Unsticker = { unstick: unstickViaEm, grantState: grantStateViaEm, publishedKinds: publishedKindsViaEm };
  enabled(config: AgentConfig): boolean {
    return Boolean(config.emRepoPath);
  }
}
