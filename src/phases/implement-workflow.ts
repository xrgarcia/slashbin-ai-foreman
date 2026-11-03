import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { GithubConventions } from "../config-schema/github.js";
import type { ClaudeTrust } from "../claude-trust.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import { codeHost } from "../plugins/registry.js";
import { describeSpawnFailure, phaseTranscriptPath, spawnClaude } from "../session/runner.js";
import {
  detectDeclaredLanded, detectDeclaredSkip, detectSkipSignal, detectUpstreamLimit, extractStreamResult,
  type ImplementationResult,
} from "../session/protocol.js";
import { IMAGE_HANDLING_INSTRUCTIONS, readOverlay, skillInstruction } from "./workflow-prompt.js";

/** The priority tiers as one line, e.g. `S1 > security > S2+bug > … > chore`. */
function priorityOrder(github: GithubConventions): string {
  return github.priorityLabels.map((tier) => tier.join("+")).join(" > ");
}

/**
 * The hand-off line: the work items the source selected, as the only work the
 * session may do. One sentence, so a skill can quote it back.
 */
export function workItemsLine(issueNumbers: number[]): string {
  return `Implement exactly these work items, and no others: ${issueNumbers.map((n) => `#${n}`).join(", ")}.`;
}

/**
 * Invoke Claude CLI to implement the selected work items for a repo.
 *
 * `issueNumbers` is the Foreman's capped discovery batch: the inline prompt's
 * scope and what a batch-wide skip backs off. `handOff` is the uncapped list a
 * skill chooses from; it defaults to `issueNumbers`.
 * The skill (SKILL.md) owns inventory, prioritization, implementation,
 * and PR creation. Foreman just triggers and detects the result.
 */
export async function implementApprovedIssues(
  trust: ClaudeTrust,
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  priorFailureReason?: string | null,
  issueNumbers?: number[],
  handOff?: number[],
): Promise<ImplementationResult> {
  logger.info(`Starting batch implementation for ${config.name}`);

  // Captured so a DECLARED skip can be distinguished from a declaration made
  // while the agent was in fact pushing work. Evidence beats narrative in both
  // directions: the trailer is only honoured when the branch really did not move.
  const beforeSha = codeHost().getRemoteBranchSha(config.githubRepo, config.featureBranch, config.repoPath, logger);

  // Resolve the skill and the overlay before anything is launched: either one
  // configured but unreadable fails this item with Claude never started.
  const skill = config.skillPath ? skillInstruction(config, config.skillPath, "implement") : null;
  const overlay = readOverlay(config, config.skillOverlayPath, "skillOverlayPath");
  for (const part of [skill, overlay]) {
    if (part && !part.ok) {
      logger.error(`Implementation not started for ${config.name}: ${part.error}`);
      return { success: false, error: part.error };
    }
  }

  let prompt: string;

  if (config.skillPath && skill?.ok) {
    // The work source chose the batch; the session builds from it and nothing
    // else, so an item from a source the skill cannot query is still built.
    // A repo-local skill that runs its own `gh issue list` gets these same
    // GitHub issues back, so it is told to pick and order within the batch as
    // it always has — the batch only takes away issues outside it.
    //
    // `handOff` is what the implement stage chose to hand over — its build
    // batch (buildBatchSize, default one issue). Without one, the batch.
    const items = handOff && handOff.length > 0 ? handOff : issueNumbers;
    const scope = items && items.length > 0
      ? `${workItemsLine(items)} If the skill runs its own issue query, it returns these same issues: choose and order among them as the skill directs, but take nothing outside this list.`
      : `Implement all approved issues for this repository.`;
    prompt = `${skill.text}\n\n${scope} The skill defines the full workflow — follow it exactly.\n\n${IMAGE_HANDLING_INSTRUCTIONS}`;
  } else if (config.prompt) {
    // Custom user prompt — don't auto-modify (backward compat). Users who want
    // image handling in a custom prompt should include their own instructions.
    prompt = config.prompt;
  } else {
    const issueScope = issueNumbers && issueNumbers.length > 0
      ? `Implement ONLY these issues: ${issueNumbers.map(n => `#${n}`).join(", ")}. Read each issue with \`gh issue view <number>\` to understand the requirements.`
      : `Implement all open GitHub issues labeled "${config.triggerLabel}" in this repository.\n\n1. Query GitHub for them: gh issue list --label ${JSON.stringify(config.triggerLabel)} --state open --json number,title,body,labels\n2. Skip any labeled ${JSON.stringify(config.github.blockedLabel)}. Prioritize by labels, highest first: ${priorityOrder(config.github)}.`;

    prompt = `${issueScope}

3. Implement each issue, commit with message: fix|feat|chore: <description> (#<issue-number>)
4. Push to ${config.featureBranch} and create a PR targeting ${config.baseBranch}.

IMPORTANT: In PR descriptions, use "Related to #N" — NEVER use "Closes #N" or "Fixes #N". Issues are closed by the EM after production verification, not on dev merge.

${IMAGE_HANDLING_INSTRUCTIONS}

Work autonomously. Do not ask questions.`;
  }

  if (overlay.ok) prompt += overlay.text;

  // Skip-signaling protocol: an issue body may explicitly direct the agent NOT
  // to implement (e.g., investigation-first, blocked on external verification).
  // If the agent decides not to implement any of the assigned issues, it must
  // end its output with a single line `FOREMAN_RESULT: skipped reason="<text>"`
  // so the orchestrator can distinguish a deliberate no-op from a failed
  // implementation attempt and back off accordingly.
  prompt += `\n\nIMPORTANT — Skip protocol: If you stop on an issue without producing a PR — because its body directs you NOT to write code (investigation-first, "no immediate code change", waiting on external verification), or because its spec is unusable (a cited path that does not exist, an acceptance script you cannot fetch, a convention you cannot resolve) — do NOT create an empty PR or guess at a fix. Comment on the issue saying what would unblock it, then end your output with this exact line and nothing after it:\n\nFOREMAN_RESULT: skipped issue=<the issue number you stopped on> reason="<one-line explanation>"\n\nIf the issue is waiting on another issue or PR (a dependency not merged yet, a precondition another issue delivers), add \` waiting_on="<owner/repo#N>"\` (or \`#N\` in this repo) to that line, e.g. \`FOREMAN_RESULT: skipped issue=127 waiting_on="acme/site#166" reason="refund_policy.md is on unmerged PR #166"\`.\n\nThis tells the Foreman to hold THAT issue in Blocked rather than re-queue it every cycle: it runs again only when the issue changes (a comment, an edit, a label) or the \`waiting_on\` issue closes or PR merges. Always include \`issue=\` — without it the skip applies to every issue in this batch, which takes issues you never read off the board too. If at least one issue in the batch IS implementable, implement those normally and only skip the rest (a created PR plus a scoped trailer is a valid combination).`;

  // Landed protocol, in the common prompt so a repo-local skill hears it too
  // (the built-in skill carries it as well). Without it "all 16 already on
  // features" ended as prose, no trailer, and the issue stayed open and approved
  // while the issues blocked by it waited (jerky_skuvault_service#478, 2026-10-26).
  prompt += `\n\nIMPORTANT — Nothing-to-land protocol: if the work an issue asks for is ALREADY on ${config.featureBranch} (for example every dependency PR is already merged there), there is nothing to build and no PR to open. Comment the evidence on the issue (what you checked: PR numbers, SHAs), push nothing, then end your output with this exact line and nothing after it:\n\nFOREMAN_RESULT: landed issue=<the issue number> reason="<one-line evidence>"\n\nThe Foreman then closes the issue as completed, which releases every issue blocked by it. Never end with prose such as "No PR produced" or "No code change to land" alone: it is not heard, and the issue stays open. If the work cannot land and a person must act, use the skip protocol above instead.`;

  // Third Way: if a prior attempt failed, include context so Claude can adapt
  if (priorFailureReason) {
    prompt += `\n\nIMPORTANT — PRIOR ATTEMPT FAILED: "${priorFailureReason}". Ensure you: (1) commit changes to the ${config.featureBranch} branch, (2) push to origin, (3) create a PR targeting ${config.baseBranch} using \`gh pr create\`. If a PR already exists, push new commits to it.`;
  }

  const transcriptPath = phaseTranscriptPath("implement", config.name);
  logger.info(`Transcript: ${transcriptPath}`);
  const result = await spawnClaude(trust, prompt, config, logger, abortSignal, transcriptPath);
  // The session may have opened a PR the cached list predates.
  codeHost().forgetOpenPrs(config.githubRepo);

  if (result.timedOut) {
    return { success: false, error: "timed out" };
  }

  if (result.exitCode !== 0) {
    const error = describeSpawnFailure(result);
    logger.error(`Claude CLI exited with code ${result.exitCode}: ${error}`);
    return { success: false, error, upstreamLimit: detectUpstreamLimit(result.stdout) };
  }

  // A DECLARED skip, with no new commits, is authoritative — and it has to be
  // checked here, ahead of every PR heuristic below.
  //
  // Slashbin-console#841, 2026-09-02. The agent correctly refused to commit a
  // chore onto `features` because an unrelated billing PR (#843) was already
  // open on that branch and its skill forbids bundling the two. It emitted the
  // trailer exactly as instructed. But an open PR on the branch existed, so the
  // PR-detection below claimed it as this run's output and returned success —
  // the skip check sat 30 lines further down and was never reached. Nothing was
  // recorded, the back-off never armed, and the issue was re-queued every cycle:
  // 41 full Claude sessions in six hours, each one reaching the same correct
  // conclusion and having it discarded.
  //
  // The SHA guard is what makes this safe to check first. The prompt tells the
  // agent not to emit the trailer when it created a PR, but "the agent followed
  // the prompt" is exactly the assumption that should not be load-bearing — so
  // a declaration is only honoured when the branch demonstrably did not move.
  // A declared LANDED is the same kind of declaration, with the same SHA guard:
  // "nothing to land" is only believable when the branch did not move. It names
  // its issue and the orchestrator closes only an issue in the batch.
  const declaredLanded = detectDeclaredLanded(result.stdout);
  if (declaredLanded.landed) {
    const afterSha = codeHost().getRemoteBranchSha(config.githubRepo, config.featureBranch, config.repoPath, logger);
    if (beforeSha && afterSha && beforeSha !== afterSha) {
      logger.warn(
        `Agent emitted a landed trailer but ${config.featureBranch} advanced ` +
        `${beforeSha.slice(0, 9)} → ${afterSha.slice(0, 9)} — treating the commits as the truth and ignoring the trailer`,
      );
    } else {
      logger.info(`Implementation found #${declaredLanded.issue} already landed — ${declaredLanded.reason}`);
      return {
        success: false,
        landed: true,
        landedIssue: declaredLanded.issue,
        landedReason: declaredLanded.reason,
        summary: extractStreamResult(result.stdout),
        error: `already landed: ${declaredLanded.reason}`,
      };
    }
  }

  const declaredSkip = detectDeclaredSkip(result.stdout);
  if (declaredSkip.skipped) {
    const afterSha = codeHost().getRemoteBranchSha(config.githubRepo, config.featureBranch, config.repoPath, logger);
    if (beforeSha && afterSha && beforeSha !== afterSha) {
      logger.warn(
        `Agent emitted a skip trailer but ${config.featureBranch} advanced ` +
        `${beforeSha.slice(0, 9)} → ${afterSha.slice(0, 9)} — treating the commits as the truth and ignoring the trailer`,
      );
    } else {
      // Scope the skip when the agent named an issue, so one unbuildable spec
      // cannot back off the issues behind it.
      //
      // A named issue is TRUSTED even when it is not in `issueNumbers`, and that
      // is deliberate. The prompt names the batch, but a repo-local skill still
      // runs its own `gh issue list` first, and that query is strictly WIDER
      // than the batch — the batch was already filtered by the `implemented`
      // cache and by the escalating skip back-off, while those issues stay open
      // and trigger-labelled on GitHub and so remain visible to the agent. So
      // "not in the batch" is an ordinary outcome, not a mistake, and widening
      // to the batch on account of it would reintroduce exactly the starvation
      // the scope exists to prevent. The agent naming one issue is strictly
      // more information than the batch list.
      const named = declaredSkip.issue;
      if (named !== undefined && !(issueNumbers ?? []).includes(named)) {
        logger.info(
          `Skip names #${named}, which was outside the tracked batch ` +
          `(${(issueNumbers ?? []).map((n) => `#${n}`).join(", ") || "none"}) — ` +
          `possible in skill mode, where a repo-local skill also runs its own query. Honouring the scope.`,
        );
      }
      logger.info(
        `Implementation skipped by declaration — ${declaredSkip.reason}` +
        (named !== undefined ? ` (scoped to #${named})` : " (batch-wide — no issue= in the trailer)"),
      );
      return {
        success: false,
        skipped: true,
        summary: extractStreamResult(result.stdout),
        skipReason: declaredSkip.reason,
        skippedIssues: named !== undefined ? [named] : (issueNumbers ?? []),
        waitingOn: declaredSkip.waitingOn,
        error: `skipped: ${declaredSkip.reason}`,
      };
    }
  }

  // Extract PR URL from Claude's output
  const prMatch = result.stdout.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
  let prUrl = prMatch ? `https://${prMatch[0]}` : undefined;

  // Fallback: query GitHub directly for an open feature PR. This spawn is
  // outside runGh, so it has to honour the GitHub back-off itself.
  if (!prUrl && !isUpstreamBlocked("github")) {
    logger.info("PR URL not found in output, querying GitHub as fallback");
    const fallbackUrl = codeHost().featurePrUrlFallback(config);
    if (fallbackUrl?.startsWith("https://")) {
      prUrl = fallbackUrl;
      logger.info(`PR found via GitHub fallback: ${prUrl}`);
    }
  }

  if (prUrl) {
    // Verify the PR actually exists on GitHub
    const verified = codeHost().verifyPRExists(
      config.githubRepo,
      config.featureBranch,
      config.baseBranch,
      config.repoPath,
      logger,
    );
    if (!verified) {
      logger.warn("PR URL found but verification failed — PR may not exist on GitHub");
      return { success: false, error: "PR creation could not be verified" };
    }
    // Post-implementation self-check: verify the PR has actual file changes
    const changedFiles = codeHost().checkPRHasChanges(config.githubRepo, config.featureBranch, config.baseBranch, config.repoPath, logger);
    if (changedFiles === 0) {
      return { success: false, error: "PR exists but has no file changes" };
    }

    logger.info(`PR created and verified: ${prUrl}`);
    return { success: true, prUrl, summary: extractStreamResult(result.stdout) };
  }

  // If Claude exited cleanly but no new PR was found, check if an existing
  // feature PR already has the work (Claude may have added commits to it).
  const existingPR = codeHost().verifyPRExists(
    config.githubRepo,
    config.featureBranch,
    config.baseBranch,
    config.repoPath,
    logger,
  );
  if (existingPR) {
    logger.info("No new PR created, but existing feature PR found — treating as success (commits added to existing PR)");
    return { success: true, summary: extractStreamResult(result.stdout) };
  }

  // Before flagging "no PR" as a failure, check whether the agent deliberately
  // chose not to implement (investigation-only issues, blocked-on-prod-verification,
  // etc.). The orchestrator backs off on skip rather than retrying every cycle.
  const skip = detectSkipSignal(result.stdout);
  if (skip.skipped) {
    logger.info(`Implementation skipped — agent declined to write code: ${skip.reason}`);
    const outputTail = result.stdout.slice(-500).trim();
    if (outputTail) {
      logger.info("Claude output (last 500 chars):\n" + outputTail);
    }
    return {
      success: false,
      skipped: true,
      summary: extractStreamResult(result.stdout),
      skipReason: skip.reason,
      skippedIssues: issueNumbers ?? [],
      error: `skipped: ${skip.reason}`,
    };
  }

  // Log Claude's output tail so we can diagnose why no PR was created
  const outputTail = result.stdout.slice(-500).trim();
  if (outputTail) {
    logger.warn("Claude output (last 500 chars):\n" + outputTail);
  }

  logger.error("Batch implementation completed (exit 0) but no PR was created or found — marking as failed");
  return { success: false, error: "no PR created" };
}
