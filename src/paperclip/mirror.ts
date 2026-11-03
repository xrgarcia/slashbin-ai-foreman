// Mirrors the Foreman's work onto Paperclip (EM#417): each step the Foreman
// reports on an issue becomes a note on that issue's Paperclip task, and the
// step's lifecycle stage places the card: the agent holding it, its status and
// its stage label, all from `paperclip.board` (board.ts). By default the
// Foreman holds every card; a config with roles hands review to one agent and
// verification to another.
//
// This file is the observer facade (EM#1267 feature 4). The work is done by five
// collaborators, each in its own file and each owning its state: card-index.ts
// (which task is the card for which issue), placement.ts (move, holder, blocks,
// labels), lease.ts (session holds and the agent's lease), snapshot-sync.ts
// (the card follows GitHub) and thread-notes.ts (the comment thread). They never
// import one another; steps.ts, env.ts and ports.ts are what they share.
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
  PriorState, ReleaseEvent, SessionEvent, SnapshotItem, WaitingItem, WorkEvent, WorkItem, WorkObserver, WorkState,
} from "../adapters.js";
import type { PaperclipConfig, PaperclipStage } from "./config.js";
import { STATE_STAGE } from "../lifecycle.js";
import type { Logger } from "../logger.js";
import type { PaperclipBucket } from "./board.js";
import { DEFAULT_HANDOFF_LABELS, type HandoffLabels } from "./handoff.js";
import type { PaperclipClient } from "./client.js";
import type { RepoIdentity } from "./repo-identity.js";
import type { ReviewMilestone } from "../review-progress.js";
import { CardIndex } from "./card-index.js";
import { PaperclipEnv } from "./env.js";
import { SessionLease } from "./lease.js";
import { Placement } from "./placement.js";
import { SnapshotSync } from "./snapshot-sync.js";
import { ThreadNotes } from "./thread-notes.js";
import {
  fill, handoffTo, INDEX_TTL_MS, LEASE_RENEW_MS, PAPERCLIP_RETRY_NOTE, PAPERCLIP_STEPS, type CardBlockStore, type NoteOpts, type PaperclipStep, type SnapshotReads,
} from "./steps.js";

// The public surface of this file is what it always was; the names now live with the collaborator that owns them.
export {
  ESCALATION_ACTION_PREFIX, PAPERCLIP_CREATE_STATUS, PAPERCLIP_OWNED_TITLE_FORMAT, PAPERCLIP_RETRY_NOTE, PAPERCLIP_STEPS, PAPERCLIP_TASK_TITLE_FORMAT,
  type CardBlock, type CardBlockStore, type PaperclipBucket, type PaperclipStep, type PaperclipStepMove, type SnapshotReads,
} from "./steps.js";
export { pickCard } from "./card-index.js";
export { configSecretRefusal } from "./lease.js";

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

function sameItem(a: WorkItem | null, b: WorkItem): boolean {
  return !!a && a.repo === b.repo && a.issueNumber === b.issueNumber;
}

/**
 * The Foreman's observer, as a facade. It is the one `WorkObserver` the plugin
 * registers and the only caller of the Paperclip client; the work is done by
 * five collaborators, each owning one job and the state that job needs:
 *
 *   CardIndex     which task is the card for which issue (the rows)
 *   Placement     where a card goes: move, holder, blocks, labels
 *   SessionLease  what a live session holds, and the lease that proves it
 *   SnapshotSync  the card follows GitHub each cycle
 *   ThreadNotes   what the card's comment thread says
 *
 * Collaborators never call or import each other (test/paperclip-collaborators
 * pins it). This class builds them, hands each what it needs, and keeps what is
 * the observer's own: the event dispatch, the claim and retry bookkeeping, and
 * the state-change handlers that sequence two or three collaborators.
 */
export class PaperclipMirror implements WorkObserver {
  private readonly env: PaperclipEnv;
  private readonly cardIndex: CardIndex;
  private readonly placement: Placement;
  private readonly lease: SessionLease;
  private readonly snapshot: SnapshotSync;
  private readonly notes: ThreadNotes;
  /** True while a housekeeping pass runs, so a slow one is never overlapped. */
  private housekeeping = false;
  /** Identity keys claimed and not yet moved on by a state change: a repeat claim is a retry. */
  private readonly claimed = new Set<string>();
  /** The item of the last claim, so a back-off note lands on the card of the build it interrupts. */
  private building: WorkItem | null = null;
  /** Task id → the last verify-waiting note, so a repeat reason is not posted twice. */
  private readonly verifyWaitNote = new Map<string, string>();
  /** Identity keys whose current claim repeats one that did not finish. */
  private readonly retrying = new Set<string>();

  constructor(
    client: PaperclipClient,
    cfg: PaperclipConfig,
    secrets: ReadonlyArray<{ name: string; value: string }>,
    logger: Logger,
    labels: Partial<HandoffLabels> = {},
    blockStore?: CardBlockStore,
    /** Reduces a repo to the key cards are compared on; unset, a repo is its own key. */
    identity?: RepoIdentity,
  ) {
    this.env = new PaperclipEnv(client, cfg, secrets, logger, { ...DEFAULT_HANDOFF_LABELS, ...labels }, identity);
    this.cardIndex = new CardIndex(this.env);
    this.lease = new SessionLease(this.env, (id, to) => this.placement.move(id, to));
    this.placement = new Placement(this.env, blockStore, this.cardIndex, this.lease.holds, (id, target) => this.lease.runInFlight(id, target));
    this.notes = new ThreadNotes(this.env, this.cardIndex, this.placement, this.lease, this.lease.holds, this.retrying);
    this.snapshot = new SnapshotSync(this.env, this.cardIndex, this.placement, this.notes, this.lease.holds);
    void this.ensureBlocks();
  }

  // What the handlers below and the tests read, answered by the owner.
  get cfg(): PaperclipConfig { return this.env.cfg; }
  private get comments() { return this.env.comments; }
  private get logger(): Logger { return this.env.logger; }
  private get holds() { return this.lease.holds; }
  get index(): Map<string, string> | null { return this.cardIndex.index; }
  get duplicates() { return this.cardIndex.duplicates; }
  private get rowState() { return this.cardIndex.rowState; }
  private get rowRepo() { return this.cardIndex.rowRepo; }
  private get closedCards() { return this.cardIndex.closedCards; }
  private get rowStage() { return this.placement.rowStage; }
  private get blockedReason() { return this.placement.blockedReason; }
  private get blockedOwner() { return this.placement.blockedOwner; }
  private get blockedAt() { return this.placement.blockedAt; }
  private get rulingHeld() { return this.placement.rulingHeld; }
  private get ghStage() { return this.placement.ghStage; }
  private get escalatedAt() { return this.placement.escalatedAt; }
  private get prOf() { return this.notes.prOf; }

  private ensureBlocks(): Promise<boolean> { return this.placement.ensureBlocks(); }
  private ensureIndex(fresh = false): Promise<boolean> { return this.cardIndex.ensureIndex(fresh); }
  private resolve(item: WorkItem, create: boolean): Promise<string | null> { return this.cardIndex.resolve(item, create); }
  private refreshRow(id: string): Promise<void> { return this.cardIndex.refreshRow(id); }
  private terminal(id: string): boolean { return this.cardIndex.terminal(id); }
  private isClosedCard(id: string): boolean { return this.cardIndex.isClosedCard(id); }
  private setHolder(id: string, agentId: string | null): void { this.cardIndex.setHolder(id, agentId); }
  private warm(...repos: string[]): Promise<void> { return this.cardIndex.warm(...repos); }
  private warmEvent(event: WorkEvent): Promise<void> { return this.cardIndex.warmEvent(event); }
  private keyNow(repo: string): string { return this.cardIndex.keyNow(repo); }
  private mirrors(event: WorkEvent): boolean { return this.cardIndex.mirrors(event); }
  private move(id: string, to: Parameters<Placement["move"]>[1], held = false, liveOpen = false): Promise<boolean> { return this.placement.move(id, to, held, liveOpen); }
  private externalHold(id: string): boolean { return this.placement.externalHold(id); }
  private holdOutranks(id: string, stage: PaperclipStage): boolean { return this.placement.holdOutranks(id, stage); }
  private persistBlock(id: string): void { this.placement.persistBlock(id); }
  private clearBlock(id: string): void { this.placement.clearBlock(id); }
  private patch(id: string, body: Record<string, unknown>, commentAuthor?: string | null): Promise<boolean> { return this.placement.patch(id, body, commentAuthor); }
  private note(id: string, text: string, opts: NoteOpts): Promise<void> { return this.notes.note(id, text, opts); }
  private clean(text: string): string { return this.env.clean(text); }
  private keyOf(item: WorkItem): string { return this.env.keyOf(item); }
  private statusName(bucket: PaperclipBucket): string { return this.env.statusName(bucket); }

  // The snapshot, a session report and a review milestone are the collaborators' work whole.


  /**
   * The one entry point: each event the Foreman emits goes to its handler
   * below. The handlers stay public so a test can drive one step directly.
   */
  /** True when the Foreman writes every card of its repos (`ownsCards`): the snapshot then carries them all. */
  wantsCards(): boolean {
    return this.cfg.ownsCards === true;
  }

  /** The mirror turns a session's report into the card's comment, and the snapshot into card moves. */
  wantsSessionReports(): boolean {
    return true;
  }

  wantsSnapshot(): boolean {
    return true;
  }

  async onEvent(event: WorkEvent, logger: Logger): Promise<void> {
    await this.warmEvent(event);
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
      case "blocked": return this.onBlocked(event.item, event.reason, undefined, undefined, PAPERCLIP_STEPS.blocked, "changesRequested", event.owner, event.at);
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
    // Block readiness comes before any hold decision: holdOutranks must only ever see restored blocks.
    // Unread, the whole event waits (the next snapshot places the card), never a guess about its hold.
    if (!(await this.ensureBlocks())) {
      this.logger.warn("Paperclip card blocks could not be read; the stage update waits for the next snapshot");
      return;
    }
    // A closed issue's card is terminal: a stage update landing after the close
    // reopened SLA-2633 as pending verification on the EM (Foreman #112). A done
    // or cancelled card counts as closed until the snapshot reads its issue open.
    if (this.terminal(id)) return;
    // At the GitHub stage the card was last placed for, the board is read first:
    // a seat's escalation made since the last scan is not in the cache, and the
    // move took the card back from the PO (Foreman #98).
    const gh = this.ghStage.get(id);
    if (step.stage !== "done" && (gh === undefined || gh === step.stage)) {
      await this.refreshRow(id);
      if (this.externalHold(id) && !this.escalatedAt.has(id)) this.escalatedAt.set(id, gh ?? step.stage);
    }
    // A hold that outranks this update keeps the card where it is; the note still says what happened.
    if (step.stage !== "done" && this.holdOutranks(id, step.stage)) {
      await this.note(id, step.note, { event: "progress" });
      return;
    }
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
    at: PaperclipStage = "changesRequested", owner?: "sre", blockStage?: PaperclipStage): Promise<void> {
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
    // A block that names its stage (a review failure: `inReview`) is anchored there, not on the last
    // snapshot: the review can outlive its stage, and a block anchored on the stage GitHub already
    // reached would never be released (foreman#180, SLA-3368 left Blocked at pendingVerification).
    this.blockedAt.set(id, step === PAPERCLIP_STEPS.escalated ? at : (blockStage ?? this.ghStage.get(id)));
    // A needs-ruling hold outranks the stage updates that follow it until the ruling lands (Foreman #109).
    if (step === PAPERCLIP_STEPS.escalated) this.rulingHeld.add(id); else this.rulingHeld.delete(id);
    this.persistBlock(id);
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
    this.clearBlock(id);
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
    // Restore first: a clear before the load would let the old block come back from the record.
    if (!(await this.ensureBlocks())) return;
    if (this.rowState.get(id) !== `status:${this.statusName("blocked")}`) return;
    this.blockedAt.delete(id);
    this.clearBlock(id);
    const stage = this.ghStage.get(id) ?? "approved";
    if (!(await this.move(id, stage))) return;
    await this.note(id, this.clean(reason), { event: "progress", handoff: handoffTo(stage, item) });
  }

  async onSnapshot(repo: string, items: ReadonlyArray<SnapshotItem>, logger: Logger, reads: SnapshotReads = {}): Promise<void> {
    return this.snapshot.onSnapshot(repo, items, logger, reads);
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

  /** Renew the lease, recover the last process's and run housekeeping, now and every index refresh after. Returns a stop function. */
  start(): () => void {
    const run = () => void this.housekeep();
    void this.lease.recover().then(run);
    const timer = setInterval(run, INDEX_TTL_MS);
    timer.unref?.();
    const renew = setInterval(() => this.lease.renew(), LEASE_RENEW_MS);
    renew.unref?.();
    return () => {
      clearInterval(timer);
      clearInterval(renew);
    };
  }

  /** Recover the last process's lease (tests call it directly). */
  recoverLease(): Promise<void> { return this.lease.recoverLease(); }

  /** Publish the config file the process runs on (the daemon calls it at start and on reload). */
  publishConfig(text: string): Promise<void> { return this.lease.publishConfig(text); }

  async onSession(event: SessionEvent, logger: Logger): Promise<void> { return this.notes.onSession(event, logger); }

  async onReviewProgress(pr: number, items: ReadonlyArray<WorkItem>, milestones: ReadonlyArray<ReviewMilestone>): Promise<void> {
    return this.notes.onReviewProgress(pr, items, milestones);
  }

  /**
   * Take a reloaded config: the board mapping, roles, labels and comments follow
   * it from the next move on. A change to what names the company, the agent or a
   * task's identity needs a restart, so that config is refused, the running one
   * kept, and false returned.
   */
  reconfigure(next: PaperclipConfig): boolean {
    const fixed = ["enabled", "url", "companyId", "agentId", "identityKeyFormat", "registryUrl", "registryApiKey"] as const;
    const changed = fixed.filter((k) => next[k] !== this.cfg[k]);
    if (changed.length) {
      this.logger.warn(`paperclip: config reload changes ${changed.join(", ")}; a new mirror takes over to apply it.`);
      return false;
    }
    this.env.reconfigure(next);
    this.placement.resetLabels();
    return true;
  }

  /** One housekeeping pass; never throws. */
  async housekeep(): Promise<void> {
    if (this.housekeeping) return;
    this.housekeeping = true;
    try {
      if (!(await this.ensureIndex(true))) return;
      await this.cardIndex.retireLiveTask();
      if (this.cfg.ownsCards === true) {
        await this.cardIndex.retireDuplicates();
        await this.placement.backfillIssueLabels();
      }
    } finally {
      this.housekeeping = false;
    }
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
    await this.warm(repo);
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
        this.persistBlock(id);
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
      this.setHolder(id, this.cfg.agentId ?? null);
      await this.note(id, fill(step.note, { reason: w.reason }), { event: "progress" });
    }

    if (await this.ensureIndex()) {
      for (const [id, state] of this.rowState) {
        if (keep.has(id) || !state.startsWith("waiting\n") || this.rowRepo.get(id) !== this.keyNow(repo)) continue;
        if (!(await this.move(id, this.rowStage.get(id) ?? "approved"))) continue;
        await this.note(id, PAPERCLIP_STEPS.resumed.note, { event: "progress" });
      }
    }
  }
}
