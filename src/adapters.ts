import type { RepoConfig, AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";

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
export type WorkState = "queued" | "inReview" | "changesRequested" | "approved";

/**
 * What the caller believes the item's state is before the report. `unknown`
 * tells the connector to read the current state first and move only what is
 * actually there (dead-zone recovery, orphan release).
 */
export type PriorState = "new" | "inReview" | "changesRequested" | "unknown";

/**
 * Where the Foreman's work comes from, and where it reports progress on that
 * work. The implement stage asks the source which items to build this pass
 * and hands exactly those to the agent; every later change to an item's
 * state goes back through the same source. GitHub issues are the first
 * connector (`GitHubIssueConnector` in github.ts); this module must stay free
 * of any source-specific code so another connector can import it alone.
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

  /** The Foreman is starting work on `item`. */
  claim(item: WorkItem, repoConfig: RepoConfig, logger: Logger): Promise<void>;

  /** The PR that delivers `item` exists at `prUrl`. */
  reportPrLink(item: WorkItem, prUrl: string, repoConfig: RepoConfig, logger: Logger): Promise<void>;

  /**
   * Move `item` from `from` to `to`. Resolves `true` when the source recorded
   * a change, `false` when it wrote nothing (already there, no longer open, a
   * failed write, or a pair it does not support). Never throws.
   */
  reportState(
    item: WorkItem,
    from: PriorState,
    to: WorkState,
    repoConfig: RepoConfig,
    logger: Logger,
  ): Promise<boolean>;

  /** The Foreman cannot proceed on `item`; `reason` says why. */
  reportBlocked(item: WorkItem, reason: string, repoConfig: RepoConfig, logger: Logger): Promise<void>;
}

/**
 * Something that watches the Foreman work without being a work source (EM#417:
 * the Paperclip mirror). It receives every report the work source receives, in
 * the same order and with the same arguments, plus the events the source never
 * sees: a feature PR merged, work handed to promotion, an upstream back-off
 * starting or ending.
 *
 * Every method is optional and best-effort. The dispatcher (work-source.ts)
 * awaits each one under a hard timeout and logs, never rethrows, its errors, so
 * an observer can neither fail nor stall a build. It never decides anything:
 * GitHub stays the only work source.
 */
export interface WorkObserver {
  onClaim?(item: WorkItem, repoConfig: RepoConfig, logger: Logger): Promise<void>;
  onState?(item: WorkItem, from: PriorState, to: WorkState, repoConfig: RepoConfig, logger: Logger): Promise<void>;
  onPrLink?(item: WorkItem, prUrl: string, repoConfig: RepoConfig, logger: Logger): Promise<void>;
  onBlocked?(item: WorkItem, reason: string, repoConfig: RepoConfig, logger: Logger): Promise<void>;
  onMerged?(item: WorkItem, repoConfig: RepoConfig, logger: Logger): Promise<void>;
  onPromoted?(item: WorkItem, repoConfig: RepoConfig, logger: Logger): Promise<void>;
  onBackoffPause?(upstream: string, reason: string, logger: Logger): Promise<void>;
  onBackoffResume?(upstream: string, logger: Logger): Promise<void>;
  /** A Claude (or Tech Lead) session on a repo started, changed hands, or ended. */
  onSession?(event: SessionEvent, logger: Logger): Promise<void>;
  /**
   * The repo's FULL set of items waiting out a back-off this cycle, each with
   * the reason it waits. An item missing from a later set has stopped waiting.
   */
  onWaiting?(repo: string, waiting: ReadonlyArray<WaitingItem>, logger: Logger): Promise<void>;
  /** Promotion on `repo` is stalled for `detail`, or no longer stalled (null). */
  onPromotionStall?(repo: string, detail: string | null, logger: Logger): Promise<void>;
  /** A release PR (base → production) opened, merged or closed for these items. */
  onRelease?(event: ReleaseEvent, logger: Logger): Promise<void>;
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

/** One session the Foreman runs for a repo: building, revising or reviewing. */
export type SessionPhase = "implement" | "revise" | "review";

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
}

/** An item the Foreman is holding back this cycle, and why. */
export interface WaitingItem {
  readonly item: WorkItem;
  readonly reason: string;
}
