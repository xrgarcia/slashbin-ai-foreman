import type { WorkItem } from "../adapters.js";
import type { AgentConfig, RepoConfig } from "../config.js";
import { recordRun, type SessionEnd } from "../session-run.js";
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
 * (`sessionBudget`, bin/em.mjs). 20 minutes killed console#1552's on 2026-10-31.
 */
export const EM_UNSTICK_REWORK_MAX_DURATION_MS = 40 * 60_000;
/**
 * A breakdown runs the board scan before and after its session (~6 min each) around a 45-minute session
 * (`sessionBudget`, bin/em.mjs).
 */
export const EM_UNSTICK_DECOMPOSE_MAX_DURATION_MS = 70 * 60_000;
export function emUnstickMaxDurationMs(kind: string): number {
  if (kind === "epic-decompose") return EM_UNSTICK_DECOMPOSE_MAX_DURATION_MS;
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

/** The result line `em.mjs unstick` prints just before its human line (docs/metrics.md): what the EM itself says it did. */
const EM_RESULT_PREFIX = "EM unstick-result ";
const EM_VERDICTS: readonly string[] = ["acted", "escalated", "out-of-scope"];

/** What the EM's result line says: its verdict, whether its answer was readable, and the cards it worked. */
export interface EmResult {
  verdict: "acted" | "escalated" | "out-of-scope";
  readable: boolean;
  worked: WorkItem[];
}

const isCard = (c: unknown): c is WorkItem => {
  const w = c as { repo?: unknown; issueNumber?: unknown } | null;
  return typeof w?.repo === "string" && Number.isInteger(w.issueNumber);
};

/**
 * The EM's result line in its stdout, or null when there is none or it is not the contract's shape (an older EM,
 * a crash before the answer, an unknown-kind refusal). Pure, exported for tests.
 */
export function parseEmResult(stdout: string): EmResult | null {
  const line = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(EM_RESULT_PREFIX)).pop();
  if (!line) return null;
  try {
    const v = JSON.parse(line.slice(EM_RESULT_PREFIX.length)) as { verdict?: unknown; readable?: unknown; worked?: unknown };
    if (typeof v.verdict !== "string" || !EM_VERDICTS.includes(v.verdict) || typeof v.readable !== "boolean") return null;
    if (!Array.isArray(v.worked) || !v.worked.every(isCard)) return null;
    return { verdict: v.verdict as EmResult["verdict"], readable: v.readable, worked: v.worked.map((c) => ({ repo: c.repo, issueNumber: c.issueNumber })) };
  } catch {
    return null;
  }
}

/**
 * How the seat run ended, from the EM's own verdict (not the exit code, which carries no worked cards).
 * completed: `acted` (exit 0) or `escalated` (exit 2) with the answer read back. noWork: `out-of-scope` (exit 3).
 * failed: the unknown-kind refusal, a failure, a refusal, a timeout, no result line, or an unreadable answer.
 */
export function emRunEnd(outcome: UnstickOutcome, result: EmResult | null): SessionEnd & { workedItems: readonly WorkItem[] } {
  const detail = `${outcome.kind}${result ? `: ${result.verdict}` : ""}`;
  const workedItems = result?.worked ?? [];
  const read = result?.readable === true;
  const completed = read && ((outcome.kind === "invoked" && result.verdict === "acted") || (outcome.kind === "escalated" && result.verdict === "escalated"));
  if (completed) return { status: "finished", outcome: "completed", detail, workedItems };
  if (outcome.kind === "declined" && result?.verdict === "out-of-scope") return { status: "finished", outcome: "noWork", detail, workedItems };
  return { status: "failed", outcome: "failed", detail, workedItems };
}

/**
 * Ask the EM to unstick `issue` (`em.mjs unstick --repo --issue --kind --reason`),
 * cwd the EM checkout. Exit 2 escalated, 3 declined; otherwise a run whose
 * output ends in the runner's refusal (out of tokens, rate-limited) is `refused`
 * whatever its exit code, since a seat that never looked has not acted; else
 * exit 0 invoked, anything else failed. Each call is one `em` run, recorded with the keyed card
 * and the cards the EM says it worked; no run is recorded when it cannot start.
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
  const keyed: WorkItem = { repo: repoConfig.githubRepo, issueNumber: issue };
  const { outcome } = await recordRun(
    { phase: "em", repo: repoConfig.githubRepo, items: [keyed], reviewer: "EM" },
    logger,
    async () => {
      const r = await runAgentCli(em, "bin/em.mjs",
        ["unstick", "--repo", repoConfig.githubRepo, "--issue", String(issue), "--kind", kind, "--reason", reason],
        buildEmEnv(agentConfig), agentConfig, emUnstickMaxDurationMs(kind), abortSignal, transcriptPath);
      return { outcome: classifyUnstick(r, kind), result: parseEmResult(r.stdout) };
    },
    ({ outcome, result }) => emRunEnd(outcome, result),
  );
  return outcome;
}

/** The unstick outcome of one finished `em.mjs unstick` run. */
function classifyUnstick(r: CliRun, kind: string): UnstickOutcome {
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

/** How long `em.mjs decompose-candidates` may run: one board scan (~6 min) with room for a slow GitHub. */
export const EM_DECOMPOSE_CANDIDATES_MAX_DURATION_MS = 15 * 60_000;

/**
 * The epics due for a breakdown (`em.mjs decompose-candidates --json`: `[{epic, approvedAt}]`, oldest first). Null on any
 * failure, a missing `emRepoPath` or `EM_GITHUB_TOKEN`, or an EM too old to have the subcommand. Never throws.
 */
export async function epicDecomposeViaEm(agentConfig: AgentConfig, logger: Logger): Promise<readonly { epic: number; approvedAt: string }[] | null> {
  const em = agentConfig.emRepoPath;
  if (!em || !process.env.EM_GITHUB_TOKEN) return null;
  try {
    const r = await runAgentCli(em, "bin/em.mjs", ["decompose-candidates", "--json"], buildEmEnv(agentConfig), agentConfig, EM_DECOMPOSE_CANDIDATES_MAX_DURATION_MS);
    const due: unknown = r.timedOut || r.code !== 0 ? null : JSON.parse(r.stdout);
    if (Array.isArray(due) && due.every((d) => Number.isInteger(d?.epic) && typeof d?.approvedAt === "string")) return due;
    logger.warn(`EM decompose-candidates unreadable (${r.timedOut ? "timed out" : r.code !== 0 ? `exit ${r.code}: ${cliTail(r)}` : "not a JSON array of {epic, approvedAt}"})`);
  } catch (err) {
    logger.warn(`EM decompose-candidates failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

/** How long one `deferred-verify.mjs schedule` may run (a few Paperclip calls). */
export const EM_FOLLOW_UP_MAX_DURATION_MS = 2 * 60_000;

/**
 * Book the EM's Paperclip follow-up for a release's deferred production check
 * (`scripts/routines/deferred-verify.mjs schedule`). The EM owns the one scheduler; the Foreman only asks. Returns
 * its `scheduled <routine> <title> <spec>` line, or null on any failure. Never throws.
 */
export async function scheduleProdFollowUpViaEm(
  repoConfig: RepoConfig, agentConfig: AgentConfig, pr: number, issues: readonly number[], at: string, logger: Logger,
): Promise<string | null> {
  const em = agentConfig.emRepoPath;
  if (!em) return null;
  try {
    const r = await runAgentCli(em, "scripts/routines/deferred-verify.mjs",
      ["schedule", "--repo", repoConfig.githubRepo, "--pr", String(pr), "--issues", issues.join(","), "--at", at],
      buildEmEnv(agentConfig), agentConfig, EM_FOLLOW_UP_MAX_DURATION_MS);
    const line = r.stdout.trim().split("\n").pop() ?? "";
    if (!r.timedOut && r.code === 0 && line.startsWith("scheduled ")) return line;
    logger.warn(`EM follow-up for ${repoConfig.githubRepo} PR #${pr} not booked (${r.timedOut ? "timed out" : `exit ${r.code}`}): ${cliTail(r)}`);
  } catch (err) {
    logger.warn(`EM follow-up for ${repoConfig.githubRepo} PR #${pr} failed: ${err instanceof Error ? err.message : String(err)}`);
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
  readonly unstick: Unsticker = { unstick: unstickViaEm, grantState: grantStateViaEm, publishedKinds: publishedKindsViaEm, epicDecompose: epicDecomposeViaEm, scheduleProdFollowUp: scheduleProdFollowUpViaEm };
  enabled(config: AgentConfig): boolean {
    return Boolean(config.emRepoPath);
  }
}
