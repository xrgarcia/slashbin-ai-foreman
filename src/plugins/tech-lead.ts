import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { pickEnv, setLabelEnv, SESSION_ENV_ESSENTIALS, SUMMARY_DISPLAY_LIMIT, type ReviewResult, type ReviewTrailer } from "../agent.js";
import { setContractReaderEnv } from "../handoff-contract.js";
import { milestoneReader, withoutProgressLines, type ReviewMilestone } from "../review-progress.js";
import { cliTail, lastLine, parseReviewTrailerRecords, runAgentCli } from "./agent-cli.js";
import type { ForemanPlugin, PromotionApproval, Reviewer, ReviewFallback } from "./contract.js";

/**
 * The Tech Lead (xrgarcia/slashbin_ai_tech_lead, EM#427) as the reviewer
 * plugin (EM#1150 f3): it reviews and merges feature PRs and approves release
 * PRs. On when `techLeadPath` is set.
 */

/**
 * The Tech Lead hand-off's environment. It reads TECHLEAD_GITHUB_KEY by name and
 * sets GH_TOKEN itself — so it receives its own token (account slasbhin-techlead)
 * and never the Foreman's or the EM's,
 * plus its own TECH_LEAD_* settings and the configured label names. From the EM
 * checkout it gets one thing: the handoff-contract reader's path (EM#614), which
 * it renders into its review prompt as authority, not as rubric. Review itself
 * moved wholly to it, 2026-10-10.
 */
export function buildTechLeadEnv(agentConfig: AgentConfig, repoConfig: RepoConfig): Record<string, string> {
  const env = pickEnv([...SESSION_ENV_ESSENTIALS, ...(agentConfig.sessionEnv ?? [])]);
  pickEnv(Object.keys(process.env).filter((n) => n.startsWith("TECH_LEAD_")), env);
  pickEnv(["TECHLEAD_GITHUB_KEY"], env);
  // The configured label names, exactly as every Claude session gets them
  // (buildSessionEnv), so the Tech Lead never writes a hardcoded name.
  setLabelEnv(env, repoConfig.triggerLabel, repoConfig.lifecycleLabels, repoConfig.github);
  setContractReaderEnv(env, agentConfig.emRepoPath);
  return env;
}

/** Render parsed trailers as the concise Discord status line. */
function formatReviewTrailers(trailers: ReviewTrailer[]): string | undefined {
  if (trailers.length === 0) return undefined;
  return trailers
    .map((t) => {
      const mergedTxt = t.merged ? "merged" : "not merged";
      const deployTxt = /^(NA|N\/A|NONE)$/.test(t.deploy) ? "no deploy" : `deploy ${t.deploy}`;
      const holdTxt = t.hold ? ` · HELD (${t.hold})` : "";
      return `#${t.pr} ${t.verdict} · ${mergedTxt} · ${deployTxt}${holdTxt}`;
    })
    .join("; ");
}

/**
 * The explicit "there was nothing to review" sentinel. Without it, a clean no-op
 * and a session that died mid-review are the same observation — no trailer — and
 * the trailer gate below would have to choose which one to assume. Making the
 * no-op DECLARE itself lets the gate treat silence as the failure it usually is.
 */
const REVIEW_NOOP_SENTINEL = /FOREMAN_REVIEW\s+none\b/i;

/**
 * Hand one PR's review to the Tech Lead.
 *
 * The Tech Lead judges on Codex inside a read-only sandbox and does the writes in
 * its own code; it emits the FOREMAN_REVIEW trailer the review phase parses.
 *
 * Exit 3 is its "I could not take this, and I wrote NOTHING" signal (Codex signed
 * out, out of allowance, timed out, or a path it does not cover). That returns
 * `{ fallback: true }` and the caller waits and offers the PR again — never to
 * Claude (Ray, 2026-10-10). Any other non-zero exit is an ordinary failure: it
 * may have written.
 *
 * While it runs, each `TECH_LEAD_PROGRESS` line on its stderr (reading, depth
 * check, final check: review-progress.ts) goes to `onProgress` as it arrives.
 * A callback that throws is ignored: progress never fails a review.
 */
export async function reviewViaTechLead(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  prNumber: number,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
  onProgress?: (m: ReviewMilestone) => void,
  /** `--no-merge`: approve and stop; the merge is a later plain call (qaBeforeMerge). */
  noMerge = false,
  /** `--merge-approved <sha>`: merge only this exact head, on the Tech Lead's own APPROVE of it; never judges (qaBeforeMerge). */
  mergeApprovedSha?: string,
): Promise<ReviewResult | ReviewFallback> {
  const techLead = agentConfig.techLeadPath;
  if (!techLead) return { fallback: true, reason: "techLeadPath not configured" };
  if (!process.env.TECHLEAD_GITHUB_KEY) {
    return { success: false, error: "TECHLEAD_GITHUB_KEY not set — refusing to run review without Tech Lead attribution" };
  }
  const args = ["review-pr", "--repo", repoConfig.githubRepo, "--pr", String(prNumber), ...(noMerge ? ["--no-merge"] : []), ...(mergeApprovedSha ? ["--merge-approved", mergeApprovedSha] : [])];
  logger.info(`Offering PR #${prNumber} on ${repoConfig.githubRepo} to the Tech Lead (Codex)`);

  const milestones = onProgress ? milestoneReader(onProgress) : null;
  const out = await runAgentCli(techLead, "bin/tech-lead.mjs", args, buildTechLeadEnv(agentConfig, repoConfig), agentConfig,
    agentConfig.reviewMaxDurationMs, abortSignal, transcriptPath, {
      appendTranscript: false,
      onStderr: (t) => milestones?.push(t),
      onClose: () => milestones?.end(),
      cleanStderr: withoutProgressLines,
    });

  if (out.code === 3) {
    const reason = out.stdout.trim().split("\n").pop() || "Codex unavailable";
    logger.info(`Tech Lead declined PR #${prNumber} (wrote nothing): ${reason} — retried later`);
    return { fallback: true, reason };
  }
  if (out.timedOut) return { success: false, error: "Tech Lead review timed out" };
  if (out.code !== 0) {
    return { success: false, error: `Tech Lead review failed (exit ${out.code}): ${(out.stderr.trim() || out.stdout).trim().slice(-400)}` };
  }

  const trailers = parseReviewTrailerRecords(out.stdout);
  const declaredNoOp = REVIEW_NOOP_SENTINEL.test(out.stdout);
  if (trailers.length === 0 && !declaredNoOp) {
    return { success: false, error: "Tech Lead exited 0 without a FOREMAN_REVIEW trailer — outcome unknown; check the issue labels", trailers };
  }
  const statusLine = formatReviewTrailers(trailers);
  const summary = out.stdout.trim().slice(0, SUMMARY_DISPLAY_LIMIT);
  logger.info(`Tech Lead review of ${repoConfig.githubRepo} PR #${prNumber}: ${statusLine || "no-op"}`);
  return { success: true, summary, statusLine, trailers };
}

/** The Tech Lead's promotion approval: one read of the diff and one review. */
export const TECH_LEAD_APPROVE_MAX_DURATION_MS = 20 * 60_000;

/**
 * Ask the Tech Lead to approve release PR `prNumber` at exactly `sha`
 * (`tech-lead.mjs approve-promotion`). The SRE's deploy refuses a PR without
 * that approval at that head. Exit 0 approved, 4 refused, anything else retry.
 */
export async function approvePromotionViaTechLead(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  prNumber: number,
  sha: string,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
): Promise<PromotionApproval> {
  const techLead = agentConfig.techLeadPath;
  if (!techLead) return { kind: "retry", reason: "techLeadPath not configured" };
  if (!process.env.TECHLEAD_GITHUB_KEY) return { kind: "retry", reason: "TECHLEAD_GITHUB_KEY not set — refusing to approve without Tech Lead attribution" };
  logger.info(`Asking the Tech Lead to approve release PR #${prNumber} on ${repoConfig.githubRepo} at ${sha.slice(0, 10)}`);
  const r = await runAgentCli(techLead, "bin/tech-lead.mjs",
    ["approve-promotion", "--repo", repoConfig.githubRepo, "--pr", String(prNumber), "--sha", sha],
    buildTechLeadEnv(agentConfig, repoConfig), agentConfig, TECH_LEAD_APPROVE_MAX_DURATION_MS, abortSignal, transcriptPath);
  if (r.timedOut) return { kind: "retry", reason: "Tech Lead approval timed out" };
  if (r.code === 0) return { kind: "approved" };
  const last = lastLine(r);
  if (r.code === 4) return { kind: "refused", reason: last || "refused" };
  return { kind: "retry", reason: `exit ${r.code}: ${cliTail(r)}` };
}

export class TechLeadPlugin implements ForemanPlugin {
  readonly id = "tech-lead";
  readonly roles = ["reviewer"] as const;
  readonly reviewer: Reviewer = { reviewPr: reviewViaTechLead, approvePromotion: approvePromotionViaTechLead };
  enabled(config: AgentConfig): boolean {
    return Boolean(config.techLeadPath);
  }
}
