import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { pickEnv, SESSION_ENV_ESSENTIALS } from "../agent.js";
import { cliTail, lastLine, runAgentCli } from "./agent-cli.js";
import type { ForemanPlugin, Unsticker, UnstickOutcome } from "./contract.js";

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
 * Ask the EM to unstick `issue` (`em.mjs unstick --repo --issue --kind --reason`),
 * cwd the EM checkout. Exit 0 invoked, 2 escalated, 3 declined, else failed.
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
  if (r.timedOut) return { kind: "failed", detail: "EM unstick timed out" };
  const last = lastLine(r);
  if (r.code === 0) return { kind: "invoked", detail: last };
  if (r.code === 2) return { kind: "escalated", detail: last };
  if (r.code === 3) return { kind: "declined", detail: last };
  return { kind: "failed", detail: `exit ${r.code}: ${cliTail(r)}` };
}

export class EmPlugin implements ForemanPlugin {
  readonly id = "em";
  readonly roles = ["unstick"] as const;
  readonly unstick: Unsticker = { unstick: unstickViaEm };
  enabled(config: AgentConfig): boolean {
    return Boolean(config.emRepoPath);
  }
}
