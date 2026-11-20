// The unstick stage (foreman#103): stuck work reaches the EM directly.
//
// Each pass reads what is stuck (src/unstick.ts: persisted state plus the
// `stuck` events that recorded the in-memory stops), calls
// `<emRepoPath>/bin/em.mjs unstick` once for each question not yet answered,
// and records the outcome in the issue's record (issue-records.ts; issue 0: the repo's record). It never clears a block (the
// unblock checks do, when the cause is gone), never writes Paperclip, and runs
// whether or not Paperclip is on. Without `emRepoPath` it does nothing.
//
// Follow-up, per question (src/unstick.ts `nextStep`):
//  - failed (any exit but 0/2/3, or the timer): called again next pass, up to
//    UNSTICK_MAX_ATTEMPTS for one reason, then the escalation owner is told.
//  - refused (the EM's runner was out of tokens or rate-limited): costs no
//    attempt; called again once the limit lifts (the stated reset, else the
//    `backoff.upstream` window, longer each refusal in a row). The refusal also
//    pauses the EM's runner daemon-wide (upstream "EM"): no other question, in
//    this repo or another, is put to it until the limit lifts.
//  - invoked: a handoff, not a resolution. While the question still stands it
//    is called again after `backoff.handoff` (2 h, then 4 h, ...), up to
//    `maxRecalls`; then the escalation owner is told, once.
//  - escalated / declined: final until the reason changes. A decline on a
//    recall (the EM's "already answered this reason") is the handoff still
//    standing, not a decision: it counts as a recall, so the watch goes on.

import { resolve } from "node:path";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { roleFor } from "../plugins/registry.js";
import type { UnstickOutcome, Unsticker } from "../plugins/contract.js";
import { fieldTable, type RepoRecord } from "../issue-records.js";
import { isUpstreamBlocked, reportRunResult, tryAcquire } from "../upstream-backoff.js";
import { backoffDelay } from "../backoff.js";
import { EVENT_KINDS, nextDecompose, decomposeInFlight, releaseGateCandidateReason, UNSTICK_MAX_ATTEMPTS, SPENT_QUESTION_REARM, handoffGiveUpComment, unstickGiveUpComment, derivedCandidates, nextStep, openEntry, unstickKey, type DecomposeCandidate, type UnstickCandidate, type UnstickEntry } from "../unstick.js";
import { activeRuns } from "./common.js";
import { report as reportStall, resolve as resolveStall, sweep as sweepStalls, unresolvedStalls, stallClockEnabled } from "../stall-clock.js";
import { isDeployFailureHold } from "./verify.js";
import { codeHost } from "../plugins/registry.js";
import type { CodeHost } from "../code-host.js";
import type { ForemanRuntime } from "../runtime.js";

function transcript(repoConfig: RepoConfig, what: string, cycleNumber: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(process.cwd(), "logs", "unstick", `${repoConfig.name}-${what}-cycle${cycleNumber}-${ts}.log`);
}

/**
 * Apply `fn` to the persisted questions about `issue` (its record's table; issue 0: the repo's own) and save them.
 * Resolves false when the record could not be read or saved, in which case nothing changed.
 */
async function mutate(rt: ForemanRuntime, repoConfig: RepoConfig, issue: number, fn: (table: Record<string, UnstickEntry>) => void): Promise<boolean> {
  if (issue <= 0) {
    return rt.records.updateRepoRecord(repoConfig, (d) => {
      const table = { ...(d.unstick ?? {}) };
      fn(table);
      d.unstick = table;
    });
  }
  return rt.records.updateIssueRecord(repoConfig, issue, (d) => {
    const table = { ...(d.unstick ?? {}) };
    fn(table);
    d.unstick = table;
  });
}

/** The standing question `key` about `issue`; undefined when there is none or the record cannot be read. */
async function entryOf(rt: ForemanRuntime, repoConfig: RepoConfig, issue: number, key: string): Promise<UnstickEntry | undefined> {
  if (issue <= 0) return (await rt.records.loadRepoRecord(repoConfig))?.unstick?.[key];
  return (await rt.records.loadIssueRecord(repoConfig, issue))?.unstick?.[key];
}

const toStatus = (o: UnstickOutcome): UnstickEntry["status"] => o.kind;

/** The EM's own runner, as an upstream: one refusal pauses every EM call daemon-wide until the limit lifts. */
export const EM_UPSTREAM = "EM";

/** The entry an outcome leaves: what each kind spends, and when a refusal may be called again. Pure, exported for tests. */
export function applyOutcome(cur: UnstickEntry, o: UnstickOutcome, nowMs: number, upstream: { baseMs: number; capMs: number; factor: number }): UnstickEntry {
  const at = new Date(nowMs).toISOString();
  // The recalls made on a standing handoff; undefined when none was handed off. An `invoked` entry written before
  // `recalls` existed is a handoff too, with none made yet.
  const handedOff = cur.recalls ?? (cur.status === "invoked" ? 0 : undefined);
  const { waitUntil: _w, ...rest } = cur;
  // A call made on a question whose first burst is spent is a re-arm: it is ONE call (attempts keep counting, never
  // reset), and each failed one lengthens the wait to the next (`SPENT_QUESTION_REARM`).
  const rearm = cur.attempts >= UNSTICK_MAX_ATTEMPTS;
  if (o.kind === "refused") {
    const refusals = (cur.refusals ?? 0) + 1;
    const until = o.resetAtMs !== undefined && o.resetAtMs > nowMs ? o.resetAtMs : nowMs + backoffDelay(refusals, upstream);
    // A refusal is not an answer: the prior status's recall count is kept, the attempt is not spent.
    return { ...rest, attempts: cur.attempts, ...(handedOff !== undefined ? { recalls: handedOff } : {}), status: "refused", refusals, waitUntil: new Date(until).toISOString(), lastCallAt: at, detail: o.detail.slice(0, 500) };
  }
  const { refusals: _r, ...clean } = rest;
  // A recall the EM declines as already answered: the handoff stands and the watch goes on (a decline is final
  // only for a question never handed off). `recalls` is set exactly while a handoff is being watched.
  if (o.kind === "declined" && handedOff !== undefined) {
    return { ...clean, status: "invoked", attempts: cur.attempts + 1, lastCallAt: at, recalls: handedOff + 1, ...(o.detail ? { detail: o.detail.slice(0, 500) } : {}) };
  }
  // `recalls` starts at 0 with the first handoff; every later handoff for the same reason is a recall.
  return {
    ...clean,
    status: toStatus(o),
    attempts: cur.attempts + 1,
    lastCallAt: at,
    ...(rearm && o.kind === "failed" ? { rearms: (cur.rearms ?? 0) + 1 } : {}),
    ...(o.kind === "invoked" ? { recalls: handedOff === undefined ? 0 : handedOff + 1 } : {}),
    ...(o.detail ? { detail: o.detail.slice(0, 500) } : {}),
  };
}

/** How often the EM is asked which approved epics have no child: its answer is a six-minute board scan. */
export const EPIC_DECOMPOSE_CHECK_MS = 30 * 60_000;
let lastDecomposeCheck = 0;
/** Test seam: forget when the last check ran. */
export function resetDecomposeThrottle(): void { lastDecomposeCheck = 0; }

/**
 * The repo that carries the epic-decompose questions: the epics live in `epicRepo`, which is no configured repo,
 * so the repo-level record of the first repo that runs stages holds them (one deterministic place, one asker).
 */
export function decomposeHost(config: AgentConfig): RepoConfig | undefined {
  return config.repos.find((r) => !r.syncOnly);
}

/**
 * An open epic of `epicRepo` that is approved, held by nothing and has no child wakes the EM once, one at a time
 * (docs/em-coordination.md §3). Raises at most one alert into `repoConfig`'s repo record; never throws.
 */
async function raiseDecompose(rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, unsticker: Unsticker, log: Logger): Promise<void> {
  const label = repoConfig.epicRefLabel;
  if (!config.epicRepo || !label || !unsticker.epicDecompose || decomposeHost(config)?.name !== repoConfig.name) return;
  if (Date.now() - lastDecomposeCheck < EPIC_DECOMPOSE_CHECK_MS || isUpstreamBlocked("github")) return;
  try {
    const record = await rt.records.loadRepoRecord(repoConfig);
    if (record === null) return;
    const table = record?.unstick ?? {};
    // One at a time: while a call is open, nothing is asked. No scan is paid for either, unless a due epic's stall is
    // open: its clearing event is the epic leaving the list, which only a scan can see.
    const inFlight = decomposeInFlight(table);
    const tracking = stallClockEnabled() && (record.epicStalls?.length ?? 0) > 0;
    if (inFlight && !tracking) return;
    lastDecomposeCheck = Date.now();
    const due = await unsticker.epicDecompose(config, log);
    if (!due) return;
    await trackDueEpics(rt, repoConfig, config, due, record, log);
    if (inFlight) return;
    const alert = nextDecompose([...due].sort((x, y) => x.approvedAt.localeCompare(y.approvedAt)), table, label);
    if (alert && await rt.handoffs.raise(repoConfig, alert)) log.info(`Asking the EM to break down ${label} #${alert.dedupeKey.split("-")[0]} (approved, no child)`);
  } catch (err) {
    log.warn(`Could not check for approved epics with no child: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Where an epic's records live: the epic is an issue of `epicRepo`, so its stall is keyed under that repo and the
 * epic's own number, never the host's (the host's numbers are another space). The same config otherwise.
 */
export const epicHome = (repoConfig: RepoConfig, config: AgentConfig): RepoConfig | null =>
  config.epicRepo ? { ...repoConfig, githubRepo: config.epicRepo } : null;

/** The epic a stored `epic-decompose` question is about: its tag starts with the epic number. */
const tagEpic = (e: UnstickEntry): number => Number.parseInt(e.tag ?? "", 10);

/**
 * The epics whose stall the epic repo's records may hold, read from durable state only: the index of epics with an open
 * stall plus the epics the EM was ever asked about. Nothing here depends on the previous scan, so a restart loses none.
 */
export function heldEpics(record: RepoRecord | null): number[] {
  const tagged = Object.values(record?.unstick ?? {}).filter((e) => e.kind === "epic-decompose").map(tagEpic);
  return [...new Set([...(record?.epicStalls ?? []), ...tagged])].filter((n) => Number.isInteger(n) && n >= 1);
}

/**
 * One `epic-unanswered` stall per due epic, started when its prerequisite closed (`afterClosedAt`) or, with no child,
 * when it was approved. A held epic absent from this scan's list is resolved, however the process got here: the
 * durable index and the asked-about epics say which to look at. The index is widened before any report and narrowed
 * only after the resolves, so an interrupted scan leaves a superset, never a stall nobody can find. Dark behind
 * FOREMAN_STALL_CLOCK; a failure is logged and never stops the pass.
 */
async function trackDueEpics(rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, due: readonly DecomposeCandidate[], record: RepoRecord, log: Logger): Promise<void> {
  if (!stallClockEnabled() || !config.epicRepo) return;
  const home = epicHome(repoConfig, config)!;
  const dueNow = new Set(due.map((d) => d.epic));
  const setIndex = (epics: Iterable<number>) => rt.records.updateRepoRecord(repoConfig, (d) => { d.epicStalls = [...new Set(epics)].sort((a, b) => a - b); });
  if (!(await setIndex([...(record.epicStalls ?? []), ...dueNow]))) { log.warn("Could not record the due epics' stall index; their stalls are not tracked this scan"); return; }
  for (const d of due) {
    const parses = (t?: string | null): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t));
    try {
      await reportStall(rt, home, {
        issue: d.epic, cause: "epic-unanswered", eventAt: d.after && parses(d.afterClosedAt) ? d.afterClosedAt : d.approvedAt,
        affected: [`${config.epicRepo}#${d.epic}`], resolver: config.unstickEscalationOwner ?? "EM",
        nextAction: "break the epic down: file its next wave of child issues",
        resumptionCondition: "a child of the epic is filed, or the epic leaves the due list",
      });
    } catch (err) {
      log.warn(`Could not report the stall of due epic #${d.epic}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const now = new Date().toISOString();
  for (const epic of heldEpics(record)) if (!dueNow.has(epic)) await resolveStall(rt, home, epic, "epic-unanswered", now);
  await setIndex(dueNow);
}

/**
 * The handoff-stall index, widened once for a batch of give-ups before any is reported: one write however many, so the
 * cost is linear in the batch. A restart or a closed issue never leaves a stall nobody can find. Dark without the flag.
 */
async function widenHandoffIndex(rt: ForemanRuntime, repoConfig: RepoConfig, known: Set<number>, issues: Iterable<number>): Promise<void> {
  if (!stallClockEnabled()) return;
  const fresh = [...new Set(issues)].filter((n) => n >= 1 && !known.has(n));
  if (fresh.length === 0) return;
  if (await rt.records.updateRepoRecord(repoConfig, (d) => { d.handoffStalls = [...new Set([...(d.handoffStalls ?? []), ...fresh])].sort((a, b) => a - b); })) for (const n of fresh) known.add(n);
}

/** A handoff the pass gave up on: the stall starts when the question first appeared. Issue 0 and `stalled` are never reported. */
async function reportGiveUp(rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, log: Logger, c: UnstickCandidate, entry: Pick<UnstickEntry, "since">, known: Set<number>): Promise<void> {
  if (c.issue < 1 || c.kind === "stalled" || !stallClockEnabled()) return;
  try {
    await widenHandoffIndex(rt, repoConfig, known, [c.issue]);
    await reportStall(rt, repoConfig, {
      issue: c.issue, cause: "handoff-gave-up", eventAt: entry.since, affected: [`${repoConfig.githubRepo}#${c.issue}`],
      resolver: config.unstickEscalationOwner ?? "EM", nextAction: `take ${c.kind}: the EM handoff gave up`,
      resumptionCondition: `the ${c.kind} question stops standing on the issue`, evidence: c.reason.slice(0, 200),
    });
  } catch (err) {
    log.warn(`Could not report the handoff stall on #${c.issue}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Returns how many EM calls this pass made. Never throws. */
export async function tryUnstick(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  base: Logger,
  cycleNumber: number,
  deps: { comment?: CodeHost["commentOnIssue"] } = {},
): Promise<number> {
  const unsticker = roleFor("unstick", config);
  if (!unsticker) return 0;
  const repoName = repoConfig.name;
  const log = base.child({ cycle: cycleNumber, repo: repoName, phase: "unstick" });
  try {
    // The issues this pass looks at: the repo's open ones. When GitHub cannot be read there are none, and the
    // pass keeps to what is held in state (the questions about no issue) and prunes nothing it cannot see.
    let issues: Awaited<ReturnType<CodeHost["getOpenIssues"]>> | null = null;
    if (!isUpstreamBlocked("github")) {
      try {
        issues = await codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, log);
      } catch (err) {
        log.warn(`Could not read open issues for the unstick pass: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const open = issues ? new Set(issues.map((i) => i.number)) : null;
    // An issue whose record cannot be read is not an issue with nothing stuck: it is left alone this pass.
    await raiseDecompose(rt, repoConfig, config, unsticker, log);
    // The epics' stalls live on the epic repo's own records, under the epic's number.
    const repoRecord = await rt.records.loadRepoRecord(repoConfig);
    const epics = heldEpics(repoRecord);
    const home = epicHome(repoConfig, config);
    // Stalls past their bound are raised once (`stalled`) before this pass reads the questions back. Dark: a no-op without FOREMAN_STALL_CLOCK.
    if (issues) {
      try {
        await sweepStalls(rt, repoConfig, new Date().toISOString(), issues.map((i) => i.number), log);
        if (home && epics.length > 0) await sweepStalls(rt, home, new Date().toISOString(), epics);
      }
      catch (err) { log.warn(`Stall sweep failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
    // The repo's own record holds the questions about no issue; unreadable, none of them is touched this pass.
    const loaded = await rt.records.loadIssueRecords(repoConfig, new Set(open ?? []));
    // The epics' own records: their `stalled` questions are delivered from here, to the epic's repo and number.
    const epicLoaded = home && epics.length > 0 ? await rt.records.loadIssueRecords(home, new Set(epics)) : null;
    const homeOf = new Map<UnstickCandidate, RepoConfig>();
    const epicCandidates: UnstickCandidate[] = [];
    for (const r of epicLoaded?.records.values() ?? []) {
      for (const e of Object.values(r.unstick ?? {})) {
        if (!EVENT_KINDS.has(e.kind)) continue;
        const c: UnstickCandidate = { issue: e.issue, kind: e.kind, reason: e.reason, ...(e.tag ? { tag: e.tag } : {}) };
        epicCandidates.push(c);
        homeOf.set(c, home!);
      }
    }
    const candidates: UnstickCandidate[] = derivedCandidates({
      verifyHeld: fieldTable(loaded, "verifyHeld"),
      skipped: fieldTable(loaded, "skipped"),
    }, {
      verifyMaxAttempts: config.backoff.verifyRetry.maxAttempts,
      isDeployFailureHold,
    });

    // The release gate is read off the board, not off state: an issue at
    // `pr approved` (and not yet `ready for prod release`) waits on the EM's
    // outcome gate.
    if (issues) {
      const { prApproved, readyForProd } = repoConfig.lifecycleLabels;
      for (const i of issues) {
        if (codeHost().hasLabel(i, prApproved) && !codeHost().hasLabel(i, readyForProd)) {
          const names = i.labels.map((l) => l.name);
          // The EM answers where a grant can live (`grantState`); the Foreman only carries its answer in the reason.
          // One call per issue, in turn. No answer keeps the last reason, so a flaky read is not a new question.
          const grantState = unsticker.grantState ? await unsticker.grantState(repoConfig, config, i.number, log) : null;
          const prior = loaded.records.get(i.number)?.unstick?.[unstickKey(i.number, "release-gate")];
          const reason = releaseGateCandidateReason(names, grantState, prior?.reason);
          candidates.push({ issue: i.number, kind: "release-gate", reason });
        }
      }
    }

    // Event-kind entries are candidates for as long as they stand.
    const standingQuestions = [...loaded.records.values()].flatMap((r) => Object.values(r.unstick ?? {})).concat(Object.values(repoRecord?.unstick ?? {}));
    for (const e of standingQuestions) {
      if (EVENT_KINDS.has(e.kind)) candidates.push({ issue: e.issue, kind: e.kind, reason: e.reason, ...(e.tag ? { tag: e.tag } : {}) });
    }

    const live = new Set(candidates.map((c) => unstickKey(c.issue, c.kind, c.tag)));
    const now = new Date().toISOString();
    // One write per issue (and one for the repo's own questions). A derived question ends with its condition;
    // an event question ends when its issue is no longer open, which a record of an open issue never shows.
    // Grouped once by issue: a scan of every candidate per issue is O(issues x candidates).
    const byIssue = new Map<number, UnstickCandidate[]>();
    for (const c of candidates) (byIssue.get(c.issue) ?? byIssue.set(c.issue, []).get(c.issue)!).push(c);
    const issuesInPlay = new Set<number>([0, ...loaded.records.keys(), ...byIssue.keys()]);
    for (const n of issuesInPlay) {
      if (n === 0 ? repoRecord === null : loaded.unavailable.has(n)) continue;
      const mine = byIssue.get(n) ?? [];
      await mutate(rt, repoConfig, n, (table) => {
        for (const [key, e] of Object.entries(table)) if (!EVENT_KINDS.has(e.kind) && !live.has(key)) delete table[key];
        for (const c of mine) {
          const key = unstickKey(c.issue, c.kind, c.tag);
          table[key] = openEntry(table[key], c, now);
        }
      });
    }

    // A handoff stall ends when no question stands on its issue any more (the hold cleared, or the issue closed) or the
    // EM answered the standing one for good: it declined, or it escalated after the Foreman's own give-up notice (the
    // notice stamps `gaveUpAt`; a later call is the EM's). The index finds a closed issue's stall, which no list shows.
    // Dark without the flag: nothing is resolved and the index is left exactly as it stands.
    const known = new Set<number>(repoRecord?.handoffStalls ?? []);
    if (stallClockEnabled()) {
      const indexed = new Set(known);
      const stale = [...indexed].filter((n) => !loaded.records.has(n));
      const extra = stale.length > 0 ? await rt.records.loadIssueRecords(repoConfig, new Set(stale)) : null;
      const answered = (n: number, c: UnstickCandidate) => {
        const e = (loaded.records.get(n)?.unstick ?? {})[unstickKey(c.issue, c.kind, c.tag)];
        if (!e || e.reason !== c.reason) return false;
        if (e.status === "declined" || e.status === "escalated") return !e.gaveUpAt || (!!e.lastCallAt && Date.parse(e.lastCallAt) > Date.parse(e.gaveUpAt));
        return false;
      };
      const stalled = new Set<number>(indexed);
      for (const [n, r] of [...loaded.records, ...(extra?.records ?? [])]) {
        if (!unresolvedStalls(r.stalls).some((st) => st.cause === "handoff-gave-up")) { stalled.delete(n); continue; }
        stalled.add(n);
        if ((byIssue.get(n) ?? []).some((c) => c.kind !== "stalled" && !answered(n, c))) continue;
        await resolveStall(rt, repoConfig, n, "handoff-gave-up", now);
        stalled.delete(n);
      }
      // An index entry whose record could not be read stays: the next pass tries again.
      for (const n of stale) if (extra?.unavailable.has(n)) stalled.add(n);
      if (stalled.size !== indexed.size || [...stalled].some((n) => !indexed.has(n))) {
        if (await rt.records.updateRepoRecord(repoConfig, (d) => { d.handoffStalls = stalled.size > 0 ? [...stalled].sort((a, b) => a - b) : undefined; })) {
          known.clear();
          for (const n of stalled) known.add(n);
        }
      }
    }

    let calls = 0;
    const policy = { maxAttempts: UNSTICK_MAX_ATTEMPTS, handoff: config.backoff.handoff };
    // Each step is read first, so the give-ups are indexed in one write before any is reported.
    const plan: Array<{ c: UnstickCandidate; key: string; where: RepoConfig; entry: UnstickEntry; step: ReturnType<typeof nextStep> }> = [];
    for (const c of [...candidates, ...epicCandidates]) {
      const key = unstickKey(c.issue, c.kind, c.tag);
      const where = homeOf.get(c) ?? repoConfig;
      const entry = await entryOf(rt, where, c.issue, key);
      if (entry) plan.push({ c, key, where, entry, step: nextStep(entry, c, Date.now(), policy) });
    }
    // A call that fails for the last time also gives up; indexing it ahead leaves at worst an entry with no stall,
    // which the next pass's clearing drops.
    const mayGiveUp = (p: (typeof plan)[number]) => p.step === "give-up" || (p.step === "call" && p.entry.attempts + 1 >= UNSTICK_MAX_ATTEMPTS);
    await widenHandoffIndex(rt, repoConfig, known, plan.filter((p) => p.where === repoConfig && mayGiveUp(p)).map((p) => p.c.issue));
    for (const { c, key, where, entry, step } of plan) {
      if (step === "wait") continue;
      if (step === "give-up") {
        await giveUpHandoff(rt, where, config, log, c, key, entry, deps, known);
        continue;
      }
      // The EM's runner is paused by a refusal (this pass, an earlier one, another repo's): no call until it lifts.
      if (!tryAcquire(EM_UPSTREAM)) continue;
      const ac = new AbortController();
      activeRuns.set(ac, repoName);
      let outcome: UnstickOutcome;
      try {
        outcome = await unsticker.unstick(where, config, c.issue, c.kind, c.reason, log, ac.signal,
          transcript(repoConfig, `${c.kind}-${c.issue}`, cycleNumber));
      } finally {
        activeRuns.delete(ac);
      }
      calls++;
      const refused = outcome.kind === "refused" ? outcome : undefined;
      reportRunResult(EM_UPSTREAM, !!refused, refused?.detail, refused?.resetAtMs);
      log.info(`EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): ${outcome.kind}${outcome.detail ? ` — ${outcome.detail.slice(0, 200)}` : ""}`);
      let spent: UnstickEntry | undefined;
      await mutate(rt, where, c.issue, (table) => {
        const cur = table[key];
        // The reason changed while the call ran: it is a new question, answered next pass.
        if (!cur || cur.reason !== c.reason) return;
        table[key] = applyOutcome(cur, outcome, Date.now(), config.backoff.upstream);
        // The first burst just ran out: the one give-up notice. A re-arm call after it never says so again.
        if (outcome.kind === "failed" && table[key]!.attempts === UNSTICK_MAX_ATTEMPTS && !table[key]!.gaveUpAt) spent = table[key];
      });
      // The runner is out of tokens or rate-limited: reportRunResult paused it, so the calls left wait for the reset.
      if (refused) {
        log.warn(`EM unstick refused by its runner — no attempt spent; EM calls paused until the limit lifts`);
        continue;
      }
      // The attempt that spends the last call: say so once, on the issue. Stored
      // `escalated`, an unchanged reason never comments again; if the post
      // fails the entry stays `failed` at the cap (no retry, no throw).
      // Issue 0 is a repo-level hold with no issue to comment on. With no
      // `unstickEscalationOwner` there is nobody to mention: the entry stays
      // `failed` at the cap, as for a failed post, and the log says why.
      if (spent) {
        await reportGiveUp(rt, where, config, log, c, spent, known);
        const owner = config.unstickEscalationOwner;
        const markNoticed = () => mutate(rt, where, c.issue, (table) => {
          const cur = table[key];
          if (cur && cur.reason === c.reason) table[key] = { ...cur, gaveUpAt: new Date().toISOString() };
        });
        if (c.issue <= 0 || !owner) {
          // Nothing to comment on (a repo-level alert) or nobody to mention: say so in the log, once. The question stays
          // `failed` and is asked again on the re-arm back-off.
          log.warn(`EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): EM unreachable after ${UNSTICK_MAX_ATTEMPTS} calls — ${owner ? "no issue to comment on" : "no unstickEscalationOwner configured, so nobody is mentioned"}; it is asked again on a back-off of ${Math.round(SPENT_QUESTION_REARM.baseMs / 3_600_000)} h up to ${Math.round(SPENT_QUESTION_REARM.capMs / 3_600_000)} h`);
          await markNoticed();
        } else {
          try {
            await (deps.comment ?? codeHost().commentOnIssue)(where, c.issue, unstickGiveUpComment(owner, spent));
            await mutate(rt, where, c.issue, (table) => {
              const cur = table[key];
              if (cur && cur.reason === c.reason) table[key] = { ...cur, status: "escalated", gaveUpAt: new Date().toISOString() };
            });
            log.warn(`EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): EM unreachable after ${UNSTICK_MAX_ATTEMPTS} calls — escalated to @${owner}`);
          } catch (err) {
            log.warn(`Could not post the unstick give-up comment on #${c.issue}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
          }
        }
      }
    }
    return calls;
  } catch (err) {
    log.warn(`Unstick pass failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * A handoff made again and again that never moved the issue: tell the
 * escalation owner once (stored `escalated`, so an unchanged reason never
 * comments again). Issue 0 has nowhere to comment and, like no configured
 * owner, is only logged; `gaveUpAt` stops it being reported every pass.
 */
async function giveUpHandoff(
  rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, log: Logger,
  c: UnstickCandidate, key: string, entry: UnstickEntry, deps: { comment?: CodeHost["commentOnIssue"] }, known: Set<number>,
): Promise<void> {
  await reportGiveUp(rt, repoConfig, config, log, c, entry, known);
  const owner = config.unstickEscalationOwner;
  const what = `EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): handed off ${entry.attempts} times since ${entry.since} and still stuck`;
  const mark = (fields: Partial<UnstickEntry>) => mutate(rt, repoConfig, c.issue, (table) => {
    const cur = table[key];
    if (cur && cur.reason === c.reason) table[key] = { ...cur, ...fields };
  });
  if (!owner || c.issue <= 0) {
    log.warn(`${what} — ${owner ? "no issue to comment on" : "no unstickEscalationOwner configured, so nobody is mentioned"}`);
    await mark({ gaveUpAt: new Date().toISOString() });
    return;
  }
  try {
    await (deps.comment ?? codeHost().commentOnIssue)(repoConfig, c.issue, handoffGiveUpComment(owner, entry));
    await mark({ status: "escalated", gaveUpAt: new Date().toISOString() });
    log.warn(`${what} — escalated to @${owner}`);
  } catch (err) {
    // Not marked: the next pass tries the comment again.
    log.warn(`Could not post the handoff give-up comment on #${c.issue}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}
