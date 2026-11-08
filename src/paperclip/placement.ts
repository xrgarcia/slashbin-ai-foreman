// Placement: where a card goes and who holds it. `move` writes the card's
// status, holder and stage label from `paperclip.board`; it keeps the Foreman's
// blocks (the reason, the role, the stage they were made at, a pending ruling)
// in memory and in the block store across a restart; it defers a move that
// would cut across a run of the card's assignee; and it keeps the issue and
// stage labels. It owns those blocks and the label ids. The card index's state
// and the session holds reach it by constructor injection, never by import.

import { ensureIssueLabel, ensureStageLabels, FOREMAN_BLOCKED_PREFIX, SESSION_STAGE, stageTarget, withIssueLabel, withStage, type PaperclipBucket } from "./board.js";
import type { PaperclipStage } from "./config.js";
import type { PaperclipEnv } from "./env.js";
import type { IndexPort } from "./ports.js";
import {
  CARD_WRITES_PER_SNAPSHOT, ESCALATION_ACTION_PREFIX, LABEL_BLOCK_ACTION, PAPERCLIP_STEPS, RECEIVER_HOLD_ENTRY,
  type CardBlock, type CardBlockStore, type Holds, type PaperclipStepMove, type RowContent,
} from "./steps.js";

type Bucket = PaperclipBucket;

export class Placement {
  /** Task id → the last lifecycle stage the mirror placed it in, so a resumed card goes back there. */
  readonly rowStage = new Map<string, PaperclipStage>();
  /** Task id → why the Foreman blocked it, the unblock descriptor's action when it moves to `blocked`. */
  readonly blockedReason = new Map<string, string>();
  /** Task id → the role key that holds its Blocked card when it is not the stage's owner (`sre`: a failed dev deploy). */
  readonly blockedOwner = new Map<string, string>();
  /** A move a run of the card's assignee in flight deferred, retried at the next snapshot. */
  readonly deferredMoves = new Map<string, PaperclipStepMove>();
  /** Task id → the GitHub stage last seen for its issue, from the cycle snapshot. */
  readonly ghStage = new Map<string, PaperclipStage | "done">();
  /**
   * Task id → the GitHub stage its issue was at when the Foreman blocked it
   * (undefined: no snapshot yet). The block stands until the issue moves on,
   * so a snapshot never undoes a block the Foreman just made.
   */
  readonly blockedAt = new Map<string, PaperclipStage | "done" | undefined>();
  /** Task ids this process moved to Blocked because GitHub's blocked label said so. */
  readonly labelBlocked = new Set<string>();
  /** A card a seat's escalation blocked, and the GitHub stage it was first seen at. */
  readonly escalatedAt = new Map<string, string>();
  /** Cards Blocked for an EM scope ruling (`escalated`): no stage update at the hold's stage moves them. */
  readonly rulingHeld = new Set<string>();
  /** Blocks read back from the store at start, not made by this process. */
  readonly restoredBlocks = new Set<string>();
  /** Task id → the block last written to the store, as JSON, so an unchanged one is not rewritten. */
  private readonly savedBlocks = new Map<string, string>();
  /** True once the store's blocks have been read back; a failed read is retried at the next snapshot. */
  private blocksLoaded = false;
  private blocksLoading: Promise<boolean> | null = null;
  /** Task id → the reason its issue is held on GitHub, from the last snapshot's cards: what it says entering Blocked. */
  readonly holdAction = new Map<string, string>();
  /** Stage label key → the company's label id, or the lookup in flight; dropped on failure. */
  private stageLabelIds: Promise<Map<string, string> | null> | null = null;
  /** The company's `issue` label id, once ensured (undefined until a label write needed it). */
  private issueLabelId: string | undefined;
  /** Cards confirmed to carry the issue label, so a sync reads and writes each once. */
  private readonly issueLabelled = new Set<string>();

  constructor(
    private readonly env: PaperclipEnv,
    private readonly blockStore: CardBlockStore | undefined,
    private readonly index: IndexPort,
    private readonly holds: Holds,
    /** Whether a run of the card's assignee is in flight (the session lease reads the board). */
    private readonly runInFlight: (id: string, target: Bucket | "done") => Promise<boolean>,
  ) {}

  /** A reloaded config may rename the labels: look them up again. */
  resetLabels(): void {
    this.stageLabelIds = null;
    this.issueLabelId = undefined;
  }

  /**
   * Read back the blocks the last process put on its cards: the reason a re-move
   * to Blocked writes, the role that holds it, the stage it was made at and
   * whether it waits on a ruling. Without them a restart moved a needs-ruling
   * card back to the Foreman (its stage read as moved on), and handed a failed
   * deploy's card from the SRE to the EM.
   */
  ensureBlocks(): Promise<boolean> {
    if (!this.blockStore || this.blocksLoaded) return Promise.resolve(true);
    this.blocksLoading ??= this.restoreBlocks().finally(() => {
      this.blocksLoading = null;
    });
    return this.blocksLoading;
  }

  private async restoreBlocks(): Promise<boolean> {
    let blocks: Record<string, CardBlock> | null = null;
    try {
      blocks = (await this.blockStore?.load()) ?? null;
    } catch {
      blocks = null;
    }
    if (!blocks) return false;
    for (const [id, b] of Object.entries(blocks)) {
      if (!b || typeof b !== "object") continue;
      // A block this process already made is newer than the one read back.
      if (this.savedBlocks.has(id) || this.blockedReason.has(id) || this.blockedAt.has(id)) continue;
      if (typeof b.reason === "string") this.blockedReason.set(id, b.reason);
      if (typeof b.owner === "string") this.blockedOwner.set(id, b.owner);
      if ("at" in b) this.blockedAt.set(id, (b.at ?? undefined) as PaperclipStage | "done" | undefined);
      if (b.ruling === true) this.rulingHeld.add(id);
      this.restoredBlocks.add(id);
      this.savedBlocks.set(id, JSON.stringify(b));
    }
    this.blocksLoaded = true;
    return true;
  }

  /** Write card `id`'s block as the maps now hold it, or forget it; only on a change, never throws. */
  persistBlock(id: string): void {
    if (!this.blockStore) return;
    const reason = this.blockedReason.get(id);
    const owner = this.blockedOwner.get(id);
    const block: CardBlock | null = reason === undefined && owner === undefined && !this.blockedAt.has(id) && !this.rulingHeld.has(id) ? null : {
      ...(reason !== undefined ? { reason } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(this.blockedAt.has(id) ? { at: this.blockedAt.get(id) ?? null } : {}),
      ...(this.rulingHeld.has(id) ? { ruling: true } : {}),
    };
    const json = block ? JSON.stringify(block) : null;
    if ((this.savedBlocks.get(id) ?? null) === json) return;
    const previous = this.savedBlocks.get(id);
    // Marked saved first, so a burst of calls writes once; put back if the write fails, so the next call retries.
    if (json) this.savedBlocks.set(id, json);
    else this.savedBlocks.delete(id);
    const revert = (): void => {
      if (this.savedBlocks.get(id) !== (json ?? undefined)) return;
      if (previous !== undefined) this.savedBlocks.set(id, previous);
      else this.savedBlocks.delete(id);
    };
    void (async () => {
      try {
        if (!(await this.blockStore!.save(id, block, this.index.repoOfCard(id)))) revert();
      } catch {
        revert(); // best-effort: the block still holds in memory
      }
    })();
  }

  /** The Foreman's block on `id` is over: forget it, here and in the store. */
  clearBlock(id: string): void {
    this.blockedAt.delete(id);
    this.blockedReason.delete(id);
    this.blockedOwner.delete(id);
    this.rulingHeld.delete(id);
    this.restoredBlocks.delete(id);
    this.persistBlock(id);
  }

  /**
   * True when a Blocked card's hold is someone else's: a seat's escalation hop
   * (`process.escalate`) or a person's hold (the deliver-to-prod nudge put
   * SLA-2591 on Ray). Every block the Foreman or a GitHub label makes names
   * FOREMAN_BLOCKED_PREFIX, and the receiver's entry text is GitHub's label.
   */
  externalHold(id: string): boolean {
    if (this.index.rowState.get(id) !== `status:${this.env.statusName("blocked")}`) return false;
    const action = this.index.blockAction.get(id);
    if (action === undefined) return false;
    if (action.startsWith(ESCALATION_ACTION_PREFIX)) return true;
    return !action.startsWith(FOREMAN_BLOCKED_PREFIX) && !RECEIVER_HOLD_ENTRY.test(action);
  }

  /**
   * True when a hold on `id` outranks a stage update to `stage`: a needs-ruling
   * block made at that stage (the review's "changes requested" landing after
   * the escalation took SLA-366 back to the Foreman, Foreman #109), or another
   * seat's or a person's hold first seen at it (Foreman #98). A different stage
   * is GitHub moving on, which releases either.
   */
  holdOutranks(id: string, stage: PaperclipStage): boolean {
    if (this.rulingHeld.has(id) && this.blockedAt.get(id) === stage) return true;
    return this.externalHold(id) && (this.escalatedAt.get(id) ?? this.ghStage.get(id)) === stage;
  }

  /**
   * The hold check an event-driven stage move makes first, read live. At the
   * GitHub stage the card was last placed for, the board is read now: a seat's
   * escalation or a person's hold made since the last scan is not in the cache,
   * and the move took the card back from the PO (Foreman #98). True when a hold
   * outranks the move to `stage`. The Foreman's stage events and its deferred
   * moves both pass through here, so neither moves a card past a hold.
   */
  async holdOutranksLive(id: string, stage: PaperclipStage): Promise<boolean> {
    const gh = this.ghStage.get(id);
    if (gh === undefined || gh === stage) {
      await this.index.refreshRow(id);
      if (this.externalHold(id) && !this.escalatedAt.has(id)) this.escalatedAt.set(id, gh ?? stage);
    }
    return this.holdOutranks(id, stage);
  }

  /**
   * True when a needs-ruling block on `id`, made at `stage`, never reached the
   * board: its write failed (Paperclip down) and the card still shows the stage
   * GitHub is at, on the Foreman or the Tech Lead. A card Blocked, or with the
   * ruling's holder (the EM's wake checks it out to in_progress), has it.
   */
  rulingPending(id: string, stage: PaperclipStage): boolean {
    if (!this.rulingHeld.has(id) || this.blockedAt.get(id) !== stage) return false;
    if (this.index.rowState.get(id) === `status:${this.env.statusName("blocked")}`) return false;
    const t = stageTarget(this.env.cfg, PAPERCLIP_STEPS.escalated.stage);
    return !(t.agentId && this.index.rowContent.get(id)?.assigneeAgentId === t.agentId);
  }

  /**
   * True when the card's holder is the one `stage` calls for, or nothing is
   * known to compare. A status alone hides a lost hand-off: pendingVerification
   * shares in_review with inReview, so SLA-2020 sat with the Tech Lead after a
   * failed PATCH and the EM's release gate never ran (Foreman #100). Blocked
   * cards are not compared: their holder is whoever the hold names.
   */
  holderMatches(id: string, stage: PaperclipStage | "done"): boolean {
    if (stage === "done") return true;
    const t = stageTarget(this.env.cfg, stage);
    if (t.bucket === "blocked" || !t.agentId) return true;
    const have = this.index.rowContent.get(id);
    if (!have) return true;
    return have.assigneeAgentId === t.agentId && !have.assigneeUserId;
  }

  /**
   * A held card its session's start could not move (Paperclip was down) takes
   * the session's column now. Otherwise the hold keeps every later writer off
   * it, and it shows its old column for the whole session: jerky_service #131
   * sat in To Do while the SRE verified it, after a 30-second outage
   * (2026-10-14).
   */
  async placeHeld(id: string): Promise<void> {
    const h = this.holds.get(id);
    if (!h || h.placed) return;
    h.placed = await this.move(id, SESSION_STAGE[h.phase], true);
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

  async move(id: string, to: PaperclipStepMove, held = false, liveOpen = false): Promise<boolean> {
    if (to === null || to === "waiting") return true;
    // Blocks unread, a card's hold is unknown: move nothing (fail closed); the next snapshot places the card.
    if (!(await this.ensureBlocks())) return false;
    // A closed issue's card is terminal; only its close moves it, and only a
    // live GitHub read of the issue as open (`liveOpen`) reopens it (Foreman #112).
    if (to !== "done" && this.index.terminal(id)) {
      if (!liveOpen) return false;
      this.index.markOpen(id);
    }
    const h = this.holds.get(id);
    if (h && !held) {
      if (to !== SESSION_STAGE[h.phase]) h.restore = to;
      return true;
    }
    if (await this.runInFlight(id, to === "done" ? "done" : stageTarget(this.env.cfg, to, to === "blocked" ? this.blockedOwner.get(id) : undefined).bucket)) {
      this.deferredMoves.set(id, to);
      return false;
    }
    this.deferredMoves.delete(id);
    let bucket: Bucket;
    let holder: Record<string, unknown> = {};
    let label: string | null = null;
    // Done is a closed issue's, and nobody's (Foreman #112): a released card left on its holder.
    if (to === "done") { bucket = "done"; holder = { assigneeAgentId: null, assigneeUserId: null }; }
    else {
      const t = stageTarget(this.env.cfg, to, to === "blocked" ? this.blockedOwner.get(id) : undefined);
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
    const ok = await this.patch(id, { status: this.env.statusName(bucket), ...holder, ...(labelIds ? { labelIds } : {}) });
    if (ok) {
      this.index.rowState.set(id, `status:${this.env.statusName(bucket)}`);
      const unblock = holder.unblockDescriptor as { action: string } | undefined;
      if (unblock) this.index.blockAction.set(id, unblock.action);
      if (to !== "done") this.rowStage.set(id, to);
      if ("assigneeAgentId" in holder) this.index.setHolder(id, holder.assigneeAgentId as string | null);
      if (to === "done") this.index.markClosed(id);
      if (bucket !== "blocked") {
        this.blockedReason.delete(id);
        this.blockedOwner.delete(id);
        this.rulingHeld.delete(id);
        this.restoredBlocks.delete(id);
      }
      this.persistBlock(id);
    }
    return ok;
  }

  /**
   * Retry the moves a run in flight deferred; the last one asked for wins. A
   * retry is decided again now, not replayed: the run it waited for is the one
   * most likely to have changed the card. Replayed blind, a move deferred during
   * the EM seat's run undid the escalation that run made (SLA-4308 left Blocked
   * for in_review) and put a card back in a column GitHub had left (SLA-4311 to
   * To Do from review), 2026-11-06.
   */
  async retryDeferredMoves(): Promise<void> {
    for (const [id, to] of [...this.deferredMoves]) {
      if (this.holds.has(id) || this.index.closedCards.has(id) || !(await this.stillWanted(id, to))) { this.deferredMoves.delete(id); continue; }
      await this.move(id, to);
    }
  }

  /**
   * A deferred move still stands. The card is read live first, whatever the
   * move: a seat's escalation or a person's hold on it now was made while the
   * move waited, so it is newer and wins, the Foreman's own block or ruling
   * included (it would overwrite the hold's holder and descriptor). A stage move
   * also stands only while GitHub is at that stage (the snapshot running the
   * retry has just placed a card GitHub moved on) and no hold outranks it. The
   * Foreman's blocks (`blocked`, `needsRuling`) are made at whatever stage
   * GitHub is at, and a close (`done`) is not a stage, so neither is compared.
   */
  private async stillWanted(id: string, to: PaperclipStepMove): Promise<boolean> {
    if (to === null || to === "waiting" || to === "done") return true;
    const own = to === "blocked" || to === "needsRuling";
    const gh = this.ghStage.get(id);
    if (!own && gh !== undefined && gh !== to) return false;
    await this.index.refreshRow(id);
    if (this.externalHold(id)) return false;
    return own || !this.holdOutranks(id, to);
  }

  /**
   * The card's label ids with `key`'s stage label as its only one (`key`
   * undefined: the stage labels as they are) and the issue label present
   * once; null when nothing changes or the labels cannot be read.
   */
  async labelIdsFor(id: string, key: string | null | undefined): Promise<string[] | null> {
    this.stageLabelIds ??= (async () => {
      const r = await this.env.safeCall("ensure stage labels", () => ensureStageLabels(this.env.client, this.env.cfg));
      if (!r.ok) this.stageLabelIds = null;
      return r.ok ? r.value : null;
    })();
    const ids = await this.stageLabelIds;
    if (!ids) return null;
    if (!this.issueLabelId) {
      const f = await this.env.safeCall("ensure issue label", () => ensureIssueLabel(this.env.client));
      if (f.ok) this.issueLabelId = f.value;
    }
    const row = await this.env.safeCall("read task", () => this.env.client.getIssue(id), id);
    if (!row.ok) return null;
    const current = Array.isArray(row.value?.labelIds) ? row.value.labelIds : [];
    let next = key === undefined ? [...current] : withStage(current, ids, key);
    if (this.issueLabelId) next = withIssueLabel(next, this.issueLabelId);
    if (this.issueLabelId && current.includes(this.issueLabelId)) this.issueLabelled.add(id);
    return next.length === current.length && next.every((x, i) => x === current[i]) ? null : next;
  }

  /** True when the card is not yet known to carry the issue label (so a sync should write it). */
  async needsIssueLabel(id: string, have: RowContent | undefined): Promise<boolean> {
    if (this.issueLabelled.has(id)) return false;
    if (!this.issueLabelId) {
      const f = await this.env.safeCall("ensure issue label", () => ensureIssueLabel(this.env.client));
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
  async patch(id: string, body: Record<string, unknown>, commentAuthor?: string | null): Promise<boolean> {
    const r = await this.env.safeCall("update task", () => this.env.client.updateIssue(id, body, { commentAuthor }), id);
    if (r.ok && this.issueLabelId && Array.isArray(body.labelIds) && body.labelIds.includes(this.issueLabelId)) this.issueLabelled.add(id);
    return r.ok;
  }

  /**
   * The issue label onto every card of a served repo the last scan found without
   * it (`ownsCards`), whatever its issue's state or age: a closed issue the
   * snapshot no longer carries, or cards beyond a snapshot's write cap, still
   * get it. Only the label changes; at most CARD_WRITES_PER_SNAPSHOT a pass.
   */
  async backfillIssueLabels(): Promise<void> {
    const dup = new Set(this.index.duplicates.map((d) => d.id));
    let left = CARD_WRITES_PER_SNAPSHOT;
    for (const [id, have] of this.index.rowContent) {
      if (left <= 0) return;
      const repo = this.index.rowRepo.get(id);
      if (!repo || !this.index.servedRepos.has(repo) || dup.has(id)) continue;
      if (!this.index.mirroredKey(repo)) continue;
      if (!(await this.needsIssueLabel(id, have))) continue;
      const labelIds = await this.labelIdsFor(id, undefined);
      if (!labelIds) continue;
      left--;
      await this.patch(id, { labelIds });
    }
  }
}
