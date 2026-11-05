// The card index: which Paperclip task is the card for which GitHub issue. It
// reads one repo's cards at a time, keys them on the repo's identity key (so one
// issue under two owner spellings is one card), resolves and creates cards, and
// keeps what each card shows (status, holder, content, repo, issue number). It
// owns that state; every other collaborator reads it through the mirror's wiring.
//
// RULES (Ray, 2026-11-05):
// - Paperclip is the record. A repo's cards come from one read of that repo
//   (`q` = its name, the in-play statuses only); what it returned is kept until
//   the next read of that repo replaces it in full. No company-wide read, no
//   merged copy of the board, no delta reads.
// - The plugin never reads a card in a terminal state (done, cancelled). A card
//   that goes terminal leaves the index at the next read of its repo; a closed
//   GitHub issue's card is moved to its terminal state with the id held from
//   the last read, then forgotten; an open issue with no card in play gets a
//   fresh one (a reopened issue included).
// - One repo's failed read means that repo places nothing this pass and the
//   next snapshot retries it; every other repo carries on. Reading the whole
//   board (~3,500 cards, 30+ s) and failing closed on it left SLA-3778 unplaced
//   after a restart (Foreman #100).

import type { WorkEvent, WorkItem } from "../adapters.js";
import { BACKLOG_STATUS, FOREMAN_BLOCKED_PREFIX } from "./board.js";
import type { PaperclipIssue } from "./client.js";
import type { PaperclipEnv } from "./env.js";
import { fill, PAPERCLIP_CREATE_STATUS, PAPERCLIP_TASK_TITLE_FORMAT, INDEX_TTL_MS, type Duplicate, type RowContent } from "./steps.js";

/** At most this many registry lookups in flight at once. */
export const REGISTRY_CONCURRENCY = 4;

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
  /** First description line → task id, from each repo's last read. */
  readonly index = new Map<string, string>();
  /** Repo identity key → when its cards were last read. */
  private readonly readAt = new Map<string, number>();
  /** Repo identity key → the ids its last read returned (and the cards created since), so the next read replaces them in full. */
  private readonly repoCards = new Map<string, Set<string>>();
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
  private readonly dupsByRepo = new Map<string, Duplicate[]>();
  get duplicates(): Duplicate[] { return [...this.dupsByRepo.values()].flat(); }
  /** Card id → the identity lines (index and uuid-cache keys) that name it, so a card's removal touches only its own entries. */
  private readonly cardLines = new Map<string, Set<string>>();
  /** The repos a snapshot has named: the ones the Foreman serves, so the only ones housekeeping may label. */
  readonly servedRepos = new Set<string>();
  /** Repos read on a fallback key (their registry lookup failed): their cards may sit under a spelling the registry would merge. */
  private readonly staleRepos = new Set<string>();
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
    // The registry is back for a repo the index was built without: rescan so its cards are keyed on the answer.
    if (this.staleRepos.delete(repo)) this.readAt.clear();
    return key;
  }

  /** The last answer for `repo`, else the repo itself. Call after `keyFor`/`warm`. */
  keyNow(repo: string): string {
    return this.repoKeys.get(repo) ?? repo;
  }

  /** `repo`'s key, never throwing: the key if the registry answers, else the last known key (else the repo as written) after one warn. */
  async keyForScan(repo: string): Promise<string> {
    try {
      return await this.keyFor(repo);
    } catch (e) {
      this.env.log("warn", `Paperclip mirror: registry identity for ${repo} unavailable: ${e instanceof Error ? e.message : String(e)}`);
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
   * The task id for `item`. A cache miss reads the item's repo; a lookup that
   * may create always reads it fresh, so a row another writer added since the
   * last read is adopted rather than duplicated. Null when Paperclip failed, or
   * when there is no card in play and `create` is false.
   */
  async resolve(item: WorkItem, create: boolean): Promise<string | null> {
    const key = await this.indexKey(item);
    if (!key) return null;
    const cached = this.taskUuidCache.get(key);
    if (cached) return cached;

    if (!(await this.ensureRepo(item.repo, create))) return null;

    const found = this.index.get(key);
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
    // A repo of this name whose registry lookup failed may hold this issue's card under another owner's spelling: create nothing until it resolves.
    const name = (r: string) => r.split("/").pop()!.toLowerCase();
    if ([...this.staleRepos].some((r) => name(r) === name(item.repo))) {
      this.env.log("warn", `Paperclip mirror: no card created for ${item.repo}#${item.issueNumber}: the registry has not answered for ${[...this.staleRepos].filter((r) => name(r) === name(item.repo)).join(", ")}, whose card for it may exist under that spelling`);
      return null;
    }
    const unplaced = !this.env.cfg.projectId && this.env.cfg.projects;
    const projectId = this.env.cfg.projectId ?? (unplaced ? await this.unplacedProjectId() : null);
    if (unplaced && !projectId) return null;
    const made = await this.env.safeCall("create task", () =>
      this.env.client.createIssue({ ...content, ...(projectId ? { projectId } : {}) }),
    );
    if (!made.ok || !made.value?.id) return null;
    const id = made.value.id;
    this.taskUuidCache.set(key, id);
    this.index.set(key, id);
    this.cardLines.set(id, new Set([key]));
    const repoKey = this.keyNow(item.repo);
    this.repoCards.set(repoKey, (this.repoCards.get(repoKey) ?? new Set()).add(id));
    this.rowRepo.set(id, repoKey);
    this.rowNumber.set(id, item.issueNumber);
    this.rowState.set(id, `status:${content.status}`);
    this.rowContent.set(id, { title: content.title, description: content.description, assigneeAgentId: null, assigneeUserId: null });
    return id;
  }

  /**
   * Make sure `repo`'s cards are at hand: a fresh read when `fresh`, else the
   * last one while it is young. One read: the repo's name as `q`, the in-play
   * statuses only, the rows whose identity line is this repo's kept. What it
   * returns replaces what the last read of this repo returned, in full. False
   * when Paperclip failed: this repo places nothing this pass, and every other
   * repo is untouched.
   */
  async ensureRepo(repo: string, fresh = false): Promise<boolean> {
    const have = this.readAt.get(this.keyNow(repo));
    if (!fresh && have !== undefined && Date.now() - have <= INDEX_TTL_MS) return true;
    const keyRe = this.env.keyPattern();
    const cancelled = this.env.statusName("cancelled");
    this.env.identity?.beginScan();
    const started = Date.now();
    const reads0 = { ...this.env.client.reads };
    const registry0 = this.env.identity?.requests?.() ?? 0;
    const failed = new Set<string>();
    const read = await this.env.safeCall(`read the cards of ${repo}`, async () => {
      const repoKey = await this.keyForScan(repo);
      const rows = new Map<string, PaperclipIssue>();
      for await (const row of this.env.client.listIssues({ q: repo.split("/").pop()!, statuses: this.inPlayStatuses() })) {
        if (!this.isTerminalStatus(row.status)) rows.set(row.id, row);
      }
      // Cards group by identity line: `identityKeyFormat` with the repo reduced to its key, so one
      // issue under two owner spellings is one group. Rows of other repos (the `q` match is a text
      // search) and lines that are no card line are not this repo's.
      const spelled = new Map<string, string>([[repo, repoKey]]); // the repo itself was just resolved: one lookup, not two
      const byLine = new Map<string, Array<{ row: PaperclipIssue; line: string; n: number }>>();
      for (const row of rows.values()) {
        const line = String(row.description ?? "").split("\n")[0].trim();
        const m = keyRe.exec(line);
        if (!m?.groups) continue;
        const written = m.groups.repo;
        if (!spelled.has(written)) {
          try { spelled.set(written, await this.keyFor(written)); }
          catch (e) {
            failed.add(written);
            this.env.log("warn", `Paperclip mirror: registry identity for ${written} unavailable: ${e instanceof Error ? e.message : String(e)}`);
            spelled.set(written, this.keyNow(written));
          }
        }
        if (spelled.get(written) !== repoKey) continue;
        const group = this.indexLine(repoKey, Number(m.groups.N));
        byLine.set(group, [...(byLine.get(group) ?? []), { row, line, n: Number(m.groups.N) }]);
      }
      const idx = new Map<string, string>();
      const state = new Map<string, string>();
      const numberOf = new Map<string, number>();
      const actions = new Map<string, string>();
      const content = new Map<string, RowContent>();
      const duplicates: Duplicate[] = [];
      for (const [group, members] of byLine) {
        const card = pickCard(members.map((x) => x.row), cancelled)!;
        const row = members.find((x) => x.row === card)!;
        idx.set(group, card.id);
        for (const x of members) {
          if (x.row !== card) duplicates.push({ id: x.row.id, key: x.line, repo: repoKey, winner: card.identifier || card.id, title: String(x.row.title ?? ""), status: x.row.status });
        }
        numberOf.set(card.id, row.n);
        content.set(card.id, {
          title: String(card.title ?? ""), description: String(card.description ?? ""),
          assigneeAgentId: card.assigneeAgentId ?? null, assigneeUserId: card.assigneeUserId ?? null,
          ...(Array.isArray(card.labelIds) ? { labelIds: card.labelIds } : {}),
        });
        const action = card.unblockDescriptor?.action;
        // A Foreman-held blocked row is a waiting hold, unless the Foreman blocked it for good.
        const blocked = card.status === this.env.statusName("blocked") && card.assigneeAgentId === this.env.cfg.agentId
          && !String(action ?? "").startsWith(FOREMAN_BLOCKED_PREFIX);
        state.set(card.id, blocked && action ? `waiting\n${action}` : blocked ? "waiting\n" : `status:${card.status}`);
        if (card.status === this.env.statusName("blocked") && action) actions.set(card.id, String(action));
      }
      return { repoKey, idx, state, numberOf, actions, content, duplicates };
    });
    if (!read.ok) {
      // safeCall has said why (once per outage); this says which repo waits, every time.
      this.readAt.delete(this.keyNow(repo)); // the next snapshot reads again, not the old success inside its TTL
      this.env.log("info", `Paperclip mirror: ${repo} cards not read; nothing is placed for it this pass, the next snapshot retries`);
      return false;
    }
    const r = read.value;
    const gets = this.env.client.reads.calls - reads0.calls;
    const rowsRead = this.env.client.reads.rows - reads0.rows;
    this.env.log("info", `Paperclip mirror: read of ${repo}'s cards in play: ${gets} Paperclip GETs, ${rowsRead} rows read, ${(this.env.identity?.requests?.() ?? 0) - registry0} registry requests, ${Date.now() - started} ms`);
    for (const f of failed) this.staleRepos.add(f);
    // Replace what the last read of this repo returned, in full.
    const old = this.repoCards.get(r.repoKey) ?? new Set<string>();
    const now = new Set(r.idx.values());
    for (const id of old) {
      for (const m of [this.rowState, this.rowRepo, this.rowNumber, this.blockAction, this.rowContent] as Array<Map<string, unknown>>) m.delete(id);
      if (!now.has(id)) { this.closedCards.delete(id); this.openConfirmed.delete(id); }
    }
    const oldLines = new Map<string, string>(); // line → old card, for the cache re-point below
    for (const id of old) {
      for (const line of this.cardLines.get(id) ?? []) { this.index.delete(line); oldLines.set(line, id); }
      this.cardLines.delete(id);
    }
    this.dupsByRepo.set(r.repoKey, r.duplicates);
    for (const [line, id] of r.idx) { this.index.set(line, id); this.cardLines.set(id, new Set([line])); }
    for (const [id, v] of r.state) { this.rowState.set(id, v); this.rowRepo.set(id, r.repoKey); }
    for (const [id, v] of r.numberOf) this.rowNumber.set(id, v);
    for (const [id, v] of r.actions) this.blockAction.set(id, v);
    for (const [id, v] of r.content) this.rowContent.set(id, v);
    this.repoCards.set(r.repoKey, now);
    this.readAt.set(r.repoKey, Date.now());
    // A key whose card the read settled on differently follows it; a card that left the read went
    // terminal (or was forgotten), so a later card for that issue is a new one.
    for (const line of oldLines.keys()) {
      const next = this.index.get(line);
      if (next) this.taskUuidCache.set(line, next); else this.taskUuidCache.delete(line);
    }
    return true;
  }

  /**
   * Forget card `id`: its issue is closed and the card has been moved to its terminal
   * state, so it is never looked for again. A later card for the issue is a new one.
   */
  forget(id: string): void {
    const repoKey = this.rowRepo.get(id);
    for (const m of [this.rowState, this.rowRepo, this.rowNumber, this.blockAction, this.rowContent] as Array<Map<string, unknown>>) m.delete(id);
    this.closedCards.delete(id);
    this.openConfirmed.delete(id);
    for (const line of this.cardLines.get(id) ?? []) {
      if (this.index.get(line) === id) this.index.delete(line);
      if (this.taskUuidCache.get(line) === id) this.taskUuidCache.delete(line);
    }
    this.cardLines.delete(id);
    if (repoKey) {
      this.repoCards.get(repoKey)?.delete(id);
      const d = this.dupsByRepo.get(repoKey);
      if (d?.some((x) => x.id === id)) this.dupsByRepo.set(repoKey, d.filter((x) => x.id !== id));
    }
  }

  /** The statuses a card in play can show: everything but done and cancelled. */
  private inPlayStatuses(): string[] {
    return [BACKLOG_STATUS, ...(["todo", "in_progress", "in_review", "blocked"] as const).map((b) => this.env.statusName(b))];
  }

  private isTerminalStatus(status: string): boolean {
    return status === this.env.statusName("done") || status === this.env.statusName("cancelled");
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
    this.dupsByRepo.clear();
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
