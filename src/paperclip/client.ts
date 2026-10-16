// HTTP client for the slice of Paperclip's REST API the Foreman uses
// (https://github.com/paperclipai/paperclip): company issues, their comments,
// company agents, the company itself and server health. One instance talks to
// one company.
//
// No retry and no back-off here: every failure — a non-2xx status, an
// unreachable server, a 2xx body that is not JSON — throws PaperclipClientError
// and the caller decides. Uses the global fetch (Node >= 18), no dependency.

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
  /** Told when the board refuses a comment's credited author and the comment is posted under the key's own user. */
  warn?: (message: string) => void;
};

/**
 * Who a comment is credited to: `agent:<agentId>` or `user:<userId>`. Sent as
 * this header by an instance-admin board key, and only the comment's author
 * changes (the Slashbin fork, slashbin/PATCHES.md "Credited comment authors").
 */
export const COMMENT_AUTHOR_HEADER = "x-slashbin-comment-author";
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

  constructor(opts: PaperclipClientOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.companyId = opts.companyId;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.apiKey = opts.apiKey || undefined;
    this.warn = opts.warn ?? (() => {});
  }

  /** `GET /api/health`: resolves when the server answers 2xx. */
  health(): Promise<unknown> {
    return this.request("GET", "/api/health");
  }

  /** The configured company. */
  getCompany(): Promise<PaperclipCompany> {
    return this.request("GET", this.companyPath());
  }

  /** Every issue in the company, fetched a page at a time. */
  async *listIssues(): AsyncIterableIterator<PaperclipIssue> {
    for (let offset = 0; ; offset += PAPERCLIP_PAGE_SIZE) {
      const page = await this.request<PaperclipIssue[]>(
        "GET",
        `${this.companyPath()}/issues?limit=${PAPERCLIP_PAGE_SIZE}&offset=${offset}`,
      );
      if (!Array.isArray(page)) {
        throw new PaperclipClientError("Paperclip issue list is not an array", 200, JSON.stringify(page));
      }
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

  /** With `commentAuthor`, a `comment` in the body is credited to it; the rest of the write stays the key's own. */
  updateIssue(id: string, body: Partial<PaperclipIssue> & Record<string, unknown>, opts: CommentOpts = {}): Promise<PaperclipIssue> {
    const author = typeof body.comment === "string" ? opts.commentAuthor : null;
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
  private async request<T>(method: string, path: string, body?: unknown, commentAuthor?: string | null): Promise<T> {
    if (!commentAuthor) return this.send<T>(method, path, body, null);
    try {
      return await this.send<T>(method, path, body, commentAuthor);
    } catch (err) {
      if (!(err instanceof PaperclipClientError) || ![403, 422].includes(err.status) || !COMMENT_AUTHOR_REFUSED.test(err.body)) throw err;
      this.warn(`Paperclip ${method} ${path}: the board refused crediting the comment to ${commentAuthor} (${err.status}); posting it as the key's own user`);
      return this.send<T>(method, path, body, null);
    }
  }

  private async send<T>(method: string, path: string, body: unknown, commentAuthor: string | null): Promise<T> {
    const what = `${method} ${path}`;
    let res: Response;
    try {
      const headers: Record<string, string> = body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      if (commentAuthor) headers[COMMENT_AUTHOR_HEADER] = commentAuthor;
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PaperclipClientError(`Paperclip ${what} failed: ${msg}`, 0, msg);
    }
    const text = await res.text().catch(() => "");
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
