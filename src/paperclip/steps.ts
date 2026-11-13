// What the Paperclip mirror and its five collaborators share: the table of
// steps the mirror writes (the single source docs/paperclip.md is generated
// from), the constants, and the plain types. Nothing here holds state and
// nothing here imports a collaborator.

import type { ItemState, SnapshotCard, SnapshotClosed, WorkItem } from "../adapters.js";
import type { PaperclipCommentEvent, PaperclipStage } from "./config.js";
import type { PaperclipBucket as Bucket } from "./board.js";
import type { Stage } from "../lifecycle.js";
import { FOREMAN_BLOCKED_PREFIX, type SESSION_STAGE } from "./board.js";
import type { HandoffVariant } from "./handoff.js";

export type { PaperclipBucket } from "./board.js";

/**
 * Where a step moves the card: a lifecycle stage (placed by `paperclip.board`),
 * "done" (status done, holder and stage label as before, stage label removed),
 * "waiting" (status blocked, held by the Foreman this cycle), or null (a note only).
 */
export type PaperclipStepMove = PaperclipStage | "done" | "waiting" | null;

/** What a snapshot carries beyond its items (the `snapshot` event's optional fields). */
export interface SnapshotReads {
  readonly cards?: ReadonlyArray<SnapshotCard>;
  readonly closed?: ReadonlyArray<SnapshotClosed>;
  readonly states?: (issueNumbers: readonly number[]) => Promise<ReadonlyMap<number, ItemState>>;
}

/** One step the mirror writes: where it moves the card, and the note. */
export type PaperclipStep = { readonly stage: PaperclipStepMove; readonly note: string };

/**
 * Every step the mirror writes to a task, in the order an issue meets them.
 * `{name}` in a note is filled from the event; nothing else varies. Exported
 * as the single source for these strings, so docs/paperclip.md is generated
 * from the table the mirror runs on.
 */
export const PAPERCLIP_STEPS = Object.freeze({
  claim: { stage: "implementing", note: "picked up by Foreman" },
  queued: { stage: "approved", note: "queued" },
  prLink: { stage: null, note: "PR opened: {prUrl}" },
  inReview: { stage: "inReview", note: "under review" },
  changesRequested: { stage: "changesRequested", note: "changes requested" },
  approved: { stage: "pendingVerification", note: "approved" },
  awaitingVerify: { stage: "merged", note: "merged; awaiting dev verification" },
  verifyWaiting: { stage: "merged", note: "merged; dev verification waiting: {reason}" },
  blocked: { stage: "blocked", note: "blocked: {reason}" },
  escalated: { stage: "needsRuling", note: "blocked: needs an EM scope ruling: {reason}" },
  merged: { stage: null, note: "merged" },
  releaseWaiting: { stage: "awaitingRelease", note: "waiting on release PR #{pr} to merge to {branch}" },
  released: { stage: "done", note: "release PR #{pr} merged to {branch}" },
  inProduction: { stage: "done", note: "in production ({branch})" },
  releaseQueued: { stage: "releasing", note: "in the release PR: Tech Lead approval, SRE deploy and prod verification next" },
  prodHeld: { stage: "prodVerifyHeld", note: "in production, prod verification held; re-verifying on a back-off" },
  releaseVerifyWait: { stage: null, note: "in production, deploy verified; waiting until {at} for {reason}; nothing needed from anyone" },
  prodVerified: { stage: "done", note: "verified in production; closed" },
  releaseClosed: { stage: null, note: "release PR #{pr} closed without merging; waiting for the next release" },
  backoffPause: { stage: null, note: "paused: {upstream} back-off: {reason}" },
  backoffResume: { stage: null, note: "resumed after back-off" },
  waiting: { stage: "waiting", note: "waiting: {reason}" },
  resumed: { stage: null, note: "resumed: no longer waiting" },
  implementFinished: { stage: null, note: "implement session finished: {detail}" },
  implementFailed: { stage: null, note: "implement session failed: {detail}" },
  reviseStarted: { stage: "revising", note: "revising PR #{pr}" },
  reviseFinished: { stage: null, note: "revision finished: {detail}" },
  reviseFailed: { stage: null, note: "revision failed: {detail}" },
  synced: { stage: null, note: "moved to match GitHub: {detail}" },
  reviewStarted: { stage: "reviewing", note: "{reviewer} reviewing PR #{pr}" },
  reviewHandoff: { stage: null, note: "review handed to {reviewer}: {detail}" },
  reviewFinished: { stage: null, note: "review finished: {detail}" },
  reviewFailed: { stage: null, note: "review failed: {detail}" },
  verifyStarted: { stage: "verifying", note: "{reviewer} verifying PR #{pr} in dev" },
  verifyFinished: { stage: null, note: "dev verification finished: {detail}" },
  verifyFailed: { stage: null, note: "dev verification did not pass: {detail}" },
} as const satisfies Record<string, PaperclipStep>);

/** The note a repeat claim posts: the same work, retried after an attempt that did not finish. */
export const PAPERCLIP_RETRY_NOTE = "retrying: the previous attempt did not finish";

/** The status a task is created with, before the claim moves it on. */
export const PAPERCLIP_CREATE_STATUS: Bucket = "todo";

/** A new task's title when `taskTitleFormat` is unset: {repo} is owner/name, {N} the issue number. */
export const PAPERCLIP_TASK_TITLE_FORMAT = "{repo}#{N}";

/** The longest reason or detail written; Paperclip caps an unblock action at 2000. */
export const TEXT_CAP = 500;

/** `template` with each `{name}` replaced from `vars`, in one pass. */
export function fill(template: string, vars: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** How long a full scan of the company's tasks answers a lookup that missed. */
export const INDEX_TTL_MS = 10 * 60_000;
/**
 * The unblock action of a card moved to Blocked with no reason of the Foreman's
 * own: GitHub's blocked label put it there. A Foreman block names its reason.
 */
export const LABEL_BLOCK_ACTION = `${FOREMAN_BLOCKED_PREFIX}needs attention`;

/**
 * The unblock action the shared escalation (`process.escalate`, slashbin_mcp_services
 * #308) writes when a seat hands a card up, back or down the chain. That block is
 * a hop between seats, not the Foreman's and not GitHub's: SLA-1873 (jerky_ops#45)
 * was put back with the EM two minutes after the hop gave it to the PO, before
 * the PO's run started (Foreman #98, 2026-10-18).
 */
export const ESCALATION_ACTION_PREFIX = "Escalation in progress (process.escalate ";

/**
 * With `ownsCards`, the most card writes (creates and content PATCHes) one
 * snapshot makes; the rest wait for the next cycle. An observer call has 30
 * seconds, and a repo's first snapshot after the switch may find many cards to
 * write.
 */
export const CARD_WRITES_PER_SNAPSHOT = 20;
/** The title of a card the Foreman owns: the issue's repo name, number and title, as the receiver wrote it. */
export const PAPERCLIP_OWNED_TITLE_FORMAT = "{name}#{N} {title}";
/** The text the receiver's sync wrote on a card entering Blocked before it read why; replaceable by the reason. */
export const RECEIVER_HOLD_ENTRY = /^GitHub issue is labelled \S+$/;

/** How often a held lease is renewed; well inside the shortest sensible `liveLeaseMinutes`. */
export const LEASE_RENEW_MS = 4 * 60_000;

export type SessionPhase = keyof typeof SESSION_STAGE;

/** A card a live session holds: how many sessions, the first one's phase, and the stage a state reported meanwhile asks for (applied when the last one ends). */
export interface Hold {
  count: number;
  phase: SessionPhase;
  restore: PaperclipStepMove;
  placed: boolean;
  fallback?: Stage;
}
export type Holds = Map<string, Hold>;

/**
 * How a note is posted: the comment event that gates it, what kind of step
 * wrote it, and the stage its step moved the card to (`handoff`): when another
 * seat holds that stage, the note carries the handoff (handoff.ts), rendered
 * when it is posted, so a note a session deferred names the session's outcome.
 */
export type NoteOpts = {
  readonly event: PaperclipCommentEvent;
  readonly tag?: "prLink" | "merged" | "session";
  readonly handoff?: { readonly stage: PaperclipStage; readonly item: WorkItem; readonly owner?: string; readonly variant?: HandoffVariant; readonly resumeAt?: string };
};

/** The handoff option for a move to `to`: only a lifecycle stage can hand a card to a seat. */
export function handoffTo(to: PaperclipStepMove | PaperclipStage | "done", item: WorkItem): NoteOpts["handoff"] {
  return to === null || to === "done" || to === "waiting" ? undefined : { stage: to, item };
}

/** What a card shows that the Foreman writes with `ownsCards`, as the last scan (or write) left it. */
export type RowContent = { title: string; description: string; assigneeAgentId: string | null; assigneeUserId: string | null; labelIds?: string[] };

/** A second card for an issue that already has one: retired by housekeeping when the Foreman owns the cards. */
export type Duplicate = { readonly id: string; readonly key: string; readonly repo: string; readonly winner: string; readonly title: string; readonly status: string };

/**
 * A block the mirror put on a card, as it is persisted: the unblock action, the
 * role holding it when not the stage's owner, the stage its issue was at (null:
 * not known yet), and whether it waits on an EM scope ruling.
 */
export interface CardBlock {
  readonly reason?: string;
  readonly owner?: string;
  readonly at?: string | null;
  readonly ruling?: boolean;
}

/** Where the mirror keeps its blocks across a restart (the plugin: each repo's own record in the work source). */
export interface CardBlockStore {
  /** Null when the blocks cannot be read: the mirror then moves nothing, rather than guess a block is absent. */
  load(): Promise<Record<string, CardBlock> | null>;
  /** The repo is the card's (`githubRepo`); true when the store holds the change. */
  save(id: string, block: CardBlock | null, repo?: string): Promise<boolean>;
}

/** The title, description and status a card is created or rewritten with. */
export type CardContent = { title: string; description: string; status: string };
