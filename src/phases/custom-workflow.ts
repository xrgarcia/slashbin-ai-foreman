import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ClaudeTrust } from "../claude-trust.js";
import { parseStageTrailer, type CustomStage } from "../stages.js";
import { describeSpawnFailure, phaseTranscriptPath, spawnClaudeWithOptions } from "../session/runner.js";
import { detectUpstreamLimit, type CustomStageResult } from "../session/protocol.js";

/** What a custom stage is handed: the work in flight on the repo when the pass reached it. */
export interface CustomStageInput {
  /** The open feature → base PR the stage runs against. */
  prNumber: number;
  /** Issues that PR implements (the same reading the implement phase uses). */
  issueNumbers: number[];
  /** Head of the feature branch the verdict applies to. */
  headSha: string;
}

/**
 * Run one custom stage: a single Claude session on the stage's skill, in the
 * managed repo, under the Foreman token with the implement session's model,
 * tools and budget. The session is told the repo, branches, PR, issues and head
 * in its prompt and as FOREMAN_STAGE_* env, next to the label env every session
 * gets. Its verdict is the FOREMAN_STAGE trailer; the Foreman does nothing with
 * the work items itself — whatever the stage should change (comments, labels),
 * its skill does.
 */
export async function runCustomStage(
  trust: ClaudeTrust,
  config: RepoConfig,
  stage: CustomStage,
  input: CustomStageInput,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<CustomStageResult> {
  const issues = input.issueNumbers.map((n) => `#${n}`).join(", ") || "none referenced";
  const prompt =
    `Read and follow the skill at ${stage.skillPath}.\n\n` +
    `This is the "${stage.id}" stage of the Foreman pipeline for ${config.githubRepo}. ` +
    `Work in flight: PR #${input.prNumber} (${config.featureBranch} → ${config.baseBranch}) at ${input.headSha}, ` +
    `implementing issues: ${issues}.\n\n` +
    `End your output with exactly one verdict line and nothing after it:\n\n` +
    `  FOREMAN_STAGE pass\n` +
    `  FOREMAN_STAGE blocked reason="<one line: what must change before this work goes further>"\n\n` +
    `\`blocked\` stops every later stage for this repo until ${config.featureBranch} moves. ` +
    `A run with no verdict line is recorded as failed, which stops them too.\n\n` +
    `Work autonomously. Do not ask questions.`;

  const transcriptPath = phaseTranscriptPath(`stage-${stage.id}`, config.name);
  logger.info(`Starting stage "${stage.id}" for ${config.name} on PR #${input.prNumber} — transcript: ${transcriptPath}`);
  const result = await spawnClaudeWithOptions(
    prompt,
    {
      trust,
      cwd: config.repoPath,
      sessionEnv: config.sessionEnv,
      ghToken: process.env.FOREMAN_GITHUB_TOKEN,
      triggerLabel: config.triggerLabel,
      lifecycleLabels: config.lifecycleLabels,
      github: config.github,
      model: config.model,
      allowedTools: config.allowedTools,
      mcpConfig: config.builderMcpConfig,
      maxTurns: config.maxTurns,
      maxDurationMs: config.maxDurationMs,
      transcriptPath,
      runLabel: `stage "${stage.id}" on ${config.name} PR #${input.prNumber}`,
      extraEnv: {
        FOREMAN_STAGE_ID: stage.id,
        FOREMAN_STAGE_REPO: config.githubRepo,
        FOREMAN_STAGE_BASE_BRANCH: config.baseBranch,
        FOREMAN_STAGE_FEATURE_BRANCH: config.featureBranch,
        FOREMAN_STAGE_PR: String(input.prNumber),
        FOREMAN_STAGE_ISSUES: JSON.stringify(input.issueNumbers),
        FOREMAN_STAGE_HEAD_SHA: input.headSha,
      },
    },
    logger,
    abortSignal,
  );

  if (result.timedOut) return { verdict: "failed", reason: "timed out" };
  if (result.exitCode !== 0) {
    return { verdict: "failed", reason: describeSpawnFailure(result), upstreamLimit: detectUpstreamLimit(result.stdout) };
  }
  const trailer = parseStageTrailer(result.stdout);
  if (!trailer) return { verdict: "failed", reason: "no FOREMAN_STAGE verdict line — outcome unknown" };
  return trailer;
}
