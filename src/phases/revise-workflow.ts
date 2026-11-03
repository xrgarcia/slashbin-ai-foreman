import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ClaudeTrust } from "../claude-trust.js";
import { codeHost } from "../plugins/registry.js";
import { describeSpawnFailure, phaseTranscriptPath, spawnClaude } from "../session/runner.js";
import { REVISION_NO_COMMIT, detectUpstreamLimit, extractStreamResult, type RevisionResult } from "../session/protocol.js";
import { IMAGE_HANDLING_INSTRUCTIONS, readOverlay, skillInstruction } from "./workflow-prompt.js";

/**
 * Invoke Claude CLI to revise PRs that have review feedback (`pr pending actions`).
 * The revision skill reads review comments, implements fixes, and pushes.
 *
 * The orchestrator passes the specific PR number and issue numbers so the
 * skill doesn't need to search by label (which historically was unreliable).
 */
export async function revisePRFeedback(
  trust: ClaudeTrust,
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  prNumber?: number,
  issueNumbers?: number[],
  /** QA's failing lines for the approved head (qaBeforeMerge): the review comments do not carry them. */
  qaFeedback?: string,
  /** The feature branch's sha the caller already read before admitting the session (a failed read never reaches here). */
  knownBeforeSha?: string | null,
  /** The PR's own head branch: the only branch this session may push to. */
  headBranch: string = config.featureBranch,
): Promise<RevisionResult> {
  logger.info(`Starting PR revision for ${config.name}`);

  // Capture the feature branch's HEAD SHA before invoking Claude so we can
  // detect the no-op case where Claude exits 0 without pushing any commits.
  // Without this, a silent no-op would be reported as success and the
  // orchestrator would (incorrectly) transition labels to `pr under review`,
  // hiding the fact that the requested fix was never applied.
  const beforeSha = knownBeforeSha !== undefined ? knownBeforeSha : codeHost().getRemoteBranchSha(config.githubRepo, headBranch, config.repoPath, logger);

  const prContext = prNumber
    ? `\n\nCONTEXT: PR #${prNumber} needs revision. PR branch: ${headBranch} (push only to this branch). Linked issues: ${(issueNumbers || []).map(n => `#${n}`).join(", ")}. Read the review comments on PR #${prNumber} to understand what changes are requested.`
    : "";
  const qaContext = qaFeedback
    ? `\n\nQA FAILED THIS PR (it booted the approved head locally before the merge). Fix what it found; the full report is the newest "## QA Report" comment on PR #${prNumber}:\n\n${qaFeedback}`
    : "";

  const labelNote = `\n\nIMPORTANT: Do NOT update issue labels — the orchestrator handles label transitions after you finish.`;

  // A review round can legitimately require no code change: the reviewer asked
  // for none, the previous round already satisfied it, or the remaining work is
  // on an issue body rather than the branch. Before this trailer existed, that
  // outcome was indistinguishable from a silent no-op and was marked failed, so
  // the labels never returned to `pr under review` and the PR could never be
  // re-reviewed — Slashbin-console#843 sat in exactly that deadlock.
  const noCommitNote = `\n\nIF NO CODE CHANGE IS NEEDED: do not invent one. Say so on its own line, as the LAST line of your output:\n\n  FOREMAN_REVISION no-commit reason=<one line: why the branch is already correct>\n\nWithout that trailer, a run that pushes nothing is treated as a failed revision — which is the correct default, because a silent no-op and a deliberate one look identical from outside.`;

  const skill = config.revisionSkillPath ? skillInstruction(config, config.revisionSkillPath, "revise") : null;
  const overlay = readOverlay(config, config.revisionSkillOverlayPath, "revisionSkillOverlayPath");
  for (const part of [skill, overlay]) {
    if (part && !part.ok) {
      logger.error(`Revision not started for ${config.name}: ${part.error}`);
      return { success: false, error: part.error };
    }
  }

  let prompt: string;

  if (config.revisionSkillPath && skill?.ok) {
    prompt = `${skill.text}\n\nRevise PR #${prNumber || "(pending)"} which has review feedback for this repository. The skill defines the full workflow — follow it exactly.${prContext}${qaContext}${labelNote}${noCommitNote}\n\n${IMAGE_HANDLING_INSTRUCTIONS}`;
  } else {
    prompt = `Revise PR #${prNumber || "(find open PRs with review feedback)"} in this repository.

1. Read the PR's review comments: gh pr view ${prNumber || "<number>"} --comments
2. Also read inline review comments: gh api repos/${config.githubRepo}/pulls/${prNumber || "<number>"}/comments --jq '.[] | {path, line, body}'
3. Implement the requested changes on the PR's branch.
4. Run tests: npm test
5. Commit fixes with message: fix: address review feedback (#${prNumber || "<number>"})
6. Push to the PR branch.
${prContext}${qaContext}${labelNote}${noCommitNote}

${IMAGE_HANDLING_INSTRUCTIONS}

Work autonomously. Do not ask questions.`;
  }

  if (overlay.ok) prompt += overlay.text;

  const transcriptPath = phaseTranscriptPath("revise", config.name);
  logger.info(`Transcript: ${transcriptPath}`);
  const result = await spawnClaude(trust, prompt, config, logger, abortSignal, transcriptPath);

  if (result.timedOut) {
    return { success: false, error: "timed out" };
  }

  if (result.exitCode !== 0) {
    const error = describeSpawnFailure(result);
    logger.error(`Claude CLI exited with code ${result.exitCode}: ${error}`);
    return { success: false, error, upstreamLimit: detectUpstreamLimit(result.stdout) };
  }

  // Post-revision self-check: confirm Claude actually pushed commits to the
  // feature branch. A clean exit with no SHA change means the revision was a
  // silent no-op (skill misfire, agent decided "nothing to fix", failed push,
  // etc.). Treat it as a failure so the orchestrator does not transition labels
  // to `pr under review` — that would lie about the PR's state and cause the
  // EM to re-review unchanged code.
  //
  // A branch that does not exist yet reads null; a read that FAILS throws and fails the
  // pass (EM#1244 f5): neither a trailer nor an exit code is trusted on an unread branch.
  const afterSha = codeHost().getRemoteBranchSha(config.githubRepo, headBranch, config.repoPath, logger);
  if (beforeSha && afterSha && beforeSha === afterSha) {
    // Declared no-commit: the revision determined the branch is already correct
    // and said so on the trailer. That is a real outcome, not a misfire, and it
    // must return success — otherwise the orchestrator never transitions the
    // labels back to `pr under review` and the PR is unreviewable forever.
    const declared = REVISION_NO_COMMIT.exec(result.stdout);
    if (declared) {
      const reason = declared[1].trim().slice(0, 300);
      logger.info(
        `PR revision made no commit BY DECLARATION on ${headBranch} ` +
        `(SHA unchanged at ${beforeSha.slice(0, 10)}): ${reason}`,
      );
      return { success: true, noCommit: true, noCommitReason: reason, summary: extractStreamResult(result.stdout) };
    }

    const outputTail = result.stdout.slice(-500).trim();
    if (outputTail) {
      logger.warn("Claude output (last 500 chars):\n" + outputTail);
    }
    logger.error(`PR revision completed (exit 0) but no commits were pushed to ${headBranch} (SHA unchanged at ${beforeSha.slice(0, 10)}) and no FOREMAN_REVISION no-commit trailer was given — marking as failed`);
    return { success: false, error: "no commits pushed — revision was a no-op" };
  }

  logger.info(`PR revision completed successfully for ${config.name}`);
  return { success: true, summary: extractStreamResult(result.stdout) };
}
