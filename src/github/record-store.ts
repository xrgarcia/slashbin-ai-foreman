// The GitHub record store (EM#1244 f1): one comment per issue or PR, written by
// the Foreman's own login, carrying the item's durable record as JSON. Created
// once, then edited in place. The marker-comment pattern of readiness.ts, with
// the record in the comment instead of a digest.
//
// Reads and writes go through gh(), which already retries a transient failure; a
// failure that survives that is `unavailable` on a load and `false` on a save,
// and is never turned into an empty record. The cache is the plugin's own: one
// read per item per process, rebuilt from the comment, never the only copy.

import type { ItemRecord, RecordKey, RecordLoad } from "../adapters.js";
import type { RepoConfig } from "../config.js";
import { canonicalJson, isItemRecord, recordId } from "../record-store.js";
import { gh } from "./gh.js";
import { foremanLogin } from "./skip-hold.js";

/** First line of every record comment; what a read looks for. */
export const RECORD_MARKER = "<!-- foreman:record v1 -->";
const DATA_PREFIX = "<!-- foreman:record-data ";
const DATA_SUFFIX = " -->";

/** What the store runs: gh with the Foreman's token, and the login that token acts as. Injectable for tests. */
export interface RecordStoreIo {
  run(args: string[], cwd: string): string;
  login(cwd: string): string | undefined;
}

const realIo: RecordStoreIo = { run: gh, login: foremanLogin };

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

/** What the store knows of one item: the comment holding its record (null: none), and the record. */
interface Entry { readonly commentId: number | null; readonly record: ItemRecord | null }

interface CommentRow { id: number; login?: string; body: string }

// Keep the marker test inside jq so a thread of unrelated comments costs no output.
const COMMENT_FILTER = `.[] | select(.body | startswith("${RECORD_MARKER}")) | {id, login: .user.login, body}`;

export class GitHubRecordStore {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly io: RecordStoreIo = realIo) {}

  async loadRecord(key: RecordKey, repoConfig: RepoConfig): Promise<RecordLoad> {
    try {
      const entry = this.entryFor(key, repoConfig.repoPath);
      return entry.record ? { status: "found", record: entry.record } : { status: "absent" };
    } catch (err) {
      return { status: "unavailable", reason: err instanceof Error ? err.message.split("\n")[0] : String(err) };
    }
  }

  async saveRecord(key: RecordKey, record: ItemRecord, repoConfig: RepoConfig): Promise<boolean> {
    if (!isItemRecord(record)) return false;
    const cwd = repoConfig.repoPath;
    try {
      const entry = this.entryFor(key, cwd);
      if (entry.record && canonicalJson(entry.record) === canonicalJson(record)) return true;
      const body = recordBody(record);
      const commentId = entry.commentId === null
        ? Number(this.io.run(["api", "-X", "POST", `repos/${key.repo}/issues/${key.number}/comments`, "-f", `body=${body}`, "--jq", ".id"], cwd))
        : this.edit(key.repo, entry.commentId, body, cwd);
      if (!Number.isFinite(commentId)) return false;
      this.cache.set(recordId(key), { commentId, record: JSON.parse(canonicalJson(record)) as ItemRecord });
      return true;
    } catch {
      return false;
    }
  }

  /** PATCH the record comment in place; returns its id. */
  private edit(repo: string, commentId: number, body: string, cwd: string): number {
    this.io.run(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`], cwd);
    return commentId;
  }

  /** The cached entry, else one read of the item's comments. Throws when GitHub cannot be read or the record is unreadable. */
  private entryFor(key: RecordKey, cwd: string): Entry {
    const id = recordId(key);
    const cached = this.cache.get(id);
    if (cached) return cached;
    const self = this.io.login(cwd)?.toLowerCase();
    if (!self) throw new Error("the Foreman's login could not be resolved");
    const out = this.io.run(["api", "--paginate", `repos/${key.repo}/issues/${key.number}/comments?per_page=100`, "--jq", COMMENT_FILTER], cwd);
    const mine = out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CommentRow)
      .filter((c) => c.login?.toLowerCase() === self);
    // Comments come oldest first; if a race ever left two, the oldest is the record.
    const comment = mine[0];
    let entry: Entry = { commentId: null, record: null };
    if (comment) {
      const record = parseRecordBody(comment.body);
      if (!record) throw new Error(`the record comment ${comment.id} on ${key.repo}#${key.number} is unreadable`);
      entry = { commentId: comment.id, record };
    }
    this.cache.set(id, entry);
    return entry;
  }
}
