// StallClock: one start per stall (slashbin-ai-foreman#364).
//
// An eligible transition can be prevented by a deferred check, a failed handoff or a satisfied prerequisite that has
// no owner. Nothing used to record when that began (`VerifyHold.heldAt` is rewritten on every attempt). This module is
// the only writer of the stall record, `IssueRecord.stalls`, and the only caller of the `stalled` unstick kind:
// phases call `report` and `resolve`; the unstick scan calls `sweep`. Behind `FOREMAN_STALL_CLOCK`: unset, it writes
// and raises nothing.

import type { RepoConfig } from "./config.js";
import type { ForemanRuntime } from "./runtime.js";
import { HandoffNotSaved, unstickKey, type UnstickEntry } from "./unstick.js";

export type StallCause =
  | "verify-deferred" | "verify-handoff-failed" | "corrective-chain-stopped"
  | "release-sign-off" | "release-blocked-label" | "handoff-gave-up" | "epic-unanswered";
export type StallState = "open" | "escalated" | "resolved";

export interface StallRecord {
  /** `${canonicalRepo}#${issue}:${cause}`; the issue is the record's own number, never 0. */
  id: string;
  cause: StallCause;
  /** "owner/repo#N", non-empty, sorted. */
  affected: string[];
  /** Non-empty: a role ("EM") or a GitHub login. */
  resolver: string;
  /** Non-empty; release stalls: "sign" | "dark-flag" | "revert". */
  nextAction: string;
  resumptionCondition: string;
  state: StallState;
  /** ISO-8601 UTC, ms. Written once; never rewritten. */
  startedAt: string;
  /** When the `stalled` raise was SAVED to the unstick outbox. EM delivery stays on `UnstickEntry.status`. */
  escalatedAt: string | null;
  /** When a sweep raise first threw HandoffNotSaved; cleared when a raise resolves. The state stays "open". */
  undeliveredSince: string | null;
  resolvedAt: string | null;
  /** Which stall of this (issue, cause) this is, set from the second on: a recurrence's question must differ from the answered one's. */
  episode?: number;
  lastNotifiedAt: string | null;
  /** Append-only links. */
  evidence: string[];
}

export interface StallReport {
  /** >= 1: the issue whose IssueRecord holds the stall (a release-level stall: its first affected issue). */
  issue: number;
  cause: StallCause;
  /** ISO-8601 UTC ms: the first failed/deferred check, failed handoff, or the moment a prerequisite became satisfied. */
  eventAt: string;
  affected: string[];
  resolver: string;
  nextAction: string;
  resumptionCondition: string;
  evidence?: string;
}

export interface StallReportResult {
  /** The open or resolved-then-new record after the call. */
  record: StallRecord;
  /** True only on the call that opened it. */
  created: boolean;
}

/** The two-hour target (`toolingHoldLimitMs`) minus the 30-minute board-scan period. */
export const STALL_ESCALATION_BOUND_MS = 7_200_000 - 1_800_000;
/** An escalation this late or later missed the two-hour target. */
export const STALL_TARGET_MS = 7_200_000;

/** The dark flag: set (and not `0`/`false`) turns the clock on. */
export function stallClockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FOREMAN_STALL_CLOCK?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

export const stallId = (repoConfig: RepoConfig, issue: number, cause: StallCause): string => `${repoConfig.githubRepo}#${issue}:${cause}`;

/** The reason the `stalled` call carries. No timestamp: one would change the dedupe key and re-ask the EM. */
export function stallReason(r: StallRecord): string {
  // `episode` only from the second stall of a cause on: the receiver never reopens an answered reason, so a recurrence must differ.
  return JSON.stringify({ stall: r.id, cause: r.cause, affected: r.affected, resolver: r.resolver, nextAction: r.nextAction, resumptionCondition: r.resumptionCondition, ...(r.episode && r.episode > 1 ? { episode: r.episode } : {}) });
}

/** Working reads (sweep, report, the measurement read) see only unresolved stalls. Pure. */
export function unresolvedStalls(stalls: Partial<Record<StallCause, StallRecord>> | undefined): StallRecord[] {
  return Object.values(stalls ?? {}).filter((s): s is StallRecord => s !== undefined && s.state !== "resolved");
}

const parses = (iso: string): boolean => typeof iso === "string" && !Number.isNaN(Date.parse(iso));
const blank = (s: unknown): boolean => typeof s !== "string" || s.trim() === "";

function openRecord(repoConfig: RepoConfig, r: StallReport, affected: string[]): StallRecord {
  return {
    id: stallId(repoConfig, r.issue, r.cause), cause: r.cause, affected, resolver: r.resolver, nextAction: r.nextAction,
    resumptionCondition: r.resumptionCondition, state: "open", startedAt: new Date(Date.parse(r.eventAt)).toISOString(),
    escalatedAt: null, undeliveredSince: null, resolvedAt: null, lastNotifiedAt: null, evidence: r.evidence ? [r.evidence] : [],
  };
}

/**
 * Record a stall, or keep the one standing for (issue, cause). A standing unresolved key updates `affected`,
 * `evidence` and `lastNotifiedAt` only: the start is never re-stamped, so a retry, restart or relabel never resets
 * the clock. A resolved key is replaced by a new record. Rejects (throws), writing nothing, on an empty field, an
 * issue below 1 or an `eventAt` that does not parse. Flag off: nothing is written and `created` is false.
 * Callers invoke it BEFORE charging an attempt; a stall charges none.
 */
export async function report(rt: ForemanRuntime, repoConfig: RepoConfig, r: StallReport): Promise<StallReportResult> {
  if (!Number.isInteger(r.issue) || r.issue < 1) throw new Error(`stall report: issue must be >= 1 (got ${r.issue})`);
  if (!parses(r.eventAt)) throw new Error(`stall report: eventAt does not parse (${r.eventAt})`);
  if (!Array.isArray(r.affected) || r.affected.length === 0 || r.affected.some(blank)) throw new Error("stall report: affected is empty");
  if (blank(r.resolver) || blank(r.nextAction) || blank(r.resumptionCondition)) throw new Error("stall report: resolver, nextAction and resumptionCondition are required");
  const affected = [...new Set(r.affected)].sort();
  if (!stallClockEnabled()) return { record: openRecord(repoConfig, r, affected), created: false };
  let result: StallReportResult | undefined;
  const ok = await rt.records.updateIssueRecord(repoConfig, r.issue, (d) => {
    const stalls = { ...(d.stalls ?? {}) };
    const standing = stalls[r.cause];
    if (standing && standing.state !== "resolved") {
      const evidence = r.evidence && !standing.evidence.includes(r.evidence) ? [...standing.evidence, r.evidence] : standing.evidence;
      const next: StallRecord = { ...standing, affected, evidence, lastNotifiedAt: r.eventAt };
      stalls[r.cause] = next;
      result = { record: next, created: false };
    } else {
      const next = openRecord(repoConfig, r, affected);
      if (standing) next.episode = (standing.episode ?? 1) + 1;
      stalls[r.cause] = next;
      dropEscalation(d, r.issue, r.cause); // a recurrence is a new question, never the earlier stall's entry
      result = { record: next, created: true };
    }
    d.stalls = stalls;
  });
  if (!ok || !result) throw new Error(`stall report: the record of #${r.issue} could not be read or saved`);
  return result;
}

/** The clearing event happened: mark the unresolved stall resolved. No entry or already resolved: a no-op. */
export async function resolve(rt: ForemanRuntime, repoConfig: RepoConfig, issue: number, cause: StallCause, at: string): Promise<void> {
  if (!stallClockEnabled() || issue < 1) return;
  await rt.records.updateIssueRecord(repoConfig, issue, (d) => {
    const standing = d.stalls?.[cause];
    if (!standing || standing.state === "resolved") return;
    d.stalls = { ...d.stalls, [cause]: { ...standing, state: "resolved", resolvedAt: at } };
    dropEscalation(d, issue, cause); // a resolved stall's question is no longer deliverable
  });
}

/** Remove the `stalled` outbox entry of (issue, cause), so the next stall of that cause raises a fresh one. */
function dropEscalation(d: { unstick?: Record<string, UnstickEntry> }, issue: number, cause: StallCause): void {
  const key = unstickKey(issue, "stalled", cause);
  if (!d.unstick || !(key in d.unstick)) return;
  const { [key]: _gone, ...rest } = d.unstick;
  d.unstick = rest;
}

/**
 * Called by the unstick scan with its open-issue list. Each `open` stall whose age has reached the bound is raised
 * as the `stalled` kind (dedupeKey = cause); once the raise resolves (new or already standing) it is `escalated`.
 * A raise that cannot be saved (HandoffNotSaved) sets `undeliveredSince` and leaves it `open` for the next scan.
 */
export async function sweep(rt: ForemanRuntime, repoConfig: RepoConfig, now: string, openIssues: number[]): Promise<void> {
  if (!stallClockEnabled()) return;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) return;
  const loaded = await rt.records.loadIssueRecords(repoConfig, openIssues);
  for (const [issue, record] of loaded.records) {
    for (const stall of unresolvedStalls(record.stalls)) {
      if (stall.state !== "open" || nowMs - Date.parse(stall.startedAt) < STALL_ESCALATION_BOUND_MS) continue;
      let saved = false;
      try {
        await rt.handoffs.raise(repoConfig, { kind: "stalled", subject: issue, dedupeKey: stall.cause, reason: stallReason(stall) });
        saved = true;
      } catch (err) {
        if (!(err instanceof HandoffNotSaved)) throw err;
      }
      await rt.records.updateIssueRecord(repoConfig, issue, (d) => {
        const cur = d.stalls?.[stall.cause];
        if (!cur || cur.state !== "open") return;
        d.stalls = { ...d.stalls, [stall.cause]: saved
          ? { ...cur, state: "escalated", escalatedAt: now, undeliveredSince: null }
          : { ...cur, undeliveredSince: cur.undeliveredSince ?? now } };
      });
    }
  }
}

/** What the `stalls` subcommand prints for a set of stall records. */
export interface StallsReadout {
  stalls: Array<{ id: string; state: StallState; delayMs: number | null; missed: boolean }>;
  openPastBound: number;
  undelivered: number;
}

/** The measurement read: unresolved stalls only. Pure. */
export function stallsReadout(records: readonly StallRecord[], nowMs: number): StallsReadout {
  const live = records.filter((s) => s.state !== "resolved");
  return {
    stalls: live.map((s) => {
      const delayMs = s.state === "escalated" && s.escalatedAt ? Date.parse(s.escalatedAt) - Date.parse(s.startedAt) : null;
      return { id: s.id, state: s.state, delayMs, missed: delayMs !== null && delayMs >= STALL_TARGET_MS };
    }),
    openPastBound: live.filter((s) => s.state === "open" && nowMs - Date.parse(s.startedAt) >= STALL_ESCALATION_BOUND_MS).length,
    undelivered: live.filter((s) => s.undeliveredSince).length,
  };
}
