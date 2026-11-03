// HTTP client for the slice of Paperclip's REST API the Foreman uses
// (https://github.com/paperclipai/paperclip): company issues, their comments,
// company agents, the company itself and server health. One instance talks to
// one company.
//
// Every failure — a non-2xx status, an unreachable server, a timeout, a 2xx body
// that is not JSON — throws PaperclipClientError. A GET that failed for a passing
// reason (no answer, a timeout, HTTP 408/429/500/502/503/504) is first retried in
// place with `backoff.paperclip`; a write (POST, PATCH, PUT) is never retried,
// because a timeout does not prove it failed and a retry could duplicate a card.
// Uses the global fetch (Node >= 18), no dependency.

import { backoffSettings, retryAsync } from "../backoff.js";

export type PaperclipIssue = {
  id: string;
  title: string;
  status: string;
  description?: string;
  /** A board user holding the task; Paperclip allows one assignee, user or agent. */
  assigneeUserId?: string | null;
  assigneeAgentId?: string | null;
  /** Why a `blocked` task waits and who unblocks it; Paperclip clears it when the task leaves blocked. */
  unblockDescriptor?: { owner: unknown; action: string } | null;
  /** The project the task belongs to; the mirror gives each repo one. */
  projectId?: string | null;
  /** The task's labels; a PATCH of labelIds replaces the whole set. */
  labelIds?: string[];
  /** The board's short name for the task (e.g. SLA-1500). */
  identifier?: string | null;
  /** The run Paperclip has open on the task (an assignee's wake), null when none. */
  executionRunId?: string | null;
  /** The run that has the task checked out, null when none. */
  checkoutRunId?: string | null;
  /** When the task was created (ISO): of two tasks for one issue, the older is the card. */
  createdAt?: string;
};

export type PaperclipLabel = {
  id: string;
  name: string;
  color?: string;
};

export type PaperclipProject = {
  id: string;
  name: string;
  status?: string;
  description?: string | null;
};

export type PaperclipComment = {
  id: string;
  body: string;
  authorAgentId: string | null;
  createdAt?: string;
};

export type PaperclipAgent = {
  id: string;
  name: string;
  role?: string;
  adapterType?: string;
  runtimeConfig?: unknown;
  title?: string | null;
  reportsTo?: string | null;
  status?: string;
  metadata?: Record<string, unknown> | null;
};

export type PaperclipCompany = {
  id: string;
  name?: string;
};

export type CreatePaperclipIssue = {
  title: string;
  status: string;
  description?: string;
  assigneeUserId?: string;
  assigneeAgentId?: string;
  projectId?: string;
};

export type CreatePaperclipAgent = {
  name: string;
  role?: string;
  adapterType?: string;
  runtimeConfig?: unknown;
};

export type PaperclipClientOptions = {
  /** Base URL of the Paperclip server, e.g. http://127.0.0.1:3100. */
  url: string;
  companyId: string;
  /** Sent as `authorization: Bearer <apiKey>` on every request when set. */
  apiKey?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Told when the board refuses a credited author and the write is sent as the key's own user. */
  warn?: (message: string) => void;
  /**
   * `agent:<id>`: every write this client makes is credited to it, so the board's
   * activity feed names that agent and not the key's user (the fork credits the
   * request's activity as well as its comment). A call that names its own comment
   * author overrides it; `null` there sends none.
   */
  actingAs?: string;
  /** The header that carries the credited author (`paperclip.commentAuthorHeader`). Unset = credit is never sent. */
  commentAuthorHeader?: string;
  /** Per-request timeout in ms, so a hung connection rejects; default 30 000. */
  timeoutMs?: number;
};

/** What a GET is worth retrying on: no answer at all, or a status that is the server's passing trouble. */
const TRANSIENT_STATUS = new Set([0, 408, 429, 500, 502, 503, 504]);
export const isTransientPaperclipError = (err: unknown): boolean =>
  err instanceof PaperclipClientError && TRANSIENT_STATUS.has(err.status);

/** GETs sent and issue rows read since the client was made, for the scan's log line. */
export type PaperclipReads = { calls: number; rows: number };

// Who a write is credited to: `agent:<agentId>` or `user:<userId>`, sent in the
// configured `commentAuthorHeader` by an instance-admin board key; the comment's
// author and the activity row's actor change, nothing else. Only an instance that
// implements the header (a fork; the profile names it) honours it.
/** The board's refusals of that header: not an admin board key, or an author it cannot credit. */
const COMMENT_AUTHOR_REFUSED = /comment_author_override_(denied|invalid)/;

/** Per-call options for a request that posts a comment. */
export type CommentOpts = { commentAuthor?: string | null };

/**
 * Any failed Paperclip call. `status` is the HTTP status, or 0 when no response
 * arrived (network failure). `body` is the response text, or the cause's message.
 */
export class PaperclipClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "PaperclipClientError";
  }
}

/** Rows per `listIssues` page. A shorter page is the last one. */
export const PAPERCLIP_PAGE_SIZE = 1000;

export class PaperclipClient {
  private readonly base: string;
  private readonly companyId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;
  private readonly warn: (message: string) => void;
  private readonly actingAs: string | null;
  private readonly commentAuthorHeader: string | undefined;
  private readonly timeoutMs: number;
  /** Every GET attempt (retries included) and every issue row `listIssues` yielded. */
  readonly reads: PaperclipReads = { calls: 0, rows: 0 };

  constructor(opts: PaperclipClientOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.companyId = opts.companyId;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.apiKey = opts.apiKey || undefined;
    this.warn = opts.warn ?? (() => {});
    this.actingAs = opts.actingAs || null;
    this.commentAuthorHeader = opts.commentAuthorHeader || undefined;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** `GET /api/health`: resolves when the server answers 2xx. */
  health(): Promise<unknown> {
    return this.request("GET", "/api/health");
  }

  /** The configured company. */
  getCompany(): Promise<PaperclipCompany> {
    return this.request("GET", this.companyPath());
  }

  /**
   * Every issue in the company, fetched a page at a time; with `updatedSince` (ISO),
   * only those changed at or after it (the server's `updatedSince` filter).
   */
  async *listIssues(opts: { updatedSince?: string } = {}): AsyncIterableIterator<PaperclipIssue> {
    const since = opts.updatedSince ? `&updatedSince=${encodeURIComponent(opts.updatedSince)}` : "";
    for (let offset = 0; ; offset += PAPERCLIP_PAGE_SIZE) {
      const page = await this.request<PaperclipIssue[]>(
        "GET",
        `${this.companyPath()}/issues?limit=${PAPERCLIP_PAGE_SIZE}&offset=${offset}${since}`,
      );
      if (!Array.isArray(page)) {
        throw new PaperclipClientError("Paperclip issue list is not an array", 200, JSON.stringify(page));
      }
      this.reads.rows += page.length;
      yield* page;
      if (page.length < PAPERCLIP_PAGE_SIZE) return;
    }
  }

  createIssue(body: CreatePaperclipIssue): Promise<PaperclipIssue> {
    return this.request("POST", `${this.companyPath()}/issues`, body);
  }

  getIssue(id: string): Promise<PaperclipIssue> {
    return this.request("GET", `/api/issues/${encodeURIComponent(id)}`);
  }

  /** With `commentAuthor`, a `comment` in the body and the write's activity are credited to it; else to `actingAs`. */
  updateIssue(id: string, body: Partial<PaperclipIssue> & Record<string, unknown>, opts: CommentOpts = {}): Promise<PaperclipIssue> {
    const author = typeof body.comment === "string" ? opts.commentAuthor : undefined;
    return this.request("PATCH", `/api/issues/${encodeURIComponent(id)}`, body, author);
  }

  getIssueComments(id: string): Promise<PaperclipComment[]> {
    return this.request("GET", `/api/issues/${encodeURIComponent(id)}/comments`);
  }

  createComment(id: string, commentBody: string, opts: CommentOpts = {}): Promise<PaperclipComment> {
    return this.request("POST", `/api/issues/${encodeURIComponent(id)}/comments`, { body: commentBody }, opts.commentAuthor);
  }

  /** Every project in the company, archived ones included, so the Unplaced lookup sees an archived duplicate too. */
  listProjects(): Promise<PaperclipProject[]> {
    return this.request("GET", `${this.companyPath()}/projects?includeArchived=true`);
  }

  listAgents(): Promise<PaperclipAgent[]> {
    return this.request("GET", `${this.companyPath()}/agents`);
  }

  createAgent(body: CreatePaperclipAgent): Promise<PaperclipAgent> {
    return this.request("POST", `${this.companyPath()}/agents`, body);
  }

  // Addressed by agent id alone: Paperclip reads `?companyId=` only to resolve
  // an agent shortname, and every id the Foreman holds is the agent's UUID.
  updateAgent(id: string, body: Partial<PaperclipAgent> & Record<string, unknown>): Promise<PaperclipAgent> {
    return this.request("PATCH", `/api/agents/${encodeURIComponent(id)}`, body);
  }

  getAgent(id: string): Promise<PaperclipAgent> {
    return this.request("GET", `/api/agents/${encodeURIComponent(id)}`);
  }

  listLabels(): Promise<PaperclipLabel[]> {
    return this.request("GET", `${this.companyPath()}/labels`);
  }

  // Label names are unique per company: a second create of one name is a 409.
  createLabel(body: { name: string; color: string }): Promise<PaperclipLabel> {
    return this.request("POST", `${this.companyPath()}/labels`, body);
  }

  private companyPath(): string {
    return `/api/companies/${encodeURIComponent(this.companyId)}`;
  }

  /**
   * A refused `commentAuthor` (a board without the patch ignores it; one with it
   * refuses a key that is not an instance-admin board key) is retried once without
   * it: the comment then reads as the key's user, as it did before credit existed.
   */
  private async request<T>(method: string, path: string, body?: unknown, credit?: string | null): Promise<T> {
    // Unnamed (undefined) → `actingAs` on a write; a named author, or null for none, wins.
    const commentAuthor = credit !== undefined ? credit : method === "GET" ? null : this.actingAs;
    if (!commentAuthor || !this.commentAuthorHeader) return this.send<T>(method, path, body, null);
    try {
      return await this.send<T>(method, path, body, commentAuthor);
    } catch (err) {
      if (!(err instanceof PaperclipClientError) || ![403, 422].includes(err.status) || !COMMENT_AUTHOR_REFUSED.test(err.body)) throw err;
      this.warn(`Paperclip ${method} ${path}: the board refused crediting the write to ${commentAuthor} (${err.status}); sending it as the key's own user`);
      return this.send<T>(method, path, body, null);
    }
  }

  /** One send; a GET is retried on a transient failure, a write never. */
  private send<T>(method: string, path: string, body: unknown, commentAuthor: string | null): Promise<T> {
    if (method !== "GET") return this.sendOnce<T>(method, path, body, commentAuthor);
    const retry = backoffSettings().paperclip;
    return retryAsync(() => this.sendOnce<T>(method, path, body, commentAuthor), {
      window: retry,
      maxAttempts: retry.maxAttempts,
      isTransient: isTransientPaperclipError,
      onRetry: (err, attempt, wait) => this.warn(`Paperclip ${method} ${path}: attempt ${attempt}/${retry.maxAttempts} failed (${err instanceof Error ? err.message : String(err)}); retrying in ${wait} ms`),
    });
  }

  private async sendOnce<T>(method: string, path: string, body: unknown, commentAuthor: string | null): Promise<T> {
    if (method === "GET") this.reads.calls++;
    const what = `${method} ${path}`;
    let res: Response;
    try {
      const headers: Record<string, string> = body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      if (commentAuthor && this.commentAuthorHeader) headers[this.commentAuthorHeader] = commentAuthor;
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PaperclipClientError(`Paperclip ${what} failed: ${msg}`, 0, msg);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // A body cut off or timed out mid-read is no answer; on a refusal the body is only a detail.
      if (res.ok) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new PaperclipClientError(`Paperclip ${what} failed: ${msg}`, 0, msg);
      }
      text = "";
    }
    if (!res.ok) {
      throw new PaperclipClientError(`Paperclip ${what} returned ${res.status}`, res.status, text);
    }
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PaperclipClientError(`Paperclip ${what} returned a body that is not JSON`, res.status, text);
    }
  }
}

/** Factory form of `new PaperclipClient(opts)`. */
export function createPaperclipClient(opts: PaperclipClientOptions): PaperclipClient {
  return new PaperclipClient(opts);
}
