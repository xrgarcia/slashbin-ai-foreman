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
] as const;
export type UnstickKind = (typeof UNSTICK_KINDS)[number];

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
  /** ISO time the handoff watch gave up with nobody to tell: it does not give up again. */
  gaveUpAt?: string;
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
  "needs-ruling", "dead-zone", "revision-exhausted", "revision-stalemate", "verify-held", "unrelated-error", "epic-ready-to-close",
]);

/** The reason the release-gate call carries: stable, so one `pr approved` costs one call. */
export const RELEASE_GATE_REASON = "at `pr approved` — dev verification passed, awaiting the EM outcome gate (`ready for prod release`)";

/** The label that carries the production grant (Ray's). The EM's gate decides; the Foreman only watches for it. */
export const GRANT_LABEL = "deliver-to-prod";
/** How deep a "— follow-up to #N" chain is followed, as the EM's own resolver (epic_grant.py `missing_grant`). */
export const GRANT_FOLLOW_UP_DEPTH = 3;

const REFERENCES = /^##\s+References\b.*?$(.*?)(?=^##\s|$(?![\s\S]))/ims;
const RELATED_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*Related\b/i;

/**
 * Each EM issue (`owner/repo#N`) a body names inside its `## References` section, sorted. A reference is
 * `<label> #N`, `<repo-name>#N` or `<owner>/<repo-name>#N`, where `emRepo` is `owner/repo-name` and `label` is the
 * config's `epicRefLabel` (the repo name, less any prefix). A line labelled `Related` is a cross-reference, not
 * membership, and is skipped. Mirrors epic_grant.py `referenced_issues`.
 */
export function referencedEmIssues(body: string, emRepo: string, label: string): string[] {
  const m = REFERENCES.exec(body ?? "");
  if (!m) return [];
  const [owner, name] = emRepo.split("/") as [string, string];
    const prefix = name.endsWith(label) ? name.slice(0, name.length - label.length) : "";
  const ref = new RegExp(`(?:([\\w.-]+)/)?(?:${escapeRegex(prefix)})?${escapeRegex(label)}\\s*#(\\d+)`, "gi");
  const text = (m[1] ?? "").split("\n").filter((ln) => !RELATED_LINE.test(ln)).join("\n");
  const found = new Set<string>();
  for (const r of text.matchAll(ref)) found.add(`${r[1] || owner}/${name}#${Number(r[2])}`);
  return [...found].sort();
}

/** Every issue a title says it follows up ("— follow-up to #N"), in order. The one parser for that phrase. */
export function followUpTargets(title: string): number[] {
  return [...(title ?? "").matchAll(/follow-up to #(\d+)/gi)].map((m) => Number(m[1]));
}

/** The first issue a title follows up, else null. */
export function followUpOrigin(title: string): number | null {
  return followUpTargets(title)[0] ?? null;
}

/**
 * Whether each place the EM's gate looks for a grant carries `deliver-to-prod`: `owner/repo#N` -> true / false,
 * or null when that place could not be read.
 */
export type GrantState = Readonly<Record<string, boolean | null>>;

/** The grant part of the reason: `[grant: a/b#1=no, a/b#2=yes]`, sorted; `?` for an unreadable place. Empty when there is none. */
export function grantFingerprint(grants: GrantState | undefined): string {
  const keys = Object.keys(grants ?? {}).sort();
  if (!keys.length) return "";
  return ` [grant: ${keys.map((k) => `${k}=${grants![k] === null ? "?" : grants![k] ? "yes" : "no"}`).join(", ")}]`;
}

/**
 * The release-gate reason for one issue: the stable text plus the issue's labels (sorted) plus the grant state
 * of every place the EM's gate looks (the issue, the epics its `## References` name, its sub-issue parent, and
 * the issue it follows up). A grant landing anywhere changes the reason, so `nextStep` calls the EM again and
 * the EM's answered-marker no longer matches. The Foreman does not decide whether the release may go: the
 * fingerprint only has to change when the answer could. Without it, a grant given after the first call was never
 * gated (jerky_ops#201/#198, jerky_public_api#181, 2026-11-05), and a grant on the EPIC never changed the child's
 * labels at all (PR #222 review, S2).
 */
export function releaseGateReason(labels: readonly string[], grants?: GrantState): string {
  const set = [...new Set(labels)].sort();
  return (set.length ? `${RELEASE_GATE_REASON} [labels: ${set.join(", ")}]` : RELEASE_GATE_REASON) + grantFingerprint(grants);
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
 *  - `call`: ask the agent (again).
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
    case "failed": return entry.attempts < policy.maxAttempts ? "call" : "wait";
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

/**
 * What the Foreman asks the EM, written to the work source's records: the questions events raise (`noteStuck`)
 * and the repo-level hand-offs (unrelated errors, epics ready to close).
 */
export class EmHandoffs {
  /**
   * Unrelated-error hand-offs the record has not taken yet, by subject (`owner/repo#PR`) and signature tag. IN MEMORY
   * ONLY, like the in-memory notes elsewhere: a durable fact persists through the work-source plugin, never a core state file
   * (EM#1244 decision 4). The SRE's report has no re-readable source, and a re-verification that comes back clean
   * would not repeat it, so the payload is held here until the record holds it.
   */
  private readonly pending = new Map<string, Map<string, { tag: string; reason: string }>>();

  constructor(private readonly records: IssueRecordStore) {}

  /** An event reported work stuck: remember it for the stage's next pass. Resolves false when it could not be recorded. */
  async noteStuck(repoConfig: RepoConfig, issue: number, kind: UnstickKind, reason: string): Promise<boolean> {
    const key = unstickKey(issue, kind);
    const now = new Date().toISOString();
    if (issue <= 0) {
      return this.records.updateRepoRecord(repoConfig, (d) => {
        const table = { ...(d.unstick ?? {}) };
        const next = openEntry(table[key], { issue, kind, reason }, now);
        if (next === table[key]) return;
        table[key] = next;
        d.unstick = table;
      });
    }
    return this.records.updateIssueRecord(repoConfig, issue, (d) => {
      const table = { ...(d.unstick ?? {}) };
      const next = openEntry(table[key], { issue, kind, reason }, now);
      if (next === table[key]) return;
      table[key] = next;
      d.unstick = table;
    });
  }

  /** The block on `issue` was released (`unblocked`): its questions are over. */
  async clearUnstick(repoConfig: RepoConfig, issue: number): Promise<boolean> {
    if (issue <= 0) return true;
    return this.records.updateIssueRecord(repoConfig, issue, (d) => { delete d.unstick; });
  }

  /**
   * The one way a repo-level hand-off to the EM is raised (unrelated-error, epic-ready-to-close): written to the
   * repo record, and only then may the event that raised it be acknowledged. `entries` are the hand-offs the event
   * produced; one already in the record is kept as it is. Resolves how many were new, and throws HandoffNotSaved
   * when the record is unavailable or the save fails, so the caller's pass fails closed with its trigger (the
   * verdict still to be acted on, the issue still open) intact and the next healthy pass raises it again.
   */
  private async persist(
    repoConfig: RepoConfig,
    kind: "unrelated-error" | "epic-ready-to-close",
    entries: readonly { tag: string; reason: string }[],
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const now = new Date().toISOString();
    let added = 0;
    const ok = await this.records.updateRepoRecord(repoConfig, (d) => {
      const table = { ...(d.unstick ?? {}) };
      added = 0;
      for (const { tag, reason } of entries) {
        const key = unstickKey(0, kind, tag);
        if (table[key]) continue;
        table[key] = openEntry(undefined, { issue: 0, kind, reason, tag }, now);
        added++;
      }
      if (added > 0) d.unstick = table;
    });
    if (!ok) throw new HandoffNotSaved(kind, repoConfig.githubRepo);
    return added;
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
      const evidence = fresh.seen.evidence.length ? ` Evidence: ${fresh.seen.evidence.slice(0, 4).join(" ")}` : "";
      const held = this.pending.get(subject) ?? this.pending.set(subject, new Map()).get(subject)!;
      for (const error of fresh.seen.errors) {
        const tag = createHash("sha256").update(unrelatedSignature(error)).digest("hex").slice(0, 12);
        if (!held.has(tag)) held.set(tag, { tag, reason: `The SRE excluded this error as not caused by the release it verified (first seen on ${fresh.seenOn}): ${error.trim().slice(0, 600)}.${evidence}` });
      }
    }
    const held = this.pending.get(subject);
    if (!held || held.size === 0) return 0;
    const added = await this.persist(repoConfig, "unrelated-error", [...held.values()]);
    this.pending.delete(subject);
    return added;
  }

  /** `settleHandoffs` with this result's reports: buffered first, then drained (see there). Returns how many were new. */
  noteUnrelated(repoConfig: RepoConfig, seen: FreshUnrelated["seen"], seenOn: string, subject: string): Promise<number> {
    return this.settleHandoffs(repoConfig, subject, { seen, seenOn });
  }

  /**
   * foreman#151: a child closed in production may have been its epic's last, and
   * closing a delivered epic is the EM's hand-off to the PO that nothing else makes.
   * Raise `epic-ready-to-close` once per epic and closed issue; the EM's READY TO
   * CLOSE check decides whether it was the last. Returns the entries added.
   */
  async noteEpicChildClosed(repoConfig: RepoConfig, issue: number, epics: readonly number[], label: string): Promise<number> {
    return this.persist(repoConfig, "epic-ready-to-close", epics.map((epic) => ({
      tag: `${epic}-${issue}`,
      reason: `${repoConfig.githubRepo}#${issue} was closed as completed after its production verification; it belongs to ${label} #${epic}. Close the epic if this was its last open child.`,
    })));
  }
}
