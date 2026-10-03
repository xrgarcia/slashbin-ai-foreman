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
};

export type PaperclipComment = {
  id: string;
  body: string;
  authorAgentId: string | null;
};

export type PaperclipAgent = {
  id: string;
  name: string;
  role?: string;
  adapterType?: string;
  runtimeConfig?: unknown;
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
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
};

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

  constructor(opts: PaperclipClientOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.companyId = opts.companyId;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
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

  updateIssue(id: string, body: Partial<PaperclipIssue> & Record<string, unknown>): Promise<PaperclipIssue> {
    return this.request("PATCH", `/api/issues/${encodeURIComponent(id)}`, body);
  }

  getIssueComments(id: string): Promise<PaperclipComment[]> {
    return this.request("GET", `/api/issues/${encodeURIComponent(id)}/comments`);
  }

  createComment(id: string, commentBody: string): Promise<PaperclipComment> {
    return this.request("POST", `/api/issues/${encodeURIComponent(id)}/comments`, { body: commentBody });
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

  private companyPath(): string {
    return `/api/companies/${encodeURIComponent(this.companyId)}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const what = `${method} ${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
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
