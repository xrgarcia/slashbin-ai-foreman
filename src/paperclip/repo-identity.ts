// The mirror's only registry client: the owner-free identity of a GitHub repo, from the
// registry's `repo_identity` MCP tool (slashbin_mcp_services). After a repo moves from
// one GitHub owner to another, `<old-owner>/<name>` and `<new-owner>/<name>` answer the same
// `key`, so a card written under one spelling is found by an item carrying the other.
//
// An outage THROWS: the registry never answers "unknown" for one (the tool errors). A request
// that failed for a passing reason (no answer, a timeout, HTTP 408/429/500/502/503/504) is first
// retried in place with `backoff.registry`; the mirror's scan tolerates what still fails (it uses
// the repo's last known key). A successful answer is kept REPO_KEY_TTL_MS; a failure never is. A repo the registry does not know
// (kind "unknown") or knows only exactly (kind "other") keeps its input as its key, so
// `jerky_*`, `cmneb_*` and `slashbin-io/jerky_rank` merge with nothing.
//
// Transport: MCP streamable HTTP (JSON-RPC over POST, bearer auth), the same route the EM's
// `registry_client.py` takes to the router. Uses the global fetch; no dependency.

import { backoffSettings, retryAsync } from "../backoff.js";

/** How long a successful answer stands before the registry is asked again. */
export const REPO_KEY_TTL_MS = 60 * 60_000;

export interface RepoIdentity {
  /** The key `repo` is compared on. Memoised since the last `beginScan`. Throws when the registry cannot answer. */
  keyOf(repo: string): Promise<string>;
  /** The registry's customer GitHub labels (the non-null `systems.github_label` of each live customer). Memoised, failure included, until the next `beginScan`. Throws when the registry cannot answer. */
  customerLabels(): Promise<string[]>;
  /** A new scan: drop answers older than REPO_KEY_TTL_MS and reopen the MCP session. */
  beginScan(): void;
  /** HTTP requests sent to the registry so far (retries included), for the scan's log line. */
  requests?(): number;
}

/** `status` is the HTTP status, 0 when no response arrived, unset for an answer that is itself the failure. */
export class RepoIdentityError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "RepoIdentityError";
  }
}

const TRANSIENT_STATUS = new Set([0, 408, 429, 500, 502, 503, 504]);
const isTransient = (err: unknown): boolean => err instanceof RepoIdentityError && err.status !== undefined && TRANSIENT_STATUS.has(err.status);

export type RepoIdentityOptions = {
  /** The registry's MCP endpoint (`paperclip.registryUrl`). */
  url: string;
  /** Bearer credential for the router, when it requires one. */
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The clock, injected for tests. */
  now?: () => number;
};

type Answer = { kind?: unknown; key?: unknown; customers?: unknown };

/** The JSON-RPC message in a response body, whether the server sent JSON or one SSE event. */
function rpcMessage(body: string, contentType: string): { result?: unknown; error?: { message?: string } } {
  const text = /text\/event-stream/i.test(contentType)
    ? body.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : body;
  try {
    return JSON.parse(text);
  } catch {
    throw new RepoIdentityError("registry answered with a body that is not JSON-RPC");
  }
}

/** The tool's answer: `structuredContent`, else the first text block parsed as JSON. */
function answerOf(result: unknown, tool: string): Answer {
  const r = (result ?? {}) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  if (r.isError) throw new RepoIdentityError(`${tool} failed: ${r.content?.[0]?.text ?? "tool error"}`);
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent as Answer;
  const text = r.content?.find((c) => c.type === "text")?.text;
  try {
    return JSON.parse(text ?? "") as Answer;
  } catch {
    throw new RepoIdentityError(`${tool} answered with no result`);
  }
}

export function createRepoIdentity(opts: RepoIdentityOptions): RepoIdentity {
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 10_000;
  const now = opts.now ?? Date.now;
  let memo = new Map<string, { p: Promise<string>; at: number }>();
  let requests = 0;
  let session: Promise<string | null> | null = null;
  let id = 0;
  let customers: Promise<string[]> | null = null;

  const postOnce = async (payload: object, sessionId: string | null) => {
    requests++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    };
    let res: Response;
    try {
      res = await doFetch(opts.url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new RepoIdentityError(`registry unreachable: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    if (!res.ok) throw new RepoIdentityError(`registry answered ${res.status}`, res.status);
    try {
      return { res, body: await res.text() };
    } catch (e) {
      throw new RepoIdentityError(`registry unreachable: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
  };

  // Every request here is a read (initialize, the initialized notice, repo_identity), so each is safe to resend.
  const post = (payload: object, sessionId: string | null) => {
    const retry = backoffSettings().registry;
    return retryAsync(() => postOnce(payload, sessionId), { window: retry, maxAttempts: retry.maxAttempts, isTransient });
  };

  // One MCP session per scan, opened on the first question.
  const open = (): Promise<string | null> => {
    session ??= (async () => {
      const init = await post({
        jsonrpc: "2.0", id: ++id, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "foreman-paperclip-mirror", version: "1" } },
      }, null);
      const msg = rpcMessage(init.body, init.res.headers.get("content-type") ?? "");
      if (msg.error) throw new RepoIdentityError(`registry refused initialize: ${msg.error.message ?? "error"}`);
      const sid = init.res.headers.get("mcp-session-id");
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
      return sid;
    })();
    session.catch(() => { session = null; });
    return session;
  };

  /** One tool call on the scan's session; the tool's answer. */
  const call = async (tool: string, args: object): Promise<Answer> => {
    const sid = await open();
    const res = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } }, sid);
    const msg = rpcMessage(res.body, res.res.headers.get("content-type") ?? "");
    if (msg.error) throw new RepoIdentityError(`${tool} failed: ${msg.error.message ?? "error"}`);
    return answerOf(msg.result, tool);
  };

  const ask = async (repo: string): Promise<string> => {
    const a = await call("repo_identity", { repo });
    if (a.kind !== "slashbin" && a.kind !== "other" && a.kind !== "unknown") throw new RepoIdentityError(`repo_identity answered an unknown kind for ${repo}`);
    // Only a Slashbin or exactly-registered repo has a key worth comparing; anything else is itself.
    return a.kind !== "unknown" && typeof a.key === "string" && a.key ? a.key : repo;
  };

  const askCustomers = async (): Promise<string[]> => {
    const a = await call("list_customers", {});
    if (!Array.isArray(a.customers)) throw new RepoIdentityError("list_customers answered no customers");
    const labels = a.customers.map((c: { systems?: { github_label?: unknown } } | null) => c?.systems?.github_label);
    return labels.filter((l): l is string => typeof l === "string" && l !== "");
  };

  return {
    keyOf(repo) {
      const have = memo.get(repo);
      if (have && now() - have.at < REPO_KEY_TTL_MS) return have.p;
      const p = ask(repo);
      const entry = { p, at: now() };
      memo.set(repo, entry);
      // A failed answer is not remembered: the next call asks again.
      p.catch(() => { if (memo.get(repo) === entry) memo.delete(repo); });
      return p;
    },
    customerLabels() {
      customers ??= askCustomers();
      return customers;
    },
    beginScan() {
      customers = null;
      for (const [repo, e] of memo) if (now() - e.at >= REPO_KEY_TTL_MS) memo.delete(repo);
      session = null;
    },
    requests: () => requests,
  };
}
