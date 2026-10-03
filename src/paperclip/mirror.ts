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

import type { PriorState, ReleaseEvent, SessionEvent, WaitingItem, WorkItem, WorkObserver, WorkState } from "../adapters.js";
import { redactAll } from "../agent.js";
import type { PaperclipCommentEvent, PaperclipConfig, PaperclipStage, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import {
  ensureStageLabels, FOREMAN_BLOCKED_PREFIX, LIVE_LEASE_KEY, SESSION_FALLBACK_STAGE, SESSION_STAGE, stageTarget, statusName, withStage,
  type LiveLease, type PaperclipBucket,
} from "./board.js";
import { PaperclipClientError, type PaperclipClient, type PaperclipComment } from "./client.js";
import { commentsOf, finishComment, redactComment, sessionComment, sessionCommentEvent, type CommentsConfig } from "./comments.js";

export type { PaperclipBucket } from "./board.js";
type Bucket = PaperclipBucket;

/**
 * Where a step moves the card: a lifecycle stage (placed by `paperclip.board`),
 * "done" (status done, holder and stage label as before, stage label removed),
 * "waiting" (status blocked, held by the Foreman this cycle), or null (a note only).
 */
export type PaperclipStepMove = PaperclipStage | "done" | "waiting" | null;

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
  blocked: { stage: "blocked", note: "blocked: {reason}" },
  merged: { stage: null, note: "merged" },
  releaseWaiting: { stage: "awaitingRelease", note: "waiting on release PR #{pr} to merge to {branch}" },
  released: { stage: "done", note: "release PR #{pr} merged to {branch}" },
  inProduction: { stage: "done", note: "in production ({branch})" },
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

/** A task's title: {repo} is owner/name, {N} the issue number. */
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

/** The step for each state the Foreman can report. */
const STATE_STEP: Record<WorkState, PaperclipStep> = {
  queued: PAPERCLIP_STEPS.queued,
  inReview: PAPERCLIP_STEPS.inReview,
  changesRequested: PAPERCLIP_STEPS.changesRequested,
  merged: PAPERCLIP_STEPS.awaitingVerify,
  approved: PAPERCLIP_STEPS.approved,
};

/** `template` with each `{name}` replaced from `vars`, in one pass. */
function fill(template: string, vars: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** How long a full scan of the company's tasks answers a lookup that missed. */
const INDEX_TTL_MS = 10 * 60_000;

/**
 * A lookup that misses rescans once the last scan is this old, so a row
 * another writer (a periodic sync) added since is found within a minute, not
 * at the next ten-minute refresh.
 */
const MISS_RESCAN_MS = 60_000;

/** How often a held lease is renewed; well inside the shortest sensible `liveLeaseMinutes`. */
const LEASE_RENEW_MS = 4 * 60_000;

type SessionPhase = keyof typeof SESSION_STAGE;

/** How a note is posted: the comment event that gates it, and what kind of step wrote it. */
type NoteOpts = { readonly event: PaperclipCommentEvent; readonly tag?: "prLink" | "merged" | "session" };

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
  /** Task id → the project id the row carries (null = none), from the last scan. */
  private readonly rowProject = new Map<string, string | null>();
  /** Project name → its id, or the lookup in flight, so a name is created once. */
  private readonly projectIds = new Map<string, Promise<string | null>>();
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
  private readonly holds = new Map<string, { count: number; phase: SessionPhase; restore: PaperclipStepMove }>();
  /** Task id → the last lifecycle stage the mirror placed it in, so a resumed card goes back there. */
  private readonly rowStage = new Map<string, PaperclipStage>();
  /** Task id → why the Foreman blocked it, the unblock descriptor's action when it moves to `blocked`. */
  private readonly blockedReason = new Map<string, string>();
  /** Stage label key → the company's label id, or the lookup in flight; dropped on failure. */
  private stageLabelIds: Promise<Map<string, string> | null> | null = null;
  /** The Foreman agent's metadata minus the lease, so a lease write keeps every other key. */
  private agentMetadata: Record<string, unknown> | null = null;
  /** Task id → its latest comment body, read once per process and kept as notes are posted. */
  private readonly lastNote = new Map<string, string>();
  /** Task id → notes due while a session held the card, posted after the session's own summary. */
  private readonly deferred = new Map<string, Array<{ text: string; opts: NoteOpts }>>();
  /** Identity keys whose current claim repeats one that did not finish. */
  private readonly retrying = new Set<string>();
  private readonly comments: CommentsConfig;

  constructor(
    private readonly client: PaperclipClient,
    private readonly cfg: PaperclipConfig,
    private readonly secrets: ReadonlyArray<{ name: string; value: string }>,
    private readonly logger: Logger,
  ) {
    this.comments = commentsOf(cfg);
  }

  async onClaim(item: WorkItem, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
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

  async onState(item: WorkItem, _from: PriorState, to: WorkState, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const step = STATE_STEP[to];
    if (!step) return;
    if (to !== "queued" && sameItem(this.building, item)) this.building = null;
    if (to !== "queued") this.claimed.delete(this.keyOf(item));
    const id = await this.resolve(item, false);
    if (!id) return;
    await this.move(id, step.stage);
    await this.note(id, step.note, { event: "progress" });
  }

  async onPrLink(item: WorkItem, prUrl: string, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (id) await this.note(id, fill(PAPERCLIP_STEPS.prLink.note, { prUrl }), { event: "progress", tag: "prLink" });
  }

  async onBlocked(item: WorkItem, reason: string, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    if (sameItem(this.building, item)) this.building = null;
    this.claimed.delete(this.keyOf(item));
    const id = await this.resolve(item, false);
    if (!id) return;
    const text = fill(PAPERCLIP_STEPS.blocked.note, { reason: this.clean(reason) });
    this.blockedReason.set(id, text);
    await this.move(id, PAPERCLIP_STEPS.blocked.stage);
    await this.note(id, text, { event: "blocked" });
  }

  async onMerged(item: WorkItem, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (id) await this.note(id, PAPERCLIP_STEPS.merged.note, { event: "progress", tag: "merged" });
  }

  /**
   * Nothing: promotion fires when the release PR is opened, not when it merges,
   * so its old "promoted to production" note claimed what had not happened.
   * `onRelease` carries the release instead.
   */
  async onPromoted(_item: WorkItem, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {}

  /**
   * A release PR opened (rows → in_review, waiting on it), merged (→ done) or
   * closed unmerged (a note; the rows stay in_review for the next release). A
   * merge with no PR is work found already in production (→ done).
   */
  async onRelease(event: ReleaseEvent, _logger: Logger): Promise<void> {
    const vars = { pr: event.pr === undefined ? "?" : String(event.pr), branch: event.productionBranch };
    const step = event.state === "open" ? PAPERCLIP_STEPS.releaseWaiting
      : event.state === "closed" ? PAPERCLIP_STEPS.releaseClosed
      : event.pr === undefined ? PAPERCLIP_STEPS.inProduction : PAPERCLIP_STEPS.released;
    for (const item of event.issues) {
      if (sameItem(this.building, item)) this.building = null;
      this.claimed.delete(this.keyOf(item));
      const id = await this.resolve(item, false);
      if (!id) continue;
      if (step.stage && !(await this.move(id, step.stage))) continue;
      await this.note(id, fill(step.note, vars), { event: "release" });
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
    void this.recoverLease().then(run);
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
   * whole metadata object, so the agent's other keys are read first when this
   * process has not seen them; unread, the lease is not written. Never throws.
   */
  private async writeLease(): Promise<void> {
    if (!this.cfg.agentId) return;
    if (this.agentMetadata === null) {
      const agent = await this.safeCall("read agent", () => this.client.getAgent(this.cfg.agentId!));
      if (!agent.ok) return;
      const { [LIVE_LEASE_KEY]: _old, ...rest } = (agent.value?.metadata ?? {}) as Record<string, unknown>;
      this.agentMetadata = rest;
    }
    const lease: LiveLease = {
      leaseAt: new Date().toISOString(),
      rows: [...this.holds].map(([id, h]) => ({ id, phase: h.phase })),
    };
    await this.safeCall("update agent", () =>
      this.client.updateAgent(this.cfg.agentId!, { metadata: { ...(this.agentMetadata ?? {}), [LIVE_LEASE_KEY]: lease } }));
  }

  /** One housekeeping pass; never throws. */
  async housekeep(): Promise<void> {
    if (this.housekeeping) return;
    this.housekeeping = true;
    try {
      if (!(await this.ensureIndex(true))) return;
      await this.retireLiveTask();
      if (!this.cfg.projects) return;
      for (const [id, repo] of [...this.rowRepo]) {
        const pid = await this.projectFor(repo);
        if (!pid || this.rowProject.get(id) === pid) continue;
        if (await this.patch(id, { projectId: pid })) this.rowProject.set(id, pid);
      }
    } finally {
      this.housekeeping = false;
    }
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
    await this.safeCall("retire live task", () => this.client.updateIssue(id, { status: cancelled, comment: LEGACY_LIVE_NOTE }), id);
  }

  /**
   * The id of `repo`'s project, looked up by name (archived included) and
   * created when missing. One lookup per name per process; a failed one is
   * forgotten so the next call retries. Null when projects are off or failed.
   */
  private projectFor(repo: string): Promise<string | null> {
    if (!this.cfg.projects) return Promise.resolve(null);
    const name = fill(this.cfg.projectNameFormat, { repo, name: repo.split("/").pop() ?? repo });
    const known = this.projectIds.get(name);
    if (known) return known;
    const lookup = (async () => {
      const listed = await this.safeCall("list projects", () => this.client.listProjects());
      if (!listed.ok) return null;
      const found = (Array.isArray(listed.value) ? listed.value : []).find((p) => p.name === name);
      if (found) return found.id;
      const made = await this.safeCall("create project", () => this.client.createProject({ name, status: this.cfg.projectStatus ?? "in_progress" }));
      return made.ok && made.value?.id ? made.value.id : null;
    })();
    this.projectIds.set(name, lookup);
    void lookup.then((id) => {
      if (!id) this.projectIds.delete(name);
    });
    return lookup;
  }

  /** `{ projectId }` when the row should carry a project it does not yet, else nothing. */
  private async projectPatch(id: string): Promise<{ projectId?: string }> {
    const repo = this.rowRepo.get(id);
    if (!repo) return {};
    const pid = await this.projectFor(repo);
    return pid && this.rowProject.get(id) !== pid ? { projectId: pid } : {};
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
      // A skip in its back-off needs a person: it is in (or goes to) the
      // blocked stage, held by that stage's owner. Re-blocking it as a
      // Foreman-held wait took it from that owner every cycle (EM #417).
      if (w.skipped) {
        if (this.rowState.get(id) === `status:${this.statusName("blocked")}`) continue;
        const text = fill(PAPERCLIP_STEPS.blocked.note, { reason: w.reason });
        this.blockedReason.set(id, text);
        if (await this.move(id, PAPERCLIP_STEPS.blocked.stage)) await this.note(id, text, { event: "blocked" });
        continue;
      }
      const want = `waiting\n${w.reason}`;
      if (this.rowState.get(id) === want) continue;
      const step = PAPERCLIP_STEPS.waiting;
      const ok = await this.patch(id, {
        ...(await this.projectPatch(id)),
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
      const text = this.comments.enabled ? sessionComment(event, item, this.comments, retry) : legacy;
      let released = false;
      if (event.status === "started" && phase in SESSION_STAGE) {
        const h = this.holds.get(id);
        if (h) h.count++;
        else {
          // The card takes the session's stage first (the claim may already
          // have put it there), then is held there.
          const stage = SESSION_STAGE[phase];
          if (this.rowStage.get(id) !== stage || this.rowState.get(id) !== `status:${this.statusName(stageTarget(this.cfg, stage).bucket)}`) {
            await this.move(id, stage);
          }
          this.holds.set(id, { count: 1, phase, restore: null });
        }
        leaseChanged = true;
      } else if (event.status === "finished" || event.status === "failed") {
        const h = this.holds.get(id);
        if (h && --h.count <= 0) {
          this.holds.delete(id);
          await this.move(id, h.restore ?? SESSION_FALLBACK_STAGE[h.phase]);
          leaseChanged = true;
          released = true;
        }
      }
      if (text) await this.note(id, text, opts);
      if (released) await this.flushDeferred(id, event);
    }
    if (leaseChanged) await this.writeLease();
    await this.syncAgentStatus();
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

    const projectId = await this.projectFor(item.repo);
    const made = await this.safeCall("create task", () =>
      this.client.createIssue({
        title: fill(PAPERCLIP_TASK_TITLE_FORMAT, { repo: item.repo, N: String(item.issueNumber) }),
        status: this.statusName(PAPERCLIP_CREATE_STATUS),
        description: `${key}\n\nhttps://github.com/${item.repo}/issues/${item.issueNumber}`,
        ...(projectId ? { projectId } : {}),
      }),
    );
    if (!made.ok || !made.value?.id) return null;
    const id = made.value.id;
    this.taskUuidCache.set(key, id);
    this.index?.set(key, id);
    this.rowRepo.set(id, item.repo);
    this.rowProject.set(id, projectId);
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
    const scanned = await this.safeCall("scan tasks", async () => {
      const idx = new Map<string, string>();
      const state = new Map<string, string>();
      const repoOf = new Map<string, string>();
      const project = new Map<string, string | null>();
      for await (const row of this.client.listIssues()) {
        const line = String(row.description ?? "").split("\n")[0].trim();
        if (!line || idx.has(line)) continue;
        idx.set(line, row.id);
        const m = keyRe.exec(line);
        if (!m?.groups) continue;
        repoOf.set(row.id, m.groups.repo);
        project.set(row.id, row.projectId ?? null);
        const action = row.unblockDescriptor?.action;
        // A Foreman-held blocked row is a waiting hold, unless the Foreman blocked it for good.
        const blocked = row.status === this.statusName("blocked") && row.assigneeAgentId === this.cfg.agentId
          && !String(action ?? "").startsWith(FOREMAN_BLOCKED_PREFIX);
        state.set(row.id, blocked && action ? `waiting\n${action}` : blocked ? "waiting\n" : `status:${row.status}`);
      }
      return { idx, state, repoOf, project };
    });
    if (!scanned.ok) return !!this.index;
    this.index = scanned.value.idx;
    this.indexedAt = Date.now();
    this.rowState.clear();
    for (const [k, v] of scanned.value.state) this.rowState.set(k, v);
    this.rowRepo.clear();
    for (const [k, v] of scanned.value.repoOf) this.rowRepo.set(k, v);
    this.rowProject.clear();
    for (const [k, v] of scanned.value.project) this.rowProject.set(k, v);
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
  private async move(id: string, to: PaperclipStepMove): Promise<boolean> {
    if (to === null || to === "waiting") return true;
    const h = this.holds.get(id);
    if (h) {
      if (to !== SESSION_STAGE[h.phase]) h.restore = to;
      return true;
    }
    let bucket: Bucket;
    let holder: Record<string, unknown> = {};
    let label: string | null = null;
    if (to === "done") bucket = "done";
    else {
      const t = stageTarget(this.cfg, to);
      bucket = t.bucket;
      label = t.label;
      if (t.agentId) holder = { assigneeAgentId: t.agentId, assigneeUserId: null };
      // Paperclip takes `blocked` only with an unblock descriptor.
      if (bucket === "blocked") {
        const action = this.blockedReason.get(id) ?? `${FOREMAN_BLOCKED_PREFIX}needs attention`;
        holder.unblockDescriptor = { owner: t.agentId ? { agentId: t.agentId } : "board", action };
      }
    }
    const project = await this.projectPatch(id);
    const labelIds = await this.labelIdsFor(id, label);
    const ok = await this.patch(id, { ...project, status: this.statusName(bucket), ...holder, ...(labelIds ? { labelIds } : {}) });
    if (ok) {
      this.rowState.set(id, `status:${this.statusName(bucket)}`);
      if (to !== "done") this.rowStage.set(id, to);
      if (bucket !== "blocked") this.blockedReason.delete(id);
      if (project.projectId) this.rowProject.set(id, project.projectId);
    }
    return ok;
  }

  /** The card's label ids with `key`'s stage label as its only one; null when the labels cannot be read. */
  private async labelIdsFor(id: string, key: string | null): Promise<string[] | null> {
    this.stageLabelIds ??= (async () => {
      const r = await this.safeCall("ensure stage labels", () => ensureStageLabels(this.client, this.cfg));
      if (!r.ok) this.stageLabelIds = null;
      return r.ok ? r.value : null;
    })();
    const ids = await this.stageLabelIds;
    if (!ids) return null;
    const row = await this.safeCall("read task", () => this.client.getIssue(id), id);
    if (!row.ok) return null;
    const current = Array.isArray(row.value?.labelIds) ? row.value.labelIds : [];
    const next = withStage(current, ids, key);
    return next.length === current.length && next.every((x, i) => x === current[i]) ? null : next;
  }

  private async patch(id: string, body: Record<string, unknown>): Promise<boolean> {
    const r = await this.safeCall("update task", () => this.client.updateIssue(id, body), id);
    return r.ok;
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
    const body = finishComment(text, this.comments, this.secrets);
    if (!body) return;
    // Never the same note twice in a row (SLA-514 got one four times).
    if ((await this.latestComment(id)) === body) return;
    const row = await this.safeCall("read task", () => this.client.getIssue(id), id);
    const status = row.ok ? row.value?.status : undefined;
    const held = (["blocked", "done", "cancelled"] as const).map((b) => this.statusName(b));
    const sent = status && held.includes(status)
      ? await this.safeCall("post note", () => this.client.updateIssue(id, { comment: body, status }), id)
      : await this.safeCall("post note", () => this.client.createComment(id, body), id);
    if (sent.ok) this.lastNote.set(id, body);
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
