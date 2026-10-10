// The implement phase: select approved work, gate on an open feature PR, run
// the implement session, and report what it opened or why it stopped.

import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionEvent, SessionReport } from "../adapters.js";
import { selectWork, emit, advance, hasObservers } from "../work-source.js";
import { GitHubIssueConnector } from "../github-work-source.js";
import {
  discoveryBatch,
  hasPendingRevisions,
  getReferencedIssuesFromOpenPR,
  isPrOpen,
  findOpenFeaturePR,
} from "../github.js";
import { implementApprovedIssues, type ImplementationResult } from "../agent.js";
import { isUpstreamBlocked, tryAcquire, reportClaudeResult } from "../upstream-backoff.js";
import {
  checkLocalBranchDivergence,
  fastForwardFeatureBranch,
  divergenceStillHolds,
  type BranchDivergence,
} from "../reconciler.js";
import { findIssuesMergedToBase } from "../github.js";
import { backoffDelay, formatWait } from "../backoff.js";
import { loadRepoState, saveRepoState, type BranchBlock } from "../state.js";
import {
  CycleEvent,
  activeRuns,
  announceDivergence,
  divergenceReason,
  failureCount,
  failurePause,
  itemOf,
  lastFailureReason,
  notifyOnce,
  prReport,
  queuedBehind,
  releaseIfResolved,
  startReport,
  stoppedReason,
} from "./common.js";

/**
 * Classify a recorded skip reason as transient + currently-resolved. Returns
 * true only when (a) the reason matches a known transient pattern AND (b) the
 * underlying precondition can be re-checked from this host AND (c) the check
 * confirms the precondition no longer holds. Returning false is safe — the
 * back-off continues normally.
 *
 * Known transient patterns:
 * - "diverged from origin/<branch>" — local working clone ahead/behind origin;
 *   resolved when both are 0. The skill emits this when `git pull origin
 *   features` fails on a divergent branch state, typically caused by an EM
 *   session leaving polluted refs in the shared clone (see
 *   feedback_em_clone_stay_on_main). An EM manual reconcile
 *   (`git branch -f features origin/features`) clears the cause but cannot
 *   reach into the daemon's skip cache; this recheck lets the orchestrator
 *   notice the cause is gone and admit on the next cycle instead of waiting
 *   out the full 30-min back-off.
 *
 * - "an open PR #N holds the feature branch" (foreman#50) — the session will not
 *   push a second issue onto a branch another PR owns. Cleared once #N is no
 *   longer open. The most common skip in the state file: Slashbin-console #1205
 *   sat out its window 16+ minutes after #1204 merged, Slashbin-io-docs #412 33.
 *
 * Add new transient patterns here as they are identified. Durable reasons
 * (issue-body says "investigation only", "no immediate code change") MUST
 * stay caught by the default `return false` — those don't go away on retry.
 * Unknown stays deny: a PR the snapshot cannot vouch for keeps the back-off.
 */
export function isResolvedTransientSkip(
  reason: string,
  repoConfig: RepoConfig,
  logger: Logger,
): boolean {
  const divergenceMatch = reason.match(/diverged from origin\/(\S+?)\b/i);
  if (divergenceMatch) {
    const branch = divergenceMatch[1];
    const div = checkLocalBranchDivergence(repoConfig.repoPath, branch, logger);
    return div !== null && div.ahead === 0 && div.behind === 0;
  }
  const prNumber = prBlockingSkip(reason);
  if (prNumber !== null) {
    return isPrOpen(repoConfig.githubRepo, prNumber, repoConfig.repoPath) === false;
  }
  return false;
}

/**
 * The PR a skip reason says is holding the branch, or null. The reason is the
 * agent's own words, so match the shapes it uses — "occupied by open PR #N",
 * "open features→develop PR #N … must merge or close" — and require the word
 * that makes the PR the BLOCKER, so a reason that merely cites a PR is not read
 * as one. Exported for tests.
 */
export function prBlockingSkip(reason: string): number | null {
  const m = reason.match(/\b(?:occupied|held|blocked)\b[^.;]*?\bPR #(\d+)/i)
    ?? reason.match(/\bopen\b[^.;#]*?\bPR #(\d+)/i)
    ?? reason.match(/\bPR #(\d+)\b[^.;]*?\b(?:must merge|is (?:still )?open|still open)/i);
  return m ? Number(m[1]) : null;
}

/**
 * A Claude launch that threw is reported as a non-limit result, so a half-open
 * probe is never left out forever. Every launch that returns is reported by its
 * phase directly after the call, ahead of every return.
 */
export function reportLaunchThrew(err: unknown): never {
  reportClaudeResult(false);
  throw err;
}

export async function tryBatchImplementation(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[]
): Promise<ImplementationResult | null> {
  const repoName = repoConfig.name;
  const { skip, repoFailure } = config.backoff;
  const repoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "implement" });

  // Claude is backing off (or its one half-open probe is already out): no
  // per-repo events — the back-off module has already said so, once.
  if (isUpstreamBlocked("claude")) return null;

  // A repo whose sessions keep failing pauses (backoff.repoFailure). When the
  // pause ends the count restarts, but the pause count is kept: tripping again
  // pauses for longer, until a success clears it.
  const failures = failureCount.get(repoName) ?? 0;
  if (failures >= repoFailure.maxFailures) {
    if (failurePause.waiting(repoName)) {
      repoLogger.debug(`Skipping ${repoName} — ${failures} consecutive failures, paused (pause ${failurePause.count(repoName)})`);
      return null;
    }
    repoLogger.info(`Failure pause over for ${repoName} — retrying`);
    failureCount.set(repoName, 0);
  }

  // Gate: are there approved issues to implement? The work source offers
  // every eligible item, uncapped. Two lists are cut from that offer:
  //   - `handOff` — the offer less the state filters below. This is what a
  //     skill is told to build. Uncapped, because a skill chooses by priority
  //     across all of it: capping would hide an S1 behind three older issues.
  //   - `actionableIssues` — the Foreman's own discovery batch (ascending,
  //     capped at MAX_BATCH_SIZE), cut from `handOff` AFTER the filters, so a
  //     backed-off or already-implemented issue never holds a batch slot.
  //     Cutting first and filtering after starved the queue: three backed-off
  //     issues filled the cap every cycle and the rest of the offer was never
  //     reached (Slashbin-console#1154, 2026-10-01). Everything the
  //     Foreman does per issue keeps using it: the run gate, the inline
  //     prompt, a batch-wide skip, the labeling fallback.
  const offered = (await selectWork(repoConfig, config, repoLogger)).map((w) => w.issueNumber);
  let handOff = offered;
  if (offered.length === 0) {
    // Nothing offered, so nothing waits: observers clear this repo's waits.
    await emit({ kind: "waiting", repo: repoConfig.githubRepo, items: [] }, null, repoLogger);
    // Reset failure count when there's no work (issues were resolved externally)
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  // Filter out issues already tracked as implemented in persistent state.
  // This prevents infinite loops where the Foreman re-implements the same
  // issues because the work source's PR check didn't match.
  const repoState = loadRepoState(repoName);

  // Self-heal the `implemented` cache (slashbin-ai-foreman #16/#18/#540 family).
  //
  // Invariant: `implemented[N]` must mean "a PR that delivers N exists".
  // `selectWork` already authoritatively returns only approved
  // issues with NO linked PR (open or merged) — it is the same check the
  // orchestrator trusts to decide what to implement. So any N that is BOTH
  // still in the offer (no delivering PR per the live check) AND in
  // `repoState.implemented` is a stale, dead-zoned entry: a prior run recorded
  // it without producing a delivering PR (PR creation failed, or its commit
  // rode a foreign PR on the shared `features` branch). Left alone it is
  // skipped forever with no recovery. The live no-linked-PR signal wins over
  // the stale cache: prune so the issue is re-implemented this cycle.
  //
  // This cannot reintroduce the re-implement loop the cache guards against:
  // that loop is "PR exists but the linkage check missed it" — here the same
  // linkage check (selectWork) reports NO PR, so there is nothing to
  // loop on; true loops remain bounded by failureCount/cooldown + skip back-off.
  // Additive only — no state shape / .ai-agent.json / branch-model change.
  const staleImplemented = repoState.implemented.filter((n) => handOff.includes(n));
  if (staleImplemented.length > 0) {
    repoLogger.warn(
      `Self-heal: pruning ${staleImplemented.length} stale 'implemented' entr${staleImplemented.length === 1 ? "y" : "ies"} with no delivering PR — re-implementable: ${staleImplemented.map((n) => `#${n}`).join(", ")}`,
    );
    const healed = loadRepoState(repoName);
    healed.implemented = healed.implemented.filter((n) => !staleImplemented.includes(n));
    saveRepoState(repoName, healed);
    repoState.implemented = healed.implemented;
  }

  const alreadyImplemented = new Set(repoState.implemented);
  handOff = handOff.filter((n) => !alreadyImplemented.has(n));
  if (handOff.length === 0) {
    await emit({ kind: "waiting", repo: repoConfig.githubRepo, items: [] }, null, repoLogger);
    repoLogger.info(`All actionable issues already implemented (state filter) — skipping`);
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  // Filter out issues the agent recently chose to skip (investigation-only,
  // blocked-on-external-verification, etc.). Back off (backoff.skip) so
  // we don't burn an agent run every cycle correctly doing nothing.
  // Skipped entries are cleared automatically when the issue is re-implemented
  // (success path) or when the back-off expires.
  //
  // Reason-aware recheck: some skip reasons describe a TRANSIENT precondition
  // (e.g., "local features branch diverged from origin/features") that an EM
  // session can manually resolve mid-back-off. Before honoring the back-off,
  // re-run the precondition check; if it now passes, admit the issue and clear
  // the stale skip entry. This prevents the cache from pinning a dead-zone
  // a whole window past an already-applied manual reconcile.
  // The open feature PR, if any. Unknown (lookup threw) reads as none: the
  // session still refuses to bundle, so the old path is the fallback.
  let featurePr: ReturnType<typeof findOpenFeaturePR> = null;
  try {
    featurePr = findOpenFeaturePR(repoConfig);
  } catch (err) {
    repoLogger.debug(`Open feature PR lookup failed — not queueing on it this cycle: ${err instanceof Error ? err.message : String(err)}`);
  }

  const skippedMap = repoState.skipped ?? {};
  const now = Date.now();
  const stillBackedOff: { n: number; reason: string }[] = [];
  const resolvedTransient: { n: number; reason: string }[] = [];
  handOff = handOff.filter((n) => {
    const entry = skippedMap[n];
    if (!entry) return true;
    const age = now - new Date(entry.lastSkippedAt).getTime();
    if (Number.isNaN(age) || age >= backoffDelay(entry.skipCount, skip)) return true;
    // A skip on the open feature PR is the queue gate's to hold, not a skip's.
    const onFeaturePr = featurePr !== null && prBlockingSkip(entry.reason) === featurePr.number;
    if (onFeaturePr || isResolvedTransientSkip(entry.reason, repoConfig, repoLogger)) {
      resolvedTransient.push({ n, reason: entry.reason });
      return true;
    }
    stillBackedOff.push({ n, reason: entry.reason });
    return false;
  });
  if (resolvedTransient.length > 0) {
    repoLogger.info(
      `Cleared ${resolvedTransient.length} resolved-transient skip entr${resolvedTransient.length === 1 ? "y" : "ies"}: ${resolvedTransient.map(({ n }) => `#${n}`).join(", ")}`,
    );
    const healed = loadRepoState(repoName);
    healed.skipped = healed.skipped ?? {};
    for (const { n } of resolvedTransient) delete healed.skipped[n];
    saveRepoState(repoName, healed);
    repoState.skipped = healed.skipped;
    await releaseIfResolved("skip", { transientCauseGone: true }, resolvedTransient.map(({ n }) => n), repoConfig, repoLogger);
  }
  if (stillBackedOff.length > 0) {
    // Promoted DEBUG → INFO so silent skip-cache filtering is visible in the
    // journal (otherwise the pipeline appears stalled while the cache holds it).
    repoLogger.info(
      `Backing off ${stillBackedOff.length} previously-skipped issue(s): ${stillBackedOff.map(({ n, reason }) => `#${n} (${reason.split("\n")[0].slice(0, 100)})`).join("; ")}`,
    );
  }
  // The repo's whole waiting set, every cycle that reaches here: an issue that
  // drops out of it has stopped waiting, which is how an observer clears it.
  // A recorded branch divergence holds everything else back too (foreman#44).
  const waitingSet = (block: BranchBlock | undefined) => [
    ...stillBackedOff.map(({ n, reason }) => ({ item: itemOf(repoConfig, n), reason: reason.split("\n")[0], skipped: true })),
    ...(block ? handOff.map((n) => ({ item: itemOf(repoConfig, n), reason: divergenceReason(block) })) : []),
  ];
  // A recorded block is re-checked read-only every pass: the fast-forward
  // below sits behind the pending-revision gate and may not run for hours.
  if (repoState.branchBlock && await releaseIfResolved("divergence", { divergenceCleared: divergenceStillHolds(repoConfig) === false }, repoState.branchBlock.announced, repoConfig, repoLogger)) {
    const cleared = loadRepoState(repoName);
    delete cleared.branchBlock;
    saveRepoState(repoName, cleared);
    repoState.branchBlock = undefined;
  }
  await emit({ kind: "waiting", repo: repoConfig.githubRepo, items: waitingSet(repoState.branchBlock) }, null, repoLogger);
  const actionableIssues = discoveryBatch(repoConfig, handOff, repoLogger);
  if (actionableIssues.length === 0) {
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }
  if (handOff.length > actionableIssues.length) {
    repoLogger.info(`Handing the skill ${handOff.length} work item(s) to choose from: ${handOff.map((n) => `#${n}`).join(", ")}`);
  }

  // Gate: if there's a PR awaiting revision (`pr pending actions`), skip implementation.
  // The revision phase (Phase 1) handles these — running implementation would just
  // re-detect the same committed issues and loop without making progress.
  if (hasPendingRevisions(repoConfig, repoLogger)) {
    repoLogger.debug(`Skipping ${repoName} implementation — PR awaiting revision`);
    return null;
  }

  // Bring `features` up to `develop` before the session builds on it.
  //
  // The implement skill's Phase 0 only pulls `features` — nothing has ever
  // merged the base branch in. Dependabot lands on the base, so without this
  // the session builds and boots a tree missing every bump since the last
  // feature merge. Fast-forward only: an in-flight feature PR (features ahead)
  // is the normal state and is left alone, and a true divergence is reported
  // rather than resolved. See fastForwardFeatureBranch for the full rationale.
  const divergence: BranchDivergence = {};
  const ffOutcome = fastForwardFeatureBranch(repoConfig, repoLogger, divergence);
  if (ffOutcome === "diverged") {
    const block = await announceDivergence(repoConfig, handOff, divergence, repoLogger);
    await emit({ kind: "waiting", repo: repoConfig.githubRepo, items: waitingSet(block) }, null, repoLogger);
    return null;
  }
  // "unknown" proves nothing either way, so a recorded block stands.
  if (ffOutcome !== "unknown" && repoState.branchBlock) {
    const cleared = loadRepoState(repoName);
    delete cleared.branchBlock;
    saveRepoState(repoName, cleared);
    repoState.branchBlock = undefined;
    repoLogger.info(
      `${repoConfig.featureBranch} is reconciled with ${repoConfig.baseBranch} — implementation on ${repoName} resumes`,
    );
    await emit({ kind: "waiting", repo: repoConfig.githubRepo, items: waitingSet(undefined) }, null, repoLogger);
  }

  // Gate: an open feature PR holds the branch. The skill builds straight on
  // `features`, so another issue's commit would land in that PR, and the skill
  // refuses to bundle (Phase 4 rule 3). Launching anyway spent a session per
  // cycle to learn that, posted "picked up" then "skipped" to Discord, and
  // bounced the Paperclip card implementing → blocked, for what is just the
  // queue (jerky_service #66/#70, 2026-10-05). Hold here: the issues show as
  // queued, say nothing to Discord, and build once the PR merges or closes.
  const repoQueue = queuedBehind.get(repoName) ?? new Map<number, number>();
  queuedBehind.set(repoName, repoQueue);
  const queued = featurePr ? actionableIssues.filter((n) => !featurePr!.issueNumbers.includes(n)) : [];
  for (const n of [...repoQueue.keys()]) if (!queued.includes(n)) repoQueue.delete(n);
  if (featurePr && queued.length > 0) {
    const fresh = queued.filter((n) => repoQueue.get(n) !== featurePr!.number);
    for (const n of fresh) {
      repoQueue.set(n, featurePr.number);
      await advance(itemOf(repoConfig, n), "queue", repoConfig, repoLogger);
    }
    repoLogger.info(`Queued ${queued.map((n) => `#${n}`).join(", ")} behind open feature PR #${featurePr.number} — builds once it merges or closes`);
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  events?.push({ message: `Picked up ${actionableIssues.length} issue(s) on ${repoConfig.githubRepo}: ${actionableIssues.map(n => `#${n}`).join(", ")}`, level: "info" });

  // Invoke the skill — one Claude session implements all approved issues
  if (!tryAcquire("claude")) return null;
  const runAbort = new AbortController();
  activeRuns.set(repoName, runAbort);
  repoLogger.info(`Triggering batch implementation for ${repoName}`);
  const session: Omit<SessionEvent, "status"> = {
    phase: "implement", repo: repoConfig.githubRepo, items: actionableIssues.map((n) => itemOf(repoConfig, n)),
  };
  // How the session ended, for observers; anything that leaves without setting it threw.
  let ended: { status: "finished" | "failed"; detail: string } = { status: "failed", detail: "the session ended without a result" };
  let report: SessionReport | undefined;
  // The items the session actually worked. A run builds one of its batch; the
  // outcome is told only to that one, never to the issues it left alone.
  let worked: number[] | undefined;

  try {
    // Tell the source the Foreman is starting on its batch, before the session.
    for (const n of actionableIssues) await emit({ kind: "claim", item: itemOf(repoConfig, n) }, repoConfig, repoLogger);
    const goals = startReport(repoConfig, actionableIssues, repoLogger);
    await emit({ kind: "session", session: { ...session, status: "started", ...(goals ? { report: goals } : {}) } }, null, repoLogger);

    const priorFailure = lastFailureReason.get(repoName) || null;
    const result = await implementApprovedIssues(repoConfig, repoLogger, runAbort.signal, priorFailure, actionableIssues, handOff)
      .catch(reportLaunchThrew);
    reportClaudeResult(!!result.upstreamLimit, result.upstreamLimit?.reason, result.upstreamLimit?.resetAtMs);
    ended = result.success
      ? { status: "finished", detail: result.prUrl ? `PR ${result.prUrl}` : "commits added to the open PR" }
      : result.skipped
        ? { status: "finished", detail: `skipped: ${result.skipReason ?? "no reason given"}` }
        : { status: "failed", detail: result.upstreamLimit ? `upstream limit: ${result.upstreamLimit.reason}` : result.error || "unknown" };
    if (hasObservers()) {
      // Commits on the open PR leave no URL: the feature branch names the PR.
      const pr = result.success ? prReport(repoConfig, result.prUrl ?? repoConfig.featureBranch, repoLogger) : undefined;
      report = { ...(result.summary ? { text: result.summary } : {}), ...(pr ? { pr } : {}) };
    }

    if (result.success) {
      failureCount.set(repoName, 0);
      lastFailureReason.delete(repoName);
      failurePause.clear(repoName);

      // Filter to only issues the implementation skill actually addressed in
      // the resulting PR. The canonical implement-approved-issues skill picks
      // ONE issue per invocation, AND it picks from the entire approved set
      // (priority + smaller-scope-first), not necessarily from the Foreman's
      // discovery batch. So the labeling-eligible set is the broader
      // "all-approved-and-actionable" set — not just `actionableIssues`
      // (which is also PR-uncovered + capped at MAX_BATCH_SIZE).
      //
      // Three cases for the intersection of `referencedAll ∩ allActionable`:
      //   1. matched.length > 0 → label the matched subset.
      //   2. referencedAll === null (gh lookup failed) → conservative
      //      fallback: label the discovery batch (`actionableIssues`), since
      //      we can't tell what shipped. Over-labeling is recoverable (EM
      //      cleanup); under-labeling stalls.
      //   3. matched.length === 0 (parser succeeded, found zero matches in
      //      the broader actionable set) → SKIP labeling + state-update
      //      entirely. The open PR exists but doesn't reference any
      //      currently-actionable approved issue. Labeling discovery-batch
      //      issues here would create self-locked issues (state filter sees
      //      them as `implemented`, no real PR to revise), requiring manual
      //      EM cleanup every cycle. (slashbin-ai-foreman#16)
      //
      // Widening to allActionable (vs just actionableIssues) is the
      // slashbin-ai-foreman#18 fix: if the skill picked an out-of-batch
      // approved issue, the resulting PR still gets correctly labeled.
      const referencedAll = getReferencedIssuesFromOpenPR(
        repoConfig.githubRepo,
        repoConfig.featureBranch,
        repoConfig.baseBranch,
        repoConfig.repoPath,
        repoLogger,
      );
      const allActionable = (await new GitHubIssueConnector().selectEligible(repoConfig, repoLogger)).map((w) => w.issueNumber);
      const labelingCandidates = Array.from(new Set([...actionableIssues, ...allActionable]));
      const matched = referencedAll
        ? labelingCandidates.filter((n) => referencedAll.includes(n))
        : null;

      if (matched !== null && matched.length === 0) {
        // Case 3: empty intersection — skip labeling + state-update, log
        // warning, exit cleanly. Next cycle re-discovers and retries.
        repoLogger.warn(
          `Open PR found but its body/title/commits do not reference any actionable approved issue (discovery batch: #${actionableIssues.join(", #")}; broader set: #${labelingCandidates.join(", #")}) — skipping label + state update so the next cycle can retry. Investigate the skill's PR formatting if this recurs.`,
        );
        return null;
      }

      const issuesActuallyImplemented =
        matched && matched.length > 0 ? matched : actionableIssues;
      if (matched && matched.length > 0) worked = matched;
      if (matched && matched.length > 0) {
        const fromBatch = matched.filter((n) => actionableIssues.includes(n));
        const fromBroader = matched.filter((n) => !actionableIssues.includes(n));
        const dropped = actionableIssues.filter((n) => !matched.includes(n));
        if (fromBroader.length > 0) {
          repoLogger.info(
            `Skill implemented ${matched.length} issue(s) — ${fromBatch.length} from discovery batch, ${fromBroader.length} from broader actionable set (skill priority differs from Foreman batch order)`,
            { implemented: matched, fromBatch, fromBroader, deferred: dropped },
          );
        } else if (matched.length < actionableIssues.length) {
          repoLogger.info(
            `Skill implemented ${matched.length}/${actionableIssues.length} discovered issues — labeling only the implemented set`,
            { implemented: matched, deferred: dropped },
          );
        }
      } else if (referencedAll === null) {
        repoLogger.warn(
          `getReferencedIssuesFromOpenPR returned null (lookup failed) — labeling full discovery batch as conservative fallback (#${actionableIssues.join(", #")})`,
        );
      }

      // Persist implemented issue numbers to prevent re-implementation loops
      const updatedState = loadRepoState(repoName);
      for (const issueNum of issuesActuallyImplemented) {
        if (!updatedState.implemented.includes(issueNum)) {
          updatedState.implemented.push(issueNum);
        }
        // Clear any prior skip record — if it's now implemented, the prior
        // "blocked on investigation" state is resolved.
        if (updatedState.skipped) delete updatedState.skipped[issueNum];
      }
      saveRepoState(repoName, updatedState);

      // Report each implemented item in review (on GitHub: the `prUnderReview`
      // label) so the EM knows the PR is ready. One item at a time, in order.
      for (const n of issuesActuallyImplemented) {
        const item = itemOf(repoConfig, n);
        if (result.prUrl) await emit({ kind: "prLink", item, prUrl: result.prUrl }, repoConfig, repoLogger);
        await advance(item, "implemented", repoConfig, repoLogger);
      }

      repoLogger.info(`Batch implementation succeeded — tracked ${issuesActuallyImplemented.map(n => `#${n}`).join(", ")} in state`, { prUrl: result.prUrl });
      events?.push({ message: `Feature PR on ${repoConfig.githubRepo}: ${result.prUrl || "(commits added to existing PR)"}`, level: "info" });
    } else if (result.skipped) {
      // Deliberate no-op by the agent (e.g., issue body says "investigate first").
      // Record per-issue skip timestamps so the back-off filter at the top of
      // this function suppresses retries for backoffDelay(skipCount, backoff.skip).
      // Do NOT increment failureCount — this isn't an error.
      const updatedState = loadRepoState(repoName);
      if (!updatedState.skipped) updatedState.skipped = {};
      let skippedSet = result.skippedIssues && result.skippedIssues.length > 0
        ? result.skippedIssues
        : actionableIssues;
      worked = [...skippedSet];
      const reason = result.skipReason ?? "no reason given";

      // --- Case 4 (slashbin-ai-foreman#32): the work is ALREADY MERGED ---------
      // A skip is only worth retrying if a retry could ever succeed. When the
      // agent declines because the work is already on `baseBranch`, retrying is
      // futile BY DEFINITION — the commits exist; no future cycle will produce a
      // PR for them. Yet the issue keeps `approved` with no lifecycle label, so
      // it stays "actionable" and we burn a full Claude session every back-off
      // window, forever (observed: 7+ hours across two repos, 2026-07-13).
      //
      // Give the lifecycle its missing EXIT: strip the trigger label and advance
      // to `ready for prod release`, permanently removing the issue from the
      // actionable set and handing the EM the signal it already expects. Forward
      // progress then no longer depends on a human closing the issue promptly.
      //
      // Safe because findIssuesMergedToBase() uses the STRICT predicate: only a
      // merged PR that says it CLOSED the issue counts (never a "related to #N").
      // On any lookup failure it advances nothing — we under-advance by design.
      const alreadyMerged = findIssuesMergedToBase(repoConfig, skippedSet, repoLogger);
      if (alreadyMerged.length > 0) {
        const mergedNums = alreadyMerged.map((m) => m.issueNumber);
        await notifyOnce("merged", repoConfig, mergedNums, repoLogger);
        for (const n of mergedNums) {
          // With a verify stage, merged work still owes its acceptance evidence (EM#441).
          await advance(itemOf(repoConfig, n), config.srePath ? "alreadyMerged" : "alreadyApproved", repoConfig, repoLogger);
        }
        repoLogger.info(
          `Advanced ${mergedNums.length} already-merged issue(s) to '${repoConfig.lifecycleLabels[config.srePath ? "prMerged" : "prApproved"]}': ${alreadyMerged.map((m) => `#${m.issueNumber} (merged in PR #${m.prNumber})`).join(", ")}`,
        );
        events?.push({
          message: `Advanced ${mergedNums.length} already-merged issue(s) on ${repoConfig.githubRepo} to '${repoConfig.lifecycleLabels.prApproved}': ${mergedNums.map((n) => `#${n}`).join(", ")}`,
          level: "info",
        });
        // They're out of the actionable set now — no skip record needed, and a
        // stale one would linger in state forever.
        for (const n of mergedNums) delete updatedState.skipped[n];
        skippedSet = skippedSet.filter((n) => !mergedNums.includes(n));
      }
      // ------------------------------------------------------------------------

      const stamp = new Date().toISOString();
      for (const issueNum of skippedSet) {
        // Escalating per-issue back-off: a fixed snooze never gives up, so a
        // permanently-unactionable issue costs an agent session every window,
        // indefinitely. Count the consecutive skips; the filter at the top of
        // this function widens the window geometrically off this count.
        const priorCount = updatedState.skipped[issueNum]?.skipCount ?? 0;
        updatedState.skipped[issueNum] = {
          lastSkippedAt: stamp,
          reason,
          skipCount: priorCount + 1,
        };
      }
      saveRepoState(repoName, updatedState);
      // The agent declined these; the source hears why. On GitHub this writes
      // nothing — the agent posts its own skip comment.
      for (const n of skippedSet) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: reason }, repoConfig, repoLogger);
      // Reset the failure counter — an explicit skip is not a failure.
      failureCount.set(repoName, 0);
      lastFailureReason.delete(repoName);
      failurePause.clear(repoName);
      repoLogger.info(`Batch implementation skipped by agent: ${reason} (issues: ${skippedSet.map(n => `#${n}`).join(", ")})`);
      events?.push({ message: `Implementation skipped on ${repoConfig.githubRepo}: ${reason}`, level: "info" });
    } else {
      // An upstream limit refused the run (or a swallowed GitHub back-off made
      // it look failed) — not a defect, so it charges no retry. The card still
      // goes to Blocked: the work has stopped, and the board says why.
      if (result.upstreamLimit || isUpstreamBlocked("github")) {
        const why = stoppedReason("Implementation", result, isUpstreamBlocked("github"));
        for (const n of actionableIssues) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, repoLogger);
        return null;
      }
      const newCount = (failureCount.get(repoName) ?? 0) + 1;
      failureCount.set(repoName, newCount);
      // The run failed after its work landed in a PR: the PR names the issue
      // it was on, and only that issue is told it failed.
      const onPr = getReferencedIssuesFromOpenPR(
        repoConfig.githubRepo, repoConfig.featureBranch, repoConfig.baseBranch, repoConfig.repoPath, repoLogger,
      )?.filter((n) => actionableIssues.includes(n));
      if (onPr && onPr.length > 0) worked = onPr;
      const failedOn = worked ?? actionableIssues;
      if (newCount < repoFailure.maxFailures) {
        const why = stoppedReason("Implementation", result, false, `${newCount}/${repoFailure.maxFailures}`);
        for (const n of failedOn) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, repoLogger);
      } else {
        const pause = failurePause.start(repoName, repoFailure);
        const why = `implementation failed ${newCount}× — paused ${formatWait(pause)}: ${result.error || "unknown"}`;
        for (const n of failedOn) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, repoLogger);
      }
      lastFailureReason.set(repoName, result.error || "unknown");
      repoLogger.warn(`Batch implementation failed (${newCount}/${repoFailure.maxFailures}): ${result.error}`);
      events?.push({ message: `Implementation failed on ${repoConfig.githubRepo}: ${result.error}`, level: "error" });
    }

    return result;
  } finally {
    activeRuns.delete(repoName);
    await emit({ kind: "session", session: { ...session, ...ended, ...(worked ? { worked } : {}), ...(report ? { report } : {}) } }, null, repoLogger);
  }
}

