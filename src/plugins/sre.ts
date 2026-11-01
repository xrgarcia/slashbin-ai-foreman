import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { pickEnv, setLabelEnv, SESSION_ENV_ESSENTIALS, SUMMARY_DISPLAY_LIMIT, type ReviewTrailer } from "../agent.js";
import { setContractReaderEnv } from "../handoff-contract.js";
import { cliTail, parseReviewTrailerRecords, parseUnrelatedErrors, runAgentCli, type CliRun } from "./agent-cli.js";
import type { Deployer, DeployResult, DeployTrailer, ForemanPlugin, Verifier, VerifyResult } from "./contract.js";

/**
 * The SRE (`<srePath>/bin/sre.mjs`) as the verifier and deployer plugin
 * (EM#1150 f3): dev verification (EM#440), the release deploy and production
 * verification (EM#578). On when `srePath` is set.
 */

/**
 * The SRE's environment: essentials, `sessionEnv`, the label names, its own SRE_*
 * settings (SRE_GITHUB_KEY among them, account `slashbin-sre`) and the EM checkout it
 * verifies from. No other agent's token. Until 2026-10-10 this was the Tech Lead's env,
 * which carried the Tech Lead's key and no token the SRE reads, so the SRE posted as
 * whatever `gh` login was active on the host.
 */
export function buildSreEnv(agentConfig: AgentConfig, repoConfig: RepoConfig): Record<string, string> {
  const env = pickEnv([...SESSION_ENV_ESSENTIALS, ...(agentConfig.sessionEnv ?? [])]);
  setLabelEnv(env, repoConfig.triggerLabel, repoConfig.lifecycleLabels, repoConfig.github);
  pickEnv(Object.keys(process.env).filter((n) => n.startsWith("SRE_")), env);
  if (agentConfig.emRepoPath && !env.SRE_EM_REPO) env.SRE_EM_REPO = agentConfig.emRepoPath;
  setContractReaderEnv(env, agentConfig.emRepoPath);
  return env;
}

/**
 * The verify run's ceiling. The SRE's own budget is a hook canary (3 min), a
 * Codex run (40 min) and, on Codex failure, a Claude run (40 min); the Foreman
 * kills only past all three.
 */
export const SRE_VERIFY_MAX_DURATION_MS = 90 * 60_000;

/**
 * The verdict a verify trailer carries. Pass is an approved merge with a clean
 * (or not-applicable) deploy and no hold; everything else is a hold with the
 * reason the EM reads on the card. Pure, exported for tests.
 */
export function verifyVerdict(t: ReviewTrailer): { pass: boolean; reason?: string } {
  if (t.hold) return { pass: false, reason: t.hold };
  if (t.verdict !== "APPROVE" || !t.merged) return { pass: false, reason: `unexpected trailer verdict=${t.verdict} merged=${t.merged}` };
  if (/^(SUCCESS|NA)$/.test(t.deploy)) return { pass: true };
  return { pass: false, reason: t.deploy === "FAILURE" ? "dev-verify-failed" : `deploy=${t.deploy}` };
}

/** A verify run's trailer for `prNumber`, read into the verdict. */
function readVerify(r: CliRun, repoConfig: RepoConfig, prNumber: number, what: string, logger: Logger): VerifyResult {
  const trailer = parseReviewTrailerRecords(r.stdout).filter((t) => t.pr === prNumber).pop();
  if (!trailer) return { kind: "error", error: "SRE exited 0 without a FOREMAN_REVIEW trailer for this PR" };
  const v = verifyVerdict(trailer);
  logger.info(`SRE ${what} of ${repoConfig.githubRepo} PR #${prNumber}: ${v.pass ? "PASS" : `HOLD (${v.reason})`}`);
  const unrelated = parseUnrelatedErrors(r.stdout);
  return { kind: "verdict", pass: v.pass, trailer, ...(v.reason ? { reason: v.reason } : {}), summary: r.stdout.trim().slice(-SUMMARY_DISPLAY_LIMIT), ...(unrelated ? { unrelated } : {}) };
}

/**
 * Hand one merged PR to the SRE (`sre.mjs verify`) for dev verification. The
 * SRE posts the evidence comment and writes no label; the Foreman reads the
 * trailer it prints last and moves the label itself.
 *
 * The SRE runs on Codex only. When Codex cannot run it still exits 0, with
 * `hold=codex-unavailable` in the trailer; the orchestrator defers on that.
 */
export async function verifyViaSre(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  prNumber: number,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
): Promise<VerifyResult> {
  const sre = agentConfig.srePath;
  if (!sre) return { kind: "error", error: "srePath not configured" };
  if (!process.env.SRE_GITHUB_KEY) {
    return { kind: "error", error: "SRE_GITHUB_KEY not set — refusing to verify without SRE-account (slashbin-sre) attribution" };
  }
  logger.info(`Handing PR #${prNumber} on ${repoConfig.githubRepo} to the SRE for dev verification`);
  const r = await runAgentCli(sre, "bin/sre.mjs", ["verify", "--repo", repoConfig.githubRepo, "--pr", String(prNumber)],
    buildSreEnv(agentConfig, repoConfig), agentConfig, SRE_VERIFY_MAX_DURATION_MS, abortSignal, transcriptPath, { appendTranscript: false });
  if (r.timedOut) return { kind: "error", error: "SRE verification timed out" };
  if (r.code !== 0) return { kind: "error", error: `SRE verification failed (exit ${r.code}): ${cliTail(r)}` };
  return readVerify(r, repoConfig, prNumber, "verification", logger);
}

/**
 * Parse `SRE_DEPLOY pr=#N merged=<yes|no> merge_sha=<sha|none>
 * verify=<pass|hold|fail|none> [hold=<slug>] [evidence=<url>]`; the last one
 * for `prNumber` wins. Same grammar as the SRE's own parser (lib/deploy.mjs);
 * a merge_sha that is not 40 hex reads as none. Null when there is none. Pure,
 * exported for tests.
 */
export function parseDeployTrailer(stdout: string, prNumber: number): DeployTrailer | null {
  const re = /SRE_DEPLOY\s+pr=#?(\d+)\s+merged=(yes|no)\s+merge_sha=(\S+)\s+verify=(pass|hold|fail|none)(?:\s+hold=([\w/-]+))?(?:\s+evidence=(\S+))?/g;
  let found: DeployTrailer | null = null;
  for (const m of stdout.matchAll(re)) {
    if (Number(m[1]) !== prNumber) continue;
    found = {
      pr: prNumber,
      merged: m[2] === "yes",
      mergeSha: /^[0-9a-f]{40}$/.test(m[3]) ? m[3] : null,
      verify: m[4] as DeployTrailer["verify"],
      ...(m[5] ? { hold: m[5] } : {}),
      ...(m[6] ? { evidence: m[6] } : {}),
    };
  }
  return found;
}

/**
 * Hand release PR `prNumber` at `sha` to the SRE (`sre.mjs deploy`): it
 * validates, merges (as itself, sha-pinned, never squash), waits for the
 * deploy and verifies production. It never tags, relabels or closes: the
 * Foreman does that from the trailer. Exit 1 is a refused precondition;
 * exit 3 (whatever its trailer says) could not run.
 */
export async function deployViaSre(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  prNumber: number,
  sha: string,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
): Promise<DeployResult> {
  const sre = agentConfig.srePath;
  if (!sre) return { kind: "retry", reason: "srePath not configured" };
  if (!process.env.SRE_GITHUB_KEY) return { kind: "retry", reason: "SRE_GITHUB_KEY not set — refusing to deploy without SRE-account attribution" };
  logger.info(`Handing release PR #${prNumber} on ${repoConfig.githubRepo} at ${sha.slice(0, 10)} to the SRE to deploy`);
  const r = await runAgentCli(sre, "bin/sre.mjs",
    ["deploy", "--repo", repoConfig.githubRepo, "--pr", String(prNumber), "--sha", sha],
    buildSreEnv(agentConfig, repoConfig), agentConfig, agentConfig.sreDeployMaxDurationMs, abortSignal, transcriptPath);
  const trailer = parseDeployTrailer(r.stdout, prNumber);
  // A merge the trailer reports is the truth whatever the exit: it must never
  // be read as "nothing happened".
  const unrelated = parseUnrelatedErrors(r.stdout);
  // The deploy may carry its evidence link only on the trailer.
  if (unrelated && trailer?.evidence && !unrelated.evidence.includes(trailer.evidence)) unrelated.evidence.push(trailer.evidence);
  if (trailer?.merged) return { kind: "trailer", trailer, ...(unrelated ? { unrelated } : {}) };
  // Exit 3 prints a trailer too (hold=codex-unavailable / em-mirror-unavailable),
  // but it means "could not run, nothing merged": retry, whatever it says.
  if (r.code === 3) return { kind: "retry", reason: `the SRE could not run (${trailer?.hold ?? cliTail(r)})` };
  if (trailer && r.code === 0) return { kind: "trailer", trailer };
  if (r.timedOut) return { kind: "retry", reason: "SRE deploy timed out" };
  if (r.code === 1) return { kind: "refused", reason: cliTail(r) || "refused" };
  if (r.code === 0) return { kind: "retry", reason: "SRE exited 0 without an SRE_DEPLOY trailer for this PR" };
  return { kind: "retry", reason: `exit ${r.code}: ${cliTail(r)}` };
}

/**
 * Verify a merged release PR in production (`sre.mjs verify --mode prod`), for
 * an issue whose prod verification held, or run its 30-minute soak (`--mode
 * soak`; the SRE's ledger records it, so its promotion-verify sweep skips a
 * release the Foreman soaked). Same trailer and verdict as the dev verify
 * (verifyVerdict); the hold slug is the reason. A soak with nothing left to
 * soak exits 1: `{ kind: "nothing" }`.
 */
export async function verifyProdViaSre(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  prNumber: number,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
  mode: "prod" | "soak" = "prod",
): Promise<VerifyResult | { kind: "nothing"; reason: string }> {
  const sre = agentConfig.srePath;
  if (!sre) return { kind: "error", error: "srePath not configured" };
  if (!process.env.SRE_GITHUB_KEY) return { kind: "error", error: "SRE_GITHUB_KEY not set — refusing to verify without SRE-account attribution" };
  const what = mode === "soak" ? "30-minute soak" : "prod verification";
  logger.info(`Handing release PR #${prNumber} on ${repoConfig.githubRepo} to the SRE for its ${what}`);
  const r = await runAgentCli(sre, "bin/sre.mjs",
    ["verify", "--mode", mode, "--repo", repoConfig.githubRepo, "--pr", String(prNumber)],
    buildSreEnv(agentConfig, repoConfig), agentConfig, SRE_VERIFY_MAX_DURATION_MS, abortSignal, transcriptPath);
  if (r.timedOut) return { kind: "error", error: `SRE ${what} timed out` };
  if (mode === "soak" && r.code === 1) return { kind: "nothing", reason: cliTail(r) || "nothing to soak" };
  if (r.code !== 0) return { kind: "error", error: `SRE ${what} failed (exit ${r.code}): ${cliTail(r)}` };
  return readVerify(r, repoConfig, prNumber, what, logger);
}

export class SrePlugin implements ForemanPlugin {
  readonly id = "sre";
  readonly roles = ["verifier", "deployer"] as const;
  readonly verifier: Verifier = { verifyDev: verifyViaSre, verifyProd: verifyProdViaSre };
  readonly deployer: Deployer = { deploy: deployViaSre };
  enabled(config: AgentConfig): boolean {
    return Boolean(config.srePath);
  }
}
