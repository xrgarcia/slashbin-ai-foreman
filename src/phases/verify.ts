// The verify phase: dev verification of merged work, with holds and retries.

import { resolve } from "node:path";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionEvent } from "../adapters.js";
import type { BlockKind } from "../unblock.js";
import { emit, advance } from "../work-source.js";
import { verifyViaSre } from "../agent.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import { findIssuesMergedToBase, findIssuesAwaitingVerify } from "../github.js";
import { loadRepoState, saveRepoState, type VerifyHold } from "../state.js";
import { BackoffTracker, DEFAULT_BACKOFF, backoffDelay, formatWait, type BackoffConfig } from "../backoff.js";
import { CycleEvent, activeRuns, baseAdvancedSince, issueEditedSince, itemOf, releaseIfResolved } from "./common.js";

/**
 * Review phase: invoke the EM /review-all-prs skill, scoped to one repo, when it
 * has an open feature PR awaiting review (`pr under review`, no current EM review).
 *
 * Unlike implement/revise, the orchestrator does NOT transition labels afterward —
 * the skill owns its own merges and label transitions at full fidelity. We just
 * gate, trigger, log, and back off on failure. Every run's full interaction is
 * written to logs/review/<repo>-cycle<N>-<ts>.log for debugging.
 *
 * Returns true when a review run was triggered (regardless of verdict).
 */
/**
 * Whether new commits on base may reopen an exhausted hold. Not one the SRE
 * could not observe (`acceptance-not-verified`): commits do not give dev the
 * instrument it lacks, so each reopen buys three more runs of the same hold.
 * Only an edited spec (an acceptance script, an offline-instrument exception) can.
 */
export function reopensOnBaseAdvance(reason: string): boolean {
  return reason !== "acceptance-not-verified";
}

/**
 * What a non-passing verify costs. Pure, exported for tests.
 *
 * - `defer`: the SRE could not run (Codex or its EM spec mirror unavailable) —
 *   nothing was verified, so no attempt is charged; the repo asks again shortly.
 * - `wait`: the SRE verified what it could and named the time the rest becomes
 *   observable (`wait-until-YYYYMMDDTHHMMZ`) — not a failure, so no attempt is
 *   charged; the PR is not picked again before that time.
 * - `charge`: a real hold or error — one attempt spent.
 */
export function verifyHoldPlan(reason: string): { kind: "defer" } | { kind: "wait"; retryAt: string } | { kind: "charge" } {
  if (/^(codex-unavailable|em-mirror-unavailable)$/.test(reason)) return { kind: "defer" };
  const m = /^wait-until-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(reason);
  if (m) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
    if (Number.isFinite(t)) return { kind: "wait", retryAt: new Date(t).toISOString() };
  }
  return { kind: "charge" };
}
/**
 * The merged issue whose dev verification holds the repo's next build, or
 * null. Pure, exported for tests.
 *
 * Ray, 2026-10-14: one issue in flight per repo, from build until it is
 * verified on dev — a fix the verification asks for lands before the next issue
 * is built on top. A merge holds while the SRE has it: not yet verified, or
 * held and still retrying. It frees the repo once its attempts are spent (it
 * waits on a person) or it waits on a named time, so one stuck verification
 * never stalls every issue behind it.
 */
export function devVerifyHolding(
  merged: readonly number[],
  held: Readonly<Record<number, VerifyHold>>,
  maxAttempts: number,
): number | null {
  for (const n of [...merged].sort((a, b) => a - b)) {
    const h = held[n];
    if (h && (h.attempts >= maxAttempts || h.retryAt)) continue;
    return n;
  }
  return null;
}

/**
 * The issues in `batch` filed as the follow-up to `holder` — the fix its dev
 * verification is waiting on — by the title's "follow-up to #N". Pure,
 * exported for tests.
 */
export function followUpsOf(holder: number, batch: readonly number[], titles: ReadonlyMap<number, string>): number[] {
  const marker = new RegExp(`follow-up to #${holder}(?!\\d)`, "i");
  return batch.filter((n) => marker.test(titles.get(n) ?? ""));
}

/** Per repo: the verify stage waiting after the SRE could not run at all (backoff.agentUnavailable). */
export const verifyDefer = new BackoffTracker();

/**
 * The merged PR to verify this pass, or null. Pure, exported for tests.
 *
 * One PR per pass, oldest issue first. A PR is skipped while ANY of its issues
 * is held within its retry window or has spent its attempts: the SRE verifies
 * the PR, not the issue, so one held issue holds its PR. The Nth failed attempt
 * waits backoffDelay(N, retry) from when it was held.
 */
export function pickVerifyTarget(
  refs: ReadonlyArray<{ issueNumber: number; prNumber: number }>,
  held: Readonly<Record<number, VerifyHold>>,
  now: number,
  retry: BackoffConfig["verifyRetry"] = DEFAULT_BACKOFF.verifyRetry,
): { prNumber: number; issueNumbers: number[] } | null {
  const byPr = new Map<number, number[]>();
  for (const r of [...refs].sort((a, b) => a.issueNumber - b.issueNumber)) {
    byPr.set(r.prNumber, [...(byPr.get(r.prNumber) ?? []), r.issueNumber]);
  }
  for (const [prNumber, issueNumbers] of byPr) {
    const waiting = issueNumbers.some((n) => {
      const h = held[n];
      if (!h) return false;
      if (h.attempts >= retry.maxAttempts) return true;
      if (h.retryAt) return now < Date.parse(h.retryAt);
      return now - Date.parse(h.heldAt) < backoffDelay(h.attempts, retry);
    });
    if (!waiting) return { prNumber, issueNumbers };
  }
  return null;
}

/**
 * The verify stage (EM#440): hand one merged PR to the SRE and move its issues
 * `pr merged` → `pr approved` on a pass. A hold or an error never relabels: the
 * issue stays `pr merged`, its card goes to Blocked with the reason, and the
 * stage retries it after a growing wait (backoff.verifyRetry) up to its
 * maxAttempts, after which it waits for a person. Nothing here writes `pr pending actions` — a merged PR
 * has no feature PR left to revise.
 *
 * The SRE runs on Codex only (Ray, 2026-10-10). A run that could not happen, or
 * one waiting on a named time, costs no attempt — see verifyHoldPlan.
 */
export async function tryVerify(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[],
): Promise<boolean> {
  if (!config.srePath) return false;
  if (isUpstreamBlocked("github")) return false;
  const repoName = repoConfig.name;
  if (verifyDefer.waiting(repoName)) return false;
  const { verifyRetry, agentUnavailable } = config.backoff;
  const vlog = logger.child({ cycle: cycleNumber, repo: repoName, phase: "verify" });

  const waiting = findIssuesAwaitingVerify(repoConfig, vlog);
  const state = loadRepoState(repoName);
  const held: Record<number, VerifyHold> = { ...(state.verifyHeld ?? {}) };
  // A hold outlives its label only by mistake: a person relabelled the issue,
  // or it closed. Drop those so a later `pr merged` starts fresh.
  const stale = Object.keys(held).map(Number).filter((n) => !waiting.includes(n));
  if (stale.length > 0) {
    for (const n of stale) delete held[n];
    saveRepoState(repoName, { ...state, verifyHeld: held });
  }
  if (waiting.length === 0) return false;

  const refs = findIssuesMergedToBase(repoConfig, waiting, vlog);
  // The blocked verify holds, re-checked: a merged PR now closes a
  // "no merged PR" hold; an edited spec reopens any failed one at once, with a
  // fresh attempt count, because retrying an unchanged spec cannot pass; new
  // commits on base reopen an exhausted one, unless dev could not observe it.
  let released = false;
  for (const [key, h] of Object.entries(held)) {
    const n = Number(key);
    const noPr = h.reason === "no-merged-pr";
    const exhausted = h.attempts >= verifyRetry.maxAttempts;
    const kind: BlockKind = exhausted ? "verify-exhausted" : "verify-held";
    const ok = noPr
      ? await releaseIfResolved("verify-no-pr", { mergedPrFound: refs.some((r) => r.issueNumber === n) }, [n], repoConfig, vlog)
      : await releaseIfResolved(kind, {
        specEdited: issueEditedSince(repoConfig, n, h.heldAt),
        ...(exhausted && reopensOnBaseAdvance(h.reason) ? { baseAdvanced: baseAdvancedSince(repoConfig, h.heldAt) } : {}),
      }, [n], repoConfig, vlog);
    if (ok) { delete held[n]; released = true; }
  }
  if (released) saveRepoState(repoName, { ...loadRepoState(repoName), verifyHeld: held });
  const unmatched = waiting.filter((n) => !refs.some((r) => r.issueNumber === n) && !held[n]);
  for (const n of unmatched) {
    // Labelled merged, but no merged PR closes it — nothing to verify against.
    const reason = `"${repoConfig.lifecycleLabels.prMerged}" but no merged PR into ${repoConfig.baseBranch} closes it`;
    held[n] = { heldAt: new Date().toISOString(), prNumber: 0, reason: "no-merged-pr", attempts: verifyRetry.maxAttempts };
    vlog.warn(`#${n}: ${reason} — needs a person`);
    await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: reason }, repoConfig, vlog);
  }
  if (unmatched.length > 0) saveRepoState(repoName, { ...loadRepoState(repoName), verifyHeld: held });

  const target = pickVerifyTarget(refs, held, Date.now(), verifyRetry);
  if (!target) return false;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const transcriptPath = resolve(process.cwd(), "logs", "verify", `${repoName}-cycle${cycleNumber}-${ts}.log`);
  const runAbort = new AbortController();
  activeRuns.set(runAbort, repoName);
  const items = target.issueNumbers.map((n) => itemOf(repoConfig, n));
  const session: Omit<SessionEvent, "status"> = { phase: "verify", repo: repoConfig.githubRepo, pr: target.prNumber, items, reviewer: "SRE" };
  let ended: { status: "finished" | "failed"; detail: string } = { status: "failed", detail: "the verification ended without a result" };
  const issues = target.issueNumbers.map((n) => `#${n}`).join(", ");
  vlog.info(`Verifying ${repoName} PR #${target.prNumber} in dev (issues: ${issues}), transcript: ${transcriptPath}`);
  events?.push({ message: `Verifying ${repoConfig.githubRepo} PR #${target.prNumber} in dev (issues: ${issues})`, level: "info" });

  try {
    await emit({ kind: "session", session: { ...session, status: "started" } }, null, vlog);
    const r = await verifyViaSre(repoConfig, config, target.prNumber, vlog, runAbort.signal, transcriptPath)
      .catch((e: unknown) => ({ kind: "error" as const, error: `SRE launch threw: ${String(e)}` }));

    if (r.kind === "verdict" && r.pass) {
      verifyDefer.clear(repoName);
      const after = loadRepoState(repoName);
      const kept = { ...(after.verifyHeld ?? {}) };
      for (const n of target.issueNumbers) {
        await advance(itemOf(repoConfig, n), "verifyPassed", repoConfig, vlog);
        delete kept[n];
      }
      saveRepoState(repoName, { ...after, verifyHeld: kept });
      ended = { status: "finished", detail: `PR #${target.prNumber} verified in dev (deploy ${r.trailer.deploy})` };
      events?.push({ message: `✅ ${repoConfig.githubRepo} PR #${target.prNumber} verified in dev — ${issues} → "${repoConfig.lifecycleLabels.prApproved}"`, level: "info" });
      return true;
    }

    const reason = r.kind === "verdict" ? (r.reason ?? "held") : r.error;
    const plan = r.kind === "verdict" ? verifyHoldPlan(reason) : { kind: "charge" as const };
    if (plan.kind === "defer") {
      const wait = formatWait(verifyDefer.start(repoName, agentUnavailable));
      ended = { status: "failed", detail: `deferred — the SRE could not run (${reason}); retry in ${wait}` };
      vlog.info(`Verify of PR #${target.prNumber} deferred: ${reason} — retry in ${wait}`);
      const why = `waiting on the SRE: it could not run (${reason}) — dev verification of PR #${target.prNumber} retries automatically in ${wait}`;
      for (const n of target.issueNumbers) await emit({ kind: "verifyWaiting", item: itemOf(repoConfig, n), reason: why }, repoConfig, vlog);
      return false;
    }
    verifyDefer.clear(repoName);
    const after = loadRepoState(repoName);
    const kept = { ...(after.verifyHeld ?? {}) };
    if (plan.kind === "wait") {
      for (const n of target.issueNumbers) {
        kept[n] = { heldAt: new Date().toISOString(), prNumber: target.prNumber, reason, attempts: kept[n]?.attempts ?? 0, retryAt: plan.retryAt };
      }
      saveRepoState(repoName, { ...after, verifyHeld: kept });
      ended = { status: "failed", detail: `waiting — PR #${target.prNumber} is observable from ${plan.retryAt}` };
      vlog.info(`Verify of PR #${target.prNumber} waits until ${plan.retryAt}`);
      events?.push({ message: `⏳ ${repoConfig.githubRepo} ${issues}: dev verification resumes at ${plan.retryAt.slice(0, 16)}Z (${reason})`, level: "info" });
      const why = `waiting until ${plan.retryAt.slice(0, 16)}Z: the SRE says PR #${target.prNumber} is not observable before then (${reason}) — dev verification resumes automatically then`;
      for (const n of target.issueNumbers) await emit({ kind: "verifyWaiting", item: itemOf(repoConfig, n), reason: why }, repoConfig, vlog);
      return false;
    }
    let attempts = 0;
    for (const n of target.issueNumbers) {
      attempts = Math.max(attempts, (kept[n]?.attempts ?? 0) + 1);
    }
    for (const n of target.issueNumbers) {
      kept[n] = { heldAt: new Date().toISOString(), prNumber: target.prNumber, reason, attempts };
    }
    saveRepoState(repoName, { ...after, verifyHeld: kept });
    const final = attempts >= verifyRetry.maxAttempts;
    const why = `dev verification of PR #${target.prNumber} did not pass (${reason}) — attempt ${attempts}/${verifyRetry.maxAttempts}` +
      (final ? "; no more retries, a person must look" : `; retrying in ${formatWait(backoffDelay(attempts, verifyRetry))}`);
    for (const n of target.issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, vlog);
    ended = { status: "failed", detail: why };
    vlog.warn(`${repoName}: ${why}`);
    events?.push({ message: `⏸️ ${repoConfig.githubRepo} ${issues}: ${why}`, level: final ? "error" : "warn" });
    return false;
  } finally {
    activeRuns.delete(runAbort);
    await emit({ kind: "session", session: { ...session, ...ended } }, null, vlog);
  }
}

