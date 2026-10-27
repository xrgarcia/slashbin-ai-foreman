// A skipped issue is held, not retried on a timer: the reads that decide when
// it may run again. Each one is a cheap gh call, never an agent session.
//
// Origin: jerky_service#127 (2026-10-14). The session skipped it about ten times
// in a day for the same unmet precondition — a file on another repo's unmerged
// PR — because the skip back-off only hid it for a window (5 min rising to 4 h)
// and every expiry bought a full session to rediscover the same answer. A held
// issue runs again only when something it waits on actually moves.

import { gh } from "./gh.js";

/** What a skip says it waits on: another issue or PR, by structured reference. */
export interface WaitingOn {
  repo: string;
  number: number;
}

/** Where a waited-on reference stands: open or done, and whether it is a PR. */
export interface RefState {
  open: boolean;
  isPr: boolean;
  merged: boolean;
}

/**
 * Parse `owner/repo#N` or `#N` (same repo as `repo`). Anything else is not a
 * reference: undefined, never a guess.
 */
export function parseWaitingOn(raw: string | undefined, repo: string): WaitingOn | undefined {
  const m = raw?.trim().match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
  return m ? { repo: m[1] ?? repo, number: Number(m[2]) } : undefined;
}

/** `#166`, `jerky_com_marketing#166` for a sibling repo, `owner/repo#166` elsewhere. */
export function waitingOnLabel(ref: WaitingOn, repo: string): string {
  if (ref.repo === repo) return `#${ref.number}`;
  const [owner, name] = ref.repo.split("/");
  return owner === repo.split("/")[0] ? `${name}#${ref.number}` : `${ref.repo}#${ref.number}`;
}

/**
 * The blocked reason a held issue carries on the card and the issue: what it is
 * held for, and what releases it. A PR closed unmerged releases it too; the
 * text names the expected way out.
 */
export function heldReason(reason: string, repo: string, ref?: WaitingOn, refIsPr?: boolean): string {
  const first = reason.split("\n")[0];
  const until = ref
    ? `held until ${waitingOnLabel(ref, repo)} ${refIsPr ? "merges" : "closes"} or this issue changes`
    : `held until this issue changes`;
  return `${first} — ${until}`;
}

/** The reference's state: one read. Throws on a gh failure. */
export function refState(ref: WaitingOn, cwd: string): RefState {
  const raw = gh(["api", `repos/${ref.repo}/issues/${ref.number}`, "--jq", "{state, pr: (.pull_request != null), merged: (.pull_request.merged_at != null)}"], cwd);
  const s = JSON.parse(raw) as { state: string; pr: boolean; merged: boolean };
  return { open: s.state !== "closed", isPr: s.pr, merged: s.merged };
}

/** One change on the issue: when, by whom, and what kind (absent reads as an action). */
export interface IssueActivity {
  at: string;
  login?: string;
  kind?: "edit" | "comment" | "event";
  /** A comment opening `**EM unstick`: the EM's note from an unstick call. It is talk about the hold, never a change to the issue. */
  emUnstick?: boolean;
}

/** The opening of the one comment every `bin/em.mjs unstick` call leaves (foreman#103). */
export const EM_UNSTICK_MARKER = "**EM unstick";

/** True when `body` is the EM's unstick comment. */
export function isEmUnstickComment(body: string | null | undefined): boolean {
  return typeof body === "string" && body.trimStart().startsWith(EM_UNSTICK_MARKER);
}

/**
 * Whether anyone but `self` changed the issue after `since`: an edit to its
 * body or title, a comment, a label added or removed, a reopen. The Foreman's
 * own writes (its skip comment, its labels) never count, or a hold would
 * release itself. Nor does the EM's `**EM unstick` comment: it answers the
 * hold, and counting it would release a skip and loop the build.
 */
export function changedSince(activity: IssueActivity[], since: string, self: string | undefined): boolean {
  const t = new Date(since).getTime();
  if (Number.isNaN(t)) return true;
  const me = self?.toLowerCase();
  return activity.some((a) => !a.emUnstick && new Date(a.at).getTime() > t && (!me || a.login?.toLowerCase() !== me));
}

/**
 * Who changed an escalated issue after `since`, for the cap: `person` for
 * anyone not the Foreman and not one of `agents`; `agent` for an agent's edit
 * or label, never its comment. An agent's comment is talk, not an action: two
 * agents answering each other's "still held" would otherwise restart the count
 * forever. Undefined when nothing counts.
 */
export function escalatedChangeBy(activity: IssueActivity[], since: string, self: string | undefined, agents: readonly string[] = []): "person" | "agent" | undefined {
  const t = new Date(since).getTime();
  if (Number.isNaN(t)) return "person";
  const me = self?.toLowerCase();
  const bots = new Set(agents.map((a) => a.toLowerCase()));
  let by: "agent" | undefined;
  for (const a of activity) {
    const login = a.login?.toLowerCase();
    if (a.emUnstick || new Date(a.at).getTime() <= t || (me && login === me)) continue;
    if (!login || !bots.has(login)) return "person";
    if (a.kind !== "comment") by = "agent";
  }
  return by;
}

const ACTIVITY_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){
updatedAt
userContentEdits(last:10){nodes{editedAt editor{login}}}
comments(last:20){nodes{createdAt author{login} body}}
timelineItems(last:20,itemTypes:[LABELED_EVENT,UNLABELED_EVENT,RENAMED_TITLE_EVENT,REOPENED_EVENT]){nodes{
... on LabeledEvent{createdAt actor{login}}
... on UnlabeledEvent{createdAt actor{login}}
... on RenamedTitleEvent{createdAt actor{login}}
... on ReopenedEvent{createdAt actor{login}}}}}}}`;

type Node = { body?: string; createdAt?: string; editedAt?: string; author?: { login?: string } | null; editor?: { login?: string } | null; actor?: { login?: string } | null };

/**
 * The issue's recent changes, newest window only. One read, plus none at all
 * when the issue has not been touched since `since`. Throws on a gh failure.
 */
export function issueActivitySince(repo: string, issue: number, since: string, cwd: string): IssueActivity[] {
  const updated = gh(["api", `repos/${repo}/issues/${issue}`, "--jq", ".updated_at"], cwd);
  if (new Date(updated).getTime() <= new Date(since).getTime()) return [];
  const [o, r] = repo.split("/");
  const raw = gh(["api", "graphql", "-f", `query=${ACTIVITY_QUERY}`, "-F", `o=${o}`, "-F", `r=${r}`, "-F", `n=${issue}`], cwd);
  const i = JSON.parse(raw)?.data?.repository?.issue;
  if (!i) return [];
  const nodes = (x: { nodes?: Node[] } | undefined) => x?.nodes ?? [];
  return [
    ...nodes(i.userContentEdits).map((e) => ({ at: e.editedAt ?? "", login: e.editor?.login, kind: "edit" as const })),
    ...nodes(i.comments).map((c) => ({ at: c.createdAt ?? "", login: c.author?.login, kind: "comment" as const, ...(isEmUnstickComment(c.body) ? { emUnstick: true } : {}) })),
    ...nodes(i.timelineItems).filter((e) => e.createdAt).map((e) => ({ at: e.createdAt!, login: e.actor?.login, kind: "event" as const })),
  ];
}

let selfLogin: string | undefined;
/** The login the Foreman's token acts as, read once. Undefined when the read fails. */
export function foremanLogin(cwd: string): string | undefined {
  if (selfLogin) return selfLogin;
  try {
    selfLogin = gh(["api", "user", "--jq", ".login"], cwd) || undefined;
  } catch {
    return undefined;
  }
  return selfLogin;
}

/** The reads a hold decision makes, injectable so the decision is testable without GitHub. */
export interface HoldReads {
  /** The waited-on reference's state. Throws when GitHub cannot say. */
  refState(ref: WaitingOn): RefState;
  /** The issue's changes after `since`. Throws when GitHub cannot say. */
  activitySince(since: string): IssueActivity[];
  /** The Foreman's own login; its writes never release a hold. */
  self: string | undefined;
  /** Other agents' logins (`backoff.skip.agentLogins`); their comments never release an escalated hold. */
  agents?: readonly string[];
}

/** Whether a held issue stays held, and if not, what released it. */
export type HoldStatus =
  | { held: true; ref?: WaitingOn; refIsPr?: boolean }
  | { held: false; releasedBy: "waitedOnDone" | "issueChanged"; ref?: WaitingOn };

/**
 * Decide one held issue: released when the issue or PR it waits on has closed
 * or merged, or when anyone but the Foreman changed the issue after the skip.
 * A read that fails keeps the hold — unknown never releases — and is passed to
 * `onError` for the log.
 */
export function holdStatus(
  entry: { lastSkippedAt: string; waitingOn?: string },
  repo: string,
  reads: HoldReads,
  onError: (what: string, err: unknown) => void = () => {},
): HoldStatus {
  const ref = parseWaitingOn(entry.waitingOn, repo);
  let refIsPr: boolean | undefined;
  if (ref) {
    try {
      const s = reads.refState(ref);
      if (!s.open) return { held: false, releasedBy: "waitedOnDone", ref };
      refIsPr = s.isPr;
    } catch (err) {
      onError(`state of ${ref.repo}#${ref.number}`, err);
    }
  }
  try {
    if (changedSince(reads.activitySince(entry.lastSkippedAt), entry.lastSkippedAt, reads.self)) {
      return { held: false, releasedBy: "issueChanged", ref };
    }
  } catch (err) {
    onError("issue activity", err);
  }
  return { held: true, ref, refIsPr };
}

/**
 * The reason an escalated skip carries: why it stopped, how many sessions it
 * took, and the one thing that releases it now.
 */
export function escalatedReason(reason: string, attempts: number): string {
  return `${reason.split("\n")[0]} — skipped ${attempts} times in a row; held for the EM until a person changes this issue (an agent's edit or label buys one session; its comment releases nothing)`;
}

/** What a held skip entry carries into the decision. */
export interface HeldEntry {
  lastSkippedAt: string;
  reason: string;
  skipCount?: number;
  waitingOn?: string;
  releasedAt?: string;
  escalatedAt?: string;
}

/** Whether a held skip runs a session this cycle. */
export type SkipGate =
  /**
   * Run it. `by` is the check that released it this cycle (absent: released
   * on an earlier one, so nothing new to announce). `reset` clears the entry,
   * attempt count included; otherwise the entry stays, marked released.
   */
  | { run: true; by?: "transientCauseGone" | "waitedOnDone" | "issueChanged"; reset: boolean }
  /** Hold it, with the reason the card shows; `escalate` the first time it is out of attempts. */
  | { run: false; reason: string; escalate: boolean };

/**
 * Decide one skipped issue under `backoff.skip.hold`. Under the cap, any cheap
 * release (`transientCleared`, the waited-on reference done, the issue changed)
 * buys one session and keeps the count. At the cap the issue is escalated: a
 * person changing the issue releases it with the count reset; an agent's edit
 * or label buys one session and keeps the count, so the next skip escalates
 * again; an agent's comment releases nothing. The transient and reference
 * checks no longer run.
 */
export function skipGate(
  entry: HeldEntry,
  repo: string,
  maxAttempts: number,
  reads: HoldReads,
  transientCleared: () => boolean,
  onError: (what: string, err: unknown) => void = () => {},
): SkipGate {
  const attempts = entry.skipCount ?? 0;
  if (entry.escalatedAt || attempts >= maxAttempts) {
    let by: "person" | "agent" | undefined;
    try {
      by = escalatedChangeBy(reads.activitySince(entry.lastSkippedAt), entry.lastSkippedAt, reads.self, reads.agents);
    } catch (err) {
      onError("issue activity", err);
    }
    if (by) return { run: true, by: "issueChanged", reset: by === "person" };
    return { run: false, reason: escalatedReason(entry.reason, attempts), escalate: !entry.escalatedAt };
  }
  if (entry.releasedAt) return { run: true, reset: false };
  if (transientCleared()) return { run: true, by: "transientCauseGone", reset: false };
  const status = holdStatus(entry, repo, reads, onError);
  if (!status.held) return { run: true, by: status.releasedBy, reset: false };
  return { run: false, reason: heldReason(entry.reason, repo, status.ref, status.refIsPr), escalate: false };
}
