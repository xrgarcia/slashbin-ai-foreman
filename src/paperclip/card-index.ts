// The card index: which Paperclip task is the card for which GitHub issue. It
// scans the company's tasks, keys them on the repo's identity key (so one issue
// under two owner spellings is one card), resolves and creates cards, and keeps
// what each card shows (status, holder, content, repo, issue number). It owns
// that state; every other collaborator reads it through the mirror's wiring.

import type { WorkEvent, WorkItem } from "../adapters.js";
import { FOREMAN_BLOCKED_PREFIX } from "./board.js";
import type { PaperclipIssue } from "./client.js";
import type { PaperclipEnv } from "./env.js";
import { fill, PAPERCLIP_CREATE_STATUS, PAPERCLIP_TASK_TITLE_FORMAT, INDEX_TTL_MS, type Duplicate, type RowContent } from "./steps.js";

/** The first description line of the retired live task, which housekeeping cancels. */
const LEGACY_LIVE_KEY_FORMAT = "foreman-live: {agentId}";

/** The note that cancels it. */
const LEGACY_LIVE_NOTE = "retired: the board is the queue now; each task's status shows what the Foreman is doing with it";

/** A lookup that misses rescans once the last scan is this old, so a row another writer added since is found within a minute. */
const MISS_RESCAN_MS = 60_000;

/** At most this many registry lookups in flight at once. */
export const REGISTRY_CONCURRENCY = 4;

/**
 * A scan reads only the rows Paperclip changed since the last read (`updatedSince`), merged
 * into the rows already held; the whole list is re-read once this old, which also drops a row
 * deleted since. Every card, done or cancelled included, stays in the index: a closed issue's
 * card must be found, never created again.
 */
export const FULL_READ_TTL_MS = 60 * 60_000;

/** Back-dating of the `updatedSince` mark, so a clock a little apart from Paperclip's loses no change. */
const DELTA_OVERLAP_MS = 120_000;

/** With `ownsCards`, the most second cards one housekeeping pass retires. */
const RETIRES_PER_PASS = 25;

/** The comment on a second card for one issue when it is retired. */
const DUPLICATE_NOTE = "retired: a second card for {key}; {winner} is the card for this issue";

/**
 * Which of the rows carrying one identity key is the card: the oldest that is
 * not cancelled, else the oldest. A row with no creation time sorts by the
 * order it was listed in, after every dated one. Both writers' rows for
 * jerky_ops#11 stood open side by side because each kept a different one of the
 * pair: the Foreman the first listed, the receiver the last (2026-10-15).
 */
export function pickCard<T extends { status: string; createdAt?: string }>(rows: readonly T[], cancelled: string): T | undefined {
  const time = (r: T) => {
    const t = Date.parse(r.createdAt ?? "");
    return Number.isNaN(t) ? Infinity : t;
  };
  const ranked = rows.map((r, i) => ({ r, i })).sort((a, b) =>
    Number(a.r.status === cancelled) - Number(b.r.status === cancelled) || time(a.r) - time(b.r) || a.i - b.i);
  return ranked[0]?.r;
}

export class CardIndex {
  /** Identity key → Paperclip task id, for every task this mirror has resolved. */
  private readonly taskUuidCache = new Map<string, string>();
  /** First description line → task id, from the last full scan. */
  index: Map<string, string> | null = null;
  private indexedAt = 0;
  /** Task id → what the row shows: `waiting\n<action>` when blocked, else `status:<status>`. */
  readonly rowState = new Map<string, string>();
  /** Card id -> the identity key of its repo (not the spelling its description carries). */
  readonly rowRepo = new Map<string, string>();
  /** Repo as written -> its identity key, as last answered. Sync readers use it; a repo never asked about is its own key. */
  private readonly repoKeys = new Map<string, string>();
  /** Task id → its issue number, from the identity line. */
  readonly rowNumber = new Map<string, number>();
  /** Cards whose issue GitHub reads closed: a hold the Foreman reports later never reopens them. */
  readonly closedCards = new Set<string>();
  /** Cards whose issue GitHub last read open, live: one showing done or cancelled is not terminal (a reopen). */
  private readonly openConfirmed = new Set<string>();
  /** Task id → a blocked card's unblock-descriptor action, as the last scan read it. */
  readonly blockAction = new Map<string, string>();
  /** Task id → its title, description and holders, as the last scan or write left them (`ownsCards`). */
  readonly rowContent = new Map<string, RowContent>();
  /** Every second card the last scan found, for housekeeping to retire (`ownsCards`). */
  duplicates: Duplicate[] = [];
  /** The repos a snapshot has named: the ones the Foreman serves, so the only ones housekeeping may label. */
  readonly servedRepos = new Set<string>();
  /** Every company row as the last successful scan left it, by id; a delta scan merges into it. */
  private rows: Map<string, PaperclipIssue> | null = null;
  private fullReadAt = 0;
  private lastReadStartedAt = 0;
  /** Repos whose registry lookup failed during the scan in progress: asked once, then compared on their last known key. */
  private readonly unresolved = new Set<string>();
  private scanning = false;
  /** The Unplaced project's id, or the lookup in flight; cleared when it finds none or an ambiguous set. */
  private unplacedLookup: Promise<string | null> | null = null;

  constructor(private readonly env: PaperclipEnv) {}

  /** Whether `event` is about a repo `repos` mirrors. Daemon-wide events (back-off) always are. */
  mirrors(event: WorkEvent): boolean {
    const repo = this.eventRepo(event);
    return repo === null || this.mirrored(repo);
  }

  private eventRepo(event: WorkEvent): string | null {
    return "item" in event ? event.item.repo
      : event.kind === "session" ? event.session.repo
      : event.kind === "release" ? event.release.repo
      : "repo" in event ? event.repo
      : null;
  }

  /** Whether `repo` is one `repos` mirrors, on identity keys: either owner spelling of a configured repo is. */
  mirrored(repo: string): boolean {
    return this.mirroredKey(this.keyNow(repo));
  }

  /** Whether a repo already reduced to its key is one `repos` mirrors. */
  mirroredKey(key: string): boolean {
    return !this.env.cfg.repos || this.env.cfg.repos.some((r) => this.keyNow(r) === key);
  }

  /** `repo`'s identity key. Throws when the registry cannot answer; with no registry configured, the repo itself. */
  async keyFor(repo: string): Promise<string> {
    if (!this.env.identity) return repo;
    const key = await this.env.identity.keyOf(repo);
    this.repoKeys.set(repo, key);
    return key;
  }

  /** The last answer for `repo`, else the repo itself. Call after `keyFor`/`warm`. */
  keyNow(repo: string): string {
    return this.repoKeys.get(repo) ?? repo;
  }

  /**
   * `repo`'s key, never throwing: the key if the registry answers, else the last known key (else the
   * repo as written) after one warn. During a scan a failed repo is asked once; the rest of that scan
   * compares it on what is known.
   */
  async keyForScan(repo: string): Promise<string> {
    if (!this.scanning || !this.unresolved.has(repo)) {
      try {
        return await this.keyFor(repo);
      } catch (e) {
        if (this.scanning) this.unresolved.add(repo);
        this.env.log("warn", `Paperclip mirror: registry identity for ${repo} unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return this.keyNow(repo);
  }

  /** Resolve many repos, at most REGISTRY_CONCURRENCY in flight; a failed one is logged by name and the rest go on. Never throws. */
  async resolveAll(repos: readonly string[]): Promise<void> {
    const queue = [...new Set(repos)];
    const worker = async () => {
      for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) await this.keyForScan(repo);
    };
    await Promise.all(Array.from({ length: Math.min(REGISTRY_CONCURRENCY, queue.length) }, worker));
  }

  /** Ask for `repo`'s key ahead of a synchronous comparison; an outage is logged and the repo compares as written. */
  async warm(...repos: string[]): Promise<void> {
    await this.resolveAll(repos);
  }

  async warmEvent(event: WorkEvent): Promise<void> {
    if (!this.env.identity || !this.env.cfg.repos) return;
    const repo = this.eventRepo(event);
    if (repo !== null) await this.warm(repo, ...this.env.cfg.repos);
  }

  /** The index key for `item`'s card: `identityKeyFormat` with the repo's identity key. Null when the registry is down. */
  private async indexKey(item: WorkItem): Promise<string | null> {
    try {
      return this.indexLine(await this.keyFor(item.repo), item.issueNumber);
    } catch (e) {
      this.env.log("warn", `Paperclip mirror: registry identity for ${item.repo} unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  indexLine(repoKey: string, n: number): string {
    return this.env.cfg.identityKeyFormat.split("{repo}").join(repoKey).split("{N}").join(String(n));
  }

  /** Card `id`'s issue is closed: no stage update moves it until GitHub reads it open again. */
  markClosed(id: string): void {
    this.closedCards.add(id);
    this.openConfirmed.delete(id);
  }

  /** GitHub read card `id`'s issue open, live: a reopen, if it was closed. */
  markOpen(id: string): void {
    this.closedCards.delete(id);
    this.openConfirmed.add(id);
  }

  /** True when card `id` is a closed issue's: known closed, or showing done or cancelled with no live open read since. */
  terminal(id: string): boolean {
    return this.closedCards.has(id) || (this.isClosedCard(id) && !this.openConfirmed.has(id));
  }

  /**
   * Re-read card `id` from the board, as a scan reads it: status (a Foreman-held
   * blocked row is a waiting hold), unblock action, holder. One GET; a failed
   * read leaves the cache as it was.
   */
  async refreshRow(id: string): Promise<void> {
    const r = await this.env.safeCall("read task", () => this.env.client.getIssue(id), id);
    if (!r.ok || !r.value || typeof r.value.status !== "string") return;
    const row = r.value;
    const action = row.unblockDescriptor?.action;
    const blockedName = this.env.statusName("blocked");
    const waiting = row.status === blockedName && row.assigneeAgentId === this.env.cfg.agentId && !String(action ?? "").startsWith(FOREMAN_BLOCKED_PREFIX);
    this.rowState.set(id, waiting ? `waiting\n${action ?? ""}` : `status:${row.status}`);
    if (row.status === blockedName && action) this.blockAction.set(id, String(action));
    else this.blockAction.delete(id);
    const have = this.rowContent.get(id);
    if (have) this.rowContent.set(id, { ...have, assigneeAgentId: row.assigneeAgentId ?? null, assigneeUserId: row.assigneeUserId ?? null });
  }

  /** The repo (`githubRepo`) card `id` belongs to, from the identity key its row was read under. */
  repoOfCard(id: string): string | undefined {
    const key = this.rowRepo.get(id);
    if (key === undefined) return undefined;
    for (const [repo, k] of this.repoKeys) if (k === key) return repo;
    return this.env.identity ? undefined : key;
  }

  /** True when the card shows done or cancelled. */
  isClosedCard(id: string): boolean {
    const state = this.rowState.get(id);
    return state === `status:${this.env.statusName("done")}` || state === `status:${this.env.statusName("cancelled")}`;
  }

  /** The repo spelling on card `id`'s identity line, as last scanned. */
  writtenRepo(id: string): string | null {
    const first = (this.rowContent.get(id)?.description ?? "").split("\n")[0].trim();
    return this.env.keyPattern().exec(first)?.groups?.repo ?? null;
  }

  /**
   * The task id for `item`. A cache miss scans the company's tasks; a lookup
   * that may create always scans fresh, so a row another writer added since the
   * last scan is adopted rather than duplicated. Null when Paperclip failed, or
   * when there is no row and `create` is false.
   */
  async resolve(item: WorkItem, create: boolean): Promise<string | null> {
    const key = await this.indexKey(item);
    if (!key) return null;
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
    return this.createTask(item, this.defaultContent(item));
  }

  /** What a task the Foreman creates for `item` says, outside `ownsCards`. */
  defaultContent(item: WorkItem): { title: string; description: string; status: string } {
    const [owner = "", name = ""] = item.repo.split("/");
    return {
      title: fill(this.env.cfg.taskTitleFormat ?? PAPERCLIP_TASK_TITLE_FORMAT, { repo: item.repo, owner, name, N: String(item.issueNumber) }),
      description: `${this.env.keyOf(item)}\n\nhttps://github.com/${item.repo}/issues/${item.issueNumber}`,
      status: this.env.statusName(PAPERCLIP_CREATE_STATUS),
    };
  }

  /** Create `item`'s task, filed where every task the Foreman creates goes; its id, or null. */
  async createTask(item: WorkItem, content: { title: string; description: string; status: string }): Promise<string | null> {
    // An explicit project wins; the Unplaced lookup files nothing until it finds one.
    const key = await this.indexKey(item);
    if (!key) return null;
    const unplaced = !this.env.cfg.projectId && this.env.cfg.projects;
    const projectId = this.env.cfg.projectId ?? (unplaced ? await this.unplacedProjectId() : null);
    if (unplaced && !projectId) return null;
    const made = await this.env.safeCall("create task", () =>
      this.env.client.createIssue({ ...content, ...(projectId ? { projectId } : {}) }),
    );
    if (!made.ok || !made.value?.id) return null;
    const id = made.value.id;
    this.taskUuidCache.set(key, id);
    this.index?.set(key, id);
    this.rowRepo.set(id, this.keyNow(item.repo));
    this.rowNumber.set(id, item.issueNumber);
    this.rowState.set(id, `status:${content.status}`);
    this.rowContent.set(id, { title: content.title, description: content.description, assigneeAgentId: null, assigneeUserId: null });
    return id;
  }

  /**
   * Make sure a scan of the company's tasks is at hand: a fresh one when
   * `fresh`, else the last one while it is young. Each scan also re-reads what
   * every issue row shows, so a restart picks up rows it had blocked. False
   * when Paperclip failed and there is no index to fall back on.
   */
  async ensureIndex(fresh = false): Promise<boolean> {
    if (!fresh && this.index && Date.now() - this.indexedAt <= INDEX_TTL_MS) return true;
    const keyRe = this.env.keyPattern();
    const cancelled = this.env.statusName("cancelled");
    // One registry answer per distinct repo per REPO_KEY_TTL_MS. A repo the registry cannot answer
    // compares on its last known key for this scan (a warn names it); the scan goes on.
    this.env.identity?.beginScan();
    this.unresolved.clear();
    this.scanning = true;
    const started = Date.now();
    const reads0 = { ...this.env.client.reads };
    const registry0 = this.env.identity?.requests?.() ?? 0;
    const delta = this.rows !== null && started - this.fullReadAt < FULL_READ_TTL_MS;
    const scanned = await this.env.safeCall("scan tasks", async () => {
      await this.resolveAll(this.env.cfg.repos ?? []);
      const idx = new Map<string, string>();
      const state = new Map<string, string>();
      const repoOf = new Map<string, string>();
      const numberOf = new Map<string, number>();
      const actions = new Map<string, string>();
      const content = new Map<string, RowContent>();
      const duplicates: Duplicate[] = [];
      // Cards group by identity line: `identityKeyFormat` with the repo reduced to its key, so one
      // issue under two owner spellings is one group. A line that is no card line groups as written.
      const byLine = new Map<string, PaperclipIssue[]>();
      const keyed = new Map<string, string>();
      // The rows held, plus the ones Paperclip changed since the last read; or every row.
      const rows = new Map(delta ? this.rows : []);
      const since = delta ? new Date(this.lastReadStartedAt - DELTA_OVERLAP_MS).toISOString() : undefined;
      for await (const row of this.env.client.listIssues(since ? { updatedSince: since } : {})) rows.set(row.id, row);
      for (const row of rows.values()) {
        const line = String(row.description ?? "").split("\n")[0].trim();
        if (!line) continue;
        const m = keyRe.exec(line);
        const group = m?.groups ? this.indexLine(await this.keyForScan(m.groups.repo), Number(m.groups.N)) : line;
        keyed.set(row.id, line);
        byLine.set(group, [...(byLine.get(group) ?? []), row]);
      }
      for (const [group, rows] of byLine) {
        const row = pickCard(rows, cancelled)!;
        idx.set(group, row.id);
        const m = keyRe.exec(keyed.get(row.id)!);
        if (!m?.groups) continue;
        const repoKey = this.keyNow(m.groups.repo);
        for (const r of rows) {
          if (r !== row) duplicates.push({ id: r.id, key: keyed.get(r.id)!, repo: repoKey, winner: row.identifier || row.id, title: String(r.title ?? ""), status: r.status });
        }
        repoOf.set(row.id, repoKey);
        numberOf.set(row.id, Number(m.groups.N));
        content.set(row.id, {
          title: String(row.title ?? ""), description: String(row.description ?? ""),
          assigneeAgentId: row.assigneeAgentId ?? null, assigneeUserId: row.assigneeUserId ?? null,
          ...(Array.isArray(row.labelIds) ? { labelIds: row.labelIds } : {}),
        });
        const action = row.unblockDescriptor?.action;
        // A Foreman-held blocked row is a waiting hold, unless the Foreman blocked it for good.
        const blocked = row.status === this.env.statusName("blocked") && row.assigneeAgentId === this.env.cfg.agentId
          && !String(action ?? "").startsWith(FOREMAN_BLOCKED_PREFIX);
        state.set(row.id, blocked && action ? `waiting\n${action}` : blocked ? "waiting\n" : `status:${row.status}`);
        if (row.status === this.env.statusName("blocked") && action) actions.set(row.id, String(action));
      }
      return { idx, state, repoOf, numberOf, actions, content, duplicates, rows };
    });
    this.scanning = false;
    if (!scanned.ok) return !!this.index;
    this.rows = scanned.value.rows;
    this.lastReadStartedAt = started;
    if (!delta) this.fullReadAt = started;
    const gets = this.env.client.reads.calls - reads0.calls;
    const read = this.env.client.reads.rows - reads0.rows;
    this.env.log("info", `Paperclip mirror: scan ${delta ? "since last read" : "of every row"}: ${gets} Paperclip GETs, ${read} rows read (${this.rows.size} held), ${(this.env.identity?.requests?.() ?? 0) - registry0} registry requests, ${Date.now() - started} ms`);
    this.index = scanned.value.idx;
    this.indexedAt = Date.now();
    this.rowState.clear();
    for (const [k, v] of scanned.value.state) this.rowState.set(k, v);
    this.rowRepo.clear();
    for (const [k, v] of scanned.value.repoOf) this.rowRepo.set(k, v);
    this.rowNumber.clear();
    for (const [k, v] of scanned.value.numberOf) this.rowNumber.set(k, v);
    this.blockAction.clear();
    for (const [k, v] of scanned.value.actions) this.blockAction.set(k, v);
    // A card another writer closed since is closed again until GitHub reads it open.
    for (const id of [...this.openConfirmed]) if (this.isClosedCard(id)) this.openConfirmed.delete(id);
    this.rowContent.clear();
    for (const [k, v] of scanned.value.content) this.rowContent.set(k, v);
    this.duplicates = scanned.value.duplicates;
    // A key whose card the scan settled on differently follows it.
    for (const [key, id] of this.taskUuidCache) {
      const now = this.index.get(key);
      if (now && now !== id) this.taskUuidCache.set(key, now);
    }
    return true;
  }

  /** Record that card `id` is now `agentId`'s, so the next pass compares holders on fact. */
  setHolder(id: string, agentId: string | null): void {
    const have = this.rowContent.get(id);
    if (have) this.rowContent.set(id, { ...have, assigneeAgentId: agentId, assigneeUserId: null });
  }

  /**
   * Retire every second card the last scan found for an issue in a mirrored
   * repo (`ownsCards`): cancelled, nobody's, its identity line rewritten to name
   * the card that stays so no writer adopts it again, its title saying so, and a
   * note — one PATCH each, at most RETIRES_PER_PASS a pass.
   */
  async retireDuplicates(): Promise<void> {
    const cancelled = this.env.statusName("cancelled");
    let left = RETIRES_PER_PASS;
    for (const d of this.duplicates) {
      if (left-- <= 0) break;
      if (!this.mirroredKey(d.repo)) continue;
      const tag = `[duplicate of ${d.winner}] `;
      const r = await this.env.safeCall("retire duplicate", () => this.env.client.updateIssue(d.id, {
        status: cancelled,
        assigneeAgentId: null,
        assigneeUserId: null,
        title: d.title.startsWith(tag) ? d.title : `${tag}${d.title}`,
        description: `duplicate of ${d.winner} (${d.key})`,
        comment: fill(DUPLICATE_NOTE, { key: d.key, winner: d.winner }),
      }, this.env.ownComment()), d.id);
      if (r.ok) this.env.log("info", `Paperclip mirror: retired a second card for ${d.key}; ${d.winner} stays`);
    }
    this.duplicates = [];
  }

  /** Cancel the live summary task an earlier version kept, once. */
  async retireLiveTask(): Promise<void> {
    if (!this.env.cfg.agentId) return;
    const id = this.index?.get(fill(LEGACY_LIVE_KEY_FORMAT, { agentId: this.env.cfg.agentId }));
    if (!id) return;
    const row = await this.env.safeCall("read task", () => this.env.client.getIssue(id), id);
    const cancelled = this.env.statusName("cancelled");
    if (!row.ok || row.value?.status === cancelled) return;
    // Status and note in one PATCH: a note alone on an agent-held row reopens it.
    await this.env.safeCall("retire live task", () => this.env.client.updateIssue(id, { status: cancelled, comment: LEGACY_LIVE_NOTE }, this.env.ownComment()), id);
  }

  /**
   * The id of the one project whose description line 1 is `roadmap-position:
   * unplaced` — where every task the Foreman creates is filed; the EM's sync
   * then places it in its roadmap position's project (EM #513). The Foreman
   * never creates a project and never moves a task between projects. Only a
   * found id is kept: none, two or more, or a failed listing is looked up again
   * on the next call, with one warn per count per process.
   */
  private unplacedProjectId(): Promise<string | null> {
    if (this.unplacedLookup) return this.unplacedLookup;
    const lookup = (async () => {
      const listed = await this.env.safeCall("list projects", () => this.env.client.listProjects());
      if (!listed.ok) return null;
      const found = (Array.isArray(listed.value) ? listed.value : []).filter(
        (p) => (p.description ?? "").split("\n")[0] === "roadmap-position: unplaced",
      );
      if (found.length === 1) return found[0].id;
      const once = `unplaced ${found.length}`;
      if (!this.env.rejectionsLogged.has(once)) {
        this.env.rejectionsLogged.add(once);
        this.env.log("warn", `Paperclip mirror: Unplaced project not found: found ${found.length} projects whose description line 1 is "roadmap-position: unplaced"`);
      }
      return null;
    })();
    this.unplacedLookup = lookup;
    void lookup.then((id) => {
      if (!id) this.unplacedLookup = null;
    });
    return lookup;
  }
}
