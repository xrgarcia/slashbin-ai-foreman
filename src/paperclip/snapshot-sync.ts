// Snapshot sync: the card follows GitHub. Each cycle's snapshot puts every card
// in the column its issue's labels call for, creates the cards an issue lacks,
// closes the cards of closed issues, and (with `ownsCards`) brings each card's
// title, description, holder and hold reason in step with its issue. GitHub is
// the record; events only move a card when the Foreman acts on that issue. It
// owns the sync's own memory (when a stale card was last read, which hold
// comments are on the board, who the board's GitHub logins are); the card
// index, placement and thread notes reach it by constructor injection.

import type { ItemState, SnapshotCard, SnapshotItem, WorkItem } from "../adapters.js";
import type { Logger } from "../logger.js";
import { assigneeFor, BACKLOG_STATUS, HOLD_PREFIX, isHoldComment, stageTarget } from "./board.js";
import { handoffNextLine } from "./handoff.js";
import { redactComment } from "./comments.js";
import type { PaperclipStage } from "./config.js";
import type { PaperclipEnv } from "./env.js";
import type { IndexPort, NotesPort, PlacementPort } from "./ports.js";
import {
  CARD_WRITES_PER_SNAPSHOT, fill, handoffTo, LABEL_BLOCK_ACTION, PAPERCLIP_CREATE_STATUS, PAPERCLIP_OWNED_TITLE_FORMAT, PAPERCLIP_STEPS,
  RECEIVER_HOLD_ENTRY, type Holds, type SnapshotReads,
} from "./steps.js";

/** How long the board's GitHub logins are trusted before a re-read. Each agent's `metadata.githubLogin` is the golden source for who it is on GitHub (Ray, 2026-10-16), so a hold comment is credited to the agent whose words it is. */
const GITHUB_LOGINS_TTL_MS = 10 * 60_000;

/** Cards with no open issue behind them that are read live per cycle, and how long a card waits between reads. */
const STALE_CHECKS_PER_SNAPSHOT = 50;
const STALE_CHECK_MS = 10 * 60_000;

export class SnapshotSync {
  /** Task id → when a card with no open issue was last read live. */
  private readonly staleCheckedAt = new Map<string, number>();
  /** "<task id> <comment url>": the holder's comment is on the card, posted or found; never read again. */
  private readonly holdCommented = new Set<string>();
  /** GitHub login → the agent whose `metadata.githubLogin` it is, and when the board was read. */
  private githubAgents: { at: number; byLogin: Map<string, string> } | null = null;

  constructor(
    private readonly env: PaperclipEnv,
    private readonly index: IndexPort,
    private readonly placement: PlacementPort,
    private readonly notes: NotesPort,
    private readonly holds: Holds,
  ) {}

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
    await this.index.warm(_repo);
    this.index.servedRepos.add(this.index.keyNow(_repo));
    // Blocks unread, a card's hold is unknown: place nothing this pass (fail closed).
    if (!(await this.placement.ensureBlocks())) {
      this.env.logger.warn("Paperclip card blocks could not be read; the snapshot pass waits for the next one");
      return;
    }
    // This repo's cards unread: place nothing for it this pass; the next snapshot retries (other repos carry on).
    if (!(await this.index.ensureRepo(_repo))) return;
    const blocked = `status:${this.env.statusName("blocked")}`;
    const cards = read.cards;
    // With `ownsCards`, every issue has a card before the lifecycle pass places
    // them, and a held issue's reason is at hand for a card entering Blocked.
    const owned = this.env.cfg.ownsCards === true && cards ? cards : null;
    const budget = { left: CARD_WRITES_PER_SNAPSHOT };
    const ids: Array<[SnapshotCard, string]> = [];
    for (const c of owned ?? []) {
      let id = await this.index.resolve(c.item, false);
      if (!id && c.state === "open" && budget.left > 0) {
        id = await this.createCard(c);
        if (id) budget.left--;
      }
      if (!id) continue;
      ids.push([c, id]);
      if (c.hold) this.placement.holdAction.set(id, c.hold.action);
      else this.placement.holdAction.delete(id);
    }
    // Closed on GitHub, read live: the open-issue view the items come from can
    // still carry such an issue with its old labels. Its card is not placed by them.
    const closed = new Map<number, "completed" | "not_planned">();
    for (const c of cards ?? read.closed ?? []) if (c.state !== "open") closed.set(c.item.issueNumber, c.state);
    const movers: Array<{ item: WorkItem; id: string; stage: SnapshotItem["stage"]; detail: string; state: string; want: string }> = [];
    // Lifecycle issues with no card yet: each gets one at its stage once GitHub reads it open (Foreman #113).
    const fresh: Array<{ item: WorkItem; stage: PaperclipStage; detail: string }> = [];
    // Needs-ruling blocks whose write never landed: delivered once GitHub reads the issue open.
    const rulings: Array<{ item: WorkItem; id: string }> = [];
    for (const { item, stage, detail, verifyHeld, foremanHeld } of items) {
      if (closed.has(item.issueNumber)) continue;
      const id = await this.index.resolve(item, false);
      if (!id) {
        if (stage !== "done") fresh.push({ item, stage, detail });
        continue;
      }
      this.placement.ghStage.set(id, stage);
      const state = this.index.rowState.get(id);
      if (this.holds.has(id)) {
        await this.placement.placeHeld(id);
        continue;
      }
      if (!state || state.startsWith("waiting\n")) continue;
      if (state === `status:${this.env.statusName("cancelled")}`) continue;
      // A needs-ruling block lost to an outage outranks the stage's own placement,
      // however well the card matches it: it sat on the Foreman or the Tech Lead.
      if (stage !== "done" && this.placement.rulingPending(id, stage)) {
        rulings.push({ item, id });
        continue;
      }
      const want = `status:${this.env.statusName(stage === "done" ? "done" : stageTarget(this.env.cfg, stage).bucket)}`;
      // The holder counts as much as the column: a lost hand-off leaves the status right and the seat wrong (Foreman #100).
      if (state === want && this.placement.holderMatches(id, stage)) continue;
      // A Foreman block is released by GitHub moving on, not by another writer:
      // the stage owner's own wake checks the card out to in_progress, and
      // matching that to GitHub took SLA-1335 out of the EM's hands (2026-10-14).
      // A block GitHub's label made ends when the label goes, at any stage:
      // read as a Foreman block from before a restart, jerky_service #132/#133
      // sat Blocked for hours after the EM lifted the label (2026-10-14).
      // A seat's escalation hop, or a person's hold, keeps the card until it is
      // resolved, or until GitHub moves the issue to another stage (Foreman #98):
      // undone each cycle, SLA-2591 went back to the EM three times in an hour.
      if (state === blocked && this.placement.externalHold(id)) {
        if (!this.placement.escalatedAt.has(id) || this.placement.escalatedAt.get(id) === stage) {
          this.placement.escalatedAt.set(id, stage);
          continue;
        }
      }
      this.placement.escalatedAt.delete(id);
      if ((state === blocked || this.placement.blockedAt.has(id)) && stage !== "blocked" && !(await this.blockedByLabel(id))) {
        // A block from before this process started stands only while the Foreman's state still holds the issue:
        // jerky_security_testing#398 sat Blocked at `release pending` after every hold was gone (2026-10-26).
        // A block read back from the store is that kind of block too.
        const anchored = this.placement.blockedAt.has(id) && !(this.placement.restoredBlocks.has(id) && foremanHeld === false);
        if (anchored ? this.placement.blockedAt.get(id) === stage || this.placement.blockedAt.get(id) === undefined : foremanHeld !== false && (stage === "approved" || (stage === "merged" && verifyHeld === true))) {
          this.placement.blockedAt.set(id, stage);
          this.placement.persistBlock(id);
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
    // A card closed for an issue the cards now show open is asked about too: only a live read reopens it.
    const reopened = ids.filter(([c, id]) => c.state === "open" && this.index.closedCards.has(id) && !closed.has(c.item.issueNumber));
    const asked = [...new Set([...movers.map((m) => m.item.issueNumber), ...toBacklog.map(([c]) => c.item.issueNumber),
      ...fresh.map((f) => f.item.issueNumber), ...reopened.map(([c]) => c.item.issueNumber), ...rulings.map((r) => r.item.issueNumber)])];
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
      // The board, read now: a hold put on since the scan stands (Foreman #98),
      // and a card someone already placed is not written again.
      await this.index.refreshRow(id);
      const nowState = this.index.rowState.get(id) ?? "";
      if (nowState.startsWith("waiting\n")) continue;
      // Only a hold new since the scan: one the cache showed was weighed above, and GitHub moving on released it.
      if (state !== blocked && this.placement.externalHold(id)) {
        this.placement.escalatedAt.set(id, stage);
        continue;
      }
      if (nowState === want && this.placement.holderMatches(id, stage)) continue;
      // Read open live: a card closed for it before is the issue reopened.
      if (!(await this.placement.move(id, stage, false, true))) continue;
      this.placement.blockedAt.delete(id);
      this.placement.persistBlock(id);
      if (stage === "blocked") this.placement.labelBlocked.add(id);
      else this.placement.labelBlocked.delete(id);
      logger.info(`Paperclip: ${item.repo}#${item.issueNumber} card ${state.slice(7)} → ${want.slice(7)}${state === want ? ", re-assigned" : ""} to match GitHub`);
      await this.notes.note(id, fill(PAPERCLIP_STEPS.synced.note, { detail }), { event: "progress", handoff: handoffTo(stage, item) });
    }
    for (const { item, id } of rulings) {
      if (live.get(item.issueNumber) !== "open") continue;
      const step = PAPERCLIP_STEPS.escalated;
      if (!(await this.placement.move(id, step.stage, false, true))) continue;
      logger.info(`Paperclip: ${item.repo}#${item.issueNumber} needs-ruling block delivered: its first write did not land`);
      const text = this.placement.blockedReason.get(id);
      if (text) await this.notes.note(id, text, { event: "blocked", handoff: handoffTo(step.stage, item) });
    }
    for (const { item, stage, detail } of fresh) {
      if (live.get(item.issueNumber) !== "open") continue;
      if (budget.left <= 0) break;
      const c = owned?.find((x) => x.item.issueNumber === item.issueNumber && x.item.repo === item.repo);
      const id = c ? await this.createCard(c) : await this.index.createTask(item, this.index.defaultContent(item));
      if (!id) continue;
      budget.left--;
      this.placement.ghStage.set(id, stage);
      if (c) ids.push([c, id]);
      if (!(await this.placement.move(id, stage, false, true))) continue;
      if (stage === "blocked") this.placement.labelBlocked.add(id);
      logger.info(`Paperclip: ${item.repo}#${item.issueNumber} had no card: created at ${stage} to match GitHub`);
      await this.notes.note(id, fill(PAPERCLIP_STEPS.synced.note, { detail }), { event: "progress", handoff: handoffTo(stage, item) });
    }
    // Without the cards, a card for an issue closed since the last read follows it.
    if (!owned) {
      for (const [n, how] of closed) {
        const id = await this.index.resolve({ issueNumber: n, repo: _repo }, false);
        if (id) await this.closeCard(id, how, { issueNumber: n, repo: _repo }, logger);
      }
    }
    // The closed read is one-shot per window, and a close it missed (Paperclip
    // down for that write, a hold that put the card back) is never offered
    // again: a card of this repo with no open issue behind it is asked about
    // live, so every closed issue's card reaches done or cancelled.
    if (read.states) {
      const open = new Set(owned ? owned.filter((c) => c.state === "open").map((c) => c.item.issueNumber) : items.map((i) => i.item.issueNumber));
      await this.closeStale(_repo, open, closed, read.states, logger);
    }
    const backlogged = new Set(toBacklog.map(([, id]) => id));
    for (const [c, id] of ids) {
      if (budget.left <= 0) {
        logger.info(`Paperclip: ${_repo} card writes capped at ${CARD_WRITES_PER_SNAPSHOT} this cycle; the rest follow next cycle`);
        break;
      }
      const now = live.get(c.item.issueNumber);
      // An issue the open view carries but GitHub reads closed is synced as closed.
      const card: SnapshotCard = c.state === "open" && now !== undefined && now !== "open" ? { ...c, state: now, stage: null } : c;
      await this.syncCard(id, card, budget, backlogged.has(id) && now !== "open", now === "open");
    }
    // Last, once this cycle's closes are made: a move a run deferred never lands
    // on a card whose issue this snapshot reads closed (Foreman #112).
    await this.placement.retryDeferredMoves();
  }

  /**
   * Close the cards of `repo` that show neither done nor cancelled while no
   * open issue stands behind them and this cycle's closed read did not name
   * them. Each is read live (`states`), at most STALE_CHECK_MS apart and
   * STALE_CHECKS_PER_SNAPSHOT a cycle; an issue that cannot be read is left.
   */
  private async closeStale(
    repo: string,
    open: ReadonlySet<number>,
    closed: ReadonlyMap<number, "completed" | "not_planned">,
    states: (issueNumbers: readonly number[]) => Promise<ReadonlyMap<number, ItemState>>,
    logger: Logger,
  ): Promise<void> {
    const now = Date.now();
    const due: Array<[string, number]> = [];
    for (const [id, n] of this.index.rowNumber) {
      if (this.index.rowRepo.get(id) !== this.index.keyNow(repo) || open.has(n)) continue;
      // Already done or cancelled with no open issue behind it: terminal, whatever arrives late (Foreman #112).
      if (this.index.isClosedCard(id)) { this.index.markClosed(id); continue; }
      if (due.length >= STALE_CHECKS_PER_SNAPSHOT) continue;
      if (closed.has(n) || this.holds.has(id) || !this.index.rowState.has(id)) continue;
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
      // Stamp only a settled check: a close whose write failed (Paperclip down)
      // must be retried next snapshot, not wait out STALE_CHECK_MS.
      if (s === "open" || (await this.closeCard(id, s, { issueNumber: n, repo }, logger))) this.staleCheckedAt.set(id, now);
    }
  }

  /** True when syncing an open, unapproved issue's card would move it to backlog. */
  private wouldBacklog(id: string): boolean {
    if (this.holds.has(id)) return false;
    const state = this.index.rowState.get(id) ?? "";
    if (!state.startsWith("status:")) return false;
    const status = state.slice(7);
    return status !== BACKLOG_STATUS && status !== this.env.statusName("cancelled");
  }

  /**
   * A card whose issue is closed: done, or cancelled when not planned, with no
   * stage label. A card a session holds and one already there are left alone;
   * a hold of the Foreman's (waiting, or Blocked) never keeps a closed issue's
   * card open (jerky_ops#138 and nine more, 2026-10-26). With `ownsCards` the
   * card sync does this instead.
   */
  private async closeCard(id: string, how: "completed" | "not_planned", item: WorkItem, logger: Logger): Promise<boolean> {
    if (this.holds.has(id)) return true;
    const state = this.index.rowState.get(id);
    if (!state) return true;
    const target = this.env.statusName(how === "not_planned" ? "cancelled" : "done");
    this.index.markClosed(id);
    this.placement.deferredMoves.delete(id);
    const have = this.index.rowContent.get(id);
    const assigned = !!(have?.assigneeAgentId || have?.assigneeUserId);
    if (state === `status:${target}` && !assigned) return true;
    const labelIds = await this.placement.labelIdsFor(id, null);
    // A closed issue's card is nobody's: a holder left on it is a seat told to act on finished work.
    if (!(await this.placement.patch(id, { status: target, assigneeAgentId: null, assigneeUserId: null, ...(labelIds ? { labelIds } : {}) }))) return false;
    this.index.setHolder(id, null);
    this.placement.labelBlocked.delete(id);
    this.placement.clearBlock(id);
    // Moved to its terminal state: the card is done with, and never looked for again.
    this.index.forget(id);
    if (state === `status:${target}`) return true;
    logger.info(`Paperclip: ${item.repo}#${item.issueNumber} card ${state.startsWith("waiting\n") ? "waiting" : state.slice(7)} → ${target}: the issue is closed ${how} on GitHub`);
    return true;
  }

  /**
   * What a card the Foreman owns says: title and description, from its issue.
   * At a stage another seat holds, the line under `stage <stage>` says what that
   * seat does next; line 2 keeps its shape, which readers of the board parse.
   */
  private cardContent(c: SnapshotCard, id: string | null = null): { title: string; description: string } {
    const [owner = "", name = ""] = c.item.repo.split("/");
    const line = c.state !== "open" ? `GitHub: closed ${c.state}` : `GitHub: open · ${c.stage ? `stage ${c.stage}` : "not approved"}`;
    const facts = c.state === "open" && c.stage && c.stage !== "done" ? this.notes.handoffFacts(id, c.stage, c.item) : null;
    const next = facts && c.stage && c.stage !== "done" ? `\n${handoffNextLine(c.stage, facts, this.env.labels)}` : "";
    const out = {
      title: fill(PAPERCLIP_OWNED_TITLE_FORMAT, { repo: c.item.repo, owner, name, N: String(c.item.issueNumber), title: c.title }),
      description: `${this.env.keyOf(c.item)}\n${line}${next}\n\n${c.url}`,
    };
    // A card found through the identity key keeps the owner spelling it was written with:
    // after a move the item names the new owner, and the card's text is not rewritten.
    const written = id ? this.index.writtenRepo(id) : null;
    if (written && written !== c.item.repo) {
      return { title: out.title.split(c.item.repo).join(written), description: out.description.split(c.item.repo).join(written) };
    }
    return out;
  }

  /**
   * The card for an open issue that has none (`ownsCards`): filed in the
   * Unplaced project like a claim's, in backlog when the issue is not approved,
   * else in the create status for the lifecycle pass to place.
   */
  private async createCard(c: SnapshotCard): Promise<string | null> {
    const status = c.stage === null ? BACKLOG_STATUS : this.env.statusName(PAPERCLIP_CREATE_STATUS);
    return this.index.createTask(c.item, { ...this.cardContent(c), status });
  }

  /**
   * Bring a card the Foreman owns in step with its issue (`ownsCards`): title
   * and description; closed → done, or cancelled when not planned, with no stage
   * label and nobody's; not approved → backlog, no stage label, held by
   * nobody, or by `humanUserId` when labelled `approved-for-human` (assigneeFor); a held card's reason as its unblock descriptor, and the holder's
   * comment once. One PATCH, only when something differs. A card a session holds
   * keeps its status; a cancelled card of an open issue and a waiting hold are
   * left as they are, as the lifecycle pass leaves them.
   */
  private async syncCard(id: string, c: SnapshotCard, budget: { left: number }, unconfirmed = false, liveOpen = false): Promise<void> {
    const want = this.cardContent(c, id);
    // Only a live read reopens a closed card: the open view can still carry a closed issue (Foreman #112).
    if (liveOpen) this.index.markOpen(id);
    const have = this.index.rowContent.get(id);
    const state = this.index.rowState.get(id) ?? "";
    const body: Record<string, unknown> = {};
    if (have?.title !== want.title) body.title = want.title;
    if (have?.description !== want.description) body.description = want.description;
    const free = !this.holds.has(id) && !state.startsWith("waiting\n");
    // The receiver's entry text on a Foreman-held card reads as a waiting hold; it is GitHub's hold, unread.
    const entry = !this.holds.has(id) && state.startsWith("waiting\n") && RECEIVER_HOLD_ENTRY.test(state.slice(8));
    let status = state.startsWith("status:") ? state.slice(7) : entry || state.startsWith("waiting\n") ? this.env.statusName("blocked") : null;
    // A closed issue closes its card whatever the Foreman holds on it; only a live session defers.
    if (!this.holds.has(id) && c.state !== "open") {
      this.index.markClosed(id);
      this.placement.deferredMoves.delete(id);
      const target = this.env.statusName(c.state === "not_planned" ? "cancelled" : "done");
      if (status !== target) {
        body.status = target;
        const labelIds = await this.placement.labelIdsFor(id, null);
        if (labelIds) body.labelIds = labelIds;
      }
      // Closed is nobody's: the last holder comes off too.
      if (have?.assigneeAgentId || have?.assigneeUserId) Object.assign(body, { status: target, assigneeAgentId: null, assigneeUserId: null });
    } else if (free && c.stage === null && status !== this.env.statusName("cancelled") && !unconfirmed) {
      // A human hold waits on its person; a user assignment wakes no agent.
      const user = assigneeFor(this.env.cfg, { labels: c.labels ?? [], repo: c.item.repo })?.assigneeUserId ?? null;
      if (status !== BACKLOG_STATUS || have?.assigneeAgentId || (have?.assigneeUserId ?? null) !== user) {
        Object.assign(body, { status: BACKLOG_STATUS, assigneeAgentId: null, assigneeUserId: user });
        const labelIds = await this.placement.labelIdsFor(id, null);
        if (labelIds) body.labelIds = labelIds;
      }
    } else if ((free || entry) && c.hold && status === this.env.statusName("blocked")) {
      const action = this.index.blockAction.get(id) ?? null;
      if (action !== c.hold.action && (action === null || action === LABEL_BLOCK_ACTION || action.startsWith(HOLD_PREFIX) || RECEIVER_HOLD_ENTRY.test(action))) {
        const t = stageTarget(this.env.cfg, "blocked", this.placement.blockedOwner.get(id));
        body.unblockDescriptor = { owner: t.agentId ? { agentId: t.agentId } : "board", action: c.hold.action };
        body.status = status;
      }
    }
    // The holder's words, once, on a card whose descriptor names them, and never
    // on another agent's card: a comment wakes the agent that holds it.
    const hold = c.state === "open" ? c.hold : undefined;
    const named = (body.unblockDescriptor as { action?: string } | undefined)?.action ?? (status === this.env.statusName("blocked") ? this.index.blockAction.get(id) : undefined);
    const holder = "assigneeAgentId" in body ? body.assigneeAgentId : have?.assigneeAgentId ?? null;
    const seen = hold?.commentUrl ? `${id} ${hold.commentUrl}` : "";
    if (hold?.comment && hold.commentUrl && named === hold.action && !this.holdCommented.has(seen) && (!holder || holder === this.env.cfg.agentId)) {
      const r = await this.env.safeCall("read comments", () => this.env.client.getIssueComments(id), id);
      if (r.ok && (Array.isArray(r.value) ? r.value : []).some((x) => isHoldComment(x.body, { comment: hold.comment!, url: hold.commentUrl! }))) this.holdCommented.add(seen);
      else if (r.ok) {
        body.comment = redactComment(hold.comment, this.env.secrets);
        // A board user's comment on a blocked card reopens it unless the same request restates the status.
        body.status ??= status;
      }
    }
    // Backfill: a card that predates the issue label gets it once, whatever its stage.
    if (!("labelIds" in body) && have && (await this.placement.needsIssueLabel(id, have))) {
      const labelIds = await this.placement.labelIdsFor(id, undefined);
      if (labelIds) body.labelIds = labelIds;
    }
    // A closed issue's card at its terminal state is done with: forgotten, never looked for again.
    const closing = !this.holds.has(id) && c.state !== "open";
    if (!Object.keys(body).length) { if (closing) this.index.forget(id); return; }
    if (budget.left <= 0) return;
    budget.left--;
    const holderAgent = body.comment && hold?.author ? await this.agentForLogin(hold.author) : null;
    if (!(await this.placement.patch(id, body, holderAgent ? `agent:${holderAgent}` : null))) return;
    if (body.comment) {
      this.holdCommented.add(seen);
      this.notes.lastNote.set(id, String(body.comment));
    }
    if (typeof body.status === "string") {
      status = body.status;
      this.index.rowState.set(id, `status:${status}`);
    }
    const unblock = body.unblockDescriptor as { action: string } | undefined;
    if (unblock) this.index.blockAction.set(id, unblock.action);
    this.index.rowContent.set(id, {
      title: want.title,
      description: want.description,
      assigneeAgentId: "assigneeAgentId" in body ? null : have?.assigneeAgentId ?? null,
      assigneeUserId: "assigneeUserId" in body ? (body.assigneeUserId as string | null) : have?.assigneeUserId ?? null,
      ...(Array.isArray(body.labelIds) ? { labelIds: body.labelIds as string[] } : have?.labelIds ? { labelIds: have.labelIds } : {}),
    });
    if (closing) this.index.forget(id);
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
    if (this.placement.blockedAt.has(id)) return false;
    if (this.placement.labelBlocked.has(id)) return true;
    const action = this.index.blockAction.get(id);
    if (action === LABEL_BLOCK_ACTION || action?.startsWith(HOLD_PREFIX)) return true;
    const prefix = fill(PAPERCLIP_STEPS.synced.note, { detail: "" }).trim();
    return (await this.notes.latestComment(id))?.startsWith(prefix) === true;
  }

  /** The agent whose `metadata.githubLogin` is `login`, or null. A failed read keeps the last answer. */
  async agentForLogin(login: string): Promise<string | null> {
    if (!this.githubAgents || Date.now() - this.githubAgents.at > GITHUB_LOGINS_TTL_MS) {
      const r = await this.env.safeCall("read agents", () => this.env.client.listAgents());
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
}
