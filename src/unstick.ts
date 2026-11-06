// The unstick stage's data: what "stuck" means, and the table that remembers
// what was asked of the EM (foreman#103).
//
// The Foreman calls the Tech Lead and the SRE directly, but used to show stuck
// work to the EM only as a Paperclip card, so with Paperclip off a stuck issue
// reached no one. The unstick stage (src/phases/unstick.ts) runs
// `<emRepoPath>/bin/em.mjs unstick --repo <owner/name> --issue <N> --kind <kind>
// --reason <text>` for each stuck issue and records the outcome here.
//
// Two sources feed one table, keyed `<issue>:<kind>`. An issue's questions live in
// its record (issue-records.ts, `unstick`); the few that belong to no issue (issue 0:
// `unrelated-error`, `epic-ready-to-close`) live in the repo's own record (`RepoRecord.unstick`):
//  - DERIVED kinds are read off persisted state every pass (`derivedCandidates`):
//    nothing relies on an event having fired, so a hold whose event came and
//    went before a restart (cmneb_hr#38, 2026-10-20) is still found. Their
//    entries live while the condition does.
//  - EVENT kinds have no persisted condition to read (revision and ruling
//    stops are in memory), so the `blocked` / `escalated` event carries a
//    `stuck` kind and `noteStuck` records it. Those entries live until an
//    `unblocked` event, the issue closing, or a new reason replaces them.

import { createHash } from "node:crypto";
import { escapeRegex } from "./regex.js";
import type { RepoConfig } from "./config.js";
import type { IssueRecordStore, SkippedIssue, VerifyHold } from "./issue-records.js";
import { codeHost } from "./plugins/registry.js";
import { backoffDelay, type BackoffWindow } from "./backoff.js";

/**
 * Every `--kind` the EM's `unstick` command accepts. Shared verbatim with the
 * EM side (EM#737): change both or neither.
 */
export const UNSTICK_KINDS = [
  "skip",
  "divergence",
  "verify-held",
  "verify-exhausted",
  "verify-no-pr",
  "revision-exhausted",
  "revision-stalemate",
  "needs-ruling",
  "dead-zone",
  "deploy-failed",
  "release-gate",
  "rework-decision",
  "unrelated-error",
  "epic-ready-to-close",
  "dependency-batch-loop",
] as const;
export type UnstickKind = (typeof UNSTICK_KINDS)[number];

/** The kinds the Foreman sends that the receiver does not list. Pure: the whole of the contract check. */
export function missingKinds(published: readonly string[], ours: readonly string[] = UNSTICK_KINDS): string[] {
  const have = new Set(published);
  return ours.filter((k) => !have.has(k));
}

/**
 * `pending` not yet called · `invoked` EM exit 0 · `escalated` exit 2 · `declined` exit 3 ·
 * `refused` the EM's runner refused the work (a limit; no attempt spent) · `failed` anything else.
 */
export type UnstickStatus = "pending" | "invoked" | "escalated" | "declined" | "refused" | "failed";

/** Calls spent on one reason before a failing call stops being retried. */
export const UNSTICK_MAX_ATTEMPTS = 3;

/** The comment posted once when every EM call for a hold has failed (foreman#105). */
export function unstickGiveUpComment(owner: string, entry: Pick<UnstickEntry, "kind" | "reason" | "attempts" | "detail">): string {
  return [
    "**Foreman: the EM could not be reached for this hold**",
    "",
    `@${owner} — ${entry.attempts} calls to the EM all failed, so nobody has ruled on this. The Foreman will not call again unless the reason changes.`,
    "",
    `- Kind: \`${entry.kind}\``,
    `- Reason: ${entry.reason}`,
    "",
    "Last failure:",
    "",
    "```",
    (entry.detail ?? "(no detail)").slice(0, 800),
    "```",
  ].join("\n");
}

export interface UnstickEntry {
  issue: number;
  kind: UnstickKind;
  /** What the EM was (or will be) told. A different reason is a new question and is called again. */
  reason: string;
  status: UnstickStatus;
  /** Calls made for this reason. */
  attempts: number;
  /** ISO time this reason first appeared. */
  since: string;
  /** ISO time of the last call. */
  lastCallAt?: string;
  /** The tail of the last failure, for the log and for a person reading the state. */
  detail?: string;
  /** Tells apart questions that share an issue and kind (`unrelated-error`: one per signature). */
  tag?: string;
  /** Times an `invoked` handoff that did not move the issue was called again. */
  recalls?: number;
  /** Refusals in a row: they lengthen the wait, never spend an attempt. */
  refusals?: number;
  /** ISO time before which a `refused` entry is not called again. */
  waitUntil?: string;
  /** ISO time the give-up notice for a spent question (or a handoff watch) was made: it is never made twice. */
  gaveUpAt?: string;
  /** Calls made on a spent `failed` question after its first burst of attempts: they lengthen the wait to the next one. */
  rearms?: number;
}

/** Something stuck right now, as read this pass. */
export interface UnstickCandidate {
  issue: number;
  kind: UnstickKind;
  reason: string;
  tag?: string;
}

export const unstickKey = (issue: number, kind: UnstickKind, tag?: string): string => `${issue}:${kind}${tag ? `:${tag}` : ""}`;

/** The kinds only an event can report: there is no persisted condition to read them from. */
/** Immutable constant (not state): the kinds only an event can report. */
export const EVENT_KINDS: ReadonlySet<UnstickKind> = new Set<UnstickKind>([
  "needs-ruling", "dead-zone", "revision-exhausted", "revision-stalemate", "verify-held", "unrelated-error", "epic-ready-to-close", "dependency-batch-loop",
]);

/** The reason the release-gate call carries: stable, so one `pr approved` costs one call. */
export const RELEASE_GATE_REASON = "at `pr approved` — dev verification passed, awaiting the EM outcome gate (`ready for prod release`)";

/** Every issue a title says it follows up ("— follow-up to #N"), in order. The one parser for that phrase. */
export function followUpTargets(title: string): number[] {
  return [...(title ?? "").matchAll(/follow-up to #(\d+)/gi)].map((m) => Number(m[1]));
}

/** The first issue a title follows up, else null. */
export function followUpOrigin(title: string): number | null {
  return followUpTargets(title)[0] ?? null;
}

/**
 * The release-gate reason for one issue: the stable text, the issue's labels (sorted), and the EM's own
 * `em.mjs grant-state` answer when it gave one (opaque: the Foreman does not know where a grant can live). A grant
 * landing anywhere changes the answer, so the reason changes, `nextStep` calls the EM again and its answered-marker
 * no longer matches. The Foreman does not decide whether the release may go.
 */
export function releaseGateReason(labels: readonly string[], grantState?: string | null): string {
  const set = [...new Set(labels)].sort();
  return (set.length ? `${RELEASE_GATE_REASON} [labels: ${set.join(", ")}]` : RELEASE_GATE_REASON) + (grantState ? ` [grant: ${grantState}]` : "");
}

/**
 * The reason a release-gate candidate carries this pass. A grant state the EM could not give (null) keeps the
 * prior entry's reason, so a flaky read is not a new question; with no prior entry it is the reason without the grant part.
 */
export function releaseGateCandidateReason(labels: readonly string[], grantState: string | null, priorReason?: string): string {
  if (grantState === null && priorReason !== undefined) return priorReason;
  return releaseGateReason(labels, grantState);
}

/**
 * What the EM is told about a post-merge verification failure. Stable for one failure (no attempt count, and the
 * evidence is kept from the first run), so the same failure is one call. Pure, exported for tests.
 */
export function reworkDecisionReason(h: Pick<VerifyHold, "prNumber" | "reason" | "decision">): string {
  const d = h.decision ?? { files: [], evidence: [], verdict: "" };
  return [
    `Dev verification failed for PR #${h.prNumber}: ${h.reason}. The Foreman files no fix; the technical decision is yours.`,
    `Files the PR touched: ${d.files.length > 0 ? d.files.join(", ") : "(unreadable)"}.`,
    `Evidence: ${d.evidence.length > 0 ? d.evidence.join(" ") : "none in the output (read the evidence comments on the issue and the PR)"}.`,
    `Verdict: ${d.verdict.replace(/\s+/g, " ").trim() || "(none)"}`,
  ].join(" ");
}

/**
 * The stuck work persisted state shows. Pure.
 *
 * A verify hold is stuck only once its attempts are spent: until then the stage
 * retries it itself, and calling the EM would race that. A deploy-failure hold
 * (`owner: "sre"`) is included — the EM hands it to the SRE and rules.
 *
 */
export function derivedCandidates(
  state: {
    /** The holds and skips of the issues read this pass, by issue number. */
    verifyHeld?: Readonly<Record<number, VerifyHold>>;
    skipped?: Readonly<Record<number, SkippedIssue>>;
  },
  opts: {
    verifyMaxAttempts: number;
    isDeployFailureHold: (reason: string) => boolean;
  },
): UnstickCandidate[] {
  const out: UnstickCandidate[] = [];
  for (const [key, h] of Object.entries(state.verifyHeld ?? {})) {
    const issue = Number(key);
    if (h.reason === "no-merged-pr") {
      out.push({ issue, kind: "verify-no-pr", reason: "labelled merged, but no merged PR into the base branch closes it" });
    } else if (h.decision && !opts.isDeployFailureHold(h.reason) && (h.reason === "visual-qa-failed" || h.attempts < opts.verifyMaxAttempts)) {
      // The first failure calls the EM, not the spent retries: the fix is the EM's decision. A visual QA FAIL is held at
      // its cap and stays this kind; a charged hold hands over to verify-exhausted when its retries run out.
      out.push({ issue, kind: "rework-decision", reason: reworkDecisionReason(h) });
    } else if (h.attempts >= opts.verifyMaxAttempts) {
      const pr = h.prNumber ? ` (PR #${h.prNumber})` : "";
      out.push({
        issue,
        kind: opts.isDeployFailureHold(h.reason) ? "deploy-failed" : "verify-exhausted",
        reason: `dev verification held: ${h.reason}${pr}, ${h.attempts} attempts spent`,
      });
    }
  }
  for (const [key, s] of Object.entries(state.skipped ?? {})) {
    if (s.escalatedAt) out.push({ issue: Number(key), kind: "skip", reason: codeHost().escalatedReason(s.reason, s.skipCount ?? 0) });
  }
  return out;
}

/**
 * How a question whose calls were all spent is asked again (`nextStep`, for every kind): ONE call per window, the window
 * growing 1 h, 2 h, 4 h ... up to a day. Without it a notice that never reached the EM stayed undelivered after the EM
 * came back; unbounded, a permanently failing one would cost an EM session an hour for ever. The window is the same
 * `BackoffWindow` the other waits use, counted by `UnstickEntry.rearms`.
 */
export const SPENT_QUESTION_REARM: BackoffWindow = Object.freeze({ baseMs: 60 * 60_000, capMs: 24 * 60 * 60_000, factor: 2 });
/** The first re-arm wait: how long a spent question stays quiet before its first re-arm call. */
export const SPENT_QUESTION_REARM_MS = SPENT_QUESTION_REARM.baseMs;

/**
 * The EM never answered this question: every call failed, and the wait since the last one (`SPENT_QUESTION_REARM`,
 * by calls made past the first burst) has passed. An accepted answer of any kind (even a decline) is not this. Pure.
 */
export function deliverySpent(entry: UnstickEntry, nowMs: number, maxAttempts = UNSTICK_MAX_ATTEMPTS): boolean {
  return entry.status === "failed" && entry.attempts >= maxAttempts
    && nowMs - Date.parse(entry.lastCallAt ?? entry.since) >= backoffDelay((entry.rearms ?? 0) + 1, SPENT_QUESTION_REARM);
}

/** Whether a candidate needs an EM call now, given what the table holds for it. Pure. */
export function needsCall(entry: UnstickEntry | undefined, c: UnstickCandidate, maxAttempts = UNSTICK_MAX_ATTEMPTS): boolean {
  return nextStep(entry, c, Date.now(), { maxAttempts, handoff: NO_HANDOFF_WATCH }) === "call";
}

/** How a standing question is followed up: the failure cap and the handoff watch (`backoff.handoff`). */
export interface UnstickPolicy {
  maxAttempts: number;
  handoff: BackoffWindow & { readonly maxRecalls: number };
}

const NO_HANDOFF_WATCH: UnstickPolicy["handoff"] = Object.freeze({ baseMs: 0, capMs: 0, factor: 1, maxRecalls: 0 });

/**
 * What the unstick stage does with a standing question this pass. Pure apart from `now` (epoch ms).
 *
 *  - `call`: ask the agent (again), including a question whose calls were all spent, one call at a time on the `SPENT_QUESTION_REARM` back-off.
 *  - `give-up`: a handoff was made `maxRecalls + 1` times and the issue never
 *    moved; tell the escalation owner, once.
 *  - `wait`: nothing to do yet.
 *
 * An `invoked` answer is a handoff, not a resolution: the seat that took it can
 * die (out of tokens, crashed) and leave the issue where it was. While the
 * question still stands, it is called again after `handoff` window n since the
 * last call. A refusal waits for its `waitUntil` and costs nothing.
 */
export function nextStep(entry: UnstickEntry | undefined, c: UnstickCandidate, now: number, policy: UnstickPolicy): "call" | "wait" | "give-up" {
  if (!entry || entry.reason !== c.reason) return "call";
  switch (entry.status) {
    case "pending": return "call";
    // Failed at the cap: no answer ever came, so it is asked afresh once the re-arm window has passed (every kind).
    // An answer of any kind (invoked, escalated, declined) is delivered and is never re-armed.
    case "failed": return entry.attempts < policy.maxAttempts || deliverySpent(entry, now, policy.maxAttempts) ? "call" : "wait";
    case "refused": return !entry.waitUntil || now >= Date.parse(entry.waitUntil) ? "call" : "wait";
    case "invoked": {
      const h = policy.handoff;
      if (h.maxRecalls <= 0 || entry.gaveUpAt || !entry.lastCallAt) return "wait";
      const recalls = entry.recalls ?? 0;
      if (now < Date.parse(entry.lastCallAt) + backoffDelay(recalls + 1, h)) return "wait";
      return recalls < h.maxRecalls ? "call" : "give-up";
    }
    default: return "wait"; // escalated / declined: a person or the EM owns it until the reason changes
  }
}

/** The comment posted once when a handoff was made again and again and the issue never moved. */
export function handoffGiveUpComment(owner: string, entry: Pick<UnstickEntry, "kind" | "reason" | "attempts" | "since" | "lastCallAt" | "detail">): string {
  return [
    "**Foreman: the EM took this hold but nothing moved**",
    "",
    `@${owner} — the EM said it acted ${entry.attempts} times since ${entry.since}, the last at ${entry.lastCallAt ?? "(unknown)"}, and the issue is still stuck for the same reason. The seat it handed to may have stopped (out of tokens, crashed, blocked). The Foreman will not call again unless the reason changes.`,
    "",
    `- Kind: \`${entry.kind}\``,
    `- Reason: ${entry.reason}`,
    "",
    "Last answer:",
    "",
    "```",
    (entry.detail ?? "(no detail)").slice(0, 800),
    "```",
  ].join("\n");
}

/** Record a fresh question (or keep the standing one if the reason is unchanged). */
export function openEntry(prior: UnstickEntry | undefined, c: UnstickCandidate, now: string): UnstickEntry {
  if (prior && prior.reason === c.reason) return prior;
  return { issue: c.issue, kind: c.kind, reason: c.reason, status: "pending", attempts: 0, since: now, ...(c.tag ? { tag: c.tag } : {}) };
}

/**
 * One alert to the EM, the only shape `EmHandoffs.raise` takes. The outbox owns what happens to it after that
 * (delivery, retry, re-arm, give-up: `nextStep`), so a sender states WHAT is wrong and never HOW it is delivered.
 */
export interface Alert {
  kind: UnstickKind;
  /** The issue the alert is about; 0 for a repo-level alert that belongs to no issue. */
  subject: number;
  /**
   * Names the question when its text is not its identity: one entry per (subject, kind, dedupeKey), kept as it is
   * whatever a later raise says (the text may carry a count that moves). "" = the reason is the identity, and a
   * different reason replaces the entry (a new question).
   */
  dedupeKey: string;
  reason: string;
}

const hash12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * An error the SRE saw during a verification and excluded as not caused by the
 * release (its `Not caused by this release, needs triage:` lines). Nothing read
 * those lines, so a real defect outside the PR went unowned: the dev Stripe key
 * expired 2026-10-23 and every dev check excluded it for 8 days (SRE#369, #148).
 *
 * The signature with its numbers and long hex folded, so one error seen with a
 * different id, count or timestamp is the same signature. Pure, exported for tests.
 */
export function unrelatedSignature(error: string): string {
  return error.trim().replace(/\s+/g, " ").replace(/\b[0-9a-f]{8,}\b/gi, "#").replace(/\d+/g, "#").slice(0, 300);
}

/** A handoff to the EM that could not be saved. Thrown, so the pass fails closed with the event that raised it still pending. */
export class HandoffNotSaved extends Error {
  constructor(readonly kind: string, repo: string) {
    super(`${repo}: the ${kind} hand-off to the EM could not be saved to the repo record; the event that raised it stays pending`);
    this.name = "HandoffNotSaved";
  }
}

/** The subject a hand-off and the transitions that wait on it share: the PR the SRE verified. */
export const handoffSubject = (githubRepo: string, pr: number): string => `${githubRepo}#${pr}`;

/** The unrelated errors a fresh SRE result reported, and where they were first seen. */
export interface FreshUnrelated {
  seen: { errors: readonly string[]; evidence: readonly string[] };
  seenOn: string;
}

/** `label` with every regex metacharacter escaped. */

/**
 * The epics an issue body names as `<label> #N` (config `epicRefLabel`, the
 * `## References` convention). No label = no epic parsing: always empty.
 */
export function epicRefs(body: string, label: string | undefined): number[] {
  if (!label) return [];
  const pattern = new RegExp(`\\b${escapeRegex(label)} #(\\d+)`, "gi");
  return [...new Set([...body.matchAll(pattern)].map((m) => Number(m[1])))];
}

/** The alert for one error the SRE excluded as not caused by the release it verified. Pure, exported for tests. */
export function unrelatedErrorAlert(error: string, seenOn: string, evidence: readonly string[]): Alert {
  const shown = evidence.length ? ` Evidence: ${evidence.slice(0, 4).join(" ")}` : "";
  return {
    kind: "unrelated-error", subject: 0, dedupeKey: hash12(unrelatedSignature(error)),
    reason: `The SRE excluded this error as not caused by the release it verified (first seen on ${seenOn}): ${error.trim().slice(0, 600)}.${shown}`,
  };
}

/**
 * foreman#230: the dependency sweep filed the same batch (same PRs, same head SHAs) as many times in 24 h as its
 * policy allows and is holding it. One alert per batch key; the EM decides why the batch keeps coming back (a
 * Dependabot PR left open after its version landed, a close that fails) and clears it.
 */
export function dependencyBatchLoopAlert(batchKey: string, filings: number): Alert {
  return {
    kind: "dependency-batch-loop", subject: 0, dedupeKey: hash12(batchKey),
    reason: `The dependency sweep filed the same batch (${batchKey}) ${filings} times in 24 hours and is now holding it: no further issue is filed for these PRs at these head commits. ` +
      "Each issue ended without a PR, so a Dependabot PR is probably still open after its version reached the base branch, and the Foreman's attempt to close it failed. " +
      "Find out why, close or fix the PR(s), and the hold ends by itself (a new Dependabot push is a new batch).",
  };
}

/**
 * foreman#151: a child closed in production may have been its epic's last, and closing a delivered epic is the EM's
 * hand-off to the PO that nothing else makes. One alert per epic and closed issue; the EM's READY TO CLOSE check
 * decides whether it was the last.
 */
export function epicChildClosedAlert(githubRepo: string, issue: number, epic: number, label: string): Alert {
  return {
    kind: "epic-ready-to-close", subject: 0, dedupeKey: `${epic}-${issue}`,
    reason: `${githubRepo}#${issue} was closed as completed after its production verification; it belongs to ${label} #${epic}. Close the epic if this was its last open child.`,
  };
}

/**
 * The outbox of what the Foreman tells the EM, written to the work source's records. `raise` is the one way an
 * alert enters it; the unstick stage reads the entries back and delivers them, and `nextStep` owns the delivery
 * policy for every kind.
 */
export class EmHandoffs {
  /**
   * Unrelated-error alerts the record has not taken yet, by subject (`owner/repo#PR`) and signature. IN MEMORY
   * ONLY, like the in-memory notes elsewhere: a durable fact persists through the work-source plugin, never a core state file
   * (EM#1244 decision 4). The SRE's report has no re-readable source, and a re-verification that comes back clean
   * would not repeat it, so the payload is held here until the record holds it.
   */
  private readonly pending = new Map<string, Map<string, Alert>>();

  constructor(private readonly records: IssueRecordStore) {}

  /**
   * Put `alert` in the outbox. Resolves true when it was new (or replaced a different question) and false when it
   * was already standing, so a sender may raise on every poll at no cost. Throws HandoffNotSaved when the record
   * cannot take it: the caller's pass fails closed with its trigger intact, and the next healthy pass raises it again.
   */
  raise(repoConfig: RepoConfig, alert: Alert): Promise<boolean> {
    return this.raiseAll(repoConfig, [alert]).then((n) => n > 0);
  }

  /** `raise` for alerts produced together: one record write per subject, all or none. Resolves how many were new. */
  async raiseAll(repoConfig: RepoConfig, alerts: readonly Alert[]): Promise<number> {
    const bySubject = new Map<number, Alert[]>();
    for (const a of alerts) (bySubject.get(a.subject) ?? bySubject.set(a.subject, []).get(a.subject)!).push(a);
    const now = new Date().toISOString();
    let added = 0;
    for (const [subject, group] of bySubject) {
      let fresh = 0;
      const change = (d: { unstick?: Record<string, UnstickEntry> }): void => {
        const table = { ...(d.unstick ?? {}) };
        fresh = 0;
        for (const a of group) {
          const key = unstickKey(subject, a.kind, a.dedupeKey || undefined);
          const standing = table[key];
          if (standing && a.dedupeKey) continue; // named question: kept as it is
          const next = openEntry(standing, { issue: subject, kind: a.kind, reason: a.reason, ...(a.dedupeKey ? { tag: a.dedupeKey } : {}) }, now);
          if (next === standing) continue;
          table[key] = next;
          fresh++;
        }
        if (fresh > 0) d.unstick = table;
      };
      const ok = subject <= 0
        ? await this.records.updateRepoRecord(repoConfig, change)
        : await this.records.updateIssueRecord(repoConfig, subject, change);
      if (!ok) throw new HandoffNotSaved(group[0]!.kind, repoConfig.githubRepo);
      added += fresh;
    }
    return added;
  }

  /** An event reported work stuck: remember it for the stage's next pass. Resolves false when it could not be recorded. */
  async noteStuck(repoConfig: RepoConfig, issue: number, kind: UnstickKind, reason: string): Promise<boolean> {
    try {
      await this.raise(repoConfig, { kind, subject: issue, dedupeKey: "", reason });
      return true;
    } catch (err) {
      if (err instanceof HandoffNotSaved) return false;
      throw err;
    }
  }

  /** The block on `issue` was released (`unblocked`): its questions are over. */
  async clearUnstick(repoConfig: RepoConfig, issue: number): Promise<boolean> {
    if (issue <= 0) return true;
    return this.records.updateIssueRecord(repoConfig, issue, (d) => { delete d.unstick; });
  }

  /**
   * THE gate every lifecycle transition for `subject` (verify advance, merged/held settle, prodReverified, the
   * deploy-recovery verify, the soak drop) passes through first, and the one entry for "this result's reports". Order,
   * always: (1) buffer the fresh result's unrelated errors into the subject's pending set (deduped by signature), THEN
   * (2) drain the set to the repo's EM triage record. So a report B that arrives while an earlier report A is still
   * unsaved is kept even though the drain throws. Throws HandoffNotSaved when the record cannot take them, so the
   * transition does not happen this pass whatever the new verification says. A pending report and a recurring one
   * save once. Resolves how many were new.
   */
  async settleHandoffs(repoConfig: RepoConfig, subject: string, fresh?: FreshUnrelated): Promise<number> {
    if (fresh) {
      const held = this.pending.get(subject) ?? this.pending.set(subject, new Map()).get(subject)!;
      for (const error of fresh.seen.errors) {
        const alert = unrelatedErrorAlert(error, fresh.seenOn, fresh.seen.evidence);
        if (!held.has(alert.dedupeKey)) held.set(alert.dedupeKey, alert);
      }
    }
    const held = this.pending.get(subject);
    if (!held || held.size === 0) return 0;
    const added = await this.raiseAll(repoConfig, [...held.values()]);
    this.pending.delete(subject);
    return added;
  }
}
