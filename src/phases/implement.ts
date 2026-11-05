// The implement phase: select approved work, gate on an open feature PR, run
// the implement session, and report what it opened or why it stopped.

import type { AgentConfig, RepoConfig } from "../config.js";
import { roleFor } from "../plugins/registry.js";
import type { Logger } from "../logger.js";
import type { SessionEvent, SessionReport } from "../adapters.js";
import { selectWork, heldWork, emit, advance, wantsSessionReports, workSourceFor } from "../work-source.js";
import { implementApprovedIssues } from "./implement-workflow.js";
import type { ImplementationResult } from "../session/protocol.js";
import { isUpstreamBlocked, tryAcquire, reportRunResult } from "../upstream-backoff.js";
import { runnerName } from "../refusal.js";
import { backoffDelay, formatWait } from "../backoff.js";
import { fieldTable } from "../issue-records.js";
import { devVerifyHolding, followUpsToBuild, visualDecisionHolder } from "./verify.js";
import { alignLocalBase, resolveStartRef, settleSkillSync, type SyncOutcome } from "../skill-sync.js";
import { CycleEvent, activeRuns, itemOf, notifyOnce, prReport, releaseIfResolved, startReport, stoppedReason } from "./common.js";
import { codeHost } from "../plugins/registry.js";
import type { CodeHost, SkipGate } from "../code-host.js";
import type { ForemanRuntime } from "../runtime.js";
import { foremanBranchName } from "../foreman-branch.js";

/**
 * Classify a recorded skip reason as transient + currently-resolved. Returns
 * true only when (a) the reason matches a known transient pattern AND (b) the
 * underlying precondition can be re-checked from this host AND (c) the check
 * confirms the precondition no longer holds. Returning false is safe — the
 * back-off continues normally.
 *
 * Known transient patterns:
 * - "an open PR #N" blocks the build (foreman#50) — a skip recorded against an open
 *   Foreman PR. Cleared once #N is no longer open. The most common skip in the state file: Slashbin-console #1205
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
  const prNumber = prBlockingSkip(reason);
  if (prNumber !== null) {
    return codeHost().isPrOpen(repoConfig.githubRepo, prNumber, repoConfig.repoPath) === false;
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
  reportRunResult(runnerName(), false);
  throw err;
}

/**
 * Skipped issues out of attempts (`backoff.skip.maxAttempts`): marked escalated
 * so the filter stops every release but a person's change to the issue, and
 * escalated for the EM's ruling, the card held Blocked at the approved stage.
 */
async function escalateSkips(rt: ForemanRuntime, items: { n: number; reason: string }[], repoName: string, repoConfig: RepoConfig, repoLogger: Logger): Promise<void> {
  const at = new Date().toISOString();
  for (const { n } of items) {
    await rt.records.updateIssueRecord(repoConfig, n, (d) => { if (d.skipped) d.skipped = { ...d.skipped, escalatedAt: at }; });
  }
  for (const { n, reason } of items) {
    repoLogger.warn(`Escalated #${n} for the EM's ruling: ${reason}`);
    await emit(rt, { kind: "escalated", item: itemOf(repoConfig, n), reason, at: "approved" }, repoConfig, repoLogger);
  }
}

/**
 * A build stopped on these issues and will not land by itself. Every open issue
 * that GitHub records as blocked by one of them would otherwise wait on it
 * silently (gateway#222 held #227, an S1 fix, for 13h): tell each dependent once
 * (comment + blocked label, dead-blocker.ts) and escalate it to the EM. The stopped
 * issue itself is held with the blocked label, dependents or none, so it is not re-picked.
 * Best effort: a failed read or write is logged, never thrown, and the next skip retries.
 */
async function tellDependents(rt: ForemanRuntime, issues: number[], reason: string, repoName: string, repoConfig: RepoConfig, managed: readonly RepoConfig[], repoLogger: Logger): Promise<void> {
  for (const n of issues) {
    try {
      // An unreadable record is not an empty one: told again, the dependents would be commented twice.
      const record = await rt.records.loadIssueRecord(repoConfig, n);
      if (!record) {
        repoLogger.warn(`Could not read #${n}'s record — its dependents are checked next pass`);
        continue;
      }
      const entry = record.skipped;
      const { told, failed, open } = codeHost().announceDeadBlocker(repoConfig, n, reason, entry?.deadBlockerTold ?? []);
      // The stopped issue is held visibly whether or not anything waits on it: with no
      // dependents it was held only by the Foreman's state, `approved` and unlabelled, and
      // showed Blocked on the board alone (jerky_data_receiver#553, 2026-10-26).
      codeHost().holdBlocker(repoConfig, n);
      if (open.length === 0) continue;
      for (const f of failed) repoLogger.warn(`Could not tell dependent ${f.ref} that #${n} is dead: ${f.error}`);
      // "Told" (comment + label) and "escalated" (an EM handoff on record) are kept
      // apart: a dependent told but not escalated, because its repo was not in the
      // config then, is escalated on a later pass instead of staying silent.
      const toldRefs = [...new Set([...(entry?.deadBlockerTold ?? []), ...told.map((t) => t.ref)])];
      const escalated = [...(entry?.deadBlockerEscalated ?? [])];
      for (const t of open) {
        if (!toldRefs.includes(t.ref) || escalated.includes(t.ref)) continue;
        // The EM's handoff is recorded under the DEPENDENT's own repo (the unstick
        // stage reads each repo's state), so a dependent in another managed repo is
        // escalated through that repo's config. A repo the Foreman does not manage
        // has no such state: its comment and blocked label are all that can be said,
        // and the escalation is retried while it stays out of the config.
        const home = t.repo === repoConfig.githubRepo ? repoConfig : managed.find((r) => r.githubRepo === t.repo);
        if (!home) {
          repoLogger.warn(`${t.ref} is in a repo the Foreman does not manage — told by comment and label only; no EM handoff can be recorded yet`);
          continue;
        }
        await emit(rt, {
          kind: "escalated",
          item: itemOf(home, t.number),
          reason: `blocked by ${repoConfig.githubRepo}#${n}, which the Foreman could not land: ${reason}`,
          at: "approved",
          stuck: "needs-ruling",
        }, home, repoLogger);
        escalated.push(t.ref);
        repoLogger.warn(`Told ${t.ref} its blocker #${n} is dead and escalated it: ${reason}`);
      }
      await rt.records.updateIssueRecord(repoConfig, n, (d) => { if (d.skipped) d.skipped = { ...d.skipped, deadBlockerTold: toldRefs, deadBlockerEscalated: escalated }; });
    } catch (err) {
      repoLogger.warn(`Could not check what #${n} blocks: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Deliver EM handoffs a dead-blocker pass could not: a dependent told (comment +
 * label) while its repo was not in the config, or whose escalation failed, is
 * escalated here once its repo is managed. Runs before the eligibility gate:
 * a held blocker is never offered again, so the skip path that told its
 * dependents never runs a second time. Best effort.
 */
export async function deliverPendingHandoffs(rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, repoLogger: Logger): Promise<void> {
  const managed = config.allRepos ?? config.repos;
  try {
    // The issues the repo has open: a held blocker keeps its blocked label and is among them.
    const open = codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, repoLogger).map((i) => i.number);
    const skipped = fieldTable(await rt.records.loadIssueRecords(repoConfig, open), "skipped");
    for (const [key, entry] of Object.entries(skipped)) {
      const pending = (entry.deadBlockerTold ?? []).filter((ref) => {
        if ((entry.deadBlockerEscalated ?? []).includes(ref)) return false;
        const repo = ref.includes("#") && !ref.startsWith("#") ? ref.slice(0, ref.indexOf("#")) : repoConfig.githubRepo;
        return managed.some((r) => r.githubRepo === repo);
      });
      if (pending.length > 0) await tellDependents(rt, [Number(key)], entry.reason, repoConfig.name, repoConfig, managed, repoLogger);
    }
  } catch (err) {
    repoLogger.warn(`Could not deliver pending EM handoffs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function tryBatchImplementation(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[]
): Promise<ImplementationResult | null> {
  const repoName = repoConfig.name;
  const { skip, repoFailure } = config.backoff;
  const repoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "implement" });

  await deliverPendingHandoffs(rt, repoConfig, config, repoLogger);

  // Claude is backing off (or its one half-open probe is already out): no
  // per-repo events — the back-off module has already said so, once.
  if (isUpstreamBlocked(runnerName())) return null;

  // A repo whose sessions keep failing pauses (backoff.repoFailure). When the
  // pause ends the count restarts, but the pause count is kept: tripping again
  // pauses for longer, until a success clears it.
  const failures = rt.memory.failureCount.get(repoName) ?? 0;
  if (failures >= repoFailure.maxFailures) {
    if (rt.memory.failurePause.waiting(repoName)) {
      repoLogger.debug(`Skipping ${repoName} — ${failures} consecutive failures, paused (pause ${rt.memory.failurePause.count(repoName)})`);
      return null;
    }
    repoLogger.info(`Failure pause over for ${repoName} — retrying`);
    rt.memory.failureCount.set(repoName, 0);
  }

  // Read-only: say once per golden version that this repo's skill copy is
  // behind. The copy changes only below, when an approved issue is built.
  if (config.skillSync?.enabled) rt.skillSync.noticeSkillDrift(config.skillSync, repoConfig, repoLogger);

  // Gate: are there approved issues to implement? The work source offers
  // every eligible item, uncapped. Two lists are cut from that offer:
  //   - `handOff` — the offer less the state filters below: everything that
  //     could be built now.
  //   - `actionableIssues` — the build's batch (discoveryBatch: priority tier,
  //     then oldest, `buildBatchSize` of them, default 1), cut from `handOff`
  //     AFTER the filters, so a backed-off or already-implemented issue never
  //     holds a batch slot. Cutting first and filtering after starved the
  //     queue: three backed-off issues filled the cap every cycle and the rest
  //     of the offer was never reached (Slashbin-console#1154, 2026-10-01).
  //     The session is handed exactly this batch and only it is claimed; the
  //     rest of `handOff` stays queued, untouched, for a later build.
  const offered = (await selectWork(repoConfig, config, repoLogger)).map((w) => w.issueNumber);
  let handOff = offered;
  // Issues held for an invalid Acceptance wait on the board in every set this cycle emits, offered work or not.
  const acceptanceHolds = [...heldWork(repoConfig)];
  if (offered.length === 0) {
    // Nothing offered, so nothing waits: observers clear this repo's waits.
    await emit(rt, { kind: "waiting", repo: repoConfig.githubRepo, items: acceptanceHolds }, null, repoLogger);
    // Reset failure count when there's no work (issues were resolved externally)
    if (failures > 0) rt.memory.failureCount.set(repoName, 0);
    return null;
  }

  // Whether an issue is already built is read off the board, never remembered (EM#1244 f4): `selectWork`
  // offers only open, trigger-labelled issues in no lifecycle state with no open or merged PR, so an issue
  // that was built (a PR, or a label past the trigger) is not in the offer. The `implemented` cache that
  // used to filter here, and the self-heal that pruned every entry still in the offer, are gone with it.
  // What the Foreman holds each of these for. An issue whose record cannot be read is left out this cycle,
  // not built: a hold or a skip on it may be exactly what the unreadable record says.
  const recordsOfHandOff = await rt.records.loadIssueRecords(repoConfig, handOff);
  if (recordsOfHandOff.unavailable.size > 0) {
    repoLogger.warn(`Records unreadable, leaving these alone this cycle: ${[...recordsOfHandOff.unavailable].map((n) => `#${n}`).join(", ")}`);
    handOff = handOff.filter((n) => !recordsOfHandOff.unavailable.has(n));
  }
  if (handOff.length === 0) {
    await emit(rt, { kind: "waiting", repo: repoConfig.githubRepo, items: acceptanceHolds }, null, repoLogger);
    repoLogger.info(`All actionable issues already implemented (state filter) — skipping`);
    if (failures > 0) rt.memory.failureCount.set(repoName, 0);
    return null;
  }

  // Filter out issues the agent chose to skip (investigation-only, blocked on
  // something outside the repo, etc.), so we don't burn an agent run every
  // cycle correctly doing nothing. With `backoff.skip.hold` (the default) a
  // skipped issue is HELD: no session runs on it until a cheap GitHub read says
  // something moved — the issue changed after the skip, or the issue or PR its
  // trailer named in `waiting_on` closed or merged. Without it, the older timed
  // back-off: hidden for backoffDelay(skipCount, backoff.skip), then retried.
  // jerky_service#127, 2026-10-14: ten full sessions in a day under the timed
  // back-off, each rediscovering the same unmerged PR on another repo.
  // Skipped entries are cleared when the issue is re-implemented (success path)
  // or released here.
  //
  // Reason-aware recheck: some skip reasons describe a TRANSIENT precondition
  // (e.g., an open PR the skip named) that clears by itself mid-back-off. Before
  // honoring the back-off, re-run the precondition check; if it now passes, admit
  // the issue and clear the stale skip entry, rather than pinning it a whole window.
  // The open Foreman-owned PR, if any (findOpenFeaturePR: per-issue branch or legacy head). Unknown (lookup threw) reads as none: the
  // session still refuses to bundle, so the old path is the fallback.
  let featurePr: ReturnType<CodeHost["findOpenFeaturePR"]> = null;
  try {
    featurePr = codeHost().findOpenFeaturePR(repoConfig);
  } catch (err) {
    repoLogger.debug(`Open feature PR lookup failed — not queueing on it this cycle: ${err instanceof Error ? err.message : String(err)}`);
  }

  const skippedMap = fieldTable(recordsOfHandOff, "skipped");
  const now = Date.now();
  const stillBackedOff: { n: number; reason: string }[] = [];
  const resolvedTransient: { n: number; reason: string }[] = [];
  const released: { n: number; by: Exclude<Extract<SkipGate, { run: true }>["by"], undefined>; reset: boolean }[] = [];
  const escalating: { n: number; reason: string }[] = [];
  handOff = handOff.filter((n) => {
    const entry = skippedMap[n];
    if (!entry) return true;
    // A skip on the open feature PR is the queue gate's to hold, not a skip's.
    const transientCleared = () =>
      (featurePr !== null && prBlockingSkip(entry.reason) === featurePr.number) || isResolvedTransientSkip(entry.reason, repoConfig, repoLogger);
    if (skip.hold) {
      const gate = codeHost().skipGate(entry, repoConfig.githubRepo, skip.maxAttempts, {
        refState: (ref) => codeHost().refState(ref, repoConfig.repoPath),
        activitySince: (since) => codeHost().issueActivitySince(repoConfig.githubRepo, n, since, repoConfig.repoPath),
        self: codeHost().foremanLogin(repoConfig.repoPath),
        agents: skip.agentLogins,
      }, transientCleared, (what, err) => repoLogger.debug(`Hold on #${n}: could not read ${what} — still held: ${err instanceof Error ? err.message : String(err)}`));
      if (gate.run) {
        if (gate.by) released.push({ n, by: gate.by, reset: gate.reset });
        return true;
      }
      if (gate.escalate) escalating.push({ n, reason: gate.reason });
      stillBackedOff.push({ n, reason: gate.reason });
      return false;
    }
    const age = now - new Date(entry.lastSkippedAt).getTime();
    if (Number.isNaN(age) || age >= backoffDelay(entry.skipCount, skip)) return true;
    if (transientCleared()) {
      resolvedTransient.push({ n, reason: entry.reason });
      return true;
    }
    stillBackedOff.push({ n, reason: entry.reason });
    return false;
  });
  // A release buys one session: the entry stays, marked, so the next skip adds
  // to its count. A person's change to an escalated issue clears it instead.
  if (released.length > 0) {
    const at = new Date().toISOString();
    for (const { n, reset } of released) {
      await rt.records.updateIssueRecord(repoConfig, n, (d) => {
        if (reset) delete d.skipped;
        else if (d.skipped) d.skipped = { ...d.skipped, releasedAt: at };
      });
    }
    repoLogger.info(`Released ${released.length} held issue(s) for one session: ${released.map(({ n, by, reset }) => `#${n} (${by}${reset ? ", attempts reset" : ""})`).join("; ")}`);
    for (const { n, by } of released) {
      await releaseIfResolved(rt, "skip", { [by]: true }, [n], repoConfig, repoLogger);
    }
  }
  if (escalating.length > 0) await escalateSkips(rt, escalating, repoName, repoConfig, repoLogger);
  if (resolvedTransient.length > 0) {
    repoLogger.info(
      `Cleared ${resolvedTransient.length} resolved-transient skip entr${resolvedTransient.length === 1 ? "y" : "ies"}: ${resolvedTransient.map(({ n }) => `#${n}`).join(", ")}`,
    );
    for (const { n } of resolvedTransient) await rt.records.updateIssueRecord(repoConfig, n, (d) => { delete d.skipped; });
    await releaseIfResolved(rt, "skip", { transientCauseGone: true }, resolvedTransient.map(({ n }) => n), repoConfig, repoLogger);
  }
  if (stillBackedOff.length > 0) {
    // Promoted DEBUG → INFO so silent skip-cache filtering is visible in the
    // journal (otherwise the pipeline appears stalled while the cache holds it).
    repoLogger.info(
      skip.hold
        ? `Holding ${stillBackedOff.length} skipped issue(s), no session: ${stillBackedOff.map(({ n, reason }) => `#${n} (${reason.slice(0, 160)})`).join("; ")}`
        : `Backing off ${stillBackedOff.length} previously-skipped issue(s): ${stillBackedOff.map(({ n, reason }) => `#${n} (${reason.split("\n")[0].slice(0, 100)})`).join("; ")}`,
    );
  }
  // The repo's whole waiting set, every cycle that reaches here: an issue that
  // drops out of it has stopped waiting, which is how an observer clears it.
  const waiting = [
    ...acceptanceHolds,
    ...stillBackedOff.map(({ n, reason }) => ({ item: itemOf(repoConfig, n), reason: reason.split("\n")[0], skipped: true })),
  ];
  await emit(rt, { kind: "waiting", repo: repoConfig.githubRepo, items: waiting }, null, repoLogger);
  // Labels rank the batch by priority. Unreadable, every issue ranks the
  // same and the oldest goes first.
  let labels = new Map<number, string[]>();
  let titles = new Map<number, string>();
  try {
    const open = codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, repoLogger);
    labels = new Map(open.map((i) => [i.number, i.labels.map((l) => l.name)]));
    titles = new Map(open.map((i) => [i.number, i.title]));
  } catch (err) {
    repoLogger.debug(`Issue labels unreadable — ranking the build by age only: ${err instanceof Error ? err.message : String(err)}`);
  }
  const actionableIssues = codeHost().discoveryBatch(repoConfig, handOff, repoLogger, config.buildBatchSize, (n) => labels.get(n) ?? []);
  if (actionableIssues.length === 0) {
    if (failures > 0) rt.memory.failureCount.set(repoName, 0);
    return null;
  }

  // Gate: if there's a PR awaiting revision (`pr pending actions`), skip implementation.
  // The revision phase (Phase 1) handles these — running implementation would just
  // re-detect the same committed issues and loop without making progress.
  if (codeHost().hasPendingRevisions(repoConfig, repoLogger)) {
    repoLogger.debug(`Skipping ${repoName} implementation — PR awaiting revision`);
    return null;
  }

  // Gate 1 — an open Foreman PR: ONE issue in flight per repo is policy (Ray, 2026-10-14),
  // not a branch artifact: every issue builds on its own branch now, so nothing here is
  // "held" by a shared branch. Launching anyway would run a second issue beside the first
  // one's review, and spent a session per cycle to learn it, posted "picked up" then
  // "skipped" to Discord and bounced the Paperclip card implementing → blocked (jerky_service
  // #66/#70, 2026-10-05). Hold here: the issues show as queued, say nothing to Discord, and
  // build once the PR merges or closes.
  //
  // Gate 2 — the last merge has not passed dev verification. Merging frees the repo, but the
  // issue is not done until it is verified on dev, and what the verification finds may change
  // the next one (Ray, 2026-10-14). Independent of gate 1: it holds when no PR is open. Queued
  // the same way; see devVerifyHolding for what frees it.
  const repoQueue = rt.memory.queuedBehind.get(repoName) ?? new Map<number, string>();
  rt.memory.queuedBehind.set(repoName, repoQueue);
  const merged = !featurePr && roleFor("verifier", config) !== undefined && config.buildWaitsForDevVerify
    ? [...labels].filter(([, names]) => names.includes(repoConfig.lifecycleLabels.prMerged)).map(([n]) => n)
    : [];
  // An unreadable record of a merged issue could be the very hold that queues the build: build nothing this cycle.
  const mergedRecords = await rt.records.loadIssueRecords(repoConfig, merged);
  if (mergedRecords.unavailable.size > 0) {
    repoLogger.warn(`Dev verification holds unreadable for ${[...mergedRecords.unavailable].map((n) => `#${n}`).join(", ")} — not building this cycle`);
    return null;
  }
  const verifyHolds = fieldTable(mergedRecords, "verifyHeld");
  const verifying = devVerifyHolding(merged, verifyHolds, config.backoff.verifyRetry.maxAttempts);
  // The fix a failed verification asks for is filed as a follow-up to it.
  // Queued behind that verification, it waited out every retry, each bound to
  // fail without it (Slashbin-console#1340 behind #1338, 32 min, 2026-10-20).
  // It builds now, alone. Looked for in all of `handOff`, not the trimmed batch:
  // a rework issue outside the batch starved while the verification waited on
  // it (Slashbin-console #1440 behind #1431, 2026-10-27).
  // A visual QA FAIL is capped at once (the EM decides), so it no longer holds the repo; its follow-up still goes first.
  const followUpOf = verifying ?? visualDecisionHolder(merged, verifyHolds, config.backoff.verifyRetry.maxAttempts);
  const fixes = !featurePr && followUpOf !== null ? followUpsToBuild(followUpOf, actionableIssues, handOff, titles) : [];
  if (fixes.length > 0) {
    actionableIssues.splice(0, actionableIssues.length, ...fixes);
    repoLogger.info(`Building ${fixes.map((n) => `#${n}`).join(", ")} now — the follow-up to #${followUpOf}, whose dev verification is waiting on it`);
  }
  const prHolder = featurePr ? `open Foreman PR #${featurePr.number}` : null;
  const verifyHolder = verifying !== null && fixes.length === 0 ? `#${verifying}'s dev verification` : null;
  const holder = prHolder ?? verifyHolder;
  const queued = featurePr ? actionableIssues.filter((n) => !featurePr!.issueNumbers.includes(n)) : verifyHolder ? actionableIssues : [];
  for (const n of [...repoQueue.keys()]) if (!queued.includes(n)) repoQueue.delete(n);
  if (holder && queued.length > 0) {
    const fresh = queued.filter((n) => repoQueue.get(n) !== holder);
    for (const n of fresh) {
      repoQueue.set(n, holder);
      await advance(rt, itemOf(repoConfig, n), "queue", repoConfig, repoLogger);
    }
    repoLogger.info(`Queued ${queued.map((n) => `#${n}`).join(", ")} behind ${holder} — ${featurePr ? "builds once it merges or closes" : "builds once it passes, or waits on a person"}`);
    // A PR that names no issue is outside the lifecycle: nothing here moves it,
    // so say once that it holds the queue (jerky_service #99 held #102 for days).
    // The review stage hands it to the Tech Lead (adoptOrphanedReviewCandidate).
    if (featurePr && fresh.length > 0 && featurePr.issueNumbers.length === 0) {
      repoLogger.warn(`PR #${featurePr.number} names no issue and holds ${fresh.map((n) => `#${n}`).join(", ")} — the Tech Lead reviews it; they build once it merges or closes`);
    }
    if (failures > 0) rt.memory.failureCount.set(repoName, 0);
    return null;
  }

  events?.push({ message: `Picked up ${actionableIssues.length} issue(s) on ${repoConfig.githubRepo}: ${actionableIssues.map(n => `#${n}`).join(", ")}`, level: "info" });

  // Invoke the skill — one Claude session implements all approved issues
  if (!tryAcquire(runnerName())) return null;
  const runAbort = new AbortController();
  activeRuns.set(runAbort, repoName);
  rt.builds.started(repoName);
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
  // The skill-sync commit made for this session, settled once it ends.
  let skillSync: SyncOutcome | null = null;

  try {
    // Tell the source the Foreman is starting on its batch, before the session.
    for (const n of actionableIssues) await emit(rt, { kind: "claim", item: itemOf(repoConfig, n) }, repoConfig, repoLogger);
    const goals = startReport(repoConfig, actionableIssues, repoLogger);
    await emit(rt, { kind: "session", session: { ...session, status: "started", ...(goals ? { report: goals } : {}) } }, null, repoLogger);

    // A stale skill copy is brought to the golden in a commit the session
    // builds on and pushes with its work (docs/skill-sync.md). The code makes
    // it, never the session; it cannot fail the issue.
    // Hygiene: local <base> is brought level with origin/<base>. Correctness does not depend on it: the session starts
    // from an exact ref (below), never from wherever local <base> points.
    alignLocalBase(repoConfig, repoLogger);
    if (config.skillSync?.enabled) skillSync = rt.skillSync.syncSkillsForIssue(config.skillSync, repoConfig, actionableIssues, repoLogger);
    // A skip is as fail-open as a failure and was silent: the forecaster's ship skill went
    // undelivered for a day on an unlogged "uncommitted changes" skip (EM, 2026-11-05).
    if (skillSync?.status === "skipped") repoLogger.warn(`Skill sync skipped — implementing on the existing skill: ${skillSync.reason}`);

    const priorFailure = rt.memory.lastFailureReason.get(repoName) || null;
    // One branch per issue, named from the issue's title; the session cuts the one for the issue it picks.
    const branches: Record<number, string> = {};
    for (const n of actionableIssues) branches[n] = foremanBranchName(repoConfig, n, titles.get(n) ?? "");
    // The session's start ref: this session's own skill-sync commit if it made one, else origin/<base> as a SHA.
    const startRef = resolveStartRef(repoConfig, skillSync);
    const result = await implementApprovedIssues(rt.trust, repoConfig, repoLogger, runAbort.signal, priorFailure, actionableIssues, actionableIssues, branches, startRef)
      .catch(reportLaunchThrew);
    reportRunResult(runnerName(), !!result.upstreamLimit, result.upstreamLimit?.reason, result.upstreamLimit?.resetAtMs);
    ended = result.success
      ? { status: "finished", detail: result.prUrl ? `PR ${result.prUrl}` : "commits added to the open PR" }
      : result.landed
        ? { status: "finished", detail: `#${result.landedIssue} already landed: ${result.landedReason ?? "no evidence given"}` }
      : result.skipped
        ? { status: "finished", detail: `skipped: ${result.skipReason ?? "no reason given"}` }
        : { status: "failed", detail: result.upstreamLimit ? `upstream limit: ${result.upstreamLimit.reason}` : result.error || "unknown" };
    if (wantsSessionReports()) {
      // Commits on the open PR leave no URL: its head branch names the PR.
      const pr = result.success ? prReport(repoConfig, result.prUrl ?? codeHost().findOpenFeaturePR(repoConfig)?.headBranch ?? repoConfig.baseBranch, repoLogger) : undefined;
      report = { ...(result.summary ? { text: result.summary } : {}), ...(pr ? { pr } : {}) };
    }

    if (result.success) {
      rt.memory.failureCount.set(repoName, 0);
      rt.memory.lastFailureReason.delete(repoName);
      rt.memory.failurePause.clear(repoName);

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
      const referencedAll = codeHost().findOpenFeaturePR(repoConfig)?.issueNumbers ?? null;
      const allActionable = (await workSourceFor(repoConfig).selectEligible?.(repoConfig, repoLogger) ?? []).map((w) => w.issueNumber);
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
          `No open feature PR found after a successful run — labeling the full discovery batch (#${actionableIssues.join(", #")})`,
        );
      }

      // Clear any prior skip record — if it's now implemented, the prior
      // "blocked on investigation" state is resolved.
      for (const issueNum of issuesActuallyImplemented) await rt.records.updateIssueRecord(repoConfig, issueNum, (d) => { delete d.skipped; });

      // Report each implemented item in review (on GitHub: the `prUnderReview`
      // label) so the EM knows the PR is ready. One item at a time, in order.
      for (const n of issuesActuallyImplemented) {
        const item = itemOf(repoConfig, n);
        if (result.prUrl) await emit(rt, { kind: "prLink", item, prUrl: result.prUrl }, repoConfig, repoLogger);
        await advance(rt, item, "implemented", repoConfig, repoLogger);
      }

      repoLogger.info(`Batch implementation succeeded — tracked ${issuesActuallyImplemented.map(n => `#${n}`).join(", ")}`, { prUrl: result.prUrl });
      events?.push({ message: `Feature PR on ${repoConfig.githubRepo}: ${result.prUrl || "(commits added to existing PR)"}`, level: "info" });
    } else if (result.landed && result.landedIssue !== undefined && actionableIssues.includes(result.landedIssue)) {
      // Nothing to land: the issue's work is already on the base branch. That
      // is DONE, not stalled — close it as completed with the evidence, which also
      // releases every issue GitHub records as blocked by it (blockers.ts treats a
      // closed blocker as met). Left open and `approved` it held its dependents
      // for 13h (gateway#222 -> #227, 2026-10-26).
      const n = result.landedIssue;
      worked = [n];
      const reason = result.landedReason ?? "no evidence given";
      try {
        codeHost().closeAlreadyLanded(repoConfig, n, reason);
        await rt.records.updateIssueRecord(repoConfig, n, (d) => { delete d.skipped; });
        rt.memory.failureCount.set(repoName, 0);
        rt.memory.lastFailureReason.delete(repoName);
        rt.memory.failurePause.clear(repoName);
        repoLogger.info(`Closed #${n} as completed: already landed on ${repoConfig.baseBranch} — ${reason}`);
        events?.push({ message: `Closed #${n} on ${repoConfig.githubRepo}: already landed (${reason})`, level: "info" });
      } catch (err) {
        const why = `#${n} is already landed (${reason}) but the Foreman could not close it: ${err instanceof Error ? err.message : String(err)}`;
        repoLogger.warn(why);
        await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, repoLogger);
      }
    } else if (result.skipped) {
      // Deliberate no-op by the agent (e.g., issue body says "investigate first").
      // Record per-issue skip timestamps so the back-off filter at the top of
      // this function suppresses retries for backoffDelay(skipCount, backoff.skip).
      // Do NOT increment rt.memory.failureCount — this isn't an error.
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
      const alreadyMerged = codeHost().findIssuesMergedToBase(repoConfig, skippedSet, repoLogger);
      const hasVerifier = roleFor("verifier", config) !== undefined;
      if (alreadyMerged.length > 0) {
        const mergedNums = alreadyMerged.map((m) => m.issueNumber);
        await notifyOnce(rt, "merged", repoConfig, mergedNums, repoLogger);
        for (const n of mergedNums) {
          // With a verify stage, merged work still owes its acceptance evidence (EM#441).
          await advance(rt, itemOf(repoConfig, n), hasVerifier ? "alreadyMerged" : "alreadyApproved", repoConfig, repoLogger);
        }
        repoLogger.info(
          `Advanced ${mergedNums.length} already-merged issue(s) to '${repoConfig.lifecycleLabels[hasVerifier ? "prMerged" : "prApproved"]}': ${alreadyMerged.map((m) => `#${m.issueNumber} (merged in PR #${m.prNumber})`).join(", ")}`,
        );
        events?.push({
          message: `Advanced ${mergedNums.length} already-merged issue(s) on ${repoConfig.githubRepo} to '${repoConfig.lifecycleLabels.prApproved}': ${mergedNums.map((n) => `#${n}`).join(", ")}`,
          level: "info",
        });
        // They're out of the actionable set now — no skip record needed, and a
        // stale one would linger in state forever.
        for (const n of mergedNums) await rt.records.updateIssueRecord(repoConfig, n, (d) => { delete d.skipped; });
        skippedSet = skippedSet.filter((n) => !mergedNums.includes(n));
      }
      // ------------------------------------------------------------------------

      const stamp = new Date().toISOString();
      // What the trailer said these wait on, as `owner/repo#N`, and whether it
      // is a PR (one read, for the blocked reason's wording only).
      const waitingOn = codeHost().parseWaitingOn(result.waitingOn, repoConfig.githubRepo);
      let waitingOnIsPr: boolean | undefined;
      if (waitingOn && skip.hold) {
        try {
          waitingOnIsPr = codeHost().refState(waitingOn, repoConfig.repoPath).isPr;
        } catch (err) {
          repoLogger.debug(`Could not read ${codeHost().waitingOnLabel(waitingOn, repoConfig.githubRepo)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // The count each issue reached; an issue whose record could not be saved has none and is not escalated this pass.
      const skipCounts = new Map<number, number>();
      for (const issueNum of skippedSet) {
        // Escalating per-issue back-off: a fixed snooze never gives up, so a
        // permanently-unactionable issue costs an agent session every window,
        // indefinitely. Count the consecutive skips; the filter at the top of
        // this function widens the window geometrically off this count.
        const saved = await rt.records.updateIssueRecord(repoConfig, issueNum, (d) => {
          const prior = d.skipped;
          const skipCount = (prior?.skipCount ?? 0) + 1;
          skipCounts.set(issueNum, skipCount);
          d.skipped = {
            lastSkippedAt: stamp,
            reason,
            skipCount,
            ...(waitingOn ? { waitingOn: `${waitingOn.repo}#${waitingOn.number}` } : {}),
            ...(prior?.deadBlockerTold ? { deadBlockerTold: prior.deadBlockerTold } : {}),
            ...(prior?.deadBlockerEscalated ? { deadBlockerEscalated: prior.deadBlockerEscalated } : {}),
          };
        });
        if (!saved) {
          skipCounts.delete(issueNum);
          repoLogger.warn(`#${issueNum}: the skip could not be recorded — the issue is offered again next cycle`);
        }
      }
      // The agent declined these; the source hears why. On GitHub this writes
      // nothing — the agent posts its own skip comment.
      // Held, the reason says what releases it.
      // At the attempt cap it is escalated for the EM's ruling instead.
      const blockedReason = skip.hold ? codeHost().heldReason(reason, repoConfig.githubRepo, waitingOn, waitingOnIsPr) : reason;
      const outOfAttempts = skip.hold ? skippedSet.filter((n) => (skipCounts.get(n) ?? 0) >= skip.maxAttempts) : [];
      for (const n of skippedSet) {
        if (!outOfAttempts.includes(n)) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: blockedReason }, repoConfig, repoLogger);
      }
      if (outOfAttempts.length > 0) {
        await escalateSkips(rt, outOfAttempts.map((n) => ({ n, reason: codeHost().escalatedReason(reason, skipCounts.get(n) ?? 0) })), repoName, repoConfig, repoLogger);
      }
      // A stop that holds other issues up says so to them (dead-blocker.ts).
      // A skip naming an open PR on the branch clears when that PR leaves (isResolvedTransientSkip): never a dead blocker.
      if (codeHost().isDeadBlockerReason(reason) && prBlockingSkip(reason) === null) await tellDependents(rt, skippedSet, reason, repoName, repoConfig, config.allRepos ?? config.repos, repoLogger);
      // Reset the failure counter — an explicit skip is not a failure.
      rt.memory.failureCount.set(repoName, 0);
      rt.memory.lastFailureReason.delete(repoName);
      rt.memory.failurePause.clear(repoName);
      repoLogger.info(`Batch implementation skipped by agent: ${blockedReason} (issues: ${skippedSet.map(n => `#${n}`).join(", ")})`);
      events?.push({ message: `Implementation skipped on ${repoConfig.githubRepo}: ${reason}`, level: "info" });
    } else {
      // An upstream limit refused the run (or a swallowed GitHub back-off made
      // it look failed) — not a defect, so it charges no retry. The card still
      // goes to Blocked: the work has stopped, and the board says why.
      if (result.upstreamLimit || isUpstreamBlocked("github")) {
        const why = stoppedReason("Implementation", result, isUpstreamBlocked("github"));
        for (const n of actionableIssues) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, repoLogger);
        return null;
      }
      const newCount = (rt.memory.failureCount.get(repoName) ?? 0) + 1;
      rt.memory.failureCount.set(repoName, newCount);
      // The run failed after its work landed in a PR: the PR names the issue
      // it was on, and only that issue is told it failed.
      const onPr = (codeHost().findOpenFeaturePR(repoConfig)?.issueNumbers ?? null)?.filter((n) => actionableIssues.includes(n));
      if (onPr && onPr.length > 0) worked = onPr;
      const failedOn = worked ?? actionableIssues;
      if (newCount < repoFailure.maxFailures) {
        const why = stoppedReason("Implementation", result, false, `${newCount}/${repoFailure.maxFailures}`);
        for (const n of failedOn) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, repoLogger);
      } else {
        const pause = rt.memory.failurePause.start(repoName, repoFailure);
        const why = `implementation failed ${newCount}× — paused ${formatWait(pause)}: ${result.error || "unknown"}`;
        for (const n of failedOn) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, repoLogger);
      }
      rt.memory.lastFailureReason.set(repoName, result.error || "unknown");
      repoLogger.warn(`Batch implementation failed (${newCount}/${repoFailure.maxFailures}): ${result.error}`);
      events?.push({ message: `Implementation failed on ${repoConfig.githubRepo}: ${result.error}`, level: "error" });
    }

    return result;
  } finally {
    activeRuns.delete(runAbort);
    rt.builds.ended(repoName);
    if (skillSync) settleSkillSync(repoConfig, skillSync, repoLogger);
    await emit(rt, { kind: "session", session: { ...session, ...ended, ...(worked ? { worked } : {}), ...(report ? { report } : {}) } }, null, repoLogger);
  }
}

