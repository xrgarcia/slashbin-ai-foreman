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
import { canonicalJson, isItemRecord, recordId } from "../record-store.js";
import { formatGhError } from "./cache.js";

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
interface Entry { readonly commentId: number | null; readonly json: string | null }

interface CommentRow { id: number; login?: string; body: string }

// Keep the marker test inside jq so a thread of unrelated comments costs no output.
const COMMENT_FILTER = `.[] | select(.body | startswith("${RECORD_MARKER}")) | {id, login: .user.login, body}`;

export class GitHubRecordStore {
  private readonly cache = new Map<string, Entry>();
  /** The anchor issue of each repo's record, once found: null = looked for, none exists yet. */
  private readonly anchors = new Map<string, number | null>();
  /**
   * The tail of each record's queue of loads and saves. The reads are async, so two
   * saves of one item could otherwise both see no comment and both post one; the
   * same goes for a repo's anchor issue, which each repo record's queue guards.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly io: RecordStoreIo) {}

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
      return true;
    } catch {
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
    const number = key.kind === "repo" ? await this.anchorFor(key.repo, cwd, false) : key.number;
    // A repo whose anchor issue does not exist yet holds no record.
    if (number === null) {
      const none: Entry = { commentId: null, json: null };
      this.cache.set(id, none);
      return none;
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
    return entry;
  }

  /**
   * The number of the issue holding `repo`'s record. Found by title among the Foreman's own issues; created
   * (and closed at once, so it is on no board) only when `create` and none exists. Null: none, and not created.
   * Throws when GitHub cannot be read.
   */
  private async anchorFor(repo: string, cwd: string, create: boolean): Promise<number | null> {
    const known = this.anchors.get(repo);
    if (known !== undefined && (known !== null || !create)) return known;
    const self = await this.io.login(cwd);
    if (!self) throw new Error("the Foreman's login could not be resolved");
    if (known === undefined) {
      const q = encodeURIComponent(`repo:${repo} is:issue author:${self} in:title "${REPO_RECORD_TITLE}"`);
      const out = await this.io.run(["api", `search/issues?q=${q}&per_page=30&sort=created&order=asc`, "--jq", `.items[] | select(.title == "${REPO_RECORD_TITLE}") | .number`], cwd);
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
