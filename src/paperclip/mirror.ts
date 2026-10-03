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
// state → in_review. done / cancelled come from the issue closing, which the
// Foreman never does, so merged, promoted and blocked are notes only.
//
// The one status no label carries is `blocked`: an issue the Foreman holds
// back this cycle (a back-off, an occupied branch) is moved to blocked with the
// reason as Paperclip's unblock descriptor, and back to in_progress once it
// stops waiting. Both are written only on a change — the row's own status and
// descriptor are the record, so a restart re-derives them instead of repeating.
//
// Beside the per-issue rows, one "live" task held by the agent shows the whole
// Foreman at once (running sessions, waits, stalled promotions, back-offs) and
// the agent's own status says whether a session is running.

import type { PriorState, SessionEvent, WaitingItem, WorkItem, WorkObserver, WorkState } from "../adapters.js";
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
  promoted: { status: null, note: "promoted to production" },
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

/** The first description line of the live task: one per agent. */
export const PAPERCLIP_LIVE_KEY_FORMAT = "foreman-live: {agentId}";

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
  /** Repo → the items waiting this cycle, reasons cleaned. */
  private readonly waiting = new Map<string, ReadonlyArray<WaitingItem>>();
  /** Repo → why its promotion is stalled. */
  private readonly stalls = new Map<string, string>();
  /** Upstream → why it is backed off. */
  private readonly backoffs = new Map<string, string>();
  /** Running sessions, by repo + phase + items. */
  private readonly sessions = new Map<string, { event: SessionEvent; since: Date }>();
  /** The agent status last written, so an unchanged one is never re-sent. */
  private agentStatusSent: string | null = null;
  /** The live task's id, and the body last written to it (without the timestamp line). */
  private liveId: string | null = null;
  private liveBody: string | null = null;
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

  async onPromoted(item: WorkItem, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (id) await this.note(id, PAPERCLIP_STEPS.promoted.note);
  }

  async onBackoffPause(upstream: string, reason: string, _logger: Logger): Promise<void> {
    this.backoffs.set(upstream, this.clean(reason));
    await this.refreshLive();
    if (!this.building) return;
    const id = await this.resolve(this.building, false);
    if (id) await this.note(id, fill(PAPERCLIP_STEPS.backoffPause.note, { upstream, reason }));
  }

  async onBackoffResume(upstream: string, _logger: Logger): Promise<void> {
    this.backoffs.delete(upstream);
    await this.refreshLive();
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
    if (cleaned.length) this.waiting.set(repo, cleaned);
    else this.waiting.delete(repo);

    const keep = new Set<string>();
    for (const w of cleaned) {
      const id = await this.resolve(w.item, false);
      if (!id) continue;
      keep.add(id);
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
      await this.note(id, fill(step.note, { reason: w.reason }));
    }

    if (await this.ensureIndex()) {
      for (const [id, state] of this.rowState) {
        if (keep.has(id) || !state.startsWith("waiting\n") || this.rowRepo.get(id) !== repo) continue;
        if (!(await this.setStatus(id, "in_progress"))) continue;
        await this.note(id, PAPERCLIP_STEPS.resumed.note);
      }
    }
    await this.refreshLive();
  }

  /** A session started, changed hands or ended: one note per item, then the live view and agent status. */
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
    await this.refreshLive();
  }

  /** Promotion on `repo` is stalled for `detail`, or no longer (null): the live view only. */
  async onPromotionStall(repo: string, detail: string | null, _logger: Logger): Promise<void> {
    if (detail) this.stalls.set(repo, this.clean(detail));
    else this.stalls.delete(repo);
    await this.refreshLive();
  }

  /** The agent's status: running while any session runs, else idle. Written only on a change. */
  private async syncAgentStatus(): Promise<void> {
    if (!this.cfg.agentStatus || !this.cfg.agentId) return;
    const want = this.sessions.size ? "running" : "idle";
    if (this.agentStatusSent === want) return;
    const r = await this.safeCall("update agent", () => this.client.updateAgent(this.cfg.agentId!, { status: want }));
    if (r.ok) this.agentStatusSent = want;
  }

  /** Rewrite the live task's description when what it shows has changed. */
  private async refreshLive(): Promise<void> {
    if (!this.cfg.liveTask || !this.cfg.agentId) return;
    const body = this.renderLive();
    if (body === this.liveBody) return;
    const stamp = `Updated ${hhmm(new Date())} UTC.`;
    const liveKey = fill(PAPERCLIP_LIVE_KEY_FORMAT, { agentId: this.cfg.agentId });
    const description = `${liveKey}\n\n${body}\n\n${stamp}`;

    if (!this.liveId) {
      if (!(await this.ensureIndex(true))) return;
      this.liveId = this.index?.get(liveKey) ?? null;
      if (!this.liveId) {
        const made = await this.safeCall("create live task", () =>
          this.client.createIssue({
            title: this.cfg.liveTaskTitle,
            status: this.statusName("in_progress"),
            description: redactAll(description, this.secrets),
            assigneeAgentId: this.cfg.agentId,
          }),
        );
        if (!made.ok || !made.value?.id) return;
        this.liveId = made.value.id;
        this.index?.set(liveKey, this.liveId);
        this.liveBody = body;
        return;
      }
    }
    const id = this.liveId;
    const ok = await this.patch(id, { title: this.cfg.liveTaskTitle, description: redactAll(description, this.secrets) });
    if (ok) this.liveBody = body;
  }

  /** The live task's body: what runs, what waits, what is stalled, what is backed off. */
  private renderLive(): string {
    const out: string[] = [];
    const sessions = [...this.sessions.values()];
    out.push(`## Running now (${sessions.length})`);
    if (!sessions.length) out.push("- nothing: the Foreman is idle between cycles");
    for (const { event: e, since } of sessions) {
      const items = e.items.map((i) => `#${i.issueNumber}`).join(", ");
      out.push(`- ${e.repo}: ${e.phase}${items ? ` ${items}` : ""}${e.pr !== undefined ? ` (PR #${e.pr})` : ""}`
        + `${e.reviewer ? ` by ${e.reviewer}` : ""}, since ${hhmm(since)} UTC`);
    }
    const waits = [...this.waiting].flatMap(([repo, ws]) => ws.map((w) => `- ${repo}#${w.item.issueNumber}: ${w.reason}`));
    out.push("", `## Waiting (${waits.length})`, ...(waits.length ? waits : ["- nothing"]));
    const stalls = [...this.stalls].map(([repo, d]) => `- ${repo}: ${d}`);
    out.push("", `## Promotion stalled (${stalls.length})`, ...(stalls.length ? stalls : ["- nothing"]));
    const offs = [...this.backoffs].map(([u, r]) => `- ${u}: ${r}`);
    out.push("", `## Upstream back-off (${offs.length})`, ...(offs.length ? offs : ["- nothing"]));
    return out.join("\n");
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

    const made = await this.safeCall("create task", () =>
      this.client.createIssue({
        title: fill(PAPERCLIP_TASK_TITLE_FORMAT, { repo: item.repo, N: String(item.issueNumber) }),
        status: this.statusName(PAPERCLIP_CREATE_STATUS),
        description: `${key}\n\nhttps://github.com/${item.repo}/issues/${item.issueNumber}`,
      }),
    );
    if (!made.ok || !made.value?.id) return null;
    this.taskUuidCache.set(key, made.value.id);
    this.index?.set(key, made.value.id);
    return made.value.id;
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
      for await (const row of this.client.listIssues()) {
        const line = String(row.description ?? "").split("\n")[0].trim();
        if (!line || idx.has(line)) continue;
        idx.set(line, row.id);
        const m = keyRe.exec(line);
        if (!m?.groups) continue;
        repoOf.set(row.id, m.groups.repo);
        const action = row.unblockDescriptor?.action;
        const blocked = row.status === this.statusName("blocked") && row.assigneeAgentId === this.cfg.agentId;
        state.set(row.id, blocked && action ? `waiting\n${action}` : blocked ? "waiting\n" : `status:${row.status}`);
      }
      return { idx, state, repoOf };
    });
    if (!scanned.ok) return !!this.index;
    this.index = scanned.value.idx;
    this.indexedAt = Date.now();
    this.rowState.clear();
    for (const [k, v] of scanned.value.state) this.rowState.set(k, v);
    this.rowRepo.clear();
    for (const [k, v] of scanned.value.repoOf) this.rowRepo.set(k, v);
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
    const ok = await this.patch(id, { status: this.statusName(bucket), assigneeAgentId: this.cfg.agentId, assigneeUserId: null });
    if (ok) this.rowState.set(id, `status:${this.statusName(bucket)}`);
    return ok;
  }

  private async patch(id: string, body: Record<string, unknown>): Promise<boolean> {
    const r = await this.safeCall("update task", () => this.client.updateIssue(id, body), id);
    return r.ok;
  }

  private async note(id: string, text: string): Promise<void> {
    await this.safeCall("post note", () => this.client.createComment(id, redactAll(text, this.secrets)), id);
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

/** `date` as HH:MM in UTC. */
function hhmm(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function sameItem(a: WorkItem | null, b: WorkItem): boolean {
  return !!a && a.repo === b.repo && a.issueNumber === b.issueNumber;
}
