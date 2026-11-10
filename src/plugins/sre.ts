import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { pickEnv, setLabelEnv, SESSION_ENV_ESSENTIALS } from "../session/env.js";
import { SUMMARY_DISPLAY_LIMIT, extractStreamResult, type ReviewTrailer } from "../session/protocol.js";
import { readResultV1, waitUntilSlug, type RoleResult } from "../contract/result-v1.js";
import { recordContractPath } from "../contract/usage.js";
import { setContractReaderEnv } from "../handoff-contract.js";
import { cliTail, parseReviewTrailerRecords, parseUnrelatedErrors, runAgentCli, type CliRun } from "./agent-cli.js";
import type { Deployer, DeployResult, DeployTrailer, ForemanPlugin, UnrelatedErrors, Verifier, VerifyResult } from "./contract.js";

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

/** The hold a v1 line that failed its schema becomes: never a pass, and a person decides (verifyHoldPlan). */
export const CONTRACT_INVALID_HOLD = "contract-invalid-result";

/** The text a v1 line is read from: a stream-JSON envelope's result, else the plain stdout. */
const resultText = (stdout: string): string => extractStreamResult(stdout) ?? stdout;

/** A v1 `unrelated_errors` list as the Foreman's UnrelatedErrors, signatures kept. Pure, exported for tests. */
export function unrelatedFromV1(list: RoleResult<"verifier">["unrelated_errors"], extraEvidence?: string | null): UnrelatedErrors | undefined {
  if (!list?.length) return undefined;
  const evidence = [...new Set([...list.map((e) => e.evidence).filter((e): e is string => !!e), ...(extraEvidence ? [extraEvidence] : [])])];
  return { errors: list.map((e) => e.text ?? e.signature), signatures: list.map((e) => e.signature), evidence };
}

/** A v1 verifier result as the legacy review trailer, so verifyVerdict and verifyHoldPlan read both alike. Pure, exported for tests. */
export function verifierTrailerFromV1(v: RoleResult<"verifier">): ReviewTrailer {
  const hold = v.hold === "wait-until" && v.eligible_at ? waitUntilSlug(v.eligible_at) : v.hold ?? undefined;
  const base = { pr: v.pr, ...(hold ? { hold } : {}) };
  if (v.outcome === "pass") return { ...base, verdict: "APPROVE", merged: true, deploy: "SUCCESS" };
  if (v.outcome === "fail") return { ...base, verdict: "APPROVE", merged: true, deploy: "FAILURE" };
  if (v.outcome === "hold") return { ...base, verdict: "APPROVE", merged: true, deploy: "NA", hold: hold ?? "verify-held" };
  return { ...base, verdict: "NONE", merged: false, deploy: "NA" };
}

/** A verify run's trailer for `prNumber`, read into the verdict: the v1 line first, else the legacy trailer. */
function readVerify(r: CliRun, repoConfig: RepoConfig, prNumber: number, what: string, logger: Logger): VerifyResult {
  const v1 = readResultV1(resultText(r.stdout), "verifier", prNumber);
  recordContractPath("sre", "verifier", v1.status === "ok" ? "v1" : v1.status === "invalid" ? "invalid" : "legacy", (m) => logger.info(m));
  if (v1.status === "invalid") {
    logger.warn(`SRE ${what} of ${repoConfig.githubRepo} PR #${prNumber}: HOLD (${CONTRACT_INVALID_HOLD}: ${v1.problem})`);
    const trailer: ReviewTrailer = { pr: prNumber, verdict: "NONE", merged: false, deploy: "NA", hold: CONTRACT_INVALID_HOLD };
    return { kind: "verdict", pass: false, trailer, reason: CONTRACT_INVALID_HOLD, summary: `${v1.problem}\n\n${r.stdout.trim()}`.slice(-SUMMARY_DISPLAY_LIMIT) };
  }
  const trailer = v1.status === "ok" ? verifierTrailerFromV1(v1.result) : parseReviewTrailerRecords(r.stdout).filter((t) => t.pr === prNumber).pop();
  if (!trailer) return { kind: "error", error: "SRE exited 0 without a FOREMAN_REVIEW trailer for this PR" };
  const v = verifyVerdict(trailer);
  logger.info(`SRE ${what} of ${repoConfig.githubRepo} PR #${prNumber}: ${v.pass ? "PASS" : `HOLD (${v.reason})`}`);
  const unrelated = v1.status === "ok" ? unrelatedFromV1(v1.result.unrelated_errors) : parseUnrelatedErrors(r.stdout);
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
  force = false,
): Promise<VerifyResult> {
  const sre = agentConfig.srePath;
  if (!sre) return { kind: "error", error: "srePath not configured" };
  if (!process.env.SRE_GITHUB_KEY) {
    return { kind: "error", error: "SRE_GITHUB_KEY not set — refusing to verify without SRE-account (slashbin-sre) attribution" };
  }
  logger.info(`Handing PR #${prNumber} on ${repoConfig.githubRepo} to the SRE for dev verification${force ? " (--force: its environment was repaired)" : ""}`);
  const r = await runAgentCli(sre, "bin/sre.mjs", ["verify", "--repo", repoConfig.githubRepo, "--pr", String(prNumber), ...(force ? ["--force"] : [])],
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

/** A v1 deployer result as the Foreman's deploy trailer. Pure, exported for tests. */
export function deployTrailerFromV1(d: RoleResult<"deployer">): DeployTrailer {
  return {
    pr: d.pr,
    merged: d.merged,
    mergeSha: d.merge_sha ?? null,
    verify: d.verify,
    // A time hold travels as the existing `wait-until-…` slug, the one representation of eligibility the
    // Foreman reads (verify and release alike); the deployer's own slug moves into the reason.
    ...(d.hold_class === "time" && d.eligible_at ? { hold: waitUntilSlug(d.eligible_at) } : d.hold ? { hold: d.hold } : {}),
    ...(d.evidence?.length ? { evidence: d.evidence[0] } : {}),
    ...(d.hold_class ? { holdClass: d.hold_class } : {}),
    ...(d.reason_text || (d.hold_class === "time" && d.hold) ? { holdReason: [d.hold_class === "time" ? d.hold : null, d.reason_text].filter(Boolean).join(": ") } : {}),
  };
}

/**
 * A deploy run's trailer for `prNumber`: the v1 line first, else the legacy
 * `SRE_DEPLOY` line. A v1 line that fails its schema fails closed as a person
 * hold naming the field. A merge the legacy line reports stays true with its
 * SHA (a merge is never "nothing happened"), but its verify verdict is not
 * trusted: the release is held for a fresh verification. Exported for tests.
 */
export function readDeploy(stdout: string, prNumber: number, logger?: Logger): { trailer: DeployTrailer | null; unrelated?: UnrelatedErrors } {
  const v1 = readResultV1(resultText(stdout), "deployer", prNumber);
  recordContractPath("sre", "deployer", v1.status === "ok" ? "v1" : v1.status === "invalid" ? "invalid" : "legacy", (m) => logger?.info(m));
  const legacy = parseDeployTrailer(stdout, prNumber);
  if (v1.status === "absent") return { trailer: legacy };
  if (v1.status === "ok") {
    const trailer = deployTrailerFromV1(v1.result);
    const unrelated = unrelatedFromV1(v1.result.unrelated_errors, trailer.evidence);
    return { trailer, ...(unrelated ? { unrelated } : {}) };
  }
  logger?.warn(`SRE deploy of PR #${prNumber}: ${CONTRACT_INVALID_HOLD} (${v1.problem})`);
  // The merge and its SHA stand; the legacy verify verdict does not: production verification stays open, held
  // on the contract, until a later valid verification passes.
  if (legacy?.merged) return { trailer: { pr: prNumber, merged: true, mergeSha: legacy.mergeSha, verify: "hold", hold: CONTRACT_INVALID_HOLD, holdClass: "person", holdReason: v1.problem, ...(legacy.evidence ? { evidence: legacy.evidence } : {}) } };
  return { trailer: { pr: prNumber, merged: false, mergeSha: null, verify: "none", hold: CONTRACT_INVALID_HOLD, holdClass: "person", holdReason: v1.problem } };
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
  const { trailer, unrelated: v1Unrelated } = readDeploy(r.stdout, prNumber, logger);
  // A merge the trailer reports is the truth whatever the exit: it must never
  // be read as "nothing happened".
  const unrelated = v1Unrelated ?? parseUnrelatedErrors(r.stdout);
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
