// The GitHub record store (EM#1244 f1): one comment per issue or PR, written by
// the Foreman's own login, carrying the item's durable record as JSON. Created
// once, then edited in place. The marker-comment pattern of readiness.ts, with
// the record in the comment instead of a digest.
//
// Reads and writes go through ghAsync() (2026-11-06: a synchronous comment read
// against a GitHub that was not answering froze every lane and observer), which
// already retries a transient failure; a
// failure that survives that is `unavailable` on a load and `false` on a save,
// and is never turned into an empty record. The cache is the plugin's own: one
// read per item per process, rebuilt from the comment, never the only copy.

import type { ItemRecord, RecordKey, RecordLoad } from "../adapters.js";
import type { RepoConfig } from "../config.js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalJson, isItemRecord, recordId } from "../record-store.js";
import { formatGhError } from "./cache.js";

/**
 * Where the store keeps its read cache between restarts (set by the daemon). 2026-11-20: every restart re-read each
 * item's comments (~2,300 REST calls, 77% of an hour's core spend), and two restarts in 13 minutes took ~2,100 in 3.
 */
let recordCachePath: string | null = null;
export function setRecordCachePath(path: string | null): void { recordCachePath = path; }

/**
 * The issue a repo's own record lives on (EM#1244 f4): a repo has no item to hold a comment, so the store keeps
 * one closed issue with this title, created by the Foreman's login on the first save, and puts the repo record
 * in its comment like any other. Found by title and author, never by number, so a lost cache costs one search.
 */
export const REPO_RECORD_TITLE = "Foreman repo records (bookkeeping, do not close or edit)";

/** First line of every record comment; what a read looks for. */
export const RECORD_MARKER = "<!-- foreman:record v1 -->";
const DATA_PREFIX = "<!-- foreman:record-data ";
const DATA_SUFFIX = " -->";

/**
 * What the store runs: gh with the Foreman's token, and the login that token acts as. Injectable for tests.
 * The daemon's runs are async so a hung GitHub never blocks the event loop; a test's may answer synchronously.
 */
export interface RecordStoreIo {
  run(args: string[], cwd: string): Promise<string> | string;
  login(cwd: string): Promise<string | undefined> | string | undefined;
  /** Told why a save failed; the save itself still resolves false. Absent, the reason is dropped. */
  warn?(msg: string): void;
}

/** The comment body for a record. `<` and `>` are escaped so the JSON can never close its own HTML comment. */
export function recordBody(record: ItemRecord): string {
  const json = JSON.stringify(record).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return [RECORD_MARKER, "Foreman bookkeeping — do not edit.", `${DATA_PREFIX}${json}${DATA_SUFFIX}`].join("\n");
}

/** The record in a comment body; undefined when the body carries none or it is not a JSON object. */
export function parseRecordBody(body: string): ItemRecord | undefined {
  const line = body.split("\n").find((l) => l.startsWith(DATA_PREFIX) && l.endsWith(DATA_SUFFIX));
  if (!line) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(DATA_PREFIX.length, line.length - DATA_SUFFIX.length));
    return isItemRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the store knows of one item: the comment holding its record (null: none), and the record as
 * canonical JSON (null: none). Text, not an object, so no caller can mutate the comparison baseline.
 */
interface Entry { readonly commentId: number | null; readonly json: string | null; readonly etag?: string }

/** The on-disk form: the Foreman login the entries were read as, each item's entry, and the anchors found. */
interface RecordCacheFile { version: 1; self: string; entries: Record<string, Entry & { number: number | null }>; anchors: Record<string, number> }

/** A `gh api -i` answer split into status, headers (lower-cased names) and body. */
function parseInclude(out: string): { status: number; headers: Map<string, string>; body: string } {
  const cut = /\r?\n\r?\n/.exec(out);
  const head = cut ? out.slice(0, cut.index) : out;
  const body = cut ? out.slice(cut.index + cut[0].length) : "";
  const lines = head.split(/\r?\n/);
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
  const headers = new Map<string, string>();
  for (const l of lines.slice(1)) { const i = l.indexOf(":"); if (i > 0) headers.set(l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()); }
  return { status, headers, body };
}

/** `gh api` exits 1 on a 304: its status line is on stdout, "HTTP 304" on stderr. */
function isNotModified(err: unknown): boolean {
  const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string } | null;
  const out = typeof e?.stdout === "string" ? e.stdout : e?.stdout?.toString() ?? "";
  if (/^HTTP\/\S+ 304\b/.test(out)) return true;
  const errText = typeof e?.stderr === "string" ? e.stderr : e?.stderr?.toString() ?? "";
  return /\bHTTP 304\b/.test(`${errText}\n${e?.message ?? ""}`);
}

interface CommentRow { id: number; login?: string; body: string }

// Keep the marker test inside jq so a thread of unrelated comments costs no output.
const COMMENT_FILTER = `.[] | select(.body | startswith("${RECORD_MARKER}")) | {id, login: .user.login, body}`;

/** 2.5 s apart keeps anchor searches at 24 a minute, under search's 30. */
const SEARCH_SPACING_MS = 2_500;

export class GitHubRecordStore {
  private readonly cache = new Map<string, Entry>();
  /** The anchor issue of each repo's record, once found: null = looked for, none exists yet. */
  private readonly anchors = new Map<string, number | null>();
  /** repo as configured → its current owner/name. Search does not follow a transfer; `repos/{repo}` does. */
  private readonly names = new Map<string, string>();
  /**
   * The tail of each record's queue of loads and saves. The reads are async, so two
   * saves of one item could otherwise both see no comment and both post one; the
   * same goes for a repo's anchor issue, which each repo record's queue guards.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  /**
   * Anchor searches go one at a time, SEARCH_SPACING_MS apart: search is GitHub's 30-a-minute bucket, and an empty
   * anchor cache (every restart) looks up every repo at once. 2026-11-18: ~31 in a burst tripped it each hour.
   */
  private searchGate: Promise<void> = Promise.resolve();

  /** What the last run learned: replayed after a restart and revalidated with If-None-Match (a 304 is free). */
  private disk = new Map<string, Entry & { number: number | null }>();
  private diskLoaded = false;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private diskSelf = "";

  constructor(private readonly io: RecordStoreIo, private readonly searchSpacingMs = SEARCH_SPACING_MS, private readonly persistPath: string | null = null) {}

  private cachePath(): string | null { return this.persistPath ?? recordCachePath; }

  /**
   * Read the file once, for the login `self`; a file written as another login, or unreadable, counts as none.
   * Not before the path is known: the Paperclip mirror loads a repo record ~0.7 s before the daemon sets the path,
   * and latching then left every restart of 2026-11-20 with an empty cache (~2,350 full reads each, quota gone).
   */
  private loadDisk(self: string): void {
    if (this.diskLoaded) return;
    this.diskSelf = self;
    const path = this.cachePath();
    if (!path) return;
    this.diskLoaded = true;
    if (!existsSync(path)) return;
    try {
      const f = JSON.parse(readFileSync(path, "utf8")) as RecordCacheFile;
      if (f.version !== 1 || f.self !== self) {
        this.io.warn?.(`record cache ${path} ignored: written as ${f.self ?? "?"} v${f.version ?? "?"}, running as ${self} v1; every item is read in full`);
        return;
      }
      for (const [id, e] of Object.entries(f.entries ?? {})) if (!this.disk.has(id)) this.disk.set(id, e);
      for (const [repo, n] of Object.entries(f.anchors ?? {})) if (!this.anchors.has(repo) && Number.isFinite(n)) this.anchors.set(repo, n);
    } catch (err) {
      this.io.warn?.(`record cache ${path} unreadable (${err instanceof Error ? err.message : String(err)}); every item is read in full`);
    }
  }

  private remember(id: string, entry: Entry, number: number | null): void {
    if (!this.cachePath()) return;
    this.disk.set(id, { ...entry, number });
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 5_000);
    this.flushTimer.unref();
  }

  /** Write the cache file now (atomic rename); a failure only costs the next restart its reads. */
  flush(): void {
    const path = this.cachePath();
    if (!path || !this.dirty || !this.diskSelf) return;
    this.dirty = false;
    try {
      const anchors: Record<string, number> = {};
      for (const [repo, n] of this.anchors) if (n !== null) anchors[repo] = n;
      const file: RecordCacheFile = { version: 1, self: this.diskSelf, entries: Object.fromEntries(this.disk), anchors };
      writeFileSync(`${path}.tmp`, JSON.stringify(file));
      renameSync(`${path}.tmp`, path);
    } catch { this.dirty = true; }
  }

  /**
   * A cached entry re-proved with one conditional request: unchanged is a 304 (free), changed is the new body.
   * Undefined means "could not tell, read the item the full way".
   */
  private async revalidate(key: RecordKey, prior: Entry & { number: number | null }, self: string, cwd: string): Promise<Entry | undefined> {
    const inm = prior.etag ? ["-H", `If-None-Match: ${prior.etag}`] : [];
    try {
      if (prior.commentId !== null) {
        const out = String(await this.io.run(["api", "-i", ...inm, `repos/${key.repo}/issues/comments/${prior.commentId}`], cwd));
        const r = parseInclude(out);
        if (r.status !== 200) return undefined;
        const row = JSON.parse(r.body) as { id: number; body: string; user?: { login?: string } };
        if (row.user?.login?.toLowerCase() !== self || !row.body.startsWith(RECORD_MARKER)) return undefined;
        const record = parseRecordBody(row.body);
        if (!record) return undefined;
        return { commentId: row.id, json: canonicalJson(record), etag: r.headers.get("etag") };
      }
      if (prior.number === null) return undefined;
      const out = String(await this.io.run(["api", "-i", ...inm, `repos/${key.repo}/issues/${prior.number}/comments?per_page=100`], cwd));
      const r = parseInclude(out);
      if (r.status !== 200 || /rel="next"/.test(r.headers.get("link") ?? "")) return undefined;
      const rows = JSON.parse(r.body) as Array<{ body: string; user?: { login?: string } }>;
      if (rows.some((c) => c.user?.login?.toLowerCase() === self && c.body.startsWith(RECORD_MARKER))) return undefined;
      return { commentId: null, json: null, etag: r.headers.get("etag") };
    } catch (err) {
      return isNotModified(err) && prior.etag ? { commentId: prior.commentId, json: prior.json, etag: prior.etag } : undefined;
    }
  }

  private paced<T>(call: () => T | Promise<T>): Promise<T> {
    const turn = this.searchGate.then(call);
    const spacing = this.searchSpacingMs;
    this.searchGate = turn.then(() => undefined, () => undefined).then(() => (spacing > 0 ? new Promise<void>((r) => setTimeout(r, spacing)) : undefined));
    return turn;
  }

  /** Run `fn` after every earlier operation on `id` settles. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(id) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return next;
  }

  loadRecord(key: RecordKey, repoConfig: RepoConfig): Promise<RecordLoad> {
    return this.serial(recordId(key), () => this.load(key, repoConfig));
  }

  saveRecord(key: RecordKey, record: ItemRecord, repoConfig: RepoConfig): Promise<boolean> {
    return this.serial(recordId(key), () => this.save(key, record, repoConfig));
  }

  private async load(key: RecordKey, repoConfig: RepoConfig): Promise<RecordLoad> {
    try {
      const entry = await this.entryFor(key, repoConfig.repoPath);
      return entry.json === null ? { status: "absent" } : { status: "found", record: JSON.parse(entry.json) as ItemRecord };
    } catch (err) {
      const { message, stderr } = formatGhError(err);
      return { status: "unavailable", reason: stderr.split("\n")[0] || message.split("\n")[0] };
    }
  }

  private async save(key: RecordKey, record: ItemRecord, repoConfig: RepoConfig): Promise<boolean> {
    if (!isItemRecord(record)) return false;
    const cwd = repoConfig.repoPath;
    try {
      const entry = await this.entryFor(key, cwd);
      const json = canonicalJson(record);
      if (entry.json === json) return true;
      const body = recordBody(record);
      const number = key.kind === "repo" ? await this.anchorFor(key.repo, cwd, true) : key.number;
      if (number === null) return false;
      const commentId = entry.commentId === null
        ? Number(await this.io.run(["api", "-X", "POST", `repos/${key.repo}/issues/${number}/comments`, "-f", `body=${body}`, "--jq", ".id"], cwd))
        : await this.edit(key.repo, entry.commentId, body, cwd);
      if (!Number.isFinite(commentId)) return false;
      this.cache.set(recordId(key), { commentId, json });
      this.remember(recordId(key), { commentId, json }, number);
      return true;
    } catch (err) {
      // A swallowed reason hid a renamed repo for six hours (2026-11-18): every hand-off failed as "could not be saved".
      const { message, stderr } = formatGhError(err);
      this.io.warn?.(`record save failed for ${recordId(key)}: ${stderr.split("\n")[0] || message.split("\n")[0]}`);
      return false;
    }
  }

  /** PATCH the record comment in place; returns its id. */
  private async edit(repo: string, commentId: number, body: string, cwd: string): Promise<number> {
    await this.io.run(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`], cwd);
    return commentId;
  }

  /** The cached entry, else one read of the item's comments. Throws when GitHub cannot be read or the record is unreadable. */
  private async entryFor(key: RecordKey, cwd: string): Promise<Entry> {
    const id = recordId(key);
    const cached = this.cache.get(id);
    if (cached) return cached;
    const self = (await this.io.login(cwd))?.toLowerCase();
    if (!self) throw new Error("the Foreman's login could not be resolved");
    this.loadDisk(self);
    const number = key.kind === "repo" ? await this.anchorFor(key.repo, cwd, false) : key.number;
    // A repo whose anchor issue does not exist yet holds no record.
    if (number === null) {
      const none: Entry = { commentId: null, json: null };
      this.cache.set(id, none);
      return none;
    }
    const prior = this.disk.get(id);
    if (prior && prior.number === number) {
      const fresh = await this.revalidate(key, prior, self, cwd);
      if (fresh) { this.cache.set(id, fresh); this.remember(id, fresh, number); return fresh; }
    }
    const out = await this.io.run(["api", "--paginate", `repos/${key.repo}/issues/${number}/comments?per_page=100`, "--jq", COMMENT_FILTER], cwd);
    const mine = out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CommentRow)
      .filter((c) => c.login?.toLowerCase() === self);
    // Comments come oldest first; if a race ever left two, the oldest is the record.
    const comment = mine[0];
    let entry: Entry = { commentId: null, json: null };
    if (comment) {
      const record = parseRecordBody(comment.body);
      if (!record) throw new Error(`the record comment ${comment.id} on ${key.repo}#${number} is unreadable`);
      entry = { commentId: comment.id, json: canonicalJson(record) };
    }
    this.cache.set(id, entry);
    this.remember(id, entry, number);
    return entry;
  }

  /**
   * The number of the issue holding `repo`'s record. Found by title among the Foreman's own issues; created
   * (and closed at once, so it is on no board) only when `create` and none exists. Null: none, and not created.
   * Throws when GitHub cannot be read.
   */
  /**
   * The repo's current owner/name. A transferred repo keeps answering at its old name everywhere but search, which
   * refuses it (422), so a config naming the old owner could never find its anchor. Read once per repo; a failed
   * read keeps the configured name (the search then fails exactly as before, and the save says why).
   */
  private async currentName(repo: string, cwd: string): Promise<string> {
    const known = this.names.get(repo);
    if (known !== undefined) return known;
    let name = repo;
    try {
      const out = String(await this.io.run(["api", `repos/${repo}`, "--jq", ".full_name"], cwd)).trim();
      if (/^[^/\s]+\/[^/\s]+$/.test(out)) name = out;
    } catch { return repo; }
    this.names.set(repo, name);
    return name;
  }

  private async anchorFor(repo: string, cwd: string, create: boolean): Promise<number | null> {
    const known = this.anchors.get(repo);
    if (known !== undefined && (known !== null || !create)) return known;
    const self = await this.io.login(cwd);
    if (!self) throw new Error("the Foreman's login could not be resolved");
    if (known === undefined) {
      const q = encodeURIComponent(`repo:${await this.currentName(repo, cwd)} is:issue author:${self} in:title "${REPO_RECORD_TITLE}"`);
      const out = await this.paced(() => this.io.run(["api", `search/issues?q=${q}&per_page=30&sort=created&order=asc`, "--jq", `.items[] | select(.title == "${REPO_RECORD_TITLE}") | .number`], cwd));
      const first = out.split("\n").map((l) => Number(l.trim())).find((n) => Number.isFinite(n) && n > 0);
      this.anchors.set(repo, first ?? null);
      if (first !== undefined) return first;
    }
    if (!create) return null;
    const number = Number(await this.io.run(["api", "-X", "POST", `repos/${repo}/issues`, "-f", `title=${REPO_RECORD_TITLE}`, "-f", "body=The Foreman keeps this repo's own bookkeeping in the comment below. Nothing here is work; leave it closed.", "--jq", ".number"], cwd));
    if (!Number.isFinite(number) || number <= 0) throw new Error(`the repo record issue on ${repo} could not be created`);
    this.anchors.set(repo, number);
    // Closed at once so it never reaches a board; a failure here leaves a usable (open) anchor.
    try { await this.io.run(["api", "-X", "PATCH", `repos/${repo}/issues/${number}`, "-f", "state=closed", "-f", "state_reason=not_planned"], cwd); } catch { /* the record still works open */ }
    return number;
  }
}
