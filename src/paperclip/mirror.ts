// Mirrors the Foreman's work onto Paperclip (EM#417): each step the Foreman
// reports on an issue becomes a note on that issue's Paperclip task, the task
// is held by the Foreman's agent, and its status follows the step.
//
// An observer, never a work source: GitHub decides what is built. Everything
// here is best-effort. Every Paperclip call is caught, an outage is logged
// once (and again only after a success in between), and no method throws.
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
import type { PaperclipClient } from "./client.js";

type Bucket = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

/** The status bucket and note for each state the Foreman can report. */
const STATE_STEP: Record<WorkState, { bucket: Bucket; note: string }> = {
  queued: { bucket: "in_progress", note: "queued" },
  inReview: { bucket: "in_review", note: "under review" },
  changesRequested: { bucket: "in_review", note: "changes requested" },
  approved: { bucket: "in_review", note: "approved" },
};

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
    if (!(await this.setStatus(id, "in_progress"))) return;
    await this.note(id, "picked up by Foreman");
  }

  async onState(item: WorkItem, _from: PriorState, to: WorkState, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const step = STATE_STEP[to];
    if (!step) return;
    if (to !== "queued" && sameItem(this.building, item)) this.building = null;
    const id = await this.resolve(item, false);
    if (!id) return;
    await this.setStatus(id, step.bucket);
    await this.note(id, step.note);
  }

  async onPrLink(item: WorkItem, prUrl: string, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (id) await this.note(id, `PR opened: ${prUrl}`);
  }

  async onBlocked(item: WorkItem, reason: string, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    if (sameItem(this.building, item)) this.building = null;
    const id = await this.resolve(item, false);
    if (id) await this.note(id, `blocked: ${reason}`);
  }

  async onMerged(item: WorkItem, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (id) await this.note(id, "merged");
  }

  async onPromoted(item: WorkItem, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {
    const id = await this.resolve(item, false);
    if (id) await this.note(id, "promoted to production");
  }

  async onBackoffPause(upstream: string, reason: string, _logger: Logger): Promise<void> {
    if (!this.building) return;
    const id = await this.resolve(this.building, false);
    if (id) await this.note(id, `paused: ${upstream} back-off: ${reason}`);
  }

  async onBackoffResume(_upstream: string, _logger: Logger): Promise<void> {
    if (!this.building) return;
    const id = await this.resolve(this.building, false);
    if (id) await this.note(id, "resumed after back-off");
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
        title: `${item.repo}#${item.issueNumber}`,
        status: this.statusName("todo"),
        description: `${key}\n\nhttps://github.com/${item.repo}/issues/${item.issueNumber}`,
      }),
    );
    if (!made.ok || !made.value?.id) return null;
    this.taskUuidCache.set(key, made.value.id);
    this.index?.set(key, made.value.id);
    return made.value.id;
  }

  /** Set the task's status, held by the Foreman's agent. True on success. */
  private async setStatus(id: string, bucket: Bucket): Promise<boolean> {
    const r = await this.safeCall("update task", () =>
      this.client.updateIssue(id, { status: this.statusName(bucket), assigneeAgentId: this.cfg.agentId }),
    );
    return r.ok;
  }

  private async note(id: string, text: string): Promise<void> {
    await this.safeCall("post note", () => this.client.createComment(id, redactAll(text, this.secrets)));
  }

  /**
   * Run one Paperclip call. Never throws: a failure is logged at warn only when
   * it starts an outage, and the next success ends that outage.
   */
  private async safeCall<T>(what: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await fn();
      if (this.outageLogged) {
        this.outageLogged = false;
        this.log("info", "Paperclip mirror: Paperclip reachable again");
      }
      return { ok: true, value };
    } catch (err) {
      if (!this.outageLogged) {
        this.outageLogged = true;
        const msg = err instanceof Error ? err.message : String(err);
        this.log("warn", `Paperclip mirror: ${what} failed, notes are skipped until Paperclip answers again: ${redactAll(msg, this.secrets)}`);
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

function sameItem(a: WorkItem | null, b: WorkItem): boolean {
  return !!a && a.repo === b.repo && a.issueNumber === b.issueNumber;
}
