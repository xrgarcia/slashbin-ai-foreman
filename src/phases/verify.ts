// The verify phase: dev verification of merged work, with holds and retries.

import { resolve } from "node:path";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionEvent } from "../adapters.js";
import type { BlockKind } from "../unblock.js";
import { emit, advance } from "../work-source.js";
import { verifyViaSre, type VerifyResult } from "../agent.js";
import { applyQaGate, pendingQaRerun, QA_RERUN_PATTERN, qaApplies, qaBeforeMergeApplies, realQaDeps, runQaReport } from "../qa-report.js";
import { commentBodies } from "../github/pr-comments.js";
import { gh } from "../github/gh.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import { findIssuesMergedToBase, findIssuesAwaitingVerify, prChangedFiles } from "../github.js";
import { dropIssueSnapshot, getOpenIssues, hasLabel } from "../github/cache.js";
import { loadRepoState, saveRepoState, type VerifyHold } from "../state.js";
import { noteUnrelated } from "../unstick.js";
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
/**
 * True when a verify hold's reason says the deploy itself failed (`dev-verify-failed`:
 * trailer deploy=FAILURE; `deploy=<state>`: any other deploy state). Infrastructure,
 * so the SRE owns the hold, not the EM (jerky_ops#97, 2026-10-21: Railway paused deploys).
 */
export function isDeployFailureHold(reason: string): boolean {
  return reason === "dev-verify-failed" || reason.startsWith("deploy=");
}

/** The files a PR touched, for the EM's call; empty when unreadable (best effort, never throws). */
function prFilesTouched(repoConfig: RepoConfig, pr: number, vlog: Logger): string[] {
  return prChangedFiles(repoConfig.githubRepo, pr, repoConfig.repoPath, vlog).slice(0, 40);
}

export function reopensOnBaseAdvance(reason: string): boolean {
  return reason !== "acceptance-not-verified";
}

/**
 * SRE holds that mean "the verifier or its tooling could not run" — no verdict on
 * the change, so no attempt is charged (Slashbin-console#1445 spent 3 attempts on
 * visual-qa-review-unavailable; jerky_data_receiver#543 on registry-unavailable).
 * Mirrors the SRE's own re-run list, `slashbin_ai_sre/lib/reuse.mjs` RERUN_HOLDS,
 * minus `wait-until-*` (a named wait, handled separately). Verdicts (`visual-qa-failed`,
 * `acceptance-failed`, `dev-verify-failed`, ...) and `visual-qa-unsafe-host` (a
 * deterministic config refusal a retry cannot clear) are NOT here: they charge or rework.
 * `qa-errored` is the Foreman's own QA gate failing to produce a verdict (timeout, crash,
 * no manifest) after an SRE pass: the checker could not run, so it charges nothing either
 * (slashbin-ai-foreman#137; Slashbin-console#1492 spent 3 attempts on QA timeouts).
 */
export const SRE_TOOLING_HOLDS: readonly string[] = [
  "codex-unavailable",
  "em-mirror-unavailable",
  "registry-unavailable",
  "tooling-unavailable",
  "evidence-check-failed",
  "no-evidence-comment",
];
/**
 * The Foreman's own checkers that could not run: its QA gate (slashbin-ai-foreman#137), and the
 * QA holds that mean QA could not check, not that the page is wrong. The SRE's `visual-qa-*` twins
 * above are free; charging these let a dev outage exhaust a card. `unsafe-host`, `browser-crashed`
 * and `nothing-captured` stay charged: the same page does it again.
 */
export const FOREMAN_TOOLING_HOLDS: readonly string[] = [
  "qa-errored",
  "qa-held-dev-unreachable",
  "qa-held-sign-in-failed",
  "qa-held-review-unavailable",
  "qa-held-pr-unreadable",
  "qa-held-baseline-unreadable",
  // QA before the merge (`check --local`): QA's own boot failed, the Console's seed is missing, or the
  // data QA reads was unreachable. None is a verdict on the PR (qa-local-seed-missing is the Console's to fix).
  "qa-held-qa-local-boot-failed",
  "qa-held-qa-local-seed-missing",
  "qa-held-worker-data-unavailable",
  "qa-held-attribution-unavailable",
];
export const TOOLING_HOLDS: readonly string[] = [...SRE_TOOLING_HOLDS, ...FOREMAN_TOOLING_HOLDS];
export const isToolingHold = (reason: string): boolean => TOOLING_HOLDS.includes(reason);

/**
 * What a non-passing verify costs. Pure, exported for tests.
 *
 * - `defer`: the SRE could not run (any `TOOLING_HOLDS` member) —
 *   nothing was verified, so no attempt is charged; the repo asks again shortly.
 * - `wait`: the SRE verified what it could and named the time the rest becomes
 *   observable (`wait-until-YYYYMMDDTHHMMZ`) — not a failure, so no attempt is
 *   charged; the PR is not picked again before that time.
 * - `decide`: a visual QA FAIL (`hold=visual-qa-failed`). The fix is a technical
 *   decision, so it is the EM's (Ray, 2026-10-31; Slashbin-console#1538, where an
 *   automatic rework touched files that were not the cause and held the release
 *   queue ~24h): the Foreman files nothing. The hold is placed at its cap at once
 *   (nothing retries unchanged code), the EM is called on this first FAIL
 *   (`rework-decision`), and the PR re-verifies when the EM's follow-up merges or
 *   the spec is edited.
 * - `charge`: a real hold or error — one attempt spent.
 */
export function verifyHoldPlan(reason: string): { kind: "defer" } | { kind: "wait"; retryAt: string } | { kind: "decide" } | { kind: "charge" } {
  if (isToolingHold(reason)) return { kind: "defer" };
  const m = /^wait-until-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(reason);
  if (m) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
    if (Number.isFinite(t)) return { kind: "wait", retryAt: new Date(t).toISOString() };
  }
  if (reason === "visual-qa-failed") return { kind: "decide" };
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
 * The merged issue whose visual QA FAIL is waiting on the EM's decision, or null. It does not hold the repo
 * (the cap frees it), but the EM's follow-up to it must still build before unrelated queued work, so
 * implement looks its follow-ups up too. Pure, exported for tests.
 */
export function visualDecisionHolder(merged: readonly number[], held: Readonly<Record<number, VerifyHold>>, maxAttempts: number): number | null {
  for (const n of [...merged].sort((a, b) => a - b)) {
    const h = held[n];
    if (h && h.reason === "visual-qa-failed" && h.attempts >= maxAttempts) return n;
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

/**
 * What a held dev verification lets build now: its follow-ups, found across
 * everything buildable (`handOff`), not just the build's `batch`. The batch is
 * trimmed to the top of the queue by priority then number, so a rework issue
 * filed after the queue's older work sat outside it, and the verification
 * waited on a fix the build never saw (Slashbin-console #1440 behind #1431,
 * 2026-10-27: "this build takes #1432, 2 stay queued", every cycle). Pure,
 * exported for tests.
 */
export function followUpsToBuild(holder: number, batch: readonly number[], handOff: readonly number[], titles: ReadonlyMap<number, string>): number[] {
  return followUpsOf(holder, [...new Set([...batch, ...handOff])], titles);
}

/** The evidence links (comment and image URLs) in the SRE's or QA's output, distinct, in order, at most `max`. Pure, exported for tests. */
export function evidenceLinks(summary: string, max = 8): string[] {
  const urls = summary.match(/https?:\/\/[^\s<>()"'`\]\[]+/g) ?? [];
  return [...new Set(urls.map((u) => u.replace(/[.,;:]+$/, "")))].slice(0, max);
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
      // A visual QA rework: the fix has not merged, so retrying unchanged code cannot pass; once it has, re-verify at once.
      if (h.rework) return !h.rework.landed;
      if (h.retryAt) return now < Date.parse(h.retryAt);
      return now - Date.parse(h.heldAt) < backoffDelay(h.attempts, retry);
    });
    if (!waiting) return { prNumber, issueNumbers };
  }
  return null;
}

/**
 * The EM's QA rerun input (slashbin-ai-foreman#158): a PR comment opening `**EM QA rerun` on a merged PR whose
 * card is `pr merged` or `pr approved` (and not yet `ready for prod release`) asks for a fresh QA `check` on dev.
 * A request is answered when a `## QA Report` keyed to the merge sha comes after it. For each unanswered one this
 * moves an approved card back to `pr merged` (`qaRerun`) and drops its verify hold, so the stage below picks the PR
 * up with a fresh attempt count. Returns PR number → merge sha for every unanswered request. Never throws.
 */
async function stageQaReruns(repoConfig: RepoConfig, held: Record<number, VerifyHold>, vlog: Logger): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const { prMerged, prApproved, readyForProd } = repoConfig.lifecycleLabels;
    const cards = getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, vlog)
      .filter((i) => (hasLabel(i, prMerged) || hasLabel(i, prApproved)) && !hasLabel(i, readyForProd));
    if (cards.length === 0) return out;
    const refs = findIssuesMergedToBase(repoConfig, cards.map((i) => i.number), vlog);
    for (const pr of new Set(refs.map((r) => r.prNumber))) {
      const bodies = await commentBodies(repoConfig, pr);
      if (!bodies.some((b) => QA_RERUN_PATTERN.test(b))) continue;
      const sha = (JSON.parse(gh(["pr", "view", String(pr), "--repo", repoConfig.githubRepo, "--json", "mergeCommit"], repoConfig.repoPath) || "{}").mergeCommit?.oid ?? "") as string;
      if (!sha || !pendingQaRerun(bodies, sha)) continue;
      out.set(pr, sha);
      for (const r of refs.filter((x) => x.prNumber === pr)) {
        const card = cards.find((i) => i.number === r.issueNumber);
        if (card && hasLabel(card, prApproved)) {
          vlog.info(`#${r.issueNumber}: the EM asked for a QA rerun on merged PR #${pr} — back to verification`);
          await advance(itemOf(repoConfig, r.issueNumber), "qaRerun", repoConfig, vlog);
          dropIssueSnapshot(repoConfig.githubRepo);
        }
        delete held[r.issueNumber];
      }
    }
  } catch (e) {
    vlog.warn(`QA rerun requests not read: ${String(e).slice(0, 200)}`);
  }
  return out;
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

  const state = loadRepoState(repoName);
  const held: Record<number, VerifyHold> = { ...(state.verifyHeld ?? {}) };
  // The EM's QA rerun requests first: they move approved cards back to `pr merged` and clear their holds.
  const reruns = qaApplies(repoConfig, config) ? await stageQaReruns(repoConfig, held, vlog) : new Map<number, string>();
  if (reruns.size > 0) saveRepoState(repoName, { ...state, verifyHeld: held });
  const waiting = findIssuesAwaitingVerify(repoConfig, vlog);
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
    if (h.rework && !h.rework.landed && !exhausted) {
      // Waiting on the Foreman's fix: it landed once its issue's PR merged (or, with none filed, base moved).
      const landed = h.rework.issue !== null
        ? findIssuesMergedToBase(repoConfig, [h.rework.issue], vlog).length > 0
        : baseAdvancedSince(repoConfig, h.heldAt) === true;
      if (landed) {
        held[n] = { ...h, rework: { ...h.rework, landed: true } };
        vlog.info(`#${n}: the visual QA rework ${h.rework.issue !== null ? `#${h.rework.issue} ` : ""}landed — re-verifying`);
        released = true;
        continue;
      }
    }
    const kind: BlockKind = exhausted ? "verify-exhausted" : "verify-held";
    const ok = noPr
      ? await releaseIfResolved("verify-no-pr", { mergedPrFound: refs.some((r) => r.issueNumber === n) }, [n], repoConfig, vlog)
      : await releaseIfResolved(kind, {
        specEdited: issueEditedSince(repoConfig, n, h.heldAt),
        ...(exhausted && reopensOnBaseAdvance(h.reason) ? { baseAdvanced: baseAdvancedSince(repoConfig, h.heldAt) } : {}),
        // Exhausted on a reason that no longer charges (it joined TOOLING_HOLDS after the
        // attempts were spent): those attempts were never verdicts, so it reopens.
        ...(exhausted ? { holdNoLongerCharged: isToolingHold(h.reason) } : {}),
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
    // A QA rerun the EM asked for: the SRE already passed this merge, so only QA runs, as the gate would (applyQaGate).
    const rerunSha = reruns.get(target.prNumber);
    const sre: VerifyResult = rerunSha
      ? { kind: "verdict", pass: true, trailer: { pr: target.prNumber, verdict: "APPROVE", merged: true, deploy: "NA" }, summary: "EM-requested QA rerun" }
      : await verifyViaSre(repoConfig, config, target.prNumber, vlog, runAbort.signal, transcriptPath)
      .catch((e: unknown) => ({ kind: "error" as const, error: `SRE launch threw: ${String(e)}` }));
    // Errors the SRE excluded as not this release's go to the EM to route (unrelated-error); they never hold it.
    if (sre.kind === "verdict" && sre.unrelated) noteUnrelated(repoName, sre.unrelated, `${repoConfig.githubRepo} PR #${target.prNumber} (dev)`);
    // The QA gate (config.qaGate): QA runs on an SRE pass BEFORE the advance, and a FAIL, HELD or
    // crash turns the pass into a hold. Gate off, or not a QA repo: the SRE's result is unchanged.
    // qaBeforeMerge: QA already passed this head before the merge, so it does not run again here.
    const qaBeforeMerge = qaBeforeMergeApplies(repoConfig, config);
    let r: VerifyResult = sre;
    if (sre.kind === "verdict" && sre.pass && (rerunSha || (config.qaGate && !qaBeforeMerge)) && qaApplies(repoConfig, config)) {
      // QA is its own board stage (qaReviewing, its own seat): the card moves there while the gate runs.
      const qaSession = { ...session, phase: "qa" as const, reviewer: "QA" };
      await emit({ kind: "session", session: { ...qaSession, status: "started" } }, null, vlog);
      r = await applyQaGate(sre, repoConfig.githubRepo, target.prNumber, realQaDeps(repoConfig, config, vlog), vlog, rerunSha ? { markerSha: rerunSha } : {});
      await emit({ kind: "session", session: { ...qaSession, status: r.kind === "verdict" && r.pass ? "finished" : "failed" } }, null, vlog);
    }

    if (r.kind === "verdict" && r.pass) {
      verifyDefer.clear(repoName);
      const after = loadRepoState(repoName);
      const kept = { ...(after.verifyHeld ?? {}) };
      for (const n of target.issueNumbers) {
        await advance(itemOf(repoConfig, n), "verifyPassed", repoConfig, vlog);
        delete kept[n];
      }
      saveRepoState(repoName, { ...after, verifyHeld: kept });
      // Report-only QA (gate off), after the card has moved and not awaited: it can never delay or hold it.
      if (!rerunSha && !config.qaGate && !qaBeforeMerge && qaApplies(repoConfig, config)) {
        void runQaReport(repoConfig.githubRepo, target.prNumber, realQaDeps(repoConfig, config, vlog), vlog);
      }
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
    // The EM decides every post-merge fix (Ray, 2026-10-31): the Foreman files nothing. A visual QA FAIL is held at
    // its cap at once (retrying unchanged code cannot pass), and the unstick stage calls the EM on this first FAIL
    // (`rework-decision`) with the PR, the files it touched, the verdict and the evidence links. A charged hold
    // keeps its retries and is also shown to the EM on its first failure.
    let attempts = 0;
    for (const n of target.issueNumbers) {
      attempts = Math.max(attempts, (kept[n]?.attempts ?? 0) + 1);
    }
    if (plan.kind === "decide") attempts = verifyRetry.maxAttempts;
    const summary = r.kind === "verdict" ? r.summary : "";
    const decision = r.kind === "verdict" && !isDeployFailureHold(reason)
      // The PR link leads: the QA Report and the SRE's evidence comments are on it even when the output names no URL.
      ? { files: prFilesTouched(repoConfig, target.prNumber, vlog), evidence: [`https://github.com/${repoConfig.githubRepo}/pull/${target.prNumber}`, ...evidenceLinks(summary)].slice(0, 8), verdict: summary.trim().slice(-600) }
      : undefined;
    for (const n of target.issueNumbers) {
      // The same failure keeps its first evidence, so a retry that fails the same way is not a new question for the EM.
      const prior = kept[n]?.reason === reason ? kept[n]?.decision : undefined;
      const d = prior ?? decision;
      kept[n] = { heldAt: new Date().toISOString(), prNumber: target.prNumber, reason, attempts, ...(d ? { decision: d } : {}) };
    }
    saveRepoState(repoName, { ...after, verifyHeld: kept });
    const final = attempts >= verifyRetry.maxAttempts;
    const why = `dev verification of PR #${target.prNumber} did not pass (${reason}) — attempt ${attempts}/${verifyRetry.maxAttempts}` +
      (plan.kind === "decide" ? "; the EM decides the fix (a follow-up issue or a spec edit releases it)" : final ? "; no more retries, a person must look" : `; retrying in ${formatWait(backoffDelay(attempts, verifyRetry))}`);
    for (const n of target.issueNumbers) await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: why, ...(isDeployFailureHold(reason) ? { owner: "sre" as const } : {}) }, repoConfig, vlog);
    ended = { status: "failed", detail: why };
    vlog.warn(`${repoName}: ${why}`);
    events?.push({ message: `⏸️ ${repoConfig.githubRepo} ${issues}: ${why}`, level: final ? "error" : "warn" });
    return false;
  } finally {
    activeRuns.delete(runAbort);
    await emit({ kind: "session", session: { ...session, ...ended } }, null, vlog);
  }
}

