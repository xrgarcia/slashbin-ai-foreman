// The GitHub issue connector: GitHub issues as the Foreman's work source. It
// translates the core lifecycle (lifecycle.ts) into issue labels and back,
// and is the only module that knows which label means which stage.

import type { SnapshotItem, WorkEvent, WorkItem, WorkSourceAdapter } from "./adapters.js";
import type { AgentConfig, LifecycleLabels, RepoConfig } from "./config.js";
import {
  closedPrVersion, dropIssueSnapshot, extractImplementedIssues, findOpenPrs, getOpenIssues, gh, ghKeyed, hasLabel,
  isBackoffRefusal, openIssueLabels, type ReviewOutcome,
} from "./github.js";
import type { Move, StageOrDone } from "./lifecycle.js";
import type { Logger } from "./logger.js";

/** The source label that blocks an issue (the Foreman never picks one up). */
export const SOURCE_BLOCKED_LABEL = "blocked";

/**
 * The lifecycle stage GitHub labels put an open issue in, latest stage first;
 * "blocked" while the source labels it so, whatever else it carries; "done"
 * once promoted (the close is all that is left); null when the issue is not in
 * the Foreman's lifecycle at all. `inRelease` = an open release PR names it.
 */
export function issueStage(
  labels: readonly string[],
  inRelease: boolean,
  lifecycle: LifecycleLabels,
  triggerLabel: string,
): StageOrDone | null {
  const has = (l: string) => labels.includes(l);
  if (has(SOURCE_BLOCKED_LABEL)) return "blocked";
  if (has(lifecycle.readyToClose)) return "done";
  if (inRelease || has(lifecycle.readyForProd)) return "awaitingRelease";
  if (has(lifecycle.prApproved)) return "pendingVerification";
  if (has(lifecycle.prMerged)) return "merged";
  if (has(lifecycle.prPendingActions)) return "changesRequested";
  if (has(lifecycle.prUnderReview)) return "inReview";
  if (has(triggerLabel)) return "approved";
  return null;
}

type LabelWrite = (c: GitHubIssueConnector, config: RepoConfig, n: number, logger: Logger) => boolean;

/**
 * The label write each lifecycle move makes. A move added to the lifecycle
 * table without a row here fails to compile. `queue` writes nothing: a queued
 * issue keeps its trigger label, which is what makes it build once the PR
 * ahead of it merges or closes.
 */
const LABEL_WRITE: Readonly<Record<Move, LabelWrite>> = Object.freeze({
  queue: () => false,
  implemented: (c, cfg, n, log) => c.implementationDone(cfg, n, log),
  alreadyApproved: (c, cfg, n, log) => c.alreadyMerged(cfg, n, "prApproved", log),
  alreadyMerged: (c, cfg, n, log) => c.alreadyMerged(cfg, n, "prMerged", log),
  reviewApproved: (c, cfg, n, log) => c.reviewOutcome(cfg, n, "prApproved", log),
  reviewMerged: (c, cfg, n, log) => c.reviewOutcome(cfg, n, "prMerged", log),
  changesRequested: (c, cfg, n, log) => c.reviewOutcome(cfg, n, "prPendingActions", log),
  revised: (c, cfg, n, log) => c.revisionDone(cfg, n, log),
  verifyPassed: (c, cfg, n, log) => c.verifyPassed(cfg, n, log),
  recoverPassed: (c, cfg, n, log) => c.deadZoneResolve(cfg, n, "pass", log),
  recoverFailed: (c, cfg, n, log) => c.deadZoneResolve(cfg, n, "fail", log),
  recoverMerged: (c, cfg, n, log) => c.deadZoneResolve(cfg, n, "merged", log),
  release: (c, cfg, n, log) => c.orphanRelease(cfg, n, log),
});

/** repo → the covered issue set last announced by implement's "all have linked PRs" skip. */
const coveredSkipAnnounced = new Map<string, string>();

/**
 * GitHub issues as a work source — the first `WorkSourceAdapter` connector.
 *
 * `selectWork` is everything this source offers the implement stage: open
 * issues carrying the trigger label, not `blocked`, in no lifecycle state,
 * implemented by no open or merged PR — uncapped, in `gh issue list` order.
 * The orchestrator cuts its own capped `discoveryBatch` from it, and hands the
 * whole offer (less backed-off issues) to a skill.
 *
 * `selectEligible` is the same filter WITHOUT the PR cross-check and the cap —
 * every issue a session could still be asked to build. It is GitHub-specific
 * bookkeeping (label widening after a run, the review checkout's queue count),
 * not part of the adapter contract.
 *
 * Recording is issue labels: `record` translates a lifecycle move
 * (lifecycle.ts) into exactly the `gh issue edit` that move has always
 * written (`LABEL_WRITE`). Every other event writes nothing on GitHub: the PR
 * body's `Related to #N` already carries the link and the implement agent
 * writes the skip comment itself — a write here would change what GitHub sees.
 * `snapshot` reads the labels back as stages (`issueStage`).
 *
 * Never sets `ready for prod release`: that label is the EM outcome-gate's
 * signature (separation of duties, 2026-07-27), and no lifecycle move maps
 * to it. Putting a gate back that a review removed (`restoreEmGate`)
 * is code-host logic and stays outside the connector.
 *
 * Stateless: construct one where it is used.
 */

export class GitHubIssueConnector implements WorkSourceAdapter {
  async selectWork(repoConfig: RepoConfig, _config: AgentConfig, logger: Logger): Promise<WorkItem[]> {
    return this.selectUncovered(repoConfig, logger).map((n) => ({ issueNumber: n, repo: repoConfig.githubRepo }));
  }

  async record(event: WorkEvent, repoConfig: RepoConfig, logger: Logger): Promise<boolean> {
    if (event.kind !== "transition") return false;
    return LABEL_WRITE[event.move](this, repoConfig, event.item.issueNumber, logger);
  }

  async snapshot(repoConfig: RepoConfig, logger: Logger): Promise<SnapshotItem[]> {
    const out: SnapshotItem[] = [];
    for (const { number, labels } of openIssueLabels(repoConfig, logger)) {
      const stage = issueStage(labels, false, repoConfig.lifecycleLabels, repoConfig.triggerLabel);
      if (stage === null) continue;
      out.push({ item: { issueNumber: number, repo: repoConfig.githubRepo }, stage, detail: labels.join(", ") || "none" });
    }
    return out;
  }

  /**
   * After a successful implementation (or a reconciliation PR): add
   * `prUnderReview` so the EM knows a PR is ready for review.
   *
   * @internal
   */
  implementationDone(config: RepoConfig, num: number, logger: Logger): boolean {
    const labels = config.lifecycleLabels;
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--add-label", labels.prUnderReview,
      ], config.repoPath);
      logger.info(`Added "${labels.prUnderReview}" to issue #${num} after implementation`);
      return true;
    } catch (err) {
      logger.warn(`Failed to add "${labels.prUnderReview}" on #${num}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** After a successful revision: remove `prPendingActions`, add `prUnderReview`. @internal */
  revisionDone(config: RepoConfig, num: number, logger: Logger): boolean {
    const labels = config.lifecycleLabels;
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--remove-label", labels.prPendingActions,
        "--add-label", labels.prUnderReview,
      ], config.repoPath);
      logger.info(`Transitioned issue #${num} labels: "${labels.prPendingActions}" → "${labels.prUnderReview}"`);
      return true;
    } catch (err) {
      logger.warn(`Failed to transition labels on #${num}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Move an issue out of `pr under review` into a review outcome: the outcome
   * its own review run reported (written immediately after that run), or
   * `pr pending actions` when red CI bounces the PR back to revise.
   *
   * Why the post-review write exists at all: the merge is performed by code, but
   * the record of what the merge MEANT was left to the review agent to remember to
   * write. Measured over 7 days (2026-07-29 → 08-04): 53 merges, 12 issues left
   * mislabeled — ~23%. In the worked example (slashbin-io-worker#575) the agent
   * merged, verified, reported `verdict=APPROVE merged=yes deploy=SUCCESS`, named
   * the target label 24 times in its own output, and never executed the write.
   *
   * Sibling of the dead-zone resolve, which repairs the same state a cycle later
   * from a FRESH verification. This one needs no re-verification because the
   * verdict is the one the review just produced.
   *
   * Never applies `ready for prod release`: `outcome` names a lifecycle KEY, not a
   * label, and the type admits only the review outcomes.
   *
   * @internal
   */
  reviewOutcome(config: RepoConfig, issueNumber: number, outcome: ReviewOutcome, logger: Logger): boolean {
    const { prUnderReview } = config.lifecycleLabels;
    const nextLabel = config.lifecycleLabels[outcome];
    try {
      gh([
        "issue", "edit", String(issueNumber),
        "--repo", config.githubRepo,
        "--remove-label", prUnderReview,
        "--add-label", nextLabel,
      ], config.repoPath);
      logger.info(`Transitioned issue #${issueNumber} labels: "${prUnderReview}" → "${nextLabel}"`);
      return true;
    } catch (err) {
      logger.warn(
        `Failed to transition labels on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Dev verification passed (EM#440): `prMerged` → `prApproved`. The verifier
   * writes no label itself; this is the only writer of the step.
   *
   * @internal
   */
  verifyPassed(config: RepoConfig, issueNumber: number, logger: Logger): boolean {
    const { prMerged, prApproved } = config.lifecycleLabels;
    try {
      gh([
        "issue", "edit", String(issueNumber),
        "--repo", config.githubRepo,
        "--remove-label", prMerged,
        "--add-label", prApproved,
      ], config.repoPath);
      logger.info(`Transitioned issue #${issueNumber} labels: "${prMerged}" → "${prApproved}" (dev verification passed)`);
      return true;
    } catch (err) {
      logger.warn(
        `Failed to transition labels on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * TERMINAL transition (slashbin-ai-foreman#32): the issue's work is already
   * merged to the base branch. Strip the trigger label so the issue permanently
   * leaves the actionable set, and add `pr approved` — meaning "implemented and
   * merged, awaiting the EM outcome-gate."
   *
   * It must NOT be `ready for prod release`: that label authorizes production.
   * Granting it here would let the Foreman authorize its own release.
   *
   * Stripping `triggerLabel` is the load-bearing half: without it the issue stays
   * "actionable" forever and the Foreman burns a full Claude session every
   * back-off window concluding there is nothing to do.
   *
   * @internal
   */
  alreadyMerged(config: RepoConfig, num: number, outcome: "prApproved" | "prMerged", logger: Logger): boolean {
    const next = config.lifecycleLabels[outcome];
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--remove-label", config.triggerLabel,
        "--add-label", next,
      ], config.repoPath);
      logger.info(
        `Terminal transition on #${num}: removed "${config.triggerLabel}", added "${next}" (work already merged to ${config.baseBranch})`,
      );
      return true;
    } catch (err) {
      logger.warn(
        `Failed terminal transition on #${num}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Move a dead-zoned issue out of `pr under review` once a FRESH verification has
   * produced a verdict: `pr approved` on PASS, `pr pending actions` on FAIL.
   *
   * Deliberately never applies `ready for prod release` — the most this can do is
   * restore the issue to the state a healthy review run would have left it in.
   *
   * @internal
   */
  deadZoneResolve(config: RepoConfig, issueNumber: number, verdict: "pass" | "fail" | "merged", logger: Logger): boolean {
    const { prUnderReview, prPendingActions } = config.lifecycleLabels;
    // "merged": no verdict here — hand the issue to the verify stage (EM#441).
    const nextLabel = config.lifecycleLabels[verdict === "pass" ? "prApproved" : verdict === "merged" ? "prMerged" : "prPendingActions"];
    try {
      // Remove only what is actually present. `gh` errors on removing an absent
      // label, and since the dead zone covers `pr pending actions` as well as
      // `pr under review`, a hard `--remove-label` of `prUnderReview` would throw
      // on exactly the issues the widened detector catches.
      dropIssueSnapshot(config.githubRepo);
      const issue = getOpenIssues(config.githubRepo, config.repoPath, logger)
        .find((i) => i.number === issueNumber);
      if (!issue) {
        logger.debug(`Dead-zone resolve skipped for #${issueNumber} — no longer open`);
        return false;
      }

      const args = ["issue", "edit", String(issueNumber), "--repo", config.githubRepo];
      const stripped: string[] = [];
      for (const l of [prUnderReview, prPendingActions]) {
        // Never strip the label we are about to add — that is a no-op edit that
        // reads as a transition.
        if (l !== nextLabel && hasLabel(issue, l)) {
          args.push("--remove-label", l);
          stripped.push(l);
        }
      }
      if (!hasLabel(issue, nextLabel)) args.push("--add-label", nextLabel);
      // Nothing to strip or add: the issue is already where recovery would put it.
      // (The base argv is 5 long; this compared against 4 and so never fired,
      // sending a flagless `gh issue edit` that GitHub rejects — same `false`,
      // one wasted call and a misleading "failed" warning.)
      if (args.length === 5) {
        logger.debug(`Dead-zone resolve on #${issueNumber} is already in the target state`);
        return false;
      }

      gh(args, config.repoPath);
      logger.info(
        `Dead-zone resolved on #${issueNumber}: removed ${stripped.map((s) => `"${s}"`).join(", ") || "(nothing)"}, ` +
        `added "${nextLabel}" (re-verification ${verdict.toUpperCase()})`,
      );
      return true;
    } catch (err) {
      logger.warn(
        `Failed to resolve dead zone on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Return an orphaned issue to the implement queue by stripping whichever
   * lifecycle label is stranding it. The trigger label (`approved`) is left alone
   * — it is still authorized, it just never got built.
   *
   * @internal
   */
  orphanRelease(config: RepoConfig, issueNumber: number, logger: Logger): boolean {
    try {
      dropIssueSnapshot(config.githubRepo);
      const issue = getOpenIssues(config.githubRepo, config.repoPath, logger)
        .find((i) => i.number === issueNumber);
      if (!issue) return false;

      const args = ["issue", "edit", String(issueNumber), "--repo", config.githubRepo];
      // `gh` errors when removing a label that is not present, so only remove what is.
      for (const l of [config.lifecycleLabels.prUnderReview, config.lifecycleLabels.prPendingActions]) {
        if (hasLabel(issue, l)) args.push("--remove-label", l);
      }
      if (args.length === 5) return false; // nothing to strip — state changed under us

      gh(args, config.repoPath);
      logger.warn(
        `Released orphaned issue #${issueNumber} back to the implement queue — it carried a lifecycle label ` +
        `but no open PR covers it and nothing merged, so the work never landed.`,
      );
      return true;
    } catch (err) {
      logger.warn(
        `Failed to release orphaned issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Return all trigger-labelled open issues in the repo that have not yet
   * progressed through the lifecycle (no configured lifecycle label, not
   * `blocked`). This is the filter `selectWork` applies BEFORE the
   * PR-uncovered cross-check + batch cap — i.e. the full set of issues the
   * implementation skill might still be asked to build.
   *
   * Used by the orchestrator's labeling step to widen the intersection of
   * "issues referenced by the new PR" with "issues that should accept
   * `pr under review`": a repo-local skill makes its OWN selection from the
   * entire approved set (priority + smaller-scope-first), which can differ
   * from the discovery batch (PR-uncovered subset, capped at MAX_BATCH_SIZE).
   * Without this widening, when the skill picks an approved issue that wasn't
   * in the discovery batch, the resulting PR gets a real merge but no
   * `pr under review` label, leaving the EM with no signal.
   * (slashbin-ai-foreman#18)
   *
   * Returns [] on any gh failure (treat as "nothing to widen to" rather
   * than throwing — the caller already has the discovery batch as a
   * fallback, and a labeling miss is recoverable).
   */
  async selectEligible(repoConfig: RepoConfig, logger: Logger): Promise<WorkItem[]> {
    try {
      return this.eligible(repoConfig, logger).map((n) => ({ issueNumber: n, repo: repoConfig.githubRepo }));
    } catch (err) {
      logger.warn("selectEligible failed; returning [] (labeling will fall back to discovery batch)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Trigger-labelled, not `blocked`, no lifecycle label. Throws on gh failure. */
  private eligible(config: RepoConfig, logger: Logger): number[] {
    const issues = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, config.triggerLabel));

    const lifecycleLabelValues = Object.values(config.lifecycleLabels);

    const actionable: number[] = [];
    for (const issue of issues) {
      const labels = issue.labels.map((l) => l.name);
      if (labels.includes("blocked")) continue;
      if (lifecycleLabelValues.some((l) => labels.includes(l))) continue;
      actionable.push(issue.number);
    }
    return actionable;
  }

  /**
   * Gate check: eligible issues that don't already have a PR. Returns every
   * uncovered issue number, in the order `gh issue list` returned them (the
   * order a self-selecting skill saw), or [] if none or on any failure.
   */
  private selectUncovered(config: RepoConfig, logger: Logger): number[] {
    const repo = config.githubRepo;

    try {
      const actionable = this.eligible(config, logger);

      if (actionable.length === 0) return [];

      // Loop detection: check if all actionable issues already have a PR (open or merged)
      // that references them. If so, skip — the Foreman already did the work.
      // Check both open and merged PRs to catch issues where the PR was already merged
      // but the issue label wasn't updated.
      const openPrs = findOpenPrs(repo, config.repoPath, { base: config.baseBranch, limit: 50 });

      const mergedPrJson = ghKeyed(`merged20:${repo}:${config.baseBranch}`, () => closedPrVersion(repo), [
        "pr", "list",
        "--repo", repo,
        "--state", "merged",
        "--base", config.baseBranch,
        "--json", "number,title,body",
        "--limit", "20",
      ], config.repoPath);

      const mergedPrs: { number: number; title: string; body: string }[] = JSON.parse(mergedPrJson || "[]");
      const allPrs = [...openPrs, ...mergedPrs];

      // An issue is "covered" only if some PR IMPLEMENTS it (close/relate keyword,
      // or `(#N)` in the title) — NOT merely mentions it in body prose. The old
      // bare-`#N` test over concatenated title+body orphaned issues that a sibling
      // PR's body referenced (e.g. a schema PR body saying "tracked separately in
      // #3" made #3 look covered, so it was never implemented). (slashbin-ai-foreman#28)
      const covered = new Set<number>();
      for (const pr of allPrs) {
        for (const n of extractImplementedIssues({ title: pr.title, body: pr.body })) {
          covered.add(n);
        }
      }

      const uncovered: number[] = [];
      for (const issueNum of actionable) {
        if (!covered.has(issueNum)) {
          uncovered.push(issueNum);
        }
      }

      if (uncovered.length > 0) {
        coveredSkipAnnounced.delete(repo);
        return uncovered;
      }

      // A standing condition, not an event: announce it once per episode (the
      // same covered set), not every cycle. Dead-zone recovery picks up the
      // merged ones; this line only says why implement is idle.
      const episode = [...actionable].sort((a, b) => a - b).join(",");
      const msg = `Skipped ${repo}: ${actionable.length} approved issue(s), all have linked PRs (open or merged)`;
      if (coveredSkipAnnounced.get(repo) === episode) logger.debug(msg);
      else {
        coveredSkipAnnounced.set(repo, episode);
        logger.info(msg);
      }
      return [];
    } catch (err) {
      if (isBackoffRefusal(err)) {
        logger.debug("Failed to check for approved issues — GitHub back-off active");
        return [];
      }
      logger.error("Failed to check for approved issues", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
