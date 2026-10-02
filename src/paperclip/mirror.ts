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

import type { PriorState, WorkItem, WorkObserver, WorkState } from "../adapters.js";
import { redactAll } from "../agent.js";
import type { PaperclipConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { PaperclipClientError, type PaperclipClient } from "./client.js";

/** A Paperclip status bucket; `statusMap` may rename each one. */
export type PaperclipBucket = "todo" | "in_progress" | "in_review" | "done" | "cancelled";
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
} as const satisfies Record<string, PaperclipStep>);

/** The note a repeat claim posts: the same work, retried after an attempt that did not finish. */
export const PAPERCLIP_RETRY_NOTE = "retrying: the previous attempt did not finish";

/** The status a task is created with, before the claim moves it on. */
export const PAPERCLIP_CREATE_STATUS: Bucket = "todo";

/** A task's title: {repo} is owner/name, {N} the issue number. */
export const PAPERCLIP_TASK_TITLE_FORMAT = "{repo}#{N}";

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
    if (!this.building) return;
    const id = await this.resolve(this.building, false);
    if (id) await this.note(id, fill(PAPERCLIP_STEPS.backoffPause.note, { upstream, reason }));
  }

  async onBackoffResume(_upstream: string, _logger: Logger): Promise<void> {
    if (!this.building) return;
    const id = await this.resolve(this.building, false);
    if (id) await this.note(id, PAPERCLIP_STEPS.backoffResume.note);
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

    if (create || !this.index || Date.now() - this.indexedAt > INDEX_TTL_MS) {
      const scanned = await this.safeCall("scan tasks", async () => {
        const idx = new Map<string, string>();
        for await (const row of this.client.listIssues()) {
          const line = String(row.description ?? "").split("\n")[0].trim();
          if (line && !idx.has(line)) idx.set(line, row.id);
        }
        return idx;
      });
      if (!scanned.ok) return null;
      this.index = scanned.value;
      this.indexedAt = Date.now();
    }

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
   * Set the task's status, held by the Foreman's agent. True on success.
   *
   * `assigneeUserId: null` in the same update: Paperclip allows one assignee
   * ("Issue can only have one assignee", 422), and a sync gives an in_progress
   * row a board user, so taking the row means releasing that user.
   */
  private async setStatus(id: string, bucket: Bucket): Promise<boolean> {
    const r = await this.safeCall("update task", () =>
      this.client.updateIssue(id, { status: this.statusName(bucket), assigneeAgentId: this.cfg.agentId, assigneeUserId: null }),
    id);
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

function sameItem(a: WorkItem | null, b: WorkItem): boolean {
  return !!a && a.repo === b.repo && a.issueNumber === b.issueNumber;
}
