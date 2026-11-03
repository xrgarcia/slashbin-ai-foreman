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
import type { RepoConfig } from "./config.js";
import { updateIssueRecord, updateRepoRecord, type SkippedIssue, type VerifyHold } from "./issue-records.js";
import { codeHost } from "./plugins/registry.js";

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

/** `pending` not yet called · `invoked` EM exit 0 · `escalated` exit 2 · `declined` exit 3 · `failed` anything else. */
export type UnstickStatus = "pending" | "invoked" | "escalated" | "declined" | "failed";

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
export const EVENT_KINDS: ReadonlySet<UnstickKind> = new Set<UnstickKind>([
  "needs-ruling", "dead-zone", "revision-exhausted", "revision-stalemate", "verify-held", "unrelated-error", "epic-ready-to-close",
]);

/** The reason the release-gate call carries: stable, so one `pr approved` costs one call. */
export const RELEASE_GATE_REASON = "at `pr approved` — dev verification passed, awaiting the EM outcome gate (`ready for prod release`)";

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
 * Divergence is repo-level (derived from git, divergence.ts), not per issue. It is called
 * once for each issue the Foreman announced it on, so the EM sees a real issue;
 * with none announced, once for issue 0 (the repo). The kind and reason are
 * identical either way, so one episode is one question per issue.
 */
export function derivedCandidates(
  state: {
    /** The holds and skips of the issues read this pass, by issue number. */
    verifyHeld?: Readonly<Record<number, VerifyHold>>;
    skipped?: Readonly<Record<number, SkippedIssue>>;
    /** The divergence standing on the repo: its one-line reason (worded by phases/common.ts, which this module may not import: it would be a cycle through work-source) and the issues told about it. */
    divergence?: { reason: string; announced: readonly number[] };
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
  const d = state.divergence;
  if (d) {
    const issues = d.announced.length > 0 ? d.announced : [0];
    for (const issue of issues) out.push({ issue, kind: "divergence", reason: d.reason });
  }
  return out;
}

/** Whether a candidate needs an EM call now, given what the table holds for it. Pure. */
export function needsCall(entry: UnstickEntry | undefined, c: UnstickCandidate, maxAttempts = UNSTICK_MAX_ATTEMPTS): boolean {
  if (!entry || entry.reason !== c.reason) return true;
  switch (entry.status) {
    case "pending": return true;
    case "failed": return entry.attempts < maxAttempts;
    default: return false; // invoked / escalated / declined: wait for the reason to change
  }
}

/** Record a fresh question (or keep the standing one if the reason is unchanged). */
export function openEntry(prior: UnstickEntry | undefined, c: UnstickCandidate, now: string): UnstickEntry {
  if (prior && prior.reason === c.reason) return prior;
  return { issue: c.issue, kind: c.kind, reason: c.reason, status: "pending", attempts: 0, since: now, ...(c.tag ? { tag: c.tag } : {}) };
}

/** An event reported work stuck: remember it for the stage's next pass. Resolves false when it could not be recorded. */
export async function noteStuck(repoConfig: RepoConfig, issue: number, kind: UnstickKind, reason: string): Promise<boolean> {
  const key = unstickKey(issue, kind);
  const now = new Date().toISOString();
  if (issue <= 0) {
    return updateRepoRecord(repoConfig, (d) => {
      const table = { ...(d.unstick ?? {}) };
      const next = openEntry(table[key], { issue, kind, reason }, now);
      if (next === table[key]) return;
      table[key] = next;
      d.unstick = table;
    });
  }
  return updateIssueRecord(repoConfig, issue, (d) => {
    const table = { ...(d.unstick ?? {}) };
    const next = openEntry(table[key], { issue, kind, reason }, now);
    if (next === table[key]) return;
    table[key] = next;
    d.unstick = table;
  });
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

/**
 * The one way a repo-level hand-off to the EM is raised (unrelated-error, epic-ready-to-close): written to the
 * repo record, and only then may the event that raised it be acknowledged. `entries` are the hand-offs the event
 * produced; one already in the record is kept as it is. Resolves how many were new, and throws HandoffNotSaved
 * when the record is unavailable or the save fails, so the caller's pass fails closed with its trigger (the
 * verdict still to be acted on, the issue still open) intact and the next healthy pass raises it again.
 */
async function persistHandoffs(
  repoConfig: RepoConfig,
  kind: "unrelated-error" | "epic-ready-to-close",
  entries: readonly { tag: string; reason: string }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const now = new Date().toISOString();
  let added = 0;
  const ok = await updateRepoRecord(repoConfig, (d) => {
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
 * Unrelated-error hand-offs the record has not taken yet, by subject (`owner/repo#PR`) and signature tag. IN MEMORY
 * ONLY, like the in-memory notes elsewhere: a durable fact persists through the work-source plugin, never a core state file
 * (EM#1244 decision 4). The SRE's report has no re-readable source, and a re-verification that comes back clean
 * would not repeat it, so the payload is held here until the record holds it.
 */
const pendingHandoffs = new Map<string, Map<string, { tag: string; reason: string }>>();

/** The subject a hand-off and the transitions that wait on it share: the PR the SRE verified. */
export const handoffSubject = (githubRepo: string, pr: number): string => `${githubRepo}#${pr}`;

/**
 * THE gate every lifecycle transition for `subject` (verify advance, merged/held settle, prodReverified, the
 * deploy-recovery verify, the soak drop) passes through first: drain the subject's pending hand-offs to the repo's
 * EM triage record. Throws HandoffNotSaved when the record cannot take them, so the transition does not happen this
 * pass whatever the new verification says. One entry per signature: a pending report and a recurring one save once.
 * Resolves how many were new.
 */
export async function settleHandoffs(repoConfig: RepoConfig, subject: string): Promise<number> {
  const held = pendingHandoffs.get(subject);
  if (!held || held.size === 0) return 0;
  const added = await persistHandoffs(repoConfig, "unrelated-error", [...held.values()]);
  pendingHandoffs.delete(subject);
  return added;
}

/** Tests only. */
export function resetPendingHandoffsForTests(): void {
  pendingHandoffs.clear();
}

/**
 * Raise `unrelated-error` once per distinct signature per repo, with the PR and the SRE's evidence links, never again for
 * a signature it has already raised, from any PR. Repo-level (issue 0), so it outlives the issue it was seen on and
 * never holds a release. The report is held in memory under `subject` first (see pendingHandoffs) and then drained, so
 * a failed save leaves the original payload pending for the gate (settleHandoffs) and the pass fails closed with
 * HandoffNotSaved. Returns how many were new.
 */
export async function noteUnrelated(
  repoConfig: RepoConfig,
  seen: { errors: readonly string[]; evidence: readonly string[] },
  seenOn: string,
  subject: string,
): Promise<number> {
  const evidence = seen.evidence.length ? ` Evidence: ${seen.evidence.slice(0, 4).join(" ")}` : "";
  const held = pendingHandoffs.get(subject) ?? pendingHandoffs.set(subject, new Map()).get(subject)!;
  for (const error of seen.errors) {
    const tag = createHash("sha256").update(unrelatedSignature(error)).digest("hex").slice(0, 12);
    if (!held.has(tag)) held.set(tag, { tag, reason: `The SRE excluded this error as not caused by the release it verified (first seen on ${seenOn}): ${error.trim().slice(0, 600)}.${evidence}` });
  }
  return settleHandoffs(repoConfig, subject);
}

/** The block on `issue` was released (`unblocked`): its questions are over. */
export async function clearUnstick(repoConfig: RepoConfig, issue: number): Promise<boolean> {
  if (issue <= 0) return true;
  return updateIssueRecord(repoConfig, issue, (d) => { delete d.unstick; });
}

/** `label` with every regex metacharacter escaped. */
const escapeRegex = (label: string) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
 * foreman#151: a child closed in production may have been its epic's last, and
 * closing a delivered epic is the EM's hand-off to the PO that nothing else makes.
 * Raise `epic-ready-to-close` once per epic and closed issue; the EM's READY TO
 * CLOSE check decides whether it was the last. Returns the entries added.
 */
export async function noteEpicChildClosed(repoConfig: RepoConfig, issue: number, epics: readonly number[], label: string): Promise<number> {
  return persistHandoffs(repoConfig, "epic-ready-to-close", epics.map((epic) => ({
    tag: `${epic}-${issue}`,
    reason: `${repoConfig.githubRepo}#${issue} was closed as completed after its production verification; it belongs to ${label} #${epic}. Close the epic if this was its last open child.`,
  })));
}
