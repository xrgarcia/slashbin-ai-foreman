// Thread notes: what the card's comment thread says. One markdown summary per
// session (comments.ts), the step notes, the handoff a note carries when another
// seat takes the card, and the rule that no note is posted twice in a row. A note
// a running session triggers waits for the session's own summary so the thread
// reads in order. It owns the notes' memory: each card's latest comment, the
// notes deferred, the PR and session outcome the next handoff cites. A session
// event is sequenced here: it asks placement to move the card, the session lease
// to hold it, and writes the note, each through a port the mirror injects.

import type { SessionEvent, WorkItem } from "../adapters.js";
import type { Logger } from "../logger.js";
import { QA_BEFORE_MERGE_FALLBACK_STAGE } from "../lifecycle.js";
import type { ReviewMilestone } from "../review-progress.js";
import { SESSION_FALLBACK_STAGE, SESSION_STAGE, stageSeat, stageTarget } from "./board.js";
import { reviewProgressComment, sessionComment, sessionCommentEvent, untouched } from "./comments.js";
import type { PaperclipStage } from "./config.js";
import type { PaperclipEnv } from "./env.js";
import { finishComment } from "./comments.js";
import { handoffComment, type HandoffFacts, type HandoffVariant } from "./handoff.js";
import type { PaperclipComment } from "./client.js";
import type { IndexPort, LeasePort, PlacementPort } from "./ports.js";
import { fill, handoffTo, PAPERCLIP_STEPS, type Holds, type NoteOpts, type SessionPhase, type PaperclipStep } from "./steps.js";

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

export class ThreadNotes {
  /** Task id → the PR last seen delivering its issue (a PR link, a session), for the handoff's links. */
  readonly prOf = new Map<string, { number: number; url?: string }>();
  /** Task id → the last session's outcome on it and when, the next handoff's "why"; used once. */
  private readonly evidence = new Map<string, { text: string; at: string }>();
  /** Task id → its latest comment body, read once per process and kept as notes are posted. */
  readonly lastNote = new Map<string, string>();
  /** Task id → notes due while a session held the card, posted after the session's own summary. */
  private readonly deferred = new Map<string, Array<{ text: string; opts: NoteOpts }>>();

  constructor(
    private readonly env: PaperclipEnv,
    private readonly index: Pick<IndexPort, "resolve" | "rowState">,
    private readonly placement: Pick<PlacementPort, "move" | "clearBlock" | "rowStage">,
    private readonly lease: Pick<LeasePort, "recovery" | "trackSession" | "writeLease" | "syncAgentStatus">,
    private readonly holds: Holds,
    /** Identity keys whose current claim repeats one that did not finish (the mirror's claims). */
    private readonly retrying: ReadonlySet<string>,
  ) {}

  /** A session started, changed hands or ended: one note per item, then the agent's status. */
  async onSession(event: SessionEvent, _logger: Logger): Promise<void> {
    await this.lease.recovery;
    this.lease.trackSession(event);

    const phase = event.phase as SessionPhase;
    const step = SESSION_STEP[`${event.phase}:${event.status}`];
    const opts: NoteOpts = { event: sessionCommentEvent(event), tag: "session" };
    const legacy = step && fill(step.note, {
      pr: event.pr === undefined ? "?" : String(event.pr),
      reviewer: event.reviewer ?? "reviewer",
      detail: this.env.clean(event.detail ?? "") || event.status,
    });
    let leaseChanged = false;
    for (const item of event.items) {
      const id = await this.index.resolve(item, false);
      if (!id) continue;
      if (phase === "qa") {
        // The QA gate runs inside the verify session that holds the card: its start re-places that hold at
        // `qaReviewing` (the seat the board gives QA); its end changes nothing, the verify session's end
        // releases the hold. No hold (mirror restarted mid-gate) = nothing to move.
        const h = this.holds.get(id);
        if (event.status === "started" && h) {
          h.phase = "qa";
          // Before the merge (qaBeforeMerge) the PR is still in review: a QA that ends with nothing newer returns there.
          if (event.qaBeforeMerge) h.fallback = QA_BEFORE_MERGE_FALLBACK_STAGE;
          h.placed = await this.placement.move(id, SESSION_STAGE.qa, true);
          if (this.env.comments.enabled) {
            await this.note(id, `**QA reviewing ${event.pr === undefined ? "the PR" : `PR #${event.pr}`} ${event.qaBeforeMerge ? "locally, before the merge" : "on dev"}** (visual and behaviour checks)`,
              { ...opts, handoff: handoffTo("qaReviewing", item) });
          }
          leaseChanged = true;
        }
        continue;
      }
      const retry = event.phase === "implement" && event.status === "started" && this.retrying.has(this.env.keyOf(item));
      // The step notes speak for the item worked; an untouched one gets none.
      const text = this.env.comments.enabled ? sessionComment(event, item, this.env.comments, retry) : untouched(event, item) ? undefined : legacy;
      // What the next handoff on this card cites: the PR, and this session's outcome.
      const pr = event.report?.pr ?? (event.pr !== undefined ? { number: event.pr } : undefined);
      if (pr && !untouched(event, item)) this.prOf.set(id, { number: pr.number, ...(pr.url ? { url: pr.url } : {}) });
      if (event.status === "started") this.evidence.delete(id);
      else if ((event.status === "finished" || event.status === "failed") && !untouched(event, item)) {
        const said = this.env.clean(outcomeOf(event));
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
          const placed = (this.placement.rowStage.get(id) === stage && this.index.rowState.get(id) === `status:${this.env.statusName(stageTarget(this.env.cfg, stage).bucket)}`)
            || await this.placement.move(id, stage);
          this.holds.set(id, { count: 1, phase, restore: null, placed });
          // The Foreman working the card again (the revision after a ruling) is its block over, persisted one too.
          if (placed) this.placement.clearBlock(id);
        }
        leaseChanged = true;
      } else if (event.status === "finished" || event.status === "failed") {
        const h = this.holds.get(id);
        if (h && --h.count <= 0) {
          this.holds.delete(id);
          const fallback = h.fallback ?? SESSION_FALLBACK_STAGE[h.phase];
          await this.placement.move(id, h.restore ?? fallback);
          if (h.restore === null) handoff = handoffTo(fallback, item);
          leaseChanged = true;
          released = true;
        }
      }
      if (text) await this.note(id, text, handoff ? { ...opts, handoff } : opts);
      if (released) await this.flushDeferred(id, event);
    }
    if (leaseChanged) await this.lease.writeLease();
    await this.lease.syncAgentStatus();
  }

  /**
   * A running review reached a new stage: the checklist so far, on each
   * item's card. Summaries only (`comments.enabled`), under the `progress`
   * toggle; posted at once, like the session's own notes, not held behind it.
   */
  async onReviewProgress(pr: number, items: ReadonlyArray<WorkItem>, milestones: ReadonlyArray<ReviewMilestone>): Promise<void> {
    if (!this.env.comments.enabled || !this.env.comments.events.progress || milestones.length === 0) return;
    await this.lease.recovery;
    const text = reviewProgressComment(pr, milestones);
    for (const item of items) {
      const id = await this.index.resolve(item, false);
      if (id) await this.note(id, text, { event: "progress", tag: "session" });
    }
  }

  /**
   * Post a note without moving the row. Paperclip reads a board user's comment
   * on an agent-held blocked, done or cancelled row as "please continue" and
   * moves it to todo, so a "waiting:" note un-blocked the row it had just
   * blocked (2026-10-02, first live check). On such a row the note goes in a
   * PATCH that restates the status, which Paperclip keeps.
   */
  async note(id: string, text: string, opts: NoteOpts): Promise<void> {
    if (!this.env.comments.events[opts.event]) return;
    // A card a session holds gets its notes after the session's own summary.
    if (this.env.comments.enabled && opts.tag !== "session" && this.holds.has(id)) {
      const q = this.deferred.get(id) ?? [];
      q.push({ text, opts });
      this.deferred.set(id, q);
      return;
    }
    const handoff = opts.handoff ? this.handoffFor(id, opts.handoff.stage, opts.handoff.item, opts.handoff.owner, opts.handoff.variant) : null;
    const body = finishComment(handoff ? `${text}\n\n${handoff}` : text, this.env.comments, this.env.secrets);
    if (!body) return;
    // Never the same note twice in a row (SLA-514 got one four times).
    if ((await this.latestComment(id)) === body) return;
    const row = await this.env.safeCall("read task", () => this.env.client.getIssue(id), id);
    const status = row.ok ? row.value?.status : undefined;
    const held = (["blocked", "done", "cancelled"] as const).map((b) => this.env.statusName(b));
    const sent = status && held.includes(status)
      ? await this.env.safeCall("post note", () => this.env.client.updateIssue(id, { comment: body, status }, this.env.ownComment()), id)
      : await this.env.safeCall("post note", () => this.env.client.createComment(id, body, this.env.ownComment()), id);
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
    return facts ? handoffComment(stage, facts, this.env.labels, variant) : null;
  }

  /** What a handoff to `stage` names, or null when the Foreman holds that stage. */
  handoffFacts(id: string | null, stage: PaperclipStage, item: WorkItem, evidence?: HandoffFacts["evidence"], owner?: string): HandoffFacts | null {
    const seat = stageSeat(this.env.cfg, stage, owner);
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
  async latestComment(id: string): Promise<string | undefined> {
    if (this.lastNote.has(id)) return this.lastNote.get(id);
    const r = await this.env.safeCall("read comments", () => this.env.client.getIssueComments(id), id);
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
}
