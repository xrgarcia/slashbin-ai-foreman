// What is waiting for revise and for review, including orphaned PR adoption.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { isGitHubStateEnabled, stateOpenIssues } from "../github-state.js";
import { findOpenPrs, getOpenIssues, hasLabel, issueCacheTtlMs } from "./cache.js";
import { gh, isBackoffRefusal } from "./gh.js";
import { BackoffTracker, backoffSettings } from "../backoff.js";
import { currentApprovalMs, currentVerdictRequestsChanges, hasFreshReview, returnedToReviewSinceVerdict } from "./review-freshness.js";


// --- Revision Gate ---

export interface PendingRevisionPR {
  number: number;
  url: string;
  headRefName: string;
  /** The PR's head commit: an unblock check compares it to where the Foreman stopped. */
  headRefOid?: string;
}

export interface PendingRevisionInfo {
  issueNumbers: number[];
  pr: PendingRevisionPR;
}

/**
 * Gate check: are there any issues with the `prPendingActions` label?
 * These are issues where the reviewer requested changes on the linked PR
 * and the Foreman needs to revise the code.
 *
 * The review workflow applies `prPendingActions` to the ISSUE (not the PR),
 * so we query issues and then confirm they have an open feature PR.
 *
 * Returns the pending revision details, or null if no work.
 */
export function findPendingRevisions(
  config: RepoConfig,
  logger: Logger
): PendingRevisionInfo | null {
  try {
    // Find issues labeled `prPendingActions` + the trigger label (approved)
    const pendingLabel = config.lifecycleLabels.prPendingActions;
    const pendingActions = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, pendingLabel));
    const issues = pendingActions.filter((i) => hasLabel(i, config.triggerLabel));

    // An issue asked to revise but no longer carrying the trigger label is
    // SKIPPED here, and that is deliberate — revoking `approved` is how work is
    // called off, and revise must honour it rather than press on.
    //
    // But silent is wrong. The issue keeps `pr pending actions`, so
    // `GitHubIssueConnector.selectWork` skips it too, and it belongs to no phase at all.
    // Deliberately stopped and accidentally stranded produced the identical
    // observation — nothing — until this line existed. Say which one it is.
    const withheld = pendingActions.filter((i) => !hasLabel(i, config.triggerLabel));
    if (withheld.length > 0) {
      logger.warn(
        `${config.name}: ${withheld.length} issue(s) labeled "${pendingLabel}" without "${config.triggerLabel}" — ` +
        `revise will NOT act on them and no other phase owns them. Intentional if the work was called off; ` +
        `otherwise re-apply "${config.triggerLabel}" or clear the lifecycle label: ` +
        withheld.map((i) => `#${i.number}`).join(", "),
      );
    }

    if (issues.length === 0) return null;

    // Confirm there's an open feature PR (features → develop)
    const prs: PendingRevisionPR[] = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    if (prs.length > 0) {
      logger.info(`Found ${issues.length} issue(s) pending revision with open PR #${prs[0].number}: ${issues.map(i => `#${i.number}`).join(", ")}`);
      return { issueNumbers: issues.map(i => i.number), pr: prs[0] };
    }

    logger.debug(`Found ${issues.length} issue(s) with "${pendingLabel}" but no open feature PR`);
    return null;
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger.debug("Failed to check for pending revisions — GitHub back-off active");
      return null;
    }
    logger.error("Failed to check for pending revisions", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Backwards-compatible boolean wrapper for the implement-phase gate. */
export function hasPendingRevisions(
  config: RepoConfig,
  logger: Logger
): boolean {
  return findPendingRevisions(config, logger) !== null;
}

export interface ReviewCandidate {
  prNumber: number;
  prUrl: string;
  issueNumbers: number[];
  /**
   * The subset of `issueNumbers` adopted by the orphan fallback — the ones the
   * caller must report `new → inReview` for. Empty on the normal path, where
   * every issue already carries `pr under review`.
   */
  adopted: number[];
  /**
   * True when the PR's current verdict is CHANGES_REQUESTED but its issues still
   * sit at `pr under review`: the review landed, its label move did not. The
   * caller reports them `inReview → changesRequested` instead of reviewing.
   */
  stranded?: boolean;
}

/**
 * An APPROVED feature PR that is still open: the merge after the approval never
 * happened, and a current APPROVE is never reviewed again, so nothing would
 * offer it. On 2026-10-10 GitHub refused five merges while required checks ran
 * (HTTP 405) — Slashbin-console #1271 among them — and each PR sat approved and
 * unmerged for five hours, holding its repo's implement queue. It is offered
 * again once the approval is one `backoff.approvedUnmerged` window old, then
 * after each longer window while it stays open (an author hold keeps it open on
 * purpose). Keyed by the approval: a new verdict starts the count again.
 */
export const approvedUnmergedWaits = new BackoffTracker();

export function approvedUnmergedDue(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
  now = Date.now(),
): boolean {
  const at = currentApprovalMs(config, prNumber, reviewerLogin, logger);
  if (at === null) return false;
  const w = backoffSettings().approvedUnmerged;
  const key = `${config.githubRepo}#${prNumber}@${at}`;
  if (now - at < w.baseMs || approvedUnmergedWaits.waiting(key, now)) return false;
  approvedUnmergedWaits.start(key, w, now);
  logger.warn(`${config.name}: PR #${prNumber} was approved but is still open — the merge never happened; offering it to the reviewer again`);
  return true;
}

/**
 * Gate check for the review phase: is there an open feature PR whose linked
 * issue(s) are labeled `pr under review` (set by implement/revise) and that has
 * NOT already been reviewed by the EM at its current head?
 *
 * Idempotency is primarily label-driven and self-cleaning: a full-fidelity review
 * run either merges an approved PR (closes it → out of scope here) or posts
 * REQUEST_CHANGES and relabels the issue `pr pending actions` (→ owned by the
 * revise phase, excluded below). The freshness guard (`hasFreshReview`) covers the
 * remaining window where a review run crashed after posting its verdict but before
 * relabeling — without it the same PR would be re-reviewed every cycle.
 *
 * Self-heal fallback: when no issue carries `pr under review` but an open feature
 * PR exists, the implement phase opened the PR but never applied the label (the
 * transition step swallows errors, and the process can die between `gh pr create`
 * and the implement stage's `new → inReview` report). GitHub — the actual open PR — is the
 * source of truth for whether review is needed; the label is a tracking artifact.
 * `adoptOrphanedReviewCandidate` finds linked issues from the PR title/body and
 * returns them as `adopted` — the caller reports them `new → inReview` through
 * the work source (on GitHub: `pr under review`) — so the review runs
 * this cycle instead of hanging forever waiting for a label that never lands.
 *
 * Returns null when there's nothing to review.
 */
export function findPRsNeedingReview(
  config: RepoConfig,
  reviewerLogin: string | undefined,
  logger: Logger,
): ReviewCandidate | null {
  try {
    const { prUnderReview, prPendingActions } = config.lifecycleLabels;
    const issues = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, prUnderReview));
    // Exclude issues also labeled `pr pending actions` — the revise phase owns those.
    const reviewable = issues.filter((i) => !hasLabel(i, prPendingActions));
    if (reviewable.length === 0) {
      return adoptOrphanedReviewCandidate(config, reviewerLogin, logger);
    }

    // Confirm an open feature PR exists (features → develop).
    const prs: { number: number; url: string }[] = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    if (prs.length === 0) {
      logger.debug(`${config.name}: ${reviewable.length} issue(s) labeled "${prUnderReview}" but no open feature PR`);
      return null;
    }
    const pr = prs[0];

    if (hasFreshReview(config, pr.number, reviewerLogin, logger)) {
      // A revision that declares "no code change" returns the issues to review
      // WITHOUT moving the head, so by commit time the old verdict still looks
      // current and the PR would sit unreviewed forever (worker#694, 2026-10-03).
      // The relabel is the reply; a verdict older than it is not current.
      if (!returnedToReviewSinceVerdict(config, pr.number, reviewable.map((i) => i.number), reviewerLogin, logger)) {
        // A review run that dies after posting CHANGES_REQUESTED but before moving
        // the labels leaves the issues here: reviewed, so never reviewed again, and
        // never `pr pending actions`, so never revised (mcp_services#240,
        // 2026-10-09: a TLS timeout on the label step parked it 7 hours).
        if (currentVerdictRequestsChanges(config, pr.number, reviewerLogin, logger)) {
          logger.warn(`${config.name}: PR #${pr.number} has a current CHANGES_REQUESTED verdict but its issues are still "${prUnderReview}" — stranded; the review phase sends them to revise`);
          return { prNumber: pr.number, prUrl: pr.url, issueNumbers: reviewable.map((i) => i.number), adopted: [], stranded: true };
        }
        if (approvedUnmergedDue(config, pr.number, reviewerLogin, logger)) {
          return { prNumber: pr.number, prUrl: pr.url, issueNumbers: reviewable.map((i) => i.number), adopted: [] };
        }
        logger.debug(`${config.name}: PR #${pr.number} already has a current ${reviewerLogin ?? "reviewer"} review — skipping re-review`);
        return null;
      }
      logger.info(`${config.name}: PR #${pr.number} was returned to review after its last verdict with no new commit — re-reviewing`);
    }

    logger.info(
      `${config.name}: PR #${pr.number} needs review (issues: ${reviewable.map((i) => `#${i.number}`).join(", ")})`,
    );
    return { prNumber: pr.number, prUrl: pr.url, issueNumbers: reviewable.map((i) => i.number), adopted: [] };
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger.debug("Failed to check for PRs needing review — GitHub back-off active");
      return null;
    }
    logger.error("Failed to check for PRs needing review", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fallback for `findPRsNeedingReview`: an open feature PR exists but no linked
 * issue carries `pr under review`. The implement phase opened the PR then failed
 * (silently) to apply the label — or crashed between `gh pr create` and
 * the `new → inReview` report. Recover by extracting linked issue refs from
 * the PR title/body, returning those that still carry the trigger label as
 * `adopted` (the caller reports them `new → inReview`), and returning a
 * candidate so the review runs this cycle.
 *
 * Safety filters (only adopt issues we clearly own):
 *  - OPEN state
 *  - carries `config.triggerLabel` (default `approved`)
 *  - NOT `pr pending actions` (revise phase owns those)
 *  - NOT `ready for prod release` (already advanced)
 *
 * A PR with no issue to adopt is still reviewed, with no issues: the implement
 * stage queues every approved issue behind any open feature PR, so one the
 * review stage ignores holds the repo forever. jerky_service #99 (a person's
 * PR on `features`, linked to nothing) held #102 for days, logged once a
 * minute as "queued" (2026-10-10). The Tech Lead merges it or asks for changes;
 * the freshness guard keeps either verdict from being reviewed again.
 */
export function adoptOrphanedReviewCandidate(
  config: RepoConfig,
  reviewerLogin: string | undefined,
  logger: Logger,
): ReviewCandidate | null {
  const prs: { number: number; url: string; title: string; body: string }[] = findOpenPrs(
    config.githubRepo,
    config.repoPath,
    { head: config.featureBranch, base: config.baseBranch, limit: 1 },
  );
  if (prs.length === 0) return null;
  const pr = prs[0];

  if (hasFreshReview(config, pr.number, reviewerLogin, logger)
    && !approvedUnmergedDue(config, pr.number, reviewerLogin, logger)) return null;

  const { prUnderReview, prPendingActions, readyForProd } = config.lifecycleLabels;
  const refs = new Set<number>();
  const combined = `${pr.title}\n${pr.body ?? ""}`;
  for (const m of combined.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n !== pr.number) refs.add(n);
  }
  const unlinked = (why: string): ReviewCandidate => {
    logger.info(`${config.name}: PR #${pr.number} ${why} — reviewing it with no issue, so it cannot hold the queue`);
    return { prNumber: pr.number, prUrl: pr.url, issueNumbers: [], adopted: [] };
  };
  if (refs.size === 0) return unlinked("names no issue");

  // This probe runs on every idle cycle while a feature PR waits for review.
  // With the fleet state on, the open-issue list already answers "open, and
  // with which labels" for every ref — absent from it means not open.
  const known = issueCacheTtlMs > 0 && isGitHubStateEnabled(config.githubRepo)
    ? new Map(stateOpenIssues(config.githubRepo).map((i) => [i.number, i]))
    : null;
  const adopted: number[] = [];
  // An open approved issue the PR names, adoptable or not: one in revise or
  // past review is that stage's to move, so the PR is not reviewed without it.
  let tracked = false;
  for (const num of refs) {
    try {
      const info: { state: string; labels: { name: string }[] } = known
        ? { state: known.has(num) ? "OPEN" : "CLOSED", labels: known.get(num)?.labels ?? [] }
        : JSON.parse(gh([
          "issue", "view", String(num),
          "--repo", config.githubRepo,
          "--json", "state,labels",
        ], config.repoPath));
      if (info.state !== "OPEN") continue;
      const names = new Set(info.labels.map((l) => l.name));
      if (!names.has(config.triggerLabel)) continue;
      tracked = true;
      if (names.has(prPendingActions)) continue;
      if (names.has(readyForProd)) continue;
      logger.warn(`${config.name}: adopted orphaned issue #${num} → PR #${pr.number} (implement phase never applied "${prUnderReview}")`);
      adopted.push(num);
    } catch (err) {
      // Unread is not "not ours": the PR waits for a pass that can read it.
      tracked = true;
      logger.debug(`${config.name}: could not inspect referenced #${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (adopted.length === 0) {
    if (!tracked) return unlinked(`names no open "${config.triggerLabel}" issue`);
    logger.debug(`${config.name}: PR #${pr.number} is orphaned but its issues are owned by revise or prod`);
    return null;
  }

  logger.info(`${config.name}: adopted orphaned PR #${pr.number} for review (issues: ${adopted.map((n) => `#${n}`).join(", ")})`);
  return { prNumber: pr.number, prUrl: pr.url, issueNumbers: adopted, adopted };
}
