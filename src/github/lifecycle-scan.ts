// Lifecycle scans: merged, stuck, orphaned and still-in-review issues, review
// outcomes read from labels, and restoring a revoked EM gate.

import type { LifecycleLabels, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { closedPrVersion, dropIssueSnapshot, findOpenPrs, formatGhError, getOpenIssues, ghKeyed, hasLabel } from "./cache.js";
import { extractImplementedIssues } from "./discovery.js";
import { gh } from "./gh.js";
import { getReferencedIssuesFromOpenPR } from "./pr.js";
import { backoffSettings } from "../backoff.js";


export interface MergedIssueRef {
  issueNumber: number;
  prNumber: number;
  prUrl: string;
  mergedAt: string;
}

/**
 * THE shared primitive: of `candidates`, which issues' work is already MERGED to
 * `baseBranch`? Resolved by running each recently-merged PR through the STRICT
 * implemented-issue predicate — a merged PR must say it *closed* the issue
 * (`closes`/`fixes`/`resolves #N`, or `(#N)` in the title / a commit headline).
 * A mere "related to #N" does not count. See extractImplementedIssues({strict}).
 *
 * Two callers, two DIFFERENT policies — the distinction that matters is
 * *did a gate reject this work?*:
 *   - implement-skip (slashbin-ai-foreman#32): no gate ever ran, the work is just
 *     merged with no lifecycle label → AUTO-ADVANCE to the terminal state.
 *   - findStuckMergedIssues: post-merge verify FAILED → NEVER auto-advance
 *     (a gate rejected it); surface to the EM instead.
 *
 * Conservative: returns [] on any lookup failure — under-advancing is safe
 * (status quo), over-advancing marks unbuilt work as done.
 */
export function findIssuesMergedToBase(
  config: RepoConfig,
  candidates: number[],
  logger: Logger,
): MergedIssueRef[] {
  if (candidates.length === 0) return [];
  try {
    // The merged set only grows when a PR merges, which the fleet state sees.
    const json = ghKeyed(`merged:${config.githubRepo}:${config.baseBranch}`, () => closedPrVersion(config.githubRepo), [
      "pr", "list",
      "--repo", config.githubRepo,
      "--state", "merged",
      "--base", config.baseBranch,
      "--json", "number,url,title,body,commits,mergedAt",
      "--limit", "30",
    ], config.repoPath);
    const prs = JSON.parse(json || "[]") as {
      number: number;
      url: string;
      title?: string;
      body?: string;
      commits?: { messageHeadline?: string; messageBody?: string }[];
      mergedAt?: string;
    }[];

    const wanted = new Set(candidates);
    const hits = new Map<number, MergedIssueRef>();
    for (const pr of prs) {
      const commits = pr.commits ?? [];
      const closed = extractImplementedIssues({
        title: pr.title || "",
        body: pr.body || "",
        commitHeadlines: commits.map((c) => c.messageHeadline || ""),
        commitBodies: commits.map((c) => c.messageBody || ""),
        strict: true,
      });
      for (const n of closed) {
        // Never match a PR against its OWN number: GitHub's squash-merge appends
        // "(#<pr>)" to the commit headline, which the `(#N)` rule would otherwise
        // read as "this PR closed issue #<pr>". Harmless today (issues and PRs
        // share one number sequence, so a PR number is never an issue number) —
        // guarded anyway so it can't become a real false-advance later.
        if (n === pr.number) continue;
        // Keep the FIRST (most recent — gh lists newest-first) merged PR per issue.
        if (wanted.has(n) && !hits.has(n) && pr.mergedAt) {
          hits.set(n, {
            issueNumber: n,
            prNumber: pr.number,
            prUrl: pr.url,
            mergedAt: pr.mergedAt,
          });
        }
      }
    }
    return [...hits.values()].sort((a, b) => a.issueNumber - b.issueNumber);
  } catch (err) {
    logger.warn("findIssuesMergedToBase: gh pr list failed — advancing nothing", {
      ...formatGhError(err),
      repo: config.githubRepo,
    });
    return [];
  }
}

export type StuckMergedIssue = MergedIssueRef;

/** Grace window before a merged-but-unadvanced issue is treated as dead-zoned,
 *  giving an in-flight post-merge verify time to advance it. Prevents flapping
 *  on freshly-merged PRs the review agent is still finishing. */

/**
 * Detect issues DEAD-ZONED by a failed post-merge verify: labeled `pr under
 * review` with their feature PR already MERGED to the base branch, yet never
 * advanced to `ready for prod release`. `findPRsNeedingReview` only fires while
 * the PR is OPEN; once it merges, a failed post-merge verify leaves the issue
 * pinned at `pr under review` with NO phase that ever recovers it. This surfaces
 * those so the EM can re-verify and advance/flag by hand.
 *
 * DETECTION ONLY — this function never mutates labels. It does NOT follow that
 * nothing can be done: re-running the post-merge verification and advancing on
 * PASS / flagging on FAIL is exactly what the alert asks the EM to do by hand,
 * and it is not a rubber stamp because the verdict comes from the verifier, not
 * from the agent that dropped the ball. That repair lives in the orchestrator
 * (`recoverDeadZonedIssue`); the split keeps "what is broken" separable from
 * "what we did about it". What remains forbidden is advancing WITHOUT a fresh
 * verification — a post-merge FAIL must still HOLD.
 *
 * Conservative by design (returns [] on any ambiguity):
 *  - skips main-only repos (no features→develop lifecycle)
 *  - ignores `pr approved` / `ready for prod release` (already advanced)
 *  - ignores issues REFERENCED BY an open feature PR (normal review-pending;
 *    tryReview owns those specific issues)
 *  - only flags PRs merged more than backoff.stuckMergeGraceMs ago (no flap on fresh merges)
 *
 * An issue with ONLY the trigger label is the same dead zone by a third door
 * (slashbin-ai-foreman#73): implement treats it as covered once its PR merged,
 * and no lifecycle label ever arrives. It is included when it carries no
 * lifecycle label and is not `blocked`.
 *
 * `pr pending actions` USED to be excluded here on the grounds that "revise owns
 * it". That was only true while a feature PR is open: `findPendingRevisions`
 * returns null the moment there is none, at `debug` level, so a revision request
 * whose PR merged or closed underneath it was owned by nobody and logged
 * nowhere. It is the same dead zone as `pr under review`, one label over, and it
 * is now included.
 */
export function findStuckMergedIssues(
  config: RepoConfig,
  logger: Logger,
): StuckMergedIssue[] {
  if (config.baseBranch === config.featureBranch) return [];
  try {
    const { prUnderReview, prPendingActions, prMerged, prApproved, readyForProd } = config.lifecycleLabels;
    const lifecycle = Object.values(config.lifecycleLabels);
    const issues = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) =>
        hasLabel(i, prUnderReview) || hasLabel(i, prPendingActions) ||
        // Trigger label only, no lifecycle label: implement skips it as covered
        // once its PR merged, and before slashbin-ai-foreman#73 nothing else
        // looked at it — the third door into the same dead zone.
        (hasLabel(i, config.triggerLabel) && !hasLabel(i, "blocked") && !lifecycle.some((l) => hasLabel(i, l))));
    const candidates = issues.filter(
      // `pr merged` belongs to the verify stage, which owns its retries.
      (i) => !(
        hasLabel(i, prMerged) || hasLabel(i, prApproved) || hasLabel(i, readyForProd)
      ),
    );
    if (candidates.length === 0) return [];

    // An open feature PR means the issues THAT PR COVERS are normal
    // review-pending — tryReview owns those. It says nothing about any other
    // issue in the repo.
    //
    // This used to `return []` for the whole repo the moment any feature PR was
    // open. Because the feature branch is long-lived and shared, a repo with
    // active work almost always has one — so a single open PR concealed every
    // dead-zoned issue behind it, and the dead zone became least visible exactly
    // when the repo was busiest. Scope the exclusion to the referenced issues.
    //
    // Fail CLOSED on an unreadable reference list: if we cannot tell which
    // issues the open PR covers, suppress the whole repo as before rather than
    // risk "recovering" an issue whose PR is still open and under review.
    const openFeaturePrs = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    let reviewPending: number[] = [];
    if (openFeaturePrs.length > 0) {
      const referenced = getReferencedIssuesFromOpenPR(
        config.githubRepo,
        config.featureBranch,
        config.baseBranch,
        config.repoPath,
        logger,
      );
      if (referenced === null) {
        logger.debug(
          `${config.name}: open feature PR present but its referenced issues are unreadable — suppressing dead-zone detection this pass`,
        );
        return [];
      }
      reviewPending = referenced;
    }
    const unowned = candidates.filter((i) => !reviewPending.includes(i.number));
    if (unowned.length === 0) return [];

    // Resolve merged work via the SHARED strict primitive — not a bare `#N` scan.
    // A bare-`#N` match would false-positive on an incidental prose mention
    // (slashbin-ai-foreman#28), flagging issues that were never actually merged.
    const merged = findIssuesMergedToBase(
      config,
      unowned.map((i) => i.number),
      logger,
    );

    const nowMs = Date.now();
    return merged.filter(
      (m) => nowMs - new Date(m.mergedAt).getTime() > backoffSettings().stuckMergeGraceMs,
    );
  } catch (err) {
    logger.debug(
      `findStuckMergedIssues failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Detect issues ORPHANED by work that never landed: labeled `pr under review`
 * or `pr pending actions`, with **no open feature PR covering them and nothing
 * merged to the base branch**. The PR was closed without merging, or the
 * implement run recorded a label and then died before opening one.
 *
 * This is the third dead zone and the only one where the work does not exist:
 *
 *   | label               | PR open   | PR merged        | PR closed / none |
 *   |---------------------|-----------|------------------|------------------|
 *   | pr under review     | tryReview | findStuckMerged  | HERE             |
 *   | pr pending actions  | tryRevise | findStuckMerged  | HERE             |
 *
 * The lifecycle label is what makes it invisible: `GitHubIssueConnector.selectWork` skips
 * ANY issue carrying one, so an issue whose PR vanished keeps its `approved`
 * label, is never re-implemented, is never reviewed, and produces no log line
 * above `debug`. It simply stops existing as far as the pipeline is concerned.
 *
 * Recovery is the opposite of the merged case: there is nothing to verify, so
 * the correct action is to RETURN IT TO THE QUEUE — strip the lifecycle label
 * and let the implement phase pick it up again on its `approved` label. That is
 * safe precisely because nothing merged; re-implementing cannot duplicate work
 * that does not exist.
 *
 * Conservative by design:
 *  - skips main-only repos
 *  - ignores `pr approved` / `ready for prod release` (past this stage)
 *  - ignores issues an open feature PR references, and fails CLOSED when that
 *    reference list is unreadable
 *  - requires the issue to have been in this state longer than the grace window,
 *    so a PR being opened right now is never mistaken for one that never was
 */
export function findOrphanedLifecycleIssues(
  config: RepoConfig,
  logger: Logger,
): number[] {
  if (config.baseBranch === config.featureBranch) return [];
  try {
    const { prUnderReview, prPendingActions, prMerged, prApproved, readyForProd } = config.lifecycleLabels;
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);
    const candidates = open.filter(
      (i) =>
        (hasLabel(i, prUnderReview) || hasLabel(i, prPendingActions)) &&
        !hasLabel(i, prMerged) &&
        !hasLabel(i, prApproved) &&
        !hasLabel(i, readyForProd),
    );
    if (candidates.length === 0) return [];

    const openFeaturePrs = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    let reviewPending: number[] = [];
    if (openFeaturePrs.length > 0) {
      const referenced = getReferencedIssuesFromOpenPR(
        config.githubRepo,
        config.featureBranch,
        config.baseBranch,
        config.repoPath,
        logger,
      );
      // Unreadable reference list — cannot tell what the open PR covers, so
      // releasing anything risks re-implementing work that is in flight.
      if (referenced === null) return [];
      reviewPending = referenced;
    }

    const unowned = candidates.filter((i) => !reviewPending.includes(i.number));
    if (unowned.length === 0) return [];

    // Anything already merged belongs to findStuckMergedIssues, which re-verifies
    // rather than re-queues. Only what NEVER landed is an orphan.
    const merged = new Set(
      findIssuesMergedToBase(config, unowned.map((i) => i.number), logger).map((m) => m.issueNumber),
    );

    return unowned.filter((i) => !merged.has(i.number)).map((i) => i.number);
  } catch (err) {
    logger.debug(
      `findOrphanedLifecycleIssues failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * POST-CONDITION CHECK for a finished review run: of `issueNumbers`, which are
 * still pinned at `pr under review` with no lifecycle label beyond it?
 *
 * The review phase reports its own outcome via a self-declared status trailer.
 * A trailer is a CLAIM; the labels are the STATE. When the two disagree the
 * labels win, because the next phase reads labels and nothing ever reads the
 * trailer again. Checking them directly is what makes the orphan detectable
 * without any cooperation from the agent that created it.
 *
 * Reads FRESH — the review runs in a separate process whose label writes never
 * invalidate our snapshot cache, so a cached read here would report the
 * pre-review state and manufacture a false orphan on every successful run.
 *
 * Returns [] on any lookup failure: a check that cannot see the truth must not
 * assert one.
 */
export function findIssuesStillUnderReview(
  config: RepoConfig,
  issueNumbers: number[],
  logger: Logger,
): number[] {
  if (issueNumbers.length === 0) return [];
  try {
    dropIssueSnapshot(config.githubRepo);
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);
    return issueNumbers.filter((num) => {
      const issue = open.find((i) => i.number === num);
      // Absent from the open set = closed. The review closed it out; not stuck.
      if (!issue) return false;
      const { prUnderReview, prMerged, prApproved, prPendingActions, readyForProd } = config.lifecycleLabels;
      if (!hasLabel(issue, prUnderReview)) return false;
      return !(
        hasLabel(issue, prMerged) ||
        hasLabel(issue, prApproved) ||
        hasLabel(issue, prPendingActions) ||
        hasLabel(issue, readyForProd)
      );
    });
  } catch (err) {
    logger.debug(
      `findIssuesStillUnderReview failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * The lifecycle states a review can end in, as `LifecycleLabels` keys.
 * `prMerged` when dev verification is its own stage (EM#440): the reviewer
 * merged, and `pr approved` waits on the verifier.
 */
export type ReviewOutcome = "prApproved" | "prMerged" | "prPendingActions";

/**
 * The outcome each of `issueNumbers` carries in `issues`: `pr approved` or
 * `pr pending actions`. An issue that is closed, already `ready for prod`, or
 * has neither is absent. Pure.
 */
export function reviewOutcomesOf(
  config: Pick<RepoConfig, "lifecycleLabels">,
  issues: ReadonlyArray<{ number: number; labels: ReadonlyArray<{ name: string }> }>,
  issueNumbers: ReadonlyArray<number>,
): Map<number, ReviewOutcome> {
  const { prApproved, prMerged, prPendingActions, readyForProd } = config.lifecycleLabels;
  const out = new Map<number, ReviewOutcome>();
  for (const n of issueNumbers) {
    const issue = issues.find((i) => i.number === n);
    if (!issue) continue;
    const has = (name: string) => issue.labels.some((l) => l.name === name);
    if (has(readyForProd)) continue;
    if (has(prApproved)) out.set(n, "prApproved");
    else if (has(prMerged)) out.set(n, "prMerged");
    else if (has(prPendingActions)) out.set(n, "prPendingActions");
  }
  return out;
}

/**
 * The outcome labels a review run left on its issues, read fresh from GitHub.
 * Empty when the read fails: the caller only reports, never decides, on it.
 */
export function readReviewOutcomes(
  config: RepoConfig,
  issueNumbers: number[],
  logger: Logger,
): Map<number, ReviewOutcome> {
  if (issueNumbers.length === 0) return new Map();
  try {
    dropIssueSnapshot(config.githubRepo);
    return reviewOutcomesOf(config, getOpenIssues(config.githubRepo, config.repoPath, logger), issueNumbers);
  } catch (err) {
    logger.debug(`readReviewOutcomes failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

/**
 * Open issues waiting on dev verification (EM#440): labelled `prMerged` and not
 * yet `prApproved` / `ready for prod`. Read fresh — the reviewer that wrote the
 * label is a foreign process. [] on a failed read: nothing is verified blind.
 */
export function findIssuesAwaitingVerify(config: RepoConfig, logger: Logger): number[] {
  try {
    const { prMerged, prApproved, readyForProd } = config.lifecycleLabels;
    dropIssueSnapshot(config.githubRepo);
    return getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, prMerged) && !hasLabel(i, prApproved) && !hasLabel(i, readyForProd))
      .map((i) => i.number)
      .sort((a, b) => a - b);
  } catch (err) {
    logger.warn(`findIssuesAwaitingVerify failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export interface TimelineLabelEvent {
  event?: string;
  label?: { name?: string };
  created_at?: string;
}

/**
 * Did the EM outcome-gate label (`labels.readyForProd` — the label that authorizes
 * production, which only the EM outcome-gate applies and nothing in the review
 * path may take away) get REMOVED at or after `sinceMs`?
 *
 * Pure, so the rule can be tested without a network. The rule that matters is
 * time-symmetry: this asks "was it taken away during the window", never "did it
 * exist before the window". The previous guard asked the second question and
 * therefore missed every gate signed while a review was already running — which
 * is the normal case, not the edge case.
 */
export function wasGateRevokedSince(
  events: TimelineLabelEvent[],
  sinceMs: number,
  labels: LifecycleLabels,
): boolean {
  return events.some((e) =>
    e.event === "unlabeled" &&
    e.label?.name === labels.readyForProd &&
    typeof e.created_at === "string" &&
    Number.isFinite(Date.parse(e.created_at)) &&
    Date.parse(e.created_at) >= sinceMs,
  );
}

/**
 * Which of `issueNumbers` had the EM outcome-gate label REMOVED since `sinceIso`.
 *
 * Detected from the issue's own label timeline, not from a snapshot taken before
 * the run. That distinction is the entire point, and the first version of this
 * guard got it wrong: it captured which issues held the gate BEFORE the review
 * started, then restored those. That handles a gate signed before the run and
 * completely misses a gate signed DURING it — which is the actual reported
 * scenario, and the one that recurred on Slashbin-io-docs#269 (review triggered
 * 13:52:25Z, gate signed 13:57:41Z, agent removed it 13:58:20Z, guard restored
 * nothing because its snapshot predated the signature).
 *
 * Reading the timeline is time-symmetric: an `unlabeled` event inside the run
 * window is a revocation regardless of when the label was applied.
 *
 * Only consulted for issues that do NOT currently carry the label, so the healthy
 * path costs nothing beyond the open-issue snapshot already in hand. Returns []
 * on any failure — a lookup that fails must never manufacture authorization.
 */
export function findRevokedEmGates(
  config: RepoConfig,
  issueNumbers: number[],
  sinceIso: string,
  logger: Logger,
): number[] {
  if (issueNumbers.length === 0) return [];
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return [];

  const revoked: number[] = [];
  try {
    dropIssueSnapshot(config.githubRepo);
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);

    for (const num of issueNumbers) {
      const issue = open.find((i) => i.number === num);
      // Closed, or the gate is still there — nothing was revoked.
      if (!issue || hasLabel(issue, config.lifecycleLabels.readyForProd)) continue;

      try {
        const raw = gh([
          "api", `repos/${config.githubRepo}/issues/${num}/timeline?per_page=100`,
          "-H", "Accept: application/vnd.github.mockingbird-preview+json",
        ], config.repoPath);
        const events: TimelineLabelEvent[] = JSON.parse(raw || "[]");
        if (wasGateRevokedSince(events, since, config.lifecycleLabels)) revoked.push(num);
      } catch (err) {
        logger.warn(
          `Could not read the label timeline for #${num}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    logger.warn(`findRevokedEmGates failed for ${config.githubRepo}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return revoked;
}

export interface EmGateRestoreStep {
  number: number;
  /** The review wrote `pr approved` in the gate's place — strip it on the way back. */
  dropPrApproved: boolean;
}

/**
 * Decide, with no I/O, which issues need their EM outcome-gate put back.
 *
 * Split out from `restoreEmGate` so the decision is testable without a network:
 * the rules about what counts as "revoked" are the part worth pinning, and the
 * `gh` call around them is not.
 *
 * Restores only issues that (a) carried the gate before the run, (b) are still
 * open, and (c) no longer carry it. A closed issue needs no gate — the promotion
 * either happened or the work was abandoned, and re-labeling a closed issue would
 * put it back in the Foreman's pickup list for no reason.
 */
export function planEmGateRestore(
  hadGate: number[],
  open: { number: number; labels: { name: string }[] }[],
  labels: LifecycleLabels,
): EmGateRestoreStep[] {
  const steps: EmGateRestoreStep[] = [];
  for (const num of hadGate) {
    const issue = open.find((i) => i.number === num);
    if (!issue) continue;                                   // closed — nothing to restore
    const names = new Set(issue.labels.map((l) => l.name));
    if (names.has(labels.readyForProd)) continue;           // still signed — healthy path
    steps.push({ number: num, dropPrApproved: names.has(labels.prApproved) });
  }
  return steps;
}

/**
 * Put back any EM outcome-gate label that disappeared across a review run.
 *
 * The review agent writes issue labels itself, so the Foreman cannot intercept
 * that write — it can only detect the damage and undo it. This is the structural
 * half of a rule that until now existed only as a sentence in the review prompt.
 *
 * Why it matters that this is silent without the check: `tryPromotion` calls
 * `findReadyForProdIssues`, which filters on exactly this label, and returns
 * early on an empty set. A revoked gate produces no PR, no error and no log line
 * — indistinguishable from having nothing to promote. Observed on
 * Slashbin-io-docs, 2026-08-04: the gate was signed at 20:20:15Z, overwritten
 * with `pr approved` at 20:22:12Z by a review run that started at 20:11:59Z, and
 * the promotion sat stalled for an hour until a human noticed the absence.
 *
 * A review verdict is never authority to revoke production authorization, so
 * restoring is unconditional. `pr approved` is stripped only when present — it is
 * the label the review wrote in the gate's place, and the two are different
 * lifecycle states, not additive ones.
 *
 * Returns the issues actually restored (usually none — the healthy path).
 */
export function restoreEmGate(
  config: RepoConfig,
  hadGate: number[],
  logger: Logger,
): number[] {
  if (hadGate.length === 0) return [];
  const { readyForProd, prApproved } = config.lifecycleLabels;
  const restored: number[] = [];
  try {
    dropIssueSnapshot(config.githubRepo);
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);
    for (const step of planEmGateRestore(hadGate, open, config.lifecycleLabels)) {
      const { number: num, dropPrApproved } = step;
      const args = [
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--add-label", readyForProd,
      ];
      // Only remove what is actually there; `gh` errors on removing an absent label.
      if (dropPrApproved) args.push("--remove-label", prApproved);

      try {
        gh(args, config.repoPath);
        restored.push(num);
        logger.warn(
          `Restored "${readyForProd}" on #${num} — the review run removed it. ` +
          `A review verdict does not authorize or revoke production; only the EM outcome-gate does.`,
        );
      } catch (err) {
        logger.error(
          `Failed to restore "${readyForProd}" on #${num} — promotion is STALLED until a human re-applies it: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    logger.warn(`restoreEmGate failed for ${config.githubRepo}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return restored;
}
