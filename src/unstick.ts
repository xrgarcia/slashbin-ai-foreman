// The unstick stage's data: what "stuck" means, and the table that remembers
// what was asked of the EM (foreman#103).
//
// The Foreman calls the Tech Lead and the SRE directly, but used to show stuck
// work to the EM only as a Paperclip card, so with Paperclip off a stuck issue
// reached no one. The unstick stage (src/phases/unstick.ts) runs
// `<emRepoPath>/bin/em.mjs unstick --repo <owner/name> --issue <N> --kind <kind>
// --reason <text>` for each stuck issue and records the outcome here.
//
// Two sources feed one table, `RepoState.unstick`, keyed `<issue>:<kind>`:
//  - DERIVED kinds are read off persisted state every pass (`derivedCandidates`):
//    nothing relies on an event having fired, so a hold whose event came and
//    went before a restart (cmneb_hr#38, 2026-10-20) is still found. Their
//    entries live while the condition does.
//  - EVENT kinds have no persisted condition to read (revision and ruling
//    stops are in memory), so the `blocked` / `escalated` event carries a
//    `stuck` kind and `noteStuck` records it. Those entries live until an
//    `unblocked` event, the issue closing, or a new reason replaces them.

import { createHash } from "node:crypto";
import { loadRepoState, saveRepoState, type BranchBlock, type RepoState, type VerifyHold } from "./state.js";
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
 * Divergence is repo-level (`state.branchBlock`), not per issue. It is called
 * once for each issue the Foreman announced it on, so the EM sees a real issue;
 * with none announced, once for issue 0 (the repo). The kind and reason are
 * identical either way, so one episode is one question per issue.
 */
export function derivedCandidates(
  state: Pick<RepoState, "verifyHeld" | "skipped" | "branchBlock">,
  opts: {
    verifyMaxAttempts: number;
    isDeployFailureHold: (reason: string) => boolean;
    /** Worded by the caller (phases/common.ts), which this module may not import: it would be a cycle through work-source. */
    divergenceReason: (block: BranchBlock) => string;
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
  const b = state.branchBlock;
  if (b) {
    const reason = opts.divergenceReason(b);
    const issues = b.announced.length > 0 ? b.announced : [0];
    for (const issue of issues) out.push({ issue, kind: "divergence", reason });
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

/** An event reported work stuck: remember it for the stage's next pass. */
export function noteStuck(repoName: string, issue: number, kind: UnstickKind, reason: string): void {
  const state = loadRepoState(repoName);
  const table = { ...(state.unstick ?? {}) };
  const key = unstickKey(issue, kind);
  const next = openEntry(table[key], { issue, kind, reason }, new Date().toISOString());
  if (next === table[key]) return;
  table[key] = next;
  saveRepoState(repoName, { ...state, unstick: table });
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

/**
 * Raise `unrelated-error` once per distinct signature per repo, with the PR and the SRE's evidence links, never again for
 * a signature it has already raised, from any PR. Repo-level (issue 0), so it
 * outlives the issue it was seen on and never holds a release. Returns how many
 * were new.
 */
export function noteUnrelated(repoName: string, seen: { errors: readonly string[]; evidence: readonly string[] }, seenOn: string): number {
  const state = loadRepoState(repoName);
  const table = { ...(state.unstick ?? {}) };
  const now = new Date().toISOString();
  let added = 0;
  const evidence = seen.evidence.length ? ` Evidence: ${seen.evidence.slice(0, 4).join(" ")}` : "";
  for (const error of seen.errors) {
    const tag = createHash("sha256").update(unrelatedSignature(error)).digest("hex").slice(0, 12);
    const key = unstickKey(0, "unrelated-error", tag);
    if (table[key]) continue;
    const reason = `The SRE excluded this error as not caused by the release it verified (first seen on ${seenOn}): ${error.trim().slice(0, 600)}.${evidence}`;
    table[key] = openEntry(undefined, { issue: 0, kind: "unrelated-error", reason, tag }, now);
    added++;
  }
  if (added > 0) saveRepoState(repoName, { ...state, unstick: table });
  return added;
}

/** The block on `issue` was released (`unblocked`): its questions are over. */
export function clearUnstick(repoName: string, issue: number): void {
  const state = loadRepoState(repoName);
  const table = state.unstick;
  if (!table) return;
  const keep = Object.fromEntries(Object.entries(table).filter(([, e]) => e.issue !== issue));
  if (Object.keys(keep).length === Object.keys(table).length) return;
  saveRepoState(repoName, { ...state, unstick: keep });
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
export function noteEpicChildClosed(repoName: string, githubRepo: string, issue: number, epics: readonly number[], label: string): number {
  const state = loadRepoState(repoName);
  const table = { ...(state.unstick ?? {}) };
  const now = new Date().toISOString();
  let added = 0;
  for (const epic of epics) {
    const tag = `${epic}-${issue}`;
    const key = unstickKey(0, "epic-ready-to-close", tag);
    if (table[key]) continue;
    const reason = `${githubRepo}#${issue} was closed as completed after its production verification; it belongs to ${label} #${epic}. Close the epic if this was its last open child.`;
    table[key] = openEntry(undefined, { issue: 0, kind: "epic-ready-to-close", reason, tag }, now);
    added++;
  }
  if (added > 0) saveRepoState(repoName, { ...state, unstick: table });
  return added;
}
