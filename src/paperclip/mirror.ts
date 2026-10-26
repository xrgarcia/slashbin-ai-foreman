// Mirrors the Foreman's work onto Paperclip (EM#417): each step the Foreman
// reports on an issue becomes a note on that issue's Paperclip task, and the
// step's lifecycle stage places the card: the agent holding it, its status and
// its stage label, all from `paperclip.board` (board.ts). By default the
// Foreman holds every card; a config with roles hands review to one agent and
// verification to another.
//
// An observer, never a work source: GitHub decides what is built. Everything
// here is best-effort. Every Paperclip call is caught and no method throws.
// An outage (unreachable, or a 5xx) is logged once, and again only after a
// success in between. A rejection (any other 4xx) is about that one call: it
// is logged with Paperclip's reason, once per task and status code, and never
// stands in for an outage or stops the step's note.
//
// The task row is shared with whatever else syncs GitHub issues into Paperclip.
// It is found by the first line of its description, `identityKeyFormat` with
// {repo} = owner/name and {N} = the issue number, and created only when no row
// carries that line. Merged to the base branch and blocked are notes only.
//
// A live session (implement, review, revision) holds its cards in the
// session's stage (in progress, by default) until it ends; a state reported
// meanwhile is kept and applied when it does, and a session that ends with no
// newer state returns the card to the stage it came from. While any session
// runs, the Foreman agent's metadata carries a lease naming the cards it
// holds, renewed every few minutes: a sync reading the board defers to it, and
// on start the mirror returns any card a dead process left in progress.
//
// Release: once an item's work is in a release PR (base → production) the row
// goes to in_review, "waiting on release PR #N", and to done when that PR
// merges. Promotion used to be a note, so an item waiting only on the release
// merge read as "in progress" (Slashbin-console#1185 behind PR #1206).
//
// An issue the Foreman gives up on (an agent declined it, revision retries
// ran out) goes to the `blocked` stage: held by its configured owner, its
// reason in the unblock descriptor prefixed "blocked: ", and stays there through
// the skip's back-off. Separately, an issue the Foreman holds back this cycle
// for another reason (an occupied branch) is moved to blocked with the
// reason as Paperclip's unblock descriptor, and back to its stage once it
// stops waiting. Both are written only on a change — the row's own status and
// descriptor are the record, so a restart re-derives them instead of repeating.
//
// The thread (Foreman issue 74): with `paperclip.comments.enabled` (the
// default) each session posts one markdown summary, written by comments.ts
// from the report the session carries: implement start (the goal), implement
// end (the PR, its diff stat, the agent's own closing summary), review end
// (verdict, findings, merged/deployed), revision end. A note a running session
// triggers (PR opened, under review, approved) waits for the session's own
// summary, so the thread reads in order. No note is ever posted twice in a
// row: each task's latest comment is read once per process and a note equal
// to it is dropped, so neither a poll cycle nor a restart repeats one.
//
// The board is the queue: each row's status says what the Foreman is doing
// with it, and the agent's own status says whether a session is running. Every
// row is filed under a Paperclip project named for its repo, created on first
// use; `start()` backfills the project on rows that lack it, and cancels the
// retired "Foreman — live" summary task.

import type {
  ItemState, PriorState, ReleaseEvent, SessionEvent, SnapshotCard, SnapshotClosed, SnapshotItem, WaitingItem, WorkEvent, WorkItem, WorkObserver, WorkState,
} from "../adapters.js";
import { createHash } from "node:crypto";
import { redactAll } from "../redact.js";
import type { PaperclipCommentEvent, PaperclipConfig, PaperclipStage } from "./config.js";
import { STATE_STAGE } from "../lifecycle.js";
import type { Logger } from "../logger.js";
import {
  BACKLOG_STATUS, CONFIG_KEY, ensureIssueLabel, ensureStageLabels, FOREMAN_BLOCKED_PREFIX, HOLD_PREFIX, isHoldComment, LIVE_LEASE_KEY, SESSION_FALLBACK_STAGE, SESSION_STAGE, stageSeat, stageTarget, statusName, withIssueLabel, withStage,
  type LiveLease, type PaperclipBucket,
} from "./board.js";
import { DEFAULT_HANDOFF_LABELS, handoffComment, handoffNextLine, type HandoffFacts, type HandoffLabels, type HandoffVariant } from "./handoff.js";
import { PaperclipClientError, type PaperclipClient, type PaperclipComment, type PaperclipIssue } from "./client.js";
import { commentsOf, finishComment, redactComment, reviewProgressComment, sessionComment, sessionCommentEvent, untouched, type CommentsConfig } from "./comments.js";
import type { ReviewMilestone } from "../review-progress.js";

export type { PaperclipBucket } from "./board.js";
type Bucket = PaperclipBucket;

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

/** The first description line of the retired live task, which `start()` cancels. */
const LEGACY_LIVE_KEY_FORMAT = "foreman-live: {agentId}";

/** The note that cancels it. */
const LEGACY_LIVE_NOTE = "retired: the board is the queue now; each task's status shows what the Foreman is doing with it";

/** The step a session event writes on each of its items; implement start is the claim's own note. */
const SESSION_STEP: Partial<Record<`${SessionEvent["phase"]}:${SessionEvent["status"]}`, PaperclipStep>> = {
  "implement:finished": PAPERCLIP_STEPS.implementFinished,
  "implement:failed": PAPERCLIP_STEPS.implementFailed,
  "revise:started": PAPERCLIP_STEPS.reviseStarted,
  "revise:finished": PAPERCLIP_STEPS.reviseFinished,
  "revise:failed": PAPERCLIP_STEPS.reviseFailed,
  "review:started": PAPERCLIP_STEPS.reviewStarted,
  "review:handoff": PAPERCLIP_STEPS.reviewHandoff,
  "review:finished": PAPERCLIP_STEPS.reviewFinished,
  "review:failed": PAPERCLIP_STEPS.reviewFailed,
  "verify:started": PAPERCLIP_STEPS.verifyStarted,
  "verify:finished": PAPERCLIP_STEPS.verifyFinished,
  "verify:failed": PAPERCLIP_STEPS.verifyFailed,
};

/** The longest reason or detail written; Paperclip caps an unblock action at 2000. */
const TEXT_CAP = 500;

/** The step for each state the Foreman can report; each lands the card in the core's stage for that state (STATE_STAGE). */
const STATE_STEP: { readonly [S in WorkState]: PaperclipStep & { readonly stage: (typeof STATE_STAGE)[S] } } = {
  queued: PAPERCLIP_STEPS.queued,
  inReview: PAPERCLIP_STEPS.inReview,
  changesRequested: PAPERCLIP_STEPS.changesRequested,
  merged: PAPERCLIP_STEPS.awaitingVerify,
  approved: PAPERCLIP_STEPS.approved,
  releasing: PAPERCLIP_STEPS.releaseQueued,
  prodVerifyHeld: PAPERCLIP_STEPS.prodHeld,
  released: PAPERCLIP_STEPS.prodVerified,
};

/** `template` with each `{name}` replaced from `vars`, in one pass. */
function fill(template: string, vars: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** How long a full scan of the company's tasks answers a lookup that missed. */
const INDEX_TTL_MS = 10 * 60_000;
/**
 * The unblock action of a card moved to Blocked with no reason of the Foreman's
 * own: GitHub's blocked label put it there. A Foreman block names its reason.
 */
const LABEL_BLOCK_ACTION = `${FOREMAN_BLOCKED_PREFIX}needs attention`;

/**
 * The unblock action the shared escalation (`process.escalate`, slashbin_mcp_services
 * #308) writes when a seat hands a card up, back or down the chain. That block is
 * a hop between seats, not the Foreman's and not GitHub's: SLA-1873 (jerky_ops#45)
 * was put back with the EM two minutes after the hop gave it to the PO, before
 * the PO's run started (Foreman #98, 2026-10-18).
 */
export const ESCALATION_ACTION_PREFIX = "Escalation in progress (process.escalate ";

/**
 * A lookup that misses rescans once the last scan is this old, so a row
 * another writer (a periodic sync) added since is found within a minute, not
 * at the next ten-minute refresh.
 */
const MISS_RESCAN_MS = 60_000;
/**
 * How long the board's GitHub logins are trusted before a re-read. Each agent's
 * `metadata.githubLogin` is the golden source for who it is on GitHub (Ray,
 * 2026-10-16), so a hold comment is credited to the agent whose words it is.
 */
const GITHUB_LOGINS_TTL_MS = 10 * 60_000;

/**
 * With `ownsCards`, the most card writes (creates and content PATCHes) one
 * snapshot makes; the rest wait for the next cycle. An observer call has 30
 * seconds, and a repo's first snapshot after the switch may find many cards to
 * write.
 */
const CARD_WRITES_PER_SNAPSHOT = 20;
/** Cards with no open issue behind them that are read live per cycle, and how long a card waits between reads. */
const STALE_CHECKS_PER_SNAPSHOT = 50;
const STALE_CHECK_MS = 10 * 60_000;
/** With `ownsCards`, the most second cards one housekeeping pass retires. */
const RETIRES_PER_PASS = 25;
/** The title of a card the Foreman owns: the issue's repo name, number and title, as the receiver wrote it. */
export const PAPERCLIP_OWNED_TITLE_FORMAT = "{name}#{N} {title}";
/** The comment on a second card for one issue when it is retired. */
const DUPLICATE_NOTE = "retired: a second card for {key}; {winner} is the card for this issue";
/** The text the receiver's sync wrote on a card entering Blocked before it read why; replaceable by the reason. */
const RECEIVER_HOLD_ENTRY = /^GitHub issue is labelled \S+$/;

/** How often a held lease is renewed; well inside the shortest sensible `liveLeaseMinutes`. */
const LEASE_RENEW_MS = 4 * 60_000;

type SessionPhase = keyof typeof SESSION_STAGE;

/**
 * How a note is posted: the comment event that gates it, what kind of step
 * wrote it, and the stage its step moved the card to (`handoff`): when another
 * seat holds that stage, the note carries the handoff (handoff.ts), rendered
 * when it is posted, so a note a session deferred names the session's outcome.
 */
type NoteOpts = {
  readonly event: PaperclipCommentEvent;
  readonly tag?: "prLink" | "merged" | "session";
  readonly handoff?: { readonly stage: PaperclipStage; readonly item: WorkItem; readonly owner?: string; readonly variant?: HandoffVariant };
};

/** The handoff option for a move to `to`: only a lifecycle stage can hand a card to a seat. */
function handoffTo(to: PaperclipStepMove | PaperclipStage | "done", item: WorkItem): NoteOpts["handoff"] {
  return to === null || to === "done" || to === "waiting" ? undefined : { stage: to, item };
}

/** The outcome a session's end leaves on its cards, for the next handoff's "why". */
function outcomeOf(e: SessionEvent): string {
  const detail = (e.detail ?? "").trim();
  if (detail) return detail;
  const v = e.report?.review;
  if (e.phase === "review" && v) return `${e.reviewer ?? "review"} verdict: ${v.verdict}`;
  if (e.phase === "verify") return e.status === "finished" ? "dev verification passed" : "dev verification did not pass";
  return `${e.phase} ${e.status}`;
}

/** The longest session outcome a handoff quotes. */
const EVIDENCE_CAP = 240;

/** What a card shows that the Foreman writes with `ownsCards`, as the last scan (or write) left it. */
type RowContent = { title: string; description: string; assigneeAgentId: string | null; assigneeUserId: string | null; labelIds?: string[] };

/** A second card for an issue that already has one: retired by housekeeping when the Foreman owns the cards. */
type Duplicate = { readonly id: string; readonly key: string; readonly repo: string; readonly winner: string; readonly title: string; readonly status: string };

/**
 * Which of the rows carrying one identity key is the card: the oldest that is
 * not cancelled, else the oldest. A row with no creation time sorts by the
 * order it was listed in, after every dated one. Both writers' rows for
 * jerky_ops#11 stood open side by side because each kept a different one of the
 * pair: the Foreman the first listed, the receiver the last (2026-10-15).
 */
export function pickCard<T extends { status: string; createdAt?: string }>(rows: readonly T[], cancelled: string): T | undefined {
  const time = (r: T) => {
    const t = Date.parse(r.createdAt ?? "");
    return Number.isNaN(t) ? Infinity : t;
  };
  const ranked = rows.map((r, i) => ({ r, i })).sort((a, b) =>
    Number(a.r.status === cancelled) - Number(b.r.status === cancelled) || time(a.r) - time(b.r) || a.i - b.i);
  return ranked[0]?.r;
}

export class PaperclipMirror implements WorkObserver {
  /** Identity key → Paperclip task id, for every task this mirror has resolved. */
  private readonly taskUuidCache = new Map<string, string>();
  /** True while Paperclip is failing; cleared by the next successful call. */
  private outageLogged = false;
  /** First description line → task id, from the last full scan. */
  private index: Map<string, string> | null = null;
  /** Task id → what the row shows: `waiting\n<action>` when blocked, else `status:<status>`. */
  private readonly rowState = new Map<string, string>();
  /** Task id → the repo its identity key names, for rows that key an issue. */
  private readonly rowRepo = new Map<string, string>();
  /** Task id → its issue number, from the identity line. */
  private readonly rowNumber = new Map<string, number>();
  /** Cards whose issue GitHub reads closed: a hold the Foreman reports later never reopens them. */
  private readonly closedCards = new Set<string>();
  /** Task id → when a card with no open issue was last read live. */
  private readonly staleCheckedAt = new Map<string, number>();
  /** The Unplaced project's id, or the lookup in flight; cleared when it finds none or an ambiguous set. */
  private unplacedLookup: Promise<string | null> | null = null;
  /** True while a housekeeping pass runs, so a slow one is never overlapped. */
  private housekeeping = false;
  /** Running sessions, by repo + phase + items. */
  private readonly sessions = new Map<string, { event: SessionEvent; since: Date }>();
  /** The agent status last written, so an unchanged one is never re-sent. */
  private agentStatusSent: string | null = null;
  private indexedAt = 0;
  /** Identity keys claimed and not yet moved on by a state change: a repeat claim is a retry. */
  private readonly claimed = new Set<string>();
  /** "<task id> <status>" rejections already logged, so a repeating one is logged once. */
  private readonly rejectionsLogged = new Set<string>();
  /** The item being built right now (one session at a time), for back-off notes. */
  private building: WorkItem | null = null;
  /**
   * Task id → the live sessions holding it in progress: how many, the phase
   * of the first, and the stage a state reported meanwhile asks for, applied
   * when the last one ends.
   */
  /**
   * Lease recovery, until it settles. A session event waits on it: recovery
   * read jerky_service#87 as in progress (its implement session had died with
   * the old process), the new process's review session moved the card to the
   * Tech Lead meanwhile, and recovery's write then landed last — the card sat
   * in To-do while the Tech Lead reviewed PR #90 (2026-10-05).
   */
  private recovery: Promise<void> = Promise.resolve();
  private readonly holds = new Map<string, { count: number; phase: SessionPhase; restore: PaperclipStepMove; placed: boolean }>();
  /** Task id → the last lifecycle stage the mirror placed it in, so a resumed card goes back there. */
  private readonly rowStage = new Map<string, PaperclipStage>();
  /** Task id → why the Foreman blocked it, the unblock descriptor's action when it moves to `blocked`. */
  private readonly blockedReason = new Map<string, string>();
  /** Task id → the role key that holds its Blocked card when it is not the stage's owner (`sre`: a failed dev deploy). */
  private readonly blockedOwner = new Map<string, string>();
  /** The last dev-verification wait note per row, so a repeated wait writes nothing. */
  private readonly verifyWaitNote = new Map<string, string>();
  /** Task id → the GitHub stage last seen for its issue, from the cycle snapshot. */
  private readonly ghStage = new Map<string, PaperclipStage | "done">();
  /**
   * Task id → the GitHub stage its issue was at when the Foreman blocked it
   * (undefined: no snapshot yet). The block stands until the issue moves on,
   * so a snapshot never undoes a block the Foreman just made.
   */
  private readonly blockedAt = new Map<string, PaperclipStage | "done" | undefined>();
  /** Task ids this process moved to Blocked because GitHub's blocked label said so. */
  private readonly labelBlocked = new Set<string>();
  /** Task id → a blocked card's unblock-descriptor action, as the last scan read it. */
  private readonly blockAction = new Map<string, string>();
  /** A card a seat's escalation blocked, and the GitHub stage it was first seen at. */
  private readonly escalatedAt = new Map<string, string>();
  /** Stage label key → the company's label id, or the lookup in flight; dropped on failure. */
  private stageLabelIds: Promise<Map<string, string> | null> | null = null;
  /** The company's `issue` label id, once ensured (undefined until a label write needed it). */
  private issueLabelId: string | undefined;
  /** Cards confirmed to carry the issue label, so a sync reads and writes each once. */
  private readonly issueLabelled = new Set<string>();
  /** The repos a snapshot has named: the ones the Foreman serves, so the only ones housekeeping may label. */
  private readonly snapshotRepos = new Set<string>();
  /** The Foreman agent's metadata minus the lease, so a lease write keeps every other key. */
  private agentMetadata: Record<string, unknown> | null = null;
  /** Task id → its latest comment body, read once per process and kept as notes are posted. */
  private readonly lastNote = new Map<string, string>();
  /** Task id → notes due while a session held the card, posted after the session's own summary. */
  private readonly deferred = new Map<string, Array<{ text: string; opts: NoteOpts }>>();
  /** Identity keys whose current claim repeats one that did not finish. */
  private readonly retrying = new Set<string>();
  private comments: CommentsConfig;
  /** The sha256 of the config text last published, so an unchanged reload writes nothing. */
  private publishedSha: string | null = null;
  /** Task id → its title, description and holders, as the last scan or write left them (`ownsCards`). */
  private readonly rowContent = new Map<string, RowContent>();
  /** Every second card the last scan found, for housekeeping to retire (`ownsCards`). */
  private duplicates: Duplicate[] = [];
  /** Task id → the reason its issue is held on GitHub, from the last snapshot's cards: what it says entering Blocked. */
  private readonly holdAction = new Map<string, string>();
  /** "<task id> <comment url>": the holder's comment is on the card, posted or found; never read again. */
  private readonly holdCommented = new Set<string>();
  /** Task id → the PR last seen delivering its issue (a PR link, a session), for the handoff's links. */
  private readonly prOf = new Map<string, { number: number; url?: string }>();
  /** Task id → the last session's outcome on it and when, the next handoff's "why"; used once. */
  private readonly evidence = new Map<string, { text: string; at: string }>();
  /** The lifecycle label names a handoff quotes. */
  private readonly labels: HandoffLabels;
  /** GitHub login → the agent whose `metadata.githubLogin` it is, and when the board was read. */
  private githubAgents: { at: number; byLogin: Map<string, string> } | null = null;

  constructor(
    private readonly client: PaperclipClient,
    private cfg: PaperclipConfig,
    private readonly secrets: ReadonlyArray<{ name: string; value: string }>,
    private readonly logger: Logger,
    labels: Partial<HandoffLabels> = {},
  ) {
    this.comments = commentsOf(cfg);
    this.labels = { ...DEFAULT_HANDOFF_LABELS, ...labels };
  }

  /**
   * The one entry point: each event the Foreman emits goes to its handler
   * below. The handlers stay public so a test can drive one step directly.
   */
  /** True when the Foreman writes every card of its repos (`ownsCards`): the snapshot then carries them all. */
  wantsCards(): boolean {
    return this.cfg.ownsCards === true;
  }

  async onEvent(event: WorkEvent, logger: Logger): Promise<void> {
    if (!this.mirrors(event)) {
      // A claim outside `repos` is still the one build running: forget the last
      // one, so a back-off note never lands on a card it is not about.
      if (event.kind === "claim") this.building = null;
      return;
    }
    switch (event.kind) {
      case "claim": return this.onClaim(event.item);
      case "transition": return this.onState(event.item, event.from, event.to);
      case "prLink": return this.onPrLink(event.item, event.prUrl);
      case "blocked": return this.onBlocked(event.item, event.reason, undefined, undefined, PAPERCLIP_STEPS.blocked, "changesRequested", event.owner);
      case "escalated": return this.onBlocked(event.item, event.reason, undefined, undefined, PAPERCLIP_STEPS.escalated, event.at);
      case "verifyWaiting": return this.onVerifyWaiting(event.item, event.reason);
      case "unblocked": return this.onUnblocked(event.item, event.reason);
      case "merged": return this.onMerged(event.item);
      case "session": return this.onSession(event.session, logger);
      case "reviewProgress": return this.onReviewProgress(event.pr, event.items, event.milestones);
      case "waiting": return this.onWaiting(event.repo, event.items, logger);
      case "release": return this.onRelease(event.release, logger);
      case "backoff": return event.paused ? this.onBackoffPause(event.upstream, event.reason ?? "", logger) : this.onBackoffResume(event.upstream, logger);
      case "snapshot": return this.onSnapshot(event.repo, event.items, logger, { cards: event.cards, closed: event.closed, states: event.states });
      // A promotion PR owns the item; its card moves on the release event, not here.
      case "promoted": return;
      case "promotionStall": return;
      default: {
        const never: never = event;
        return never;
      }
    }
  }

  /** Whether `event` is about a repo `repos` mirrors. Daemon-wide events (back-off) always are. */
  private mirrors(event: WorkEvent): boolean {
    if (!this.cfg.repos) return true;
    const repo = "item" in event ? event.item.repo
      : event.kind === "session" ? event.session.repo
      : event.kind === "release" ? event.release.repo
      : "repo" in event ? event.repo
      : null;
    return repo === null || this.cfg.repos.includes(repo);
  }

  async onClaim(item: WorkItem, _repoConfig?: unknown, _logger?: Logger): Promise<void> {
    this.building = item;
    const id = await this.resolve(item, true);
    if (!id) return;
    const step = PAPERCLIP_STEPS.claim;
    await this.move(id, step.stage);
    // A second claim before any state change is the same work, retried after a
    // failed attempt: say so once, rather than "picked up" twice.
    const key = this.keyOf(item);
    const retry = this.claimed.has(key);
    if (retry) this.retrying.add(key);
    else this.retrying.delete(key);
    this.claimed.add(key);
    // With summaries on, the implement session's start comment says it (with the goal).
    if (this.comments.enabled) return;
    await this.note(id, retry ? PAPERCLIP_RETRY_NOTE : step.note, { event: "implementStart" });
  }

  async onState(item: WorkItem, _from: PriorState, to: WorkState, _repoConfig?: unknown, _logger?: Logger): Promise<void> {
    const step = STATE_STEP[to];
    if (!step) return;
    if (to !== "queued" && sameItem(this.building, item)) this.building = null;
    if (to !== "queued") this.claimed.delete(this.keyOf(item));
    const id = await this.resolve(item, false);
    if (!id) return;
    await this.move(id, step.stage);
    await this.note(id, step.note, { event: "progress", handoff: handoffTo(step.stage, item) });
  }

  async onPrLink(item: WorkItem, prUrl: string, _repoConfig?: unknown, _logger?: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (!id) return;
    const n = /\/pull\/(\d+)/.exec(prUrl)?.[1];
    if (n) this.prOf.set(id, { number: Number(n), url: prUrl });
    await this.note(id, fill(PAPERCLIP_STEPS.prLink.note, { prUrl }), { event: "progress", tag: "prLink" });
  }

  /** Blocked, or (`step` escalated) parked for the EM's ruling in the stage that holder owns. */
  async onBlocked(item: WorkItem, reason: string, _repoConfig?: unknown, _logger?: Logger,
    step: typeof PAPERCLIP_STEPS.blocked | typeof PAPERCLIP_STEPS.escalated = PAPERCLIP_STEPS.blocked,
    at: PaperclipStage = "changesRequested", owner?: "sre"): Promise<void> {
    if (sameItem(this.building, item)) this.building = null;
    this.claimed.delete(this.keyOf(item));
    const id = await this.resolve(item, false);
    if (!id || this.closedCards.has(id)) return;
    const text = fill(step.note, { reason: this.clean(reason) });
    this.blockedReason.set(id, text);
    // A hold that is not the stage owner's (a failed dev deploy is the SRE's) goes to that
    // role's seat; a role not configured with an agent id leaves the hold with the default.
    const role = owner && this.cfg.roles?.[owner]?.id ? owner : undefined;
    if (role) this.blockedOwner.set(id, role); else this.blockedOwner.delete(id);
    // An escalation names the stage its hold belongs to (`at`): revise's, the
    // default, only runs at changesRequested; a skip escalation sits at approved.
    // Anchored on the last snapshot instead, it could be stale:
    // the review that tipped the count moves the labels to `pr pending actions`
    // seconds before the escalation, and anchoring on the stale `pr under review`
    // let the next snapshot read it as "moved on" and release the hold
    // (slashbin_data_receiver#41, 2026-10-14: the card sat In Review on the
    // Foreman for ten hours with nobody told).
    this.blockedAt.set(id, step === PAPERCLIP_STEPS.escalated ? at : this.ghStage.get(id));
    await this.move(id, step.stage);
    await this.note(id, text, { event: "blocked", handoff: role ? { stage: step.stage, item, owner: role, variant: "deployFailed" } : handoffTo(step.stage, item) });
  }

  /**
   * Dev verification waits on something that clears by itself: the card stays in
   * review with the reason, never Blocked, which is a person's queue (jerky_ops#18,
   * 2026-10-15, sat in Blocked through a ten-minute deploy). The same reason twice
   * writes nothing.
   */
  async onVerifyWaiting(item: WorkItem, reason: string, _repoConfig?: unknown, _logger?: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (!id || this.holds.has(id)) return;
    const step = PAPERCLIP_STEPS.verifyWaiting;
    const text = fill(step.note, { reason: this.clean(reason) });
    if (this.verifyWaitNote.get(id) === text) return;
    this.verifyWaitNote.set(id, text);
    this.blockedAt.delete(id);
    this.blockedReason.delete(id);
    this.blockedOwner.delete(id);
    await this.move(id, step.stage);
    await this.note(id, text, { event: "progress" });
  }

  /**
   * The Foreman resolved its own block: the card goes back to the column its
   * GitHub labels call for (approved when none is known yet). Only a card the
   * Foreman holds Blocked moves; a block a person set, a waiting hold and a
   * session-held card are left alone.
   */
  async onUnblocked(item: WorkItem, reason: string, _repoConfig?: unknown, _logger?: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (!id || this.holds.has(id)) return;
    if (this.rowState.get(id) !== `status:${this.statusName("blocked")}`) return;
    this.blockedAt.delete(id);
    this.blockedReason.delete(id);
    this.blockedOwner.delete(id);
    const stage = this.ghStage.get(id) ?? "approved";
    if (!(await this.move(id, stage))) return;
    await this.note(id, this.clean(reason), { event: "progress", handoff: handoffTo(stage, item) });
  }

  /**
   * Put each card in the column its issue's GitHub labels call for. GitHub is
   * the record; events only move a card when the Foreman acts on that issue,
   * so without this a card the Foreman stops touching keeps whatever it last
   * showed. Moves only on a column change (the stage tag inside In Review is
   * left to events), and leaves alone: a card a session holds, a waiting hold,
   * a cancelled card, and a Foreman block until its issue moves on. A block
   * from before this process started stands while the issue is still at the
   * trigger label, since nothing on GitHub has moved past it — or while a
   * persisted verify hold still names it: that block sits at `pr merged`, and
   * a restart released cmneb_data_publisher#199 to the SRE's To-do after the
   * SRE had given up on it (2026-10-05).
   */
  async onSnapshot(_repo: string, items: ReadonlyArray<SnapshotItem>, logger: Logger, read: SnapshotReads = {}): Promise<void> {
    this.snapshotRepos.add(_repo);
    logger.info(`Paperclip: ${_repo} snapshot in (${items.length} items, ${read.cards?.length ?? "no"} cards)`); // DIAG
    if (!(await this.ensureIndex())) { logger.info(`Paperclip: ${_repo} snapshot dropped: no index`); return; } // DIAG
    const blocked = `status:${this.statusName("blocked")}`;
    const cards = read.cards;
    // With `ownsCards`, every issue has a card before the lifecycle pass places
    // them, and a held issue's reason is at hand for a card entering Blocked.
    const owned = this.cfg.ownsCards === true && cards ? cards : null;
    const budget = { left: CARD_WRITES_PER_SNAPSHOT };
    const ids: Array<[SnapshotCard, string]> = [];
    for (const c of owned ?? []) {
      let id = await this.resolve(c.item, false);
      if (!id && c.state === "open" && budget.left > 0) {
        id = await this.createCard(c);
        if (id) budget.left--;
      }
      if (!id) continue;
      ids.push([c, id]);
      if (c.hold) this.holdAction.set(id, c.hold.action);
      else this.holdAction.delete(id);
    }
    // Closed on GitHub, read live: the open-issue view the items come from can
    // still carry such an issue with its old labels. Its card is not placed by them.
    const closed = new Map<number, "completed" | "not_planned">();
    for (const c of cards ?? read.closed ?? []) if (c.state !== "open") closed.set(c.item.issueNumber, c.state);
    const movers: Array<{ item: WorkItem; id: string; stage: SnapshotItem["stage"]; detail: string; state: string; want: string }> = [];
    for (const { item, stage, detail, verifyHeld, foremanHeld } of items) {
      if (closed.has(item.issueNumber)) continue;
      const id = await this.resolve(item, false);
      if (!id) continue;
      this.ghStage.set(id, stage);
      const state = this.rowState.get(id);
      if (this.holds.has(id)) {
        await this.placeHeld(id);
        continue;
      }
      if (!state || state.startsWith("waiting\n")) continue;
      if (state === `status:${this.statusName("cancelled")}`) continue;
      const want = `status:${this.statusName(stage === "done" ? "done" : stageTarget(this.cfg, stage).bucket)}`;
      if (state === want) continue;
      // A Foreman block is released by GitHub moving on, not by another writer:
      // the stage owner's own wake checks the card out to in_progress, and
      // matching that to GitHub took SLA-1335 out of the EM's hands (2026-10-14).
      // A block GitHub's label made ends when the label goes, at any stage:
      // read as a Foreman block from before a restart, jerky_service #132/#133
      // sat Blocked for hours after the EM lifted the label (2026-10-14).
      // A seat's escalation hop holds the card until the hop is resolved, or until
      // GitHub moves the issue to another stage (Foreman #98).
      if (state === blocked && this.blockAction.get(id)?.startsWith(ESCALATION_ACTION_PREFIX)) {
        if (!this.escalatedAt.has(id) || this.escalatedAt.get(id) === stage) {
          this.escalatedAt.set(id, stage);
          continue;
        }
      }
      this.escalatedAt.delete(id);
      if ((state === blocked || this.blockedAt.has(id)) && stage !== "blocked" && !(await this.blockedByLabel(id))) {
        // A block from before this process started stands only while the Foreman's state still holds the issue:
        // jerky_security_testing#398 sat Blocked at `release pending` after every hold was gone (2026-10-26).
        if (this.blockedAt.has(id) ? this.blockedAt.get(id) === stage || this.blockedAt.get(id) === undefined : foremanHeld !== false && (stage === "approved" || (stage === "merged" && verifyHeld === true))) {
          this.blockedAt.set(id, stage);
          continue;
        }
      }
      movers.push({ item, id, stage, detail, state, want });
    }
    // An owned card of an open, unapproved issue goes to backlog, and that too
    // waits on the issue reading open.
    const toBacklog = ids.filter(([c, id]) => c.state === "open" && c.stage === null && !closed.has(c.item.issueNumber) && this.wouldBacklog(id));
    // Every column a label would change is confirmed against GitHub's live
    // state first, in one read: a closed issue's card goes to done, or
    // cancelled when not planned, whatever labels it still shows; one whose
    // state cannot be read is left where it is (cmneb_data_receiver#218 went
    // done → in_review on a stale open view, 2026-10-15).
    const asked = [...movers.map((m) => m.item.issueNumber), ...toBacklog.map(([c]) => c.item.issueNumber)];
    let live: ReadonlyMap<number, ItemState> = new Map();
    if (asked.length && read.states) {
      try {
        live = await read.states(asked);
      } catch (err) {
        logger.warn(`Paperclip: ${_repo} issue states not read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const unread = asked.filter((n) => !live.has(n));
    if (unread.length) logger.info(`Paperclip: ${_repo} left ${unread.map((n) => `#${n}`).join(", ")} where they are: GitHub state not read`);
    for (const { item, id, stage, detail, state, want } of movers) {
      const now = live.get(item.issueNumber);
      if (now === undefined) continue;
      if (now !== "open") {
        if (!owned) await this.closeCard(id, now, item, logger);
        continue;
      }
      if (!(await this.move(id, stage))) continue;
      this.blockedAt.delete(id);
      if (stage === "blocked") this.labelBlocked.add(id);
      else this.labelBlocked.delete(id);
      logger.info(`Paperclip: ${item.repo}#${item.issueNumber} card ${state.slice(7)} → ${want.slice(7)} to match GitHub`);
      await this.note(id, fill(PAPERCLIP_STEPS.synced.note, { detail }), { event: "progress", handoff: handoffTo(stage, item) });
    }
    // Without the cards, a card for an issue closed since the last read follows it.
    if (!owned) {
      for (const [n, how] of closed) {
        const id = await this.resolve({ issueNumber: n, repo: _repo }, false);
        if (id) await this.closeCard(id, how, { issueNumber: n, repo: _repo }, logger);
      }
    }
    // The closed read is one-shot per window, and a close it missed (Paperclip
    // down for that write, a hold that put the card back) is never offered
    // again: a card of this repo with no open issue behind it is asked about
    // live, so every closed issue's card reaches done or cancelled.
    if (owned && read.states) await this.closeStale(_repo, owned, closed, read.states, logger);
    const backlogged = new Set(toBacklog.map(([, id]) => id));
    for (const [c, id] of ids) {
      if (budget.left <= 0) {
        logger.info(`Paperclip: ${_repo} card writes capped at ${CARD_WRITES_PER_SNAPSHOT} this cycle; the rest follow next cycle`);
        break;
      }
      const now = live.get(c.item.issueNumber);
      // An issue the open view carries but GitHub reads closed is synced as closed.
      const card: SnapshotCard = c.state === "open" && now !== undefined && now !== "open" ? { ...c, state: now, stage: null } : c;
      await this.syncCard(id, card, budget, backlogged.has(id) && now !== "open");
    }
  }

  /**
   * Close the cards of `repo` that show neither done nor cancelled while no
   * open issue stands behind them and this cycle's closed read did not name
   * them. Each is read live (`states`), at most STALE_CHECK_MS apart and
   * STALE_CHECKS_PER_SNAPSHOT a cycle; an issue that cannot be read is left.
   */
  private async closeStale(
    repo: string,
    cards: ReadonlyArray<SnapshotCard>,
    closed: ReadonlyMap<number, "completed" | "not_planned">,
    states: (issueNumbers: readonly number[]) => Promise<ReadonlyMap<number, ItemState>>,
    logger: Logger,
  ): Promise<void> {
    const open = new Set(cards.filter((c) => c.state === "open").map((c) => c.item.issueNumber));
    const now = Date.now();
    const due: Array<[string, number]> = [];
    for (const [id, n] of this.rowNumber) {
      if (due.length >= STALE_CHECKS_PER_SNAPSHOT) break;
      if (this.rowRepo.get(id) !== repo || open.has(n) || closed.has(n) || this.holds.has(id) || !this.rowState.has(id) || this.isClosedCard(id)) continue;
      if (now - (this.staleCheckedAt.get(id) ?? 0) < STALE_CHECK_MS) continue;
      due.push([id, n]);
    }
    if (!due.length) return;
    let live: ReadonlyMap<number, ItemState>;
    try {
      live = await states(due.map(([, n]) => n));
    } catch (err) {
      logger.warn(`Paperclip: ${repo} stale card states not read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const [id, n] of due) {
      const s = live.get(n);
      if (s === undefined) continue;
      this.staleCheckedAt.set(id, now);
      if (s !== "open") await this.closeCard(id, s, { issueNumber: n, repo }, logger);
    }
  }

  /** True when the card shows done or cancelled. */
  private isClosedCard(id: string): boolean {
    const state = this.rowState.get(id);
    return state === `status:${this.statusName("done")}` || state === `status:${this.statusName("cancelled")}`;
  }

  /** True when syncing an open, unapproved issue's card would move it to backlog. */
  private wouldBacklog(id: string): boolean {
    if (this.holds.has(id)) return false;
    const state = this.rowState.get(id) ?? "";
    if (!state.startsWith("status:")) return false;
    const status = state.slice(7);
    return status !== BACKLOG_STATUS && status !== this.statusName("cancelled");
  }

  /**
   * A card whose issue is closed: done, or cancelled when not planned, with no
   * stage label. A card a session holds and one already there are left alone;
   * a hold of the Foreman's (waiting, or Blocked) never keeps a closed issue's
   * card open (jerky_ops#138 and nine more, 2026-10-26). With `ownsCards` the
   * card sync does this instead.
   */
  private async closeCard(id: string, how: "completed" | "not_planned", item: WorkItem, logger: Logger): Promise<void> {
    if (this.holds.has(id)) return;
    const state = this.rowState.get(id);
    if (!state) return;
    const target = this.statusName(how === "not_planned" ? "cancelled" : "done");
    this.closedCards.add(id);
    if (state === `status:${target}`) return;
    const labelIds = await this.labelIdsFor(id, null);
    if (!(await this.patch(id, { status: target, ...(labelIds ? { labelIds } : {}) }))) return;
    this.rowState.set(id, `status:${target}`);
    this.blockedAt.delete(id);
    this.labelBlocked.delete(id);
    this.blockedReason.delete(id);
    this.blockedOwner.delete(id);
    logger.info(`Paperclip: ${item.repo}#${item.issueNumber} card ${state.startsWith("waiting\n") ? "waiting" : state.slice(7)} → ${target}: the issue is closed ${how} on GitHub`);
  }

  /**
   * What a card the Foreman owns says: title and description, from its issue.
   * At a stage another seat holds, the line under `stage <stage>` says what that
   * seat does next; line 2 keeps its shape, which readers of the board parse.
   */
  private cardContent(c: SnapshotCard, id: string | null = null): { title: string; description: string } {
    const [owner = "", name = ""] = c.item.repo.split("/");
    const line = c.state !== "open" ? `GitHub: closed ${c.state}` : `GitHub: open · ${c.stage ? `stage ${c.stage}` : "not approved"}`;
    const facts = c.state === "open" && c.stage && c.stage !== "done" ? this.handoffFacts(id, c.stage, c.item) : null;
    const next = facts && c.stage && c.stage !== "done" ? `\n${handoffNextLine(c.stage, facts, this.labels)}` : "";
    return {
      title: fill(PAPERCLIP_OWNED_TITLE_FORMAT, { repo: c.item.repo, owner, name, N: String(c.item.issueNumber), title: c.title }),
      description: `${this.keyOf(c.item)}\n${line}${next}\n\n${c.url}`,
    };
  }

  /**
   * The card for an open issue that has none (`ownsCards`): filed in the
   * Unplaced project like a claim's, in backlog when the issue is not approved,
   * else in the create status for the lifecycle pass to place.
   */
  private async createCard(c: SnapshotCard): Promise<string | null> {
    const status = c.stage === null ? BACKLOG_STATUS : this.statusName(PAPERCLIP_CREATE_STATUS);
    return this.createTask(c.item, { ...this.cardContent(c), status });
  }

  /**
   * Bring a card the Foreman owns in step with its issue (`ownsCards`): title
   * and description; closed → done, or cancelled when not planned, with no stage
   * label and the last holder kept; not approved → backlog, nobody's, no stage
   * label; a held card's reason as its unblock descriptor, and the holder's
   * comment once. One PATCH, only when something differs. A card a session holds
   * keeps its status; a cancelled card of an open issue and a waiting hold are
   * left as they are, as the lifecycle pass leaves them.
   */
  private async syncCard(id: string, c: SnapshotCard, budget: { left: number }, unconfirmed = false): Promise<void> {
    const want = this.cardContent(c, id);
    if (c.state === "open") this.closedCards.delete(id);
    const have = this.rowContent.get(id);
    const state = this.rowState.get(id) ?? "";
    const body: Record<string, unknown> = {};
    if (have?.title !== want.title) body.title = want.title;
    if (have?.description !== want.description) body.description = want.description;
    const free = !this.holds.has(id) && !state.startsWith("waiting\n");
    // The receiver's entry text on a Foreman-held card reads as a waiting hold; it is GitHub's hold, unread.
    const entry = !this.holds.has(id) && state.startsWith("waiting\n") && RECEIVER_HOLD_ENTRY.test(state.slice(8));
    let status = state.startsWith("status:") ? state.slice(7) : entry || state.startsWith("waiting\n") ? this.statusName("blocked") : null;
    // A closed issue closes its card whatever the Foreman holds on it; only a live session defers.
    if (!this.holds.has(id) && c.state !== "open") {
      this.closedCards.add(id);
      const target = this.statusName(c.state === "not_planned" ? "cancelled" : "done");
      if (status !== target) {
        body.status = target;
        const labelIds = await this.labelIdsFor(id, null);
        if (labelIds) body.labelIds = labelIds;
      }
    } else if (free && c.stage === null && status !== this.statusName("cancelled") && !unconfirmed) {
      if (status !== BACKLOG_STATUS || have?.assigneeAgentId || have?.assigneeUserId) {
        Object.assign(body, { status: BACKLOG_STATUS, assigneeAgentId: null, assigneeUserId: null });
        const labelIds = await this.labelIdsFor(id, null);
        if (labelIds) body.labelIds = labelIds;
      }
    } else if ((free || entry) && c.hold && status === this.statusName("blocked")) {
      const action = this.blockAction.get(id) ?? null;
      if (action !== c.hold.action && (action === null || action === LABEL_BLOCK_ACTION || action.startsWith(HOLD_PREFIX) || RECEIVER_HOLD_ENTRY.test(action))) {
        const t = stageTarget(this.cfg, "blocked", this.blockedOwner.get(id));
        body.unblockDescriptor = { owner: t.agentId ? { agentId: t.agentId } : "board", action: c.hold.action };
        body.status = status;
      }
    }
    // The holder's words, once, on a card whose descriptor names them, and never
    // on another agent's card: a comment wakes the agent that holds it.
    const hold = c.state === "open" ? c.hold : undefined;
    const named = (body.unblockDescriptor as { action?: string } | undefined)?.action ?? (status === this.statusName("blocked") ? this.blockAction.get(id) : undefined);
    const holder = "assigneeAgentId" in body ? body.assigneeAgentId : have?.assigneeAgentId ?? null;
    const seen = hold?.commentUrl ? `${id} ${hold.commentUrl}` : "";
    if (hold?.comment && hold.commentUrl && named === hold.action && !this.holdCommented.has(seen) && (!holder || holder === this.cfg.agentId)) {
      const r = await this.safeCall("read comments", () => this.client.getIssueComments(id), id);
      if (r.ok && (Array.isArray(r.value) ? r.value : []).some((x) => isHoldComment(x.body, { comment: hold.comment!, url: hold.commentUrl! }))) this.holdCommented.add(seen);
      else if (r.ok) {
        body.comment = redactComment(hold.comment, this.secrets);
        // A board user's comment on a blocked card reopens it unless the same request restates the status.
        body.status ??= status;
      }
    }
    // Backfill: a card that predates the issue label gets it once, whatever its stage.
    if (!("labelIds" in body) && have && (await this.needsIssueLabel(id, have))) {
      const labelIds = await this.labelIdsFor(id, undefined);
      if (labelIds) body.labelIds = labelIds;
    }
    if (!Object.keys(body).length || budget.left <= 0) return;
    budget.left--;
    const holderAgent = body.comment && hold?.author ? await this.agentForLogin(hold.author) : null;
    if (!(await this.patch(id, body, holderAgent ? `agent:${holderAgent}` : null))) return;
    if (body.comment) {
      this.holdCommented.add(seen);
      this.lastNote.set(id, String(body.comment));
    }
    if (typeof body.status === "string") {
      status = body.status;
      this.rowState.set(id, `status:${status}`);
    }
    const unblock = body.unblockDescriptor as { action: string } | undefined;
    if (unblock) this.blockAction.set(id, unblock.action);
    this.rowContent.set(id, {
      title: want.title,
      description: want.description,
      assigneeAgentId: "assigneeAgentId" in body ? null : have?.assigneeAgentId ?? null,
      assigneeUserId: "assigneeUserId" in body ? null : have?.assigneeUserId ?? null,
      ...(Array.isArray(body.labelIds) ? { labelIds: body.labelIds as string[] } : have?.labelIds ? { labelIds: have.labelIds } : {}),
    });
  }

  /**
   * True when the card's block came from GitHub's blocked label: this process
   * moved it there, or (after a restart) it carries the action only that move
   * writes, or its latest note is the one that move posts. A Foreman block
   * names its reason and ends on its own note, so it never reads so. The note
   * alone is not enough: a later run note buried it on jerky_service #132/#133,
   * which sat Blocked behind a lifted label until Ray asked (2026-10-14).
   */
  private async blockedByLabel(id: string): Promise<boolean> {
    if (this.blockedAt.has(id)) return false;
    if (this.labelBlocked.has(id)) return true;
    const action = this.blockAction.get(id);
    if (action === LABEL_BLOCK_ACTION || action?.startsWith(HOLD_PREFIX)) return true;
    const prefix = fill(PAPERCLIP_STEPS.synced.note, { detail: "" }).trim();
    return (await this.latestComment(id))?.startsWith(prefix) === true;
  }

  async onMerged(item: WorkItem, _repoConfig?: unknown, _logger?: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (id) await this.note(id, PAPERCLIP_STEPS.merged.note, { event: "progress", tag: "merged" });
  }

  /**
   * A release PR opened (rows → in_review, waiting on it), merged (→ done) or
   * closed unmerged (a note; the rows stay in_review for the next release). A
   * merge with no PR is work found already in production (→ done).
   */
  async onRelease(event: ReleaseEvent, _logger: Logger): Promise<void> {
    const vars = { pr: event.pr === undefined ? "?" : String(event.pr), branch: event.productionBranch };
    // An owned release PR's items are `releasing` (the SRE's seat): an `open` re-announce
    // (a restart, a changed issue list) must not pull them back to `awaitingRelease`.
    const step = event.state === "open" ? (event.owned ? PAPERCLIP_STEPS.releaseQueued : PAPERCLIP_STEPS.releaseWaiting)
      : event.state === "closed" ? PAPERCLIP_STEPS.releaseClosed
      : event.pr === undefined ? PAPERCLIP_STEPS.inProduction : PAPERCLIP_STEPS.released;
    for (const item of event.issues) {
      if (sameItem(this.building, item)) this.building = null;
      this.claimed.delete(this.keyOf(item));
      const id = await this.resolve(item, false);
      if (!id) continue;
      // A release PR's body can name an issue already closed: an open release
      // never pulls its card out of done or cancelled (the snapshot places it
      // once GitHub reads it open).
      if (event.state === "open" && this.isClosedCard(id)) continue;
      if (step.stage && !(await this.move(id, step.stage))) continue;
      await this.note(id, fill(step.note, vars), { event: "release", handoff: handoffTo(step.stage, item) });
    }
  }

  /**
   * Housekeeping, now and every index refresh after: cancel the retired live
   * task and backfill each row's project. Started by the daemon, never inside
   * an observer call, which a full pass over every row would outlast. Returns
   * a stop function.
   */
  start(): () => void {
    const run = () => void this.housekeep();
    this.recovery = this.recoverLease();
    void this.recovery.then(run);
    const timer = setInterval(run, INDEX_TTL_MS);
    timer.unref?.();
    const renew = setInterval(() => {
      if (this.holds.size) void this.writeLease();
    }, LEASE_RENEW_MS);
    renew.unref?.();
    return () => {
      clearInterval(timer);
      clearInterval(renew);
    };
  }

  /**
   * Return every card the last process's lease still names to the stage its
   * session came from: this process has no session yet, so a card shown in
   * progress for one belongs to a session that died with it. Then write an
   * empty lease. Never throws.
   */
  async recoverLease(): Promise<void> {
    if (!this.cfg.agentId) return;
    const agent = await this.safeCall("read agent", () => this.client.getAgent(this.cfg.agentId!));
    if (!agent.ok) return;
    const { [LIVE_LEASE_KEY]: lease, ...rest } = (agent.value?.metadata ?? {}) as Record<string, unknown>;
    this.agentMetadata = rest;
    const inProgress = this.statusName("in_progress");
    for (const r of (lease as Partial<LiveLease> | undefined)?.rows ?? []) {
      if (!r?.id || this.holds.has(r.id) || !(r.phase in SESSION_FALLBACK_STAGE)) continue;
      const row = await this.safeCall("read task", () => this.client.getIssue(r.id), r.id);
      if (!row.ok || row.value?.status !== inProgress) continue;
      await this.move(r.id, SESSION_FALLBACK_STAGE[r.phase]);
    }
    await this.writeLease();
  }

  /**
   * The lease: the cards held right now, stamped now. Paperclip replaces the
   * whole metadata object, so the agent's other keys are read fresh before every
   * write: a key someone else set since (githubLogin, by the EM's github-login.mjs)
   * survives, and only the lease and the published config are the Foreman's.
   * Unread, the lease is not written. Never throws.
   */
  private async writeLease(): Promise<boolean> {
    if (!this.cfg.agentId) return false;
    const agent = await this.safeCall("read agent", () => this.client.getAgent(this.cfg.agentId!));
    if (!agent.ok) return false;
    const { [LIVE_LEASE_KEY]: _old, ...rest } = (agent.value?.metadata ?? {}) as Record<string, unknown>;
    const config = this.agentMetadata?.[CONFIG_KEY];
    this.agentMetadata = config === undefined ? rest : { ...rest, [CONFIG_KEY]: config };
    const lease: LiveLease = {
      leaseAt: new Date().toISOString(),
      rows: [...this.holds].map(([id, h]) => ({ id, phase: h.phase })),
    };
    const r = await this.safeCall("update agent", () =>
      this.client.updateAgent(this.cfg.agentId!, { metadata: { ...(this.agentMetadata ?? {}), [LIVE_LEASE_KEY]: lease } }));
    return r.ok;
  }

  /**
   * Take a reloaded config: the board mapping, roles, labels and comments follow
   * it from the next move on. A change to what names the company, the agent or a
   * task's identity needs a restart, so that config is refused, the running one
   * kept, and false returned.
   */
  reconfigure(next: PaperclipConfig): boolean {
    const fixed = ["enabled", "url", "companyId", "agentId", "identityKeyFormat"] as const;
    const changed = fixed.filter((k) => next[k] !== this.cfg[k]);
    if (changed.length) {
      this.logger.warn(`paperclip: config reload changes ${changed.join(", ")}; restart the Foreman to apply it. The mirror keeps the config it started with.`);
      return false;
    }
    this.cfg = next;
    this.comments = commentsOf(next);
    this.stageLabelIds = null;
    this.issueLabelId = undefined;
    return true;
  }

  /**
   * Publish the config file this process runs on its agent's metadata
   * (`foremanConfig`), so anything else that places the same cards reads the
   * Foreman's mapping instead of a copy of it. `text` is the file as loaded; it
   * is stored less its trailing newline and hashed that way. Refused, with a
   * warning, when the file holds a secret-shaped key or a known secret value.
   * Unchanged text writes nothing. Never throws.
   */
  async publishConfig(text: string): Promise<void> {
    if (this.cfg.publishConfig === false || !this.cfg.agentId) return;
    const body = text.replace(/\n+$/, "");
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 === this.publishedSha) return;
    const refusal = configSecretRefusal(body, this.secrets);
    if (refusal) {
      this.logger.warn(`paperclip: config not published: ${refusal}`);
      return;
    }
    await this.recovery;
    if (this.agentMetadata === null) {
      const agent = await this.safeCall("read agent", () => this.client.getAgent(this.cfg.agentId!));
      if (!agent.ok) return;
      const { [LIVE_LEASE_KEY]: _old, ...rest } = (agent.value?.metadata ?? {}) as Record<string, unknown>;
      this.agentMetadata = rest;
    }
    // The lease write carries every other key, so the config rides on it.
    this.agentMetadata = { ...this.agentMetadata, [CONFIG_KEY]: { sha256, publishedAt: new Date().toISOString(), text: body } };
    if (await this.writeLease()) {
      this.publishedSha = sha256;
      this.logger.info(`paperclip: published config sha256=${sha256.slice(0, 12)}`);
    }
  }

  /** One housekeeping pass; never throws. */
  async housekeep(): Promise<void> {
    if (this.housekeeping) return;
    this.housekeeping = true;
    try {
      if (!(await this.ensureIndex(true))) return;
      await this.retireLiveTask();
      if (this.cfg.ownsCards === true) {
        await this.retireDuplicates();
        await this.backfillIssueLabels();
      }
    } finally {
      this.housekeeping = false;
    }
  }

  /**
   * The issue label onto every card of a served repo the last scan found without
   * it (`ownsCards`), whatever its issue's state or age: a closed issue the
   * snapshot no longer carries, or cards beyond a snapshot's write cap, still
   * get it. Only the label changes; at most CARD_WRITES_PER_SNAPSHOT a pass.
   */
  private async backfillIssueLabels(): Promise<void> {
    const dup = new Set(this.duplicates.map((d) => d.id));
    let left = CARD_WRITES_PER_SNAPSHOT;
    for (const [id, have] of this.rowContent) {
      if (left <= 0) return;
      const repo = this.rowRepo.get(id);
      if (!repo || !this.snapshotRepos.has(repo) || dup.has(id)) continue;
      if (this.cfg.repos && !this.cfg.repos.includes(repo)) continue;
      if (!(await this.needsIssueLabel(id, have))) continue;
      const labelIds = await this.labelIdsFor(id, undefined);
      if (!labelIds) continue;
      left--;
      await this.patch(id, { labelIds });
    }
  }

  /**
   * Retire every second card the last scan found for an issue in a mirrored
   * repo (`ownsCards`): cancelled, nobody's, its identity line rewritten to name
   * the card that stays so no writer adopts it again, its title saying so, and a
   * note — one PATCH each, at most RETIRES_PER_PASS a pass.
   */
  private async retireDuplicates(): Promise<void> {
    const cancelled = this.statusName("cancelled");
    let left = RETIRES_PER_PASS;
    for (const d of this.duplicates) {
      if (left-- <= 0) break;
      if (this.cfg.repos && !this.cfg.repos.includes(d.repo)) continue;
      const tag = `[duplicate of ${d.winner}] `;
      const r = await this.safeCall("retire duplicate", () => this.client.updateIssue(d.id, {
        status: cancelled,
        assigneeAgentId: null,
        assigneeUserId: null,
        title: d.title.startsWith(tag) ? d.title : `${tag}${d.title}`,
        description: `duplicate of ${d.winner} (${d.key})`,
        comment: fill(DUPLICATE_NOTE, { key: d.key, winner: d.winner }),
      }, this.ownComment()), d.id);
      if (r.ok) this.log("info", `Paperclip mirror: retired a second card for ${d.key}; ${d.winner} stays`);
    }
    this.duplicates = [];
  }

  /** Cancel the live summary task an earlier version kept, once. */
  private async retireLiveTask(): Promise<void> {
    if (!this.cfg.agentId) return;
    const id = this.index?.get(fill(LEGACY_LIVE_KEY_FORMAT, { agentId: this.cfg.agentId }));
    if (!id) return;
    const row = await this.safeCall("read task", () => this.client.getIssue(id), id);
    const cancelled = this.statusName("cancelled");
    if (!row.ok || row.value?.status === cancelled) return;
    // Status and note in one PATCH: a note alone on an agent-held row reopens it.
    await this.safeCall("retire live task", () => this.client.updateIssue(id, { status: cancelled, comment: LEGACY_LIVE_NOTE }, this.ownComment()), id);
  }

  /**
   * The id of the one project whose description line 1 is `roadmap-position:
   * unplaced` — where every task the Foreman creates is filed; the EM's sync
   * then places it in its roadmap position's project (EM #513). The Foreman
   * never creates a project and never moves a task between projects. Only a
   * found id is kept: none, two or more, or a failed listing is looked up again
   * on the next call, with one warn per count per process.
   */
  private unplacedProjectId(): Promise<string | null> {
    if (this.unplacedLookup) return this.unplacedLookup;
    const lookup = (async () => {
      const listed = await this.safeCall("list projects", () => this.client.listProjects());
      if (!listed.ok) return null;
      const found = (Array.isArray(listed.value) ? listed.value : []).filter(
        (p) => (p.description ?? "").split("\n")[0] === "roadmap-position: unplaced",
      );
      if (found.length === 1) return found[0].id;
      const once = `unplaced ${found.length}`;
      if (!this.rejectionsLogged.has(once)) {
        this.rejectionsLogged.add(once);
        this.log("warn", `Paperclip mirror: Unplaced project not found: found ${found.length} projects whose description line 1 is "roadmap-position: unplaced"`);
      }
      return null;
    })();
    this.unplacedLookup = lookup;
    void lookup.then((id) => {
      if (!id) this.unplacedLookup = null;
    });
    return lookup;
  }

  async onBackoffPause(upstream: string, reason: string, _logger: Logger): Promise<void> {
    if (!this.building) return;
    const id = await this.resolve(this.building, false);
    if (id) await this.note(id, fill(PAPERCLIP_STEPS.backoffPause.note, { upstream, reason }), { event: "progress" });
  }

  async onBackoffResume(_upstream: string, _logger: Logger): Promise<void> {
    if (!this.building) return;
    const id = await this.resolve(this.building, false);
    if (id) await this.note(id, PAPERCLIP_STEPS.backoffResume.note, { event: "progress" });
  }

  /**
   * `repo`'s full waiting set this cycle. A row newly waiting, or waiting for a
   * new reason, goes blocked with the reason as its unblock descriptor and one
   * note; a row this agent had blocked in `repo` that is not in the set goes
   * back to in_progress with one note. A row already showing what it should is
   * not touched, however many cycles repeat it.
   */
  async onWaiting(repo: string, waiting: ReadonlyArray<WaitingItem>, _logger: Logger): Promise<void> {
    const cleaned = waiting.map((w) => ({ item: w.item, reason: this.clean(w.reason), skipped: w.skipped === true }));

    const keep = new Set<string>();
    for (const w of cleaned) {
      const id = await this.resolve(w.item, false);
      if (!id) continue;
      keep.add(id);
      // A card a session holds is not waiting, whatever this cycle's plan says.
      if (this.holds.has(id)) continue;
      // Nor is one whose issue GitHub reads closed: the Foreman's own state can lag the close.
      if (this.closedCards.has(id)) continue;
      // A skip in its back-off needs a person: it is in (or goes to) the
      // blocked stage, held by that stage's owner. Re-blocking it as a
      // Foreman-held wait took it from that owner every cycle (EM #417).
      if (w.skipped) {
        if (this.rowState.get(id) === `status:${this.statusName("blocked")}`) continue;
        const text = fill(PAPERCLIP_STEPS.blocked.note, { reason: w.reason });
        this.blockedReason.set(id, text);
        this.blockedOwner.delete(id);
        if (await this.move(id, PAPERCLIP_STEPS.blocked.stage)) await this.note(id, text, { event: "blocked" });
        continue;
      }
      const want = `waiting\n${w.reason}`;
      if (this.rowState.get(id) === want) continue;
      const step = PAPERCLIP_STEPS.waiting;
      const ok = await this.patch(id, {
        status: this.statusName("blocked"),
        assigneeAgentId: this.cfg.agentId,
        assigneeUserId: null,
        unblockDescriptor: { owner: this.cfg.agentId ? { agentId: this.cfg.agentId } : "board", action: w.reason },
      });
      if (!ok) continue;
      this.rowState.set(id, want);
      await this.note(id, fill(step.note, { reason: w.reason }), { event: "progress" });
    }

    if (await this.ensureIndex()) {
      for (const [id, state] of this.rowState) {
        if (keep.has(id) || !state.startsWith("waiting\n") || this.rowRepo.get(id) !== repo) continue;
        if (!(await this.move(id, this.rowStage.get(id) ?? "approved"))) continue;
        await this.note(id, PAPERCLIP_STEPS.resumed.note, { event: "progress" });
      }
    }
  }

  /** A session started, changed hands or ended: one note per item, then the agent's status. */
  async onSession(event: SessionEvent, _logger: Logger): Promise<void> {
    await this.recovery;
    const key = `${event.repo}|${event.phase}|${event.items.map((i) => i.issueNumber).join(",")}`;
    if (event.status === "started") this.sessions.set(key, { event, since: new Date() });
    else if (event.status === "handoff") {
      const s = this.sessions.get(key);
      this.sessions.set(key, { event: { ...(s?.event ?? event), reviewer: event.reviewer }, since: s?.since ?? new Date() });
    } else this.sessions.delete(key);

    const phase = event.phase as SessionPhase;
    const step = SESSION_STEP[`${event.phase}:${event.status}`];
    const opts: NoteOpts = { event: sessionCommentEvent(event), tag: "session" };
    const legacy = step && fill(step.note, {
      pr: event.pr === undefined ? "?" : String(event.pr),
      reviewer: event.reviewer ?? "reviewer",
      detail: this.clean(event.detail ?? "") || event.status,
    });
    let leaseChanged = false;
    for (const item of event.items) {
      const id = await this.resolve(item, false);
      if (!id) continue;
      const retry = event.phase === "implement" && event.status === "started" && this.retrying.has(this.keyOf(item));
      // The step notes speak for the item worked; an untouched one gets none.
      const text = this.comments.enabled ? sessionComment(event, item, this.comments, retry) : untouched(event, item) ? undefined : legacy;
      // What the next handoff on this card cites: the PR, and this session's outcome.
      const pr = event.report?.pr ?? (event.pr !== undefined ? { number: event.pr } : undefined);
      if (pr && !untouched(event, item)) this.prOf.set(id, { number: pr.number, ...(pr.url ? { url: pr.url } : {}) });
      if (event.status === "started") this.evidence.delete(id);
      else if ((event.status === "finished" || event.status === "failed") && !untouched(event, item)) {
        const said = this.clean(outcomeOf(event));
        this.evidence.set(id, { text: said.length > EVIDENCE_CAP ? `${said.slice(0, EVIDENCE_CAP - 1)}…` : said, at: new Date().toISOString() });
      }
      // The stage this session's note hands the card to: on the end, the stage
      // it returns to, unless a state reported meanwhile moves it (that state's
      // deferred note carries it). A start hands nothing over: the session runs
      // on the seat that already holds the card, and its note names who.
      let handoff: NoteOpts["handoff"];
      let released = false;
      if (event.status === "started" && phase in SESSION_STAGE) {
        const h = this.holds.get(id);
        if (h) h.count++;
        else {
          // The card takes the session's stage first (the claim may already
          // have put it there), then is held there.
          const stage = SESSION_STAGE[phase];
          const placed = (this.rowStage.get(id) === stage && this.rowState.get(id) === `status:${this.statusName(stageTarget(this.cfg, stage).bucket)}`)
            || await this.move(id, stage);
          this.holds.set(id, { count: 1, phase, restore: null, placed });
        }
        leaseChanged = true;
      } else if (event.status === "finished" || event.status === "failed") {
        const h = this.holds.get(id);
        if (h && --h.count <= 0) {
          this.holds.delete(id);
          await this.move(id, h.restore ?? SESSION_FALLBACK_STAGE[h.phase]);
          if (h.restore === null) handoff = handoffTo(SESSION_FALLBACK_STAGE[h.phase], item);
          leaseChanged = true;
          released = true;
        }
      }
      if (text) await this.note(id, text, handoff ? { ...opts, handoff } : opts);
      if (released) await this.flushDeferred(id, event);
    }
    if (leaseChanged) await this.writeLease();
    await this.syncAgentStatus();
  }

  /**
   * A running review reached a new stage: the checklist so far, on each
   * item's card. Summaries only (`comments.enabled`), under the `progress`
   * toggle; posted at once, like the session's own notes, not held behind it.
   */
  async onReviewProgress(pr: number, items: ReadonlyArray<WorkItem>, milestones: ReadonlyArray<ReviewMilestone>): Promise<void> {
    if (!this.comments.enabled || !this.comments.events.progress || milestones.length === 0) return;
    await this.recovery;
    const text = reviewProgressComment(pr, milestones);
    for (const item of items) {
      const id = await this.resolve(item, false);
      if (id) await this.note(id, text, { event: "progress", tag: "session" });
    }
  }

  /** The agent's status: running while any session runs, else idle. Written only on a change. */
  private async syncAgentStatus(): Promise<void> {
    if (!this.cfg.agentStatus || !this.cfg.agentId) return;
    const want = this.sessions.size ? "running" : "idle";
    if (this.agentStatusSent === want) return;
    const r = await this.safeCall("update agent", () => this.client.updateAgent(this.cfg.agentId!, { status: want }));
    if (r.ok) this.agentStatusSent = want;
  }

  /** A reason or detail fit to write: secrets redacted, one paragraph, capped. */
  private clean(text: string): string {
    const one = redactComment(String(text), this.secrets).replace(/\s+/g, " ").trim();
    return one.length > TEXT_CAP ? `${one.slice(0, TEXT_CAP - 1)}…` : one;
  }

  /** `identityKeyFormat` for `item`: the first line of its task's description. */
  private keyOf(item: WorkItem): string {
    return this.cfg.identityKeyFormat
      .split("{repo}").join(item.repo)
      .split("{N}").join(String(item.issueNumber));
  }

  private statusName(bucket: Bucket): string {
    return statusName(this.cfg, bucket);
  }

  /**
   * The task id for `item`. A cache miss scans the company's tasks; a lookup
   * that may create always scans fresh, so a row another writer added since the
   * last scan is adopted rather than duplicated. Null when Paperclip failed, or
   * when there is no row and `create` is false.
   */
  private async resolve(item: WorkItem, create: boolean): Promise<string | null> {
    const key = this.keyOf(item);
    const cached = this.taskUuidCache.get(key);
    if (cached) return cached;

    if (!(await this.ensureIndex(create))) return null;

    let found = this.index?.get(key);
    if (!found && !create && Date.now() - this.indexedAt > MISS_RESCAN_MS && (await this.ensureIndex(true))) {
      found = this.index?.get(key);
    }
    if (found) {
      this.taskUuidCache.set(key, found);
      return found;
    }
    if (!create) return null;
    const [owner = "", name = ""] = item.repo.split("/");
    return this.createTask(item, {
      title: fill(this.cfg.taskTitleFormat ?? PAPERCLIP_TASK_TITLE_FORMAT, { repo: item.repo, owner, name, N: String(item.issueNumber) }),
      description: `${key}\n\nhttps://github.com/${item.repo}/issues/${item.issueNumber}`,
      status: this.statusName(PAPERCLIP_CREATE_STATUS),
    });
  }

  /** Create `item`'s task, filed where every task the Foreman creates goes; its id, or null. */
  private async createTask(item: WorkItem, content: { title: string; description: string; status: string }): Promise<string | null> {
    // An explicit project wins; the Unplaced lookup files nothing until it finds one.
    const unplaced = !this.cfg.projectId && this.cfg.projects;
    const projectId = this.cfg.projectId ?? (unplaced ? await this.unplacedProjectId() : null);
    if (unplaced && !projectId) return null;
    const made = await this.safeCall("create task", () =>
      this.client.createIssue({ ...content, ...(projectId ? { projectId } : {}) }),
    );
    if (!made.ok || !made.value?.id) return null;
    const id = made.value.id;
    const key = this.keyOf(item);
    this.taskUuidCache.set(key, id);
    this.index?.set(key, id);
    this.rowRepo.set(id, item.repo);
    this.rowNumber.set(id, item.issueNumber);
    this.rowState.set(id, `status:${content.status}`);
    this.rowContent.set(id, { title: content.title, description: content.description, assigneeAgentId: null, assigneeUserId: null });
    return id;
  }

  /**
   * Make sure a scan of the company's tasks is at hand: a fresh one when
   * `fresh`, else the last one while it is young. Each scan also re-reads what
   * every issue row shows, so a restart picks up rows it had blocked. False
   * when Paperclip failed and there is no index to fall back on.
   */
  private async ensureIndex(fresh = false): Promise<boolean> {
    if (!fresh && this.index && Date.now() - this.indexedAt <= INDEX_TTL_MS) return true;
    const keyRe = this.keyPattern();
    const cancelled = this.statusName("cancelled");
    const scanned = await this.safeCall("scan tasks", async () => {
      const idx = new Map<string, string>();
      const state = new Map<string, string>();
      const repoOf = new Map<string, string>();
      const numberOf = new Map<string, number>();
      const actions = new Map<string, string>();
      const content = new Map<string, RowContent>();
      const duplicates: Duplicate[] = [];
      const byLine = new Map<string, PaperclipIssue[]>();
      for await (const row of this.client.listIssues()) {
        const line = String(row.description ?? "").split("\n")[0].trim();
        if (!line) continue;
        byLine.set(line, [...(byLine.get(line) ?? []), row]);
      }
      for (const [line, rows] of byLine) {
        const row = pickCard(rows, cancelled)!;
        idx.set(line, row.id);
        const m = keyRe.exec(line);
        if (!m?.groups) continue;
        for (const r of rows) {
          if (r !== row) duplicates.push({ id: r.id, key: line, repo: m.groups.repo, winner: row.identifier || row.id, title: String(r.title ?? ""), status: r.status });
        }
        repoOf.set(row.id, m.groups.repo);
        numberOf.set(row.id, Number(m.groups.N));
        content.set(row.id, {
          title: String(row.title ?? ""), description: String(row.description ?? ""),
          assigneeAgentId: row.assigneeAgentId ?? null, assigneeUserId: row.assigneeUserId ?? null,
          ...(Array.isArray(row.labelIds) ? { labelIds: row.labelIds } : {}),
        });
        const action = row.unblockDescriptor?.action;
        // A Foreman-held blocked row is a waiting hold, unless the Foreman blocked it for good.
        const blocked = row.status === this.statusName("blocked") && row.assigneeAgentId === this.cfg.agentId
          && !String(action ?? "").startsWith(FOREMAN_BLOCKED_PREFIX);
        state.set(row.id, blocked && action ? `waiting\n${action}` : blocked ? "waiting\n" : `status:${row.status}`);
        if (row.status === this.statusName("blocked") && action) actions.set(row.id, String(action));
      }
      return { idx, state, repoOf, numberOf, actions, content, duplicates };
    });
    if (!scanned.ok) return !!this.index;
    this.index = scanned.value.idx;
    this.indexedAt = Date.now();
    this.rowState.clear();
    for (const [k, v] of scanned.value.state) this.rowState.set(k, v);
    this.rowRepo.clear();
    for (const [k, v] of scanned.value.repoOf) this.rowRepo.set(k, v);
    this.rowNumber.clear();
    for (const [k, v] of scanned.value.numberOf) this.rowNumber.set(k, v);
    this.blockAction.clear();
    for (const [k, v] of scanned.value.actions) this.blockAction.set(k, v);
    this.rowContent.clear();
    for (const [k, v] of scanned.value.content) this.rowContent.set(k, v);
    this.duplicates = scanned.value.duplicates;
    // A key whose card the scan settled on differently follows it.
    for (const [key, id] of this.taskUuidCache) {
      const now = this.index.get(key);
      if (now && now !== id) this.taskUuidCache.set(key, now);
    }
    return true;
  }

  /** `identityKeyFormat` as a pattern capturing `repo` and `N`. */
  private keyPattern(): RegExp {
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const src = this.cfg.identityKeyFormat
      .split(/(\{repo\}|\{N\})/)
      .map((part) => (part === "{repo}" ? "(?<repo>[^\\s#]+/[^\\s#]+)" : part === "{N}" ? "(?<N>\\d+)" : esc(part)))
      .join("");
    return new RegExp(`^${src}$`);
  }

  /**
   * Move the card. A lifecycle stage places it by `paperclip.board`: status,
   * holder and stage label. "done" sets the status and drops the stage label,
   * leaving the holder as it was. A card a live session holds keeps its
   * session stage; the move is kept and made when the session ends. True on
   * success, and when kept.
   *
   * `assigneeUserId: null` with every assignee: Paperclip allows one assignee
   * ("Issue can only have one assignee", 422), and a sync may give the row a
   * board user, so taking the row means releasing that user. The stage label
   * is best-effort: when the labels cannot be read the status still moves.
   */
  /**
   * A held card its session's start could not move (Paperclip was down) takes
   * the session's column now. Otherwise the hold keeps every later writer off
   * it, and it shows its old column for the whole session: jerky_service #131
   * sat in To Do while the SRE verified it, after a 30-second outage
   * (2026-10-14).
   */
  private async placeHeld(id: string): Promise<void> {
    const h = this.holds.get(id);
    if (!h || h.placed) return;
    h.placed = await this.move(id, SESSION_STAGE[h.phase], true);
  }

  private async move(id: string, to: PaperclipStepMove, held = false): Promise<boolean> {
    if (to === null || to === "waiting") return true;
    const h = this.holds.get(id);
    if (h && !held) {
      if (to !== SESSION_STAGE[h.phase]) h.restore = to;
      return true;
    }
    let bucket: Bucket;
    let holder: Record<string, unknown> = {};
    let label: string | null = null;
    if (to === "done") bucket = "done";
    else {
      const t = stageTarget(this.cfg, to, to === "blocked" ? this.blockedOwner.get(id) : undefined);
      bucket = t.bucket;
      label = t.label;
      if (t.agentId) holder = { assigneeAgentId: t.agentId, assigneeUserId: null };
      // Paperclip takes `blocked` only with an unblock descriptor.
      if (bucket === "blocked") {
        // A card held on GitHub says why, as the holder wrote it (`ownsCards`).
        const action = this.blockedReason.get(id) ?? (to === "blocked" ? this.holdAction.get(id) : undefined) ?? LABEL_BLOCK_ACTION;
        holder.unblockDescriptor = { owner: t.agentId ? { agentId: t.agentId } : "board", action };
      }
    }
    const labelIds = await this.labelIdsFor(id, label);
    const ok = await this.patch(id, { status: this.statusName(bucket), ...holder, ...(labelIds ? { labelIds } : {}) });
    if (ok) {
      this.rowState.set(id, `status:${this.statusName(bucket)}`);
      const unblock = holder.unblockDescriptor as { action: string } | undefined;
      if (unblock) this.blockAction.set(id, unblock.action);
      if (to !== "done") this.rowStage.set(id, to);
      if (bucket !== "blocked") {
        this.blockedReason.delete(id);
        this.blockedOwner.delete(id);
      }
    }
    return ok;
  }

  /**
   * The card's label ids with `key`'s stage label as its only one (`key`
   * undefined: the stage labels as they are) and the issue label present
   * once; null when nothing changes or the labels cannot be read.
   */
  private async labelIdsFor(id: string, key: string | null | undefined): Promise<string[] | null> {
    this.stageLabelIds ??= (async () => {
      const r = await this.safeCall("ensure stage labels", () => ensureStageLabels(this.client, this.cfg));
      if (!r.ok) this.stageLabelIds = null;
      return r.ok ? r.value : null;
    })();
    const ids = await this.stageLabelIds;
    if (!ids) return null;
    if (!this.issueLabelId) {
      const f = await this.safeCall("ensure issue label", () => ensureIssueLabel(this.client));
      if (f.ok) this.issueLabelId = f.value;
    }
    const row = await this.safeCall("read task", () => this.client.getIssue(id), id);
    if (!row.ok) return null;
    const current = Array.isArray(row.value?.labelIds) ? row.value.labelIds : [];
    let next = key === undefined ? [...current] : withStage(current, ids, key);
    if (this.issueLabelId) next = withIssueLabel(next, this.issueLabelId);
    if (this.issueLabelId && current.includes(this.issueLabelId)) this.issueLabelled.add(id);
    return next.length === current.length && next.every((x, i) => x === current[i]) ? null : next;
  }

  /** True when the card is not yet known to carry the issue label (so a sync should write it). */
  private async needsIssueLabel(id: string, have: RowContent | undefined): Promise<boolean> {
    if (this.issueLabelled.has(id)) return false;
    if (!this.issueLabelId) {
      const f = await this.safeCall("ensure issue label", () => ensureIssueLabel(this.client));
      if (!f.ok || !f.value) return false;
      this.issueLabelId = f.value;
    }
    if (have?.labelIds?.includes(this.issueLabelId)) {
      this.issueLabelled.add(id);
      return false;
    }
    return true;
  }

  /**
   * A `comment` in `body` is credited to `commentAuthor`: null = the key's own user (a
   * person's words, or no agent with that login); omitted = the Foreman, as every write is.
   */
  private async patch(id: string, body: Record<string, unknown>, commentAuthor?: string | null): Promise<boolean> {
    const r = await this.safeCall("update task", () => this.client.updateIssue(id, body, { commentAuthor }), id);
    if (r.ok && this.issueLabelId && Array.isArray(body.labelIds) && body.labelIds.includes(this.issueLabelId)) this.issueLabelled.add(id);
    return r.ok;
  }

  /** The Foreman's own notes are its agent's words. */
  private ownComment(): { commentAuthor: string | null } {
    return { commentAuthor: this.cfg.agentId ? `agent:${this.cfg.agentId}` : null };
  }

  /** The agent whose `metadata.githubLogin` is `login`, or null. A failed read keeps the last answer. */
  private async agentForLogin(login: string): Promise<string | null> {
    if (!this.githubAgents || Date.now() - this.githubAgents.at > GITHUB_LOGINS_TTL_MS) {
      const r = await this.safeCall("read agents", () => this.client.listAgents());
      if (r.ok && Array.isArray(r.value)) {
        const byLogin = new Map<string, string>();
        for (const a of r.value) {
          const l = a.metadata?.githubLogin;
          if (typeof l === "string" && l && a.status !== "terminated") byLogin.set(l.toLowerCase(), a.id);
        }
        this.githubAgents = { at: Date.now(), byLogin };
      }
    }
    return this.githubAgents?.byLogin.get(login.toLowerCase()) ?? null;
  }

  /**
   * Post a note without moving the row. Paperclip reads a board user's comment
   * on an agent-held blocked, done or cancelled row as "please continue" and
   * moves it to todo, so a "waiting:" note un-blocked the row it had just
   * blocked (2026-10-02, first live check). On such a row the note goes in a
   * PATCH that restates the status, which Paperclip keeps.
   */
  private async note(id: string, text: string, opts: NoteOpts): Promise<void> {
    if (!this.comments.events[opts.event]) return;
    // A card a session holds gets its notes after the session's own summary.
    if (this.comments.enabled && opts.tag !== "session" && this.holds.has(id)) {
      const q = this.deferred.get(id) ?? [];
      q.push({ text, opts });
      this.deferred.set(id, q);
      return;
    }
    const handoff = opts.handoff ? this.handoffFor(id, opts.handoff.stage, opts.handoff.item, opts.handoff.owner, opts.handoff.variant) : null;
    const body = finishComment(handoff ? `${text}\n\n${handoff}` : text, this.comments, this.secrets);
    if (!body) return;
    // Never the same note twice in a row (SLA-514 got one four times).
    if ((await this.latestComment(id)) === body) return;
    const row = await this.safeCall("read task", () => this.client.getIssue(id), id);
    const status = row.ok ? row.value?.status : undefined;
    const held = (["blocked", "done", "cancelled"] as const).map((b) => this.statusName(b));
    const sent = status && held.includes(status)
      ? await this.safeCall("post note", () => this.client.updateIssue(id, { comment: body, status }, this.ownComment()), id)
      : await this.safeCall("post note", () => this.client.createComment(id, body, this.ownComment()), id);
    if (sent.ok) this.lastNote.set(id, body);
  }

  /**
   * The handoff a note to a card moved to `stage` carries: null when the
   * Foreman holds that stage. Cites the last session's outcome once, so a later
   * handoff never offers it as its reason.
   */
  private handoffFor(id: string, stage: PaperclipStage, item: WorkItem, owner?: string, variant?: HandoffVariant): string | null {
    const evidence = this.evidence.get(id);
    this.evidence.delete(id);
    const facts = this.handoffFacts(id, stage, item, evidence, owner);
    return facts ? handoffComment(stage, facts, this.labels, variant) : null;
  }

  /** What a handoff to `stage` names, or null when the Foreman holds that stage. */
  private handoffFacts(id: string | null, stage: PaperclipStage, item: WorkItem, evidence?: HandoffFacts["evidence"], owner?: string): HandoffFacts | null {
    const seat = stageSeat(this.cfg, stage, owner);
    if (!seat) return null;
    const pr = id ? this.prOf.get(id) : undefined;
    return { repo: item.repo, issueNumber: item.issueNumber, seat, ...(pr ? { pr } : {}), ...(evidence ? { evidence } : {}) };
  }

  /**
   * Post the notes deferred while a session held the card, after its summary.
   * A note the summary already says is dropped: the PR link when the summary
   * names the PR, "merged" when the review reports the merge.
   */
  private async flushDeferred(id: string, event: SessionEvent): Promise<void> {
    const q = this.deferred.get(id);
    this.deferred.delete(id);
    for (const { text, opts } of q ?? []) {
      if (opts.tag === "prLink" && event.report?.pr) continue;
      if (opts.tag === "merged" && event.report?.review?.merged) continue;
      await this.note(id, text, opts);
    }
  }

  /**
   * The task's latest comment body, read from Paperclip once per process and
   * then kept as notes are posted. Undefined when it could not be read: the
   * note is then posted, since a missed note is worse than a repeated one.
   */
  private async latestComment(id: string): Promise<string | undefined> {
    if (this.lastNote.has(id)) return this.lastNote.get(id);
    const r = await this.safeCall("read comments", () => this.client.getIssueComments(id), id);
    if (!r.ok) return undefined;
    const list: PaperclipComment[] = Array.isArray(r.value) ? r.value : [];
    let latest: PaperclipComment | undefined;
    if (list.length && list.every((c) => c.createdAt)) {
      latest = list.reduce((a, b) => (Date.parse(b.createdAt!) > Date.parse(a.createdAt!) ? b : a));
    } else latest = list[list.length - 1];
    const body = String(latest?.body ?? "").trim();
    this.lastNote.set(id, body);
    return body;
  }

  /**
   * Run one Paperclip call. Never throws. An outage (no answer, or a 5xx) is
   * logged at warn when it starts, and the next success ends it. A rejection
   * (any other 4xx) is about this call only: logged with Paperclip's reason,
   * once per task and status code, and it neither starts nor ends an outage.
   */
  private async safeCall<T>(what: string, fn: () => Promise<T>, taskId = ""): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await fn();
      if (this.outageLogged) {
        this.outageLogged = false;
        this.log("info", "Paperclip mirror: Paperclip reachable again");
      }
      return { ok: true, value };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err instanceof PaperclipClientError ? err.status : 0;
      if (status >= 400 && status < 500) {
        const once = `${taskId} ${what} ${status}`;
        if (!this.rejectionsLogged.has(once)) {
          this.rejectionsLogged.add(once);
          const reason = err instanceof PaperclipClientError ? reasonOf(err.body) : "";
          this.log("warn", redactAll(`Paperclip mirror: ${what} rejected: ${msg}${reason ? ` — ${reason}` : ""}`, this.secrets));
        }
      } else if (!this.outageLogged) {
        this.outageLogged = true;
        this.log("warn", `Paperclip mirror: ${what} failed, Paperclip looks down; logged again only after it answers: ${redactAll(msg, this.secrets)}`);
      }
      return { ok: false };
    }
  }

  private log(level: "info" | "warn", msg: string): void {
    try {
      this.logger[level](msg);
    } catch {
      // a broken logger must not turn a skipped note into a thrown error
    }
  }
}

/** Paperclip's error text from a response body (`{ error }` JSON), or the body trimmed. */
function reasonOf(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const e = j?.error ?? j?.message;
    if (typeof e === "string") return e.slice(0, 300);
  } catch {
    // not JSON: fall through to the raw body
  }
  return body.trim().slice(0, 300);
}

function sameItem(a: WorkItem | null, b: WorkItem): boolean {
  return !!a && a.repo === b.repo && a.issueNumber === b.issueNumber;
}

/** Why a config text must not be published, or null: a secret-shaped key holding a value, or a known secret's value anywhere in it. */
export function configSecretRefusal(text: string, secrets: ReadonlyArray<{ name: string; value: string }>): string | null {
  for (const s of secrets) if (s.value && text.includes(s.value)) return `it contains the value of ${s.name}`;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return "it is not JSON"; }
  const found: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const at = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k) && typeof x === "string" && x.length > 0) found.push(at);
      walk(x, at);
    }
  };
  walk(parsed, "");
  return found.length ? `secret-shaped key ${found.join(", ")}` : null;
}

const SECRET_KEY = /(api[_-]?key|token|secret|password)$/i;
