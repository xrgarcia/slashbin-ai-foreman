// What every collaborator of the mirror is handed and none of them owns: the
// Paperclip client, the config in force, the secrets to redact, the logger, and
// the one place a Paperclip call is made safely. The mirror builds it once; a
// reloaded config is swapped in here, so every collaborator reads the new one.

import { redactAll } from "../redact.js";
import type { Logger } from "../logger.js";
import type { WorkItem } from "../adapters.js";
import type { PaperclipConfig } from "./config.js";
import { statusName, type PaperclipBucket } from "./board.js";
import { PaperclipClientError, type PaperclipClient } from "./client.js";
import { commentsOf, redactComment, type CommentsConfig } from "./comments.js";
import type { HandoffLabels } from "./handoff.js";
import { TEXT_CAP } from "./steps.js";

export class PaperclipEnv {
  comments: CommentsConfig;
  /** True while Paperclip is failing; cleared by the next successful call. */
  private outageLogged = false;
  /** "<task id> <status>" rejections already logged, so a repeating one is logged once. */
  readonly rejectionsLogged = new Set<string>();

  constructor(
    readonly client: PaperclipClient,
    public cfg: PaperclipConfig,
    readonly secrets: ReadonlyArray<{ name: string; value: string }>,
    readonly logger: Logger,
    readonly labels: HandoffLabels,
    /** Reduces a repo to the key cards are compared on; unset, a repo is its own key. */
    readonly identity?: import("./repo-identity.js").RepoIdentity,
  ) {
    this.comments = commentsOf(cfg);
  }

  /** Take a reloaded config. */
  reconfigure(next: PaperclipConfig): void {
    this.cfg = next;
    this.comments = commentsOf(next);
  }

  /** A reason or detail fit to write: secrets redacted, one paragraph, capped. */
  clean(text: string): string {
    const one = redactComment(String(text), this.secrets).replace(/\s+/g, " ").trim();
    return one.length > TEXT_CAP ? `${one.slice(0, TEXT_CAP - 1)}…` : one;
  }

  /** `identityKeyFormat` for `item`: the first line of its task's description. */
  keyOf(item: WorkItem): string {
    return this.cfg.identityKeyFormat
      .split("{repo}").join(item.repo)
      .split("{N}").join(String(item.issueNumber));
  }

  statusName(bucket: PaperclipBucket): string {
    return statusName(this.cfg, bucket);
  }

  /** `identityKeyFormat` as a pattern capturing `repo` and `N`. */
  keyPattern(): RegExp {
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const src = this.cfg.identityKeyFormat
      .split(/(\{repo\}|\{N\})/)
      .map((part) => (part === "{repo}" ? "(?<repo>[^\\s#]+/[^\\s#]+)" : part === "{N}" ? "(?<N>\\d+)" : esc(part)))
      .join("");
    return new RegExp(`^${src}$`);
  }

  /** The Foreman's own notes are its agent's words. */
  ownComment(): { commentAuthor: string | null } {
    return { commentAuthor: this.cfg.agentId ? `agent:${this.cfg.agentId}` : null };
  }

  /**
   * Run one Paperclip call. Never throws. An outage (no answer, or a 5xx) is
   * logged at warn when it starts, and the next success ends it. A rejection
   * (any other 4xx) is about this call only: logged with Paperclip's reason,
   * once per task and status code, and it neither starts nor ends an outage.
   */
  async safeCall<T>(what: string, fn: () => Promise<T>, taskId = ""): Promise<{ ok: true; value: T } | { ok: false }> {
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

  log(level: "info" | "warn", msg: string): void {
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
