import type { RepoConfig, AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { StageOrDone, Transition } from "./lifecycle.js";

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
 * ready-for-release and no done member, on purpose: the release gate is the
 * EM outcome-gate's signature (separation of duties, 2026-07-27) and closing
 * an item is the EM's act after prod verification. A connector refuses any
 * target outside this set.
 */
export type WorkState = "queued" | "inReview" | "changesRequested" | "merged" | "approved";

/**
 * What the caller believes the item's state is before the report. `unknown`
 * tells the connector to read the current state first and move only what is
 * actually there (dead-zone recovery, orphan release).
 */
export type PriorState = "new" | "inReview" | "changesRequested" | "merged" | "unknown";

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
}

/** One item as the work source shows it at the end of a cycle. */
export interface SnapshotItem {
  readonly item: WorkItem;
  readonly stage: StageOrDone;
  /** What the source shows, in its own terms (GitHub: the issue's labels). */
  readonly detail: string;
  /** A verify session gave up on it and holds it: the block stands at `merged`. */
  readonly verifyHeld?: boolean;
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
  | { readonly kind: "blocked"; readonly item: WorkItem; readonly reason: string }
  /** A block on `item` was resolved by one of the Foreman's unblock checks (src/unblock.ts). */
  | { readonly kind: "unblocked"; readonly item: WorkItem; readonly reason: string }
  /** The feature PR delivering `item` merged to the base branch. */
  | { readonly kind: "merged"; readonly item: WorkItem }
  | { readonly kind: "promoted"; readonly item: WorkItem }
  /** A Claude (or Tech Lead / SRE) session on a repo started, changed hands, or ended. */
  | { readonly kind: "session"; readonly session: SessionEvent }
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
  | { readonly kind: "snapshot"; readonly repo: string; readonly items: ReadonlyArray<SnapshotItem> };

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
}

/** One session the Foreman runs for a repo: building, revising, reviewing or verifying in dev. */
export type SessionPhase = "implement" | "revise" | "review" | "verify";

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
