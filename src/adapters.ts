import type { RepoConfig, AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Stage, StageOrDone, Transition } from "./lifecycle.js";
import type { ReviewMilestone } from "./review-progress.js";
import type { UnstickKind } from "./unstick.js";

/**
 * One unit of work a source hands to the pipeline. Deliberately minimal: the
 * stage that receives it fetches whatever detail it needs from the source
 * itself, so a non-GitHub source (EM#417) never has to fake a GitHub shape.
 */
export interface WorkItem {
  issueNumber: number;
  repo: string;
}

/**
 * The states the Foreman itself may move a work item into. There is no
 * ready-for-release member, on purpose: the release gate is the EM's
 * verification and signature (separation of duties, 2026-07-27), and a
 * connector refuses any target outside this set. `released` is the close: the
 * Foreman makes it only after the SRE's prod verification passed (EM#578;
 * before that, closing was the EM's act).
 */
export type WorkState =
  | "queued" | "inReview" | "changesRequested" | "merged" | "approved"
  | "releasing" | "prodVerifyHeld" | "released";

/**
 * What the caller believes the item's state is before the report. `unknown`
 * tells the connector to read the current state first and move only what is
 * actually there (dead-zone recovery, orphan release). `releaseAuthorized` is
 * the EM's release authorization: a state the Foreman reads, never writes.
 * `released` is a closed item whose 30-minute soak then held (EM#578). `approved` is a dev-verified item the
 * EM sent back for a QA re-run (slashbin-ai-foreman#158).
 */
export type PriorState =
  | "new" | "inReview" | "changesRequested" | "merged" | "approved" | "unknown"
  | "releaseAuthorized" | "releasing" | "prodVerifyHeld" | "released";

/**
 * Where the Foreman's work comes from, and where its lifecycle is recorded.
 * The implement stage asks the source which items to build this pass; every
 * later event on an item goes back through `record`, the same event every
 * observer receives. GitHub issues are the first connector
 * (`GitHubIssueConnector` in github-work-source.ts); this module must stay
 * free of any source-specific code so another connector can import it alone.
 *
 * PR-level operations (open / merge / review a PR, PR labels and comments,
 * branch sync, promotion) are code-host work, not work-source reporting, and
 * stay outside this interface.
 */
export interface WorkSourceAdapter {
  selectWork(
    repoConfig: RepoConfig,
    config: AgentConfig,
    logger: Logger,
  ): Promise<WorkItem[]>;

  /**
   * The items `selectWork` last left out because of a hold the source judged on the
   * item itself (an unmet acceptance requirement), each with its reason, for the
   * cycle's waiting set. Optional: a source with no such holds omits it.
   */
  heldWork?(repoConfig: RepoConfig): ReadonlyArray<WaitingItem>;

  /**
   * Record `event` on the source. Resolves `true` when the source recorded a
   * change, `false` when it wrote nothing (already there, no longer open, a
   * failed write, or an event this source keeps no record of). Never throws.
   * An `observed` transition is never passed here: the source already shows it.
   */
  record(event: WorkEvent, repoConfig: RepoConfig, logger: Logger): Promise<boolean>;

  /**
   * Every open item in the lifecycle and the stage the source shows it at,
   * with the source's own words for that state (`detail`), for observers to
   * reconcile to. Items outside the lifecycle are left out.
   */
  snapshot(repoConfig: RepoConfig, logger: Logger): Promise<SnapshotItem[]>;

  /**
   * Every item a card exists for, for an observer that owns the cards
   * (`WorkObserver.wantsCards`): each open item, in the lifecycle or not, and
   * the items closed since the last read. Optional: a source without it gives
   * observers no cards. Never throws; a failed read gives what it could.
   */
  cards?(repoConfig: RepoConfig, logger: Logger): Promise<SnapshotCard[]>;

  /**
   * The items closed since the last read, with how they closed, for an
   * observer that does not own the cards (`cards` carries them when one does).
   * Optional. Never throws; a failed read gives what it could.
   */
  closed?(repoConfig: RepoConfig, logger: Logger): Promise<SnapshotClosed[]>;

  /**
   * Whether each of `issueNumbers` is open or how it closed, read live, not
   * from the open-issue view a snapshot is built from: that view can carry a
   * closed issue with its old labels (cmneb_data_receiver#218, 2026-10-15).
   * A number that cannot be read is left out. Optional. Never throws.
   */
  states?(repoConfig: RepoConfig, issueNumbers: readonly number[], logger: Logger): Promise<Map<number, ItemState>>;
}

/** An item open, or how it closed. */
export type ItemState = "open" | "completed" | "not_planned";

/** An item the source closed, and how. */
export interface SnapshotClosed {
  readonly item: WorkItem;
  readonly state: "completed" | "not_planned";
}

/**
 * Why the source holds an item, as its holder said it (GitHub: the comment the
 * person who added the blocked label posted with it). `action` is the line a
 * card shows; `comment` the holder's full words, posted once; `commentUrl`
 * where they are; `author` the holder's login on the source, which a mirror
 * credits the comment to. The last three are null when the holder posted no reason.
 */
export interface SnapshotHold {
  readonly action: string;
  readonly comment: string | null;
  readonly commentUrl: string | null;
  readonly author?: string | null;
}

/** One item as the work source shows it at the end of a cycle. */
export interface SnapshotCard {
  readonly item: WorkItem;
  readonly title: string;
  readonly url: string;
  /** Open, or how it closed. */
  readonly state: ItemState;
  /** An open item's lifecycle stage; null when it is in none (not approved). Null when closed. */
  readonly stage: StageOrDone | null;
  /** An open held item's reason, when it was read. */
  readonly hold?: SnapshotHold;
}

/** One lifecycle item as the work source shows it at the end of a cycle. */
export interface SnapshotItem {
  readonly item: WorkItem;
  readonly stage: StageOrDone;
  /** What the source shows, in its own terms (GitHub: the issue's labels). */
  readonly detail: string;
  /** A verify session gave up on it and holds it: the block stands at `merged`. */
  readonly verifyHeld?: boolean;
  /**
   * Whether the Foreman's own state still holds this item (a skip, a review or
   * verify hold, a failed revision, an unstick entry, a branch block, a release
   * in flight). `false`: it holds nothing, so a Blocked card with no GitHub hold
   * behind it is stale. Absent: not read; nothing is inferred.
   */
  readonly foremanHeld?: boolean;
}

/**
 * Everything the Foreman does to a work item, and everything else an observer
 * may show: one event type, delivered to the work source (`record`) and to
 * every observer (`onEvent`) in the same order. A `transition` is a move from
 * the lifecycle table (lifecycle.ts); `observed` marks one the source already
 * shows, because something outside the Foreman made it (a review agent wrote
 * the outcome label), so only observers hear of it.
 */
export type WorkEvent =
  | { readonly kind: "claim"; readonly item: WorkItem }
  | ({ readonly kind: "transition"; readonly item: WorkItem; readonly observed: boolean } & Readonly<Transition>)
  | { readonly kind: "prLink"; readonly item: WorkItem; readonly prUrl: string }
  /** `owner`: who the hold belongs to when not the stage's owner (the EM): `sre` for a failed dev deploy, which is infrastructure. */
  | { readonly kind: "blocked"; readonly item: WorkItem; readonly reason: string; readonly owner?: "sre"; readonly stuck?: UnstickKind }
  /**
   * Dev verification of `item` waits on something that clears by itself (the deploy
   * is still building, or the SRE could not run) and resumes on its own. Not a
   * block: no person is needed, so the card stays in review with the reason.
   */
  | { readonly kind: "verifyWaiting"; readonly item: WorkItem; readonly reason: string }
  /**
   * Work on `item` stopped for the EM's ruling: revision of its PR (resumes once
   * a ruling is posted on the PR), or a skip that used up its attempts (resumes
   * once the issue changes). `at` is the GitHub stage the hold belongs to.
   * absent, `changesRequested`, where revise escalates.
   */
  | { readonly kind: "escalated"; readonly item: WorkItem; readonly reason: string; readonly at?: Stage; readonly stuck?: UnstickKind }
  /** A block on `item` was resolved by one of the Foreman's unblock checks (src/unblock.ts). */
  | { readonly kind: "unblocked"; readonly item: WorkItem; readonly reason: string }
  /** The feature PR delivering `item` merged to the base branch. */
  | { readonly kind: "merged"; readonly item: WorkItem }
  | { readonly kind: "promoted"; readonly item: WorkItem }
  /** A Claude (or Tech Lead / SRE) session on a repo started, changed hands, or ended. */
  | { readonly kind: "session"; readonly session: SessionEvent }
  /**
   * A running review reached a new stage: every milestone so far, for the
   * cards of the issues the PR delivers (review-progress.ts). Sent at most
   * once per stage; the review's end comes as its session event.
   */
  | { readonly kind: "reviewProgress"; readonly repo: string; readonly pr: number; readonly items: ReadonlyArray<WorkItem>; readonly milestones: ReadonlyArray<ReviewMilestone> }
  /**
   * The repo's FULL set of items waiting out a back-off this cycle, each with
   * the reason it waits. An item missing from a later set has stopped waiting.
   */
  | { readonly kind: "waiting"; readonly repo: string; readonly items: ReadonlyArray<WaitingItem> }
  /** A release PR (base → production) opened, merged or closed for these items. */
  | { readonly kind: "release"; readonly release: ReleaseEvent }
  /** Promotion on `repo` is stalled for `detail`, or no longer stalled (null). */
  | { readonly kind: "promotionStall"; readonly repo: string; readonly detail: string | null }
  /** An upstream (github / claude) started refusing work (`reason`), or stopped. */
  | { readonly kind: "backoff"; readonly upstream: string; readonly paused: boolean; readonly reason?: string }
  /** The repo's open items at the end of a cycle, as the source shows them: the record a mirror reconciles to. */
  | {
    readonly kind: "snapshot"; readonly repo: string; readonly items: ReadonlyArray<SnapshotItem>;
    /** Every item a card exists for (`WorkSourceAdapter.cards`), only when an observer owns the cards. */
    readonly cards?: ReadonlyArray<SnapshotCard>;
    /** The items closed since the last read (`WorkSourceAdapter.closed`), when `cards` is not carried. */
    readonly closed?: ReadonlyArray<SnapshotClosed>;
    /**
     * Reads, live, whether items are open or how they closed
     * (`WorkSourceAdapter.states`): a number left out could not be read.
     * Absent when the source has no such read; nothing can then be confirmed.
     */
    readonly states?: (issueNumbers: readonly number[]) => Promise<ReadonlyMap<number, ItemState>>;
  };

export type WorkEventKind = WorkEvent["kind"];

/**
 * Something that watches the Foreman work without being a work source (EM#417:
 * the Paperclip mirror). It receives every event the work source receives, in
 * the same order, plus the ones the source keeps no record of.
 *
 * Best-effort. The dispatcher (work-source.ts) awaits each call under a hard
 * timeout and logs, never rethrows, its errors, so an observer can neither
 * fail nor stall a build. It never decides anything: the work source stays
 * the only record.
 */
export interface WorkObserver {
  onEvent(event: WorkEvent, logger: Logger): Promise<void>;
  /** True when this observer writes every card itself and needs a snapshot's `cards`. */
  wantsCards?(): boolean;
  /**
   * Declared interests. Each costs the Foreman GitHub reads that serve no one
   * else, so an observer that omits one (or answers false) is never given it:
   * `wantsSessionReports` is a session's goals, PR digest and review progress;
   * `wantsSnapshot` is the board snapshot each pass (`wantsCards` implies it).
   */
  wantsSessionReports?(): boolean;
  wantsSnapshot?(): boolean;
}

/**
 * A release: the PR promoting the base branch to production, and the items it
 * carries. `open` is waiting to merge; `merged` is in production (no `pr` when
 * the base branch was found already in production); `closed` is closed unmerged.
 */
export interface ReleaseEvent {
  readonly repo: string;
  readonly state: "open" | "merged" | "closed";
  readonly pr?: number;
  readonly url?: string;
  readonly issues: ReadonlyArray<WorkItem>;
  readonly productionBranch: string;
  /** The release stage owns this PR (`release pending`): its items are `releasing`, never
   *  `awaitingRelease`, so an `open` must not move them back off the SRE (jerky_service
   *  PR #146, 2026-10-14). */
  readonly owned?: boolean;
}

/** One session the Foreman runs for a repo: building, revising, reviewing or verifying in dev. */
export type SessionPhase = "implement" | "revise" | "review" | "verify" | "qa";

/**
 * A session's lifecycle. `handoff` is a review passing from one reviewer to
 * another (the Tech Lead declining, Claude taking over). `items` are the work
 * items the session is about; `pr` the pull request, when there is one.
 */
export interface SessionEvent {
  readonly phase: SessionPhase;
  readonly status: "started" | "handoff" | "finished" | "failed";
  readonly repo: string;
  readonly items: ReadonlyArray<WorkItem>;
  readonly pr?: number;
  readonly reviewer?: string;
  /** On a `qa` session: it runs before the merge (config.qaBeforeMerge), so the card's fallback is review, not `merged`. */
  readonly qaBeforeMerge?: boolean;
  readonly detail?: string;
  /**
   * On an implement end: the items the session actually worked — built,
   * skipped, or failed on. A session handed several items builds one, so the
   * rest were never touched and must not be told this outcome. Absent when
   * the Foreman cannot tell; the outcome then applies to every item.
   */
  readonly worked?: ReadonlyArray<number>;
  /**
   * What the session did, for an observer to summarise. Gathered only when an
   * observer is registered, from what the Foreman already holds: the issue
   * titles, the session's own final message, the PR, the review. Unredacted
   * and uncapped: an observer that shows it must redact and cap it.
   */
  readonly report?: SessionReport;
}

/** The material a session's summary is written from. Every field is optional. */
export interface SessionReport {
  /** Each item's goal (its issue title), by issue number. */
  readonly goals?: Readonly<Record<number, string>>;
  /** The session's own final message (an agent's closing summary). */
  readonly text?: string;
  /** The pull request the session produced or worked on. */
  readonly pr?: SessionPr;
  /** A review's outcome, from its trailer and the review it posted. */
  readonly review?: SessionReview;
  /** A Tech Lead review's milestones, as far as it got (review-progress.ts). */
  readonly milestones?: ReadonlyArray<ReviewMilestone>;
}

export interface SessionPr {
  readonly number: number;
  readonly url?: string;
  readonly title?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
}

export interface SessionReview {
  readonly verdict: string;
  readonly merged: boolean;
  readonly deploy: string;
  readonly hold?: string;
  /** The review's opening paragraph. */
  readonly summary?: string;
  readonly findings: ReadonlyArray<{ readonly severity: string; readonly title: string; readonly where?: string }>;
}

/** An item the Foreman is holding back this cycle, and why. */
export interface WaitingItem {
  readonly item: WorkItem;
  readonly reason: string;
  /**
   * Held back because the Foreman gave up on it (a skip still in its back-off):
   * it needs a person, so it stays in the `blocked` stage with that stage's
   * owner, not a Foreman-held wait (EM #417, slashbin-cli#142).
   */
  readonly skipped?: boolean;
}
