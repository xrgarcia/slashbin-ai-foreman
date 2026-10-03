// Mirrors the Foreman's work onto Paperclip (EM#417): each step the Foreman
// reports on an issue becomes a note on that issue's Paperclip task, the task
// is held by the Foreman's agent, and its status follows the step.
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
// carries that line. Status is set only where a sync deriving it from GitHub
// labels would set the same bucket: building → in_progress, any PR-review
// state → in_review. Merged to the base branch and blocked are notes only.
//
// Release: once an item's work is in a release PR (base → production) the row
// goes to in_review, "waiting on release PR #N", and to done when that PR
// merges. Promotion used to be a note, so an item waiting only on the release
// merge read as "in progress" (Slashbin-console#1185 behind PR #1206).
//
// The one status no label carries is `blocked`: an issue the Foreman holds
// back this cycle (a back-off, an occupied branch) is moved to blocked with the
// reason as Paperclip's unblock descriptor, and back to in_progress once it
// stops waiting. Both are written only on a change — the row's own status and
// descriptor are the record, so a restart re-derives them instead of repeating.
//
// The board is the queue: each row's status says what the Foreman is doing
// with it, and the agent's own status says whether a session is running. Every
// row is filed under a Paperclip project named for its repo, created on first
// use; `start()` backfills the project on rows that lack it, and cancels the
// retired "Foreman — live" summary task.

import type { PriorState, ReleaseEvent, SessionEvent, WaitingItem, WorkItem, WorkObserver, WorkState } from "../adapters.js";
import { redactAll } from "../agent.js";
import type { PaperclipConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { PaperclipClientError, type PaperclipClient } from "./client.js";

/** A Paperclip status bucket; `statusMap` may rename each one. */
export type PaperclipBucket = "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
type Bucket = PaperclipBucket;

/** One step the mirror writes: the status it sets (null = note only) and the note. */
export type PaperclipStep = { readonly status: Bucket | null; readonly note: string };

/**
 * Every step the mirror writes to a task, in the order an issue meets them.
 * `{name}` in a note is filled from the event; nothing else varies. Exported
 * as the single source for these strings, so docs/paperclip.md is generated
 * from the table the mirror runs on.
 */
export const PAPERCLIP_STEPS = Object.freeze({
  claim: { status: "in_progress", note: "picked up by Foreman" },
  queued: { status: "in_progress", note: "queued" },
  prLink: { status: null, note: "PR opened: {prUrl}" },
  inReview: { status: "in_review", note: "under review" },
  changesRequested: { status: "in_review", note: "changes requested" },
  approved: { status: "in_review", note: "approved" },
  blocked: { status: null, note: "blocked: {reason}" },
  merged: { status: null, note: "merged" },
  releaseWaiting: { status: "in_review", note: "waiting on release PR #{pr} to merge to {branch}" },
  released: { status: "done", note: "release PR #{pr} merged to {branch}" },
  inProduction: { status: "done", note: "in production ({branch})" },
  releaseClosed: { status: null, note: "release PR #{pr} closed without merging; waiting for the next release" },
  backoffPause: { status: null, note: "paused: {upstream} back-off: {reason}" },
  backoffResume: { status: null, note: "resumed after back-off" },
  waiting: { status: "blocked", note: "waiting: {reason}" },
  resumed: { status: "in_progress", note: "resumed: no longer waiting" },
  implementFinished: { status: null, note: "implement session finished: {detail}" },
  implementFailed: { status: null, note: "implement session failed: {detail}" },
  reviseStarted: { status: null, note: "revision started: PR #{pr}" },
  reviseFinished: { status: null, note: "revision finished: {detail}" },
  reviseFailed: { status: null, note: "revision failed: {detail}" },
  reviewStarted: { status: null, note: "review started: PR #{pr} by {reviewer}" },
  reviewHandoff: { status: null, note: "review handed to {reviewer}: {detail}" },
  reviewFinished: { status: null, note: "review finished: {detail}" },
  reviewFailed: { status: null, note: "review failed: {detail}" },
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
};

/** The longest reason or detail written; Paperclip caps an unblock action at 2000. */
const TEXT_CAP = 500;

/** The step for each state the Foreman can report. */
const STATE_STEP: Record<WorkState, PaperclipStep> = {
  queued: PAPERCLIP_STEPS.queued,
  inReview: PAPERCLIP_STEPS.inReview,
  changesRequested: PAPERCLIP_STEPS.changesRequested,
  approved: PAPERCLIP_STEPS.approved,
};

/** `template` with each `{name}` replaced from `vars`, in one pass. */
function fill(template: string, vars: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** How long a full scan of the company's tasks answers a lookup that missed. */
const INDEX_TTL_MS = 10 * 60_000;

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

  constructor(
    private readonly client: PaperclipClient,
    private readonly cfg: PaperclipConfig,
    private readonly secrets: ReadonlyArray<{ name: string; value: string }>,
    private readonly logger: Logger,
  ) {}

  async onClaim(item: WorkItem, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    this.building = item;
    const id = await this.resolve(item, true);
    if (!id) return;
    const step = PAPERCLIP_STEPS.claim;
    await this.setStatus(id, step.status);
    // A second claim before any state change is the same work, retried after a
    // failed attempt: say so once, rather than "picked up" twice.
    const key = this.keyOf(item);
    await this.note(id, this.claimed.has(key) ? PAPERCLIP_RETRY_NOTE : step.note);
    this.claimed.add(key);
  }

  async onState(item: WorkItem, _from: PriorState, to: WorkState, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const step = STATE_STEP[to];
    if (!step) return;
    if (to !== "queued" && sameItem(this.building, item)) this.building = null;
    if (to !== "queued") this.claimed.delete(this.keyOf(item));
    const id = await this.resolve(item, false);
    if (!id) return;
    if (step.status) await this.setStatus(id, step.status);
    await this.note(id, step.note);
  }

  async onPrLink(item: WorkItem, prUrl: string, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (id) await this.note(id, fill(PAPERCLIP_STEPS.prLink.note, { prUrl }));
  }

  async onBlocked(item: WorkItem, reason: string, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    if (sameItem(this.building, item)) this.building = null;
    this.claimed.delete(this.keyOf(item));
    const id = await this.resolve(item, false);
    if (id) await this.note(id, fill(PAPERCLIP_STEPS.blocked.note, { reason }));
  }

  async onMerged(item: WorkItem, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (id) await this.note(id, PAPERCLIP_STEPS.merged.note);
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
      if (step.status && !(await this.setStatus(id, step.status))) continue;
      await this.note(id, fill(step.note, vars));
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
    run();
    const timer = setInterval(run, INDEX_TTL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
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
      const made = await this.safeCall("create project", () => this.client.createProject({ name, status: "in_progress" }));
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
    if (id) await this.note(id, fill(PAPERCLIP_STEPS.backoffPause.note, { upstream, reason }));
  }

  async onBackoffResume(_upstream: string, _logger: Logger): Promise<void> {
    if (!this.building) return;
    const id = await this.resolve(this.building, false);
    if (id) await this.note(id, PAPERCLIP_STEPS.backoffResume.note);
  }

  /**
   * `repo`'s full waiting set this cycle. A row newly waiting, or waiting for a
   * new reason, goes blocked with the reason as its unblock descriptor and one
   * note; a row this agent had blocked in `repo` that is not in the set goes
   * back to in_progress with one note. A row already showing what it should is
   * not touched, however many cycles repeat it.
   */
  async onWaiting(repo: string, waiting: ReadonlyArray<WaitingItem>, _logger: Logger): Promise<void> {
    const cleaned = waiting.map((w) => ({ item: w.item, reason: this.clean(w.reason) }));

    const keep = new Set<string>();
    for (const w of cleaned) {
      const id = await this.resolve(w.item, false);
      if (!id) continue;
      keep.add(id);
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
      await this.note(id, fill(step.note, { reason: w.reason }));
    }

    if (await this.ensureIndex()) {
      for (const [id, state] of this.rowState) {
        if (keep.has(id) || !state.startsWith("waiting\n") || this.rowRepo.get(id) !== repo) continue;
        if (!(await this.setStatus(id, "in_progress"))) continue;
        await this.note(id, PAPERCLIP_STEPS.resumed.note);
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

    const step = SESSION_STEP[`${event.phase}:${event.status}`];
    if (step) {
      const text = fill(step.note, {
        pr: event.pr === undefined ? "?" : String(event.pr),
        reviewer: event.reviewer ?? "reviewer",
        detail: this.clean(event.detail ?? "") || event.status,
      });
      for (const item of event.items) {
        const id = await this.resolve(item, false);
        if (id) await this.note(id, text);
      }
    }
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
    const one = redactAll(String(text), this.secrets).replace(/\s+/g, " ").trim();
    return one.length > TEXT_CAP ? `${one.slice(0, TEXT_CAP - 1)}…` : one;
  }

  /** `identityKeyFormat` for `item`: the first line of its task's description. */
  private keyOf(item: WorkItem): string {
    return this.cfg.identityKeyFormat
      .split("{repo}").join(item.repo)
      .split("{N}").join(String(item.issueNumber));
  }

  private statusName(bucket: Bucket): string {
    return this.cfg.statusMap?.[bucket] ?? bucket;
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

    const found = this.index?.get(key);
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
        const blocked = row.status === this.statusName("blocked") && row.assigneeAgentId === this.cfg.agentId;
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
   * Set the task's status, held by the Foreman's agent. True on success.
   *
   * `assigneeUserId: null` in the same update: Paperclip allows one assignee
   * ("Issue can only have one assignee", 422), and a sync gives an in_progress
   * row a board user, so taking the row means releasing that user.
   */
  private async setStatus(id: string, bucket: Bucket): Promise<boolean> {
    const project = await this.projectPatch(id);
    const ok = await this.patch(id, { ...project, status: this.statusName(bucket), assigneeAgentId: this.cfg.agentId, assigneeUserId: null });
    if (ok) {
      this.rowState.set(id, `status:${this.statusName(bucket)}`);
      if (project.projectId) this.rowProject.set(id, project.projectId);
    }
    return ok;
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
  private async note(id: string, text: string): Promise<void> {
    const body = redactAll(text, this.secrets);
    const row = await this.safeCall("read task", () => this.client.getIssue(id), id);
    const status = row.ok ? row.value?.status : undefined;
    const held = (["blocked", "done", "cancelled"] as const).map((b) => this.statusName(b));
    if (status && held.includes(status)) {
      await this.safeCall("post note", () => this.client.updateIssue(id, { comment: body, status }), id);
      return;
    }
    await this.safeCall("post note", () => this.client.createComment(id, body), id);
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
