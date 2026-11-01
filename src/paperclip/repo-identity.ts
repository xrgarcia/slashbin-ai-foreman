// The mirror's only registry client: the owner-free identity of a GitHub repo, from the
// registry's `repo_identity` MCP tool (slashbin_mcp_services). After a repo moves from
// one GitHub owner to another, `<old-owner>/<name>` and `<new-owner>/<name>` answer the same
// `key`, so a card written under one spelling is found by an item carrying the other.
//
// An outage THROWS: the registry never answers "unknown" for one (the tool errors), and the
// mirror fails the scan on it, keeping the previous index. A repo the registry does not know
// (kind "unknown") or knows only exactly (kind "other") keeps its input as its key, so
// `jerky_*`, `cmneb_*` and `slashbin-io/jerky_rank` merge with nothing.
//
// Transport: MCP streamable HTTP (JSON-RPC over POST, bearer auth), the same route the EM's
// `registry_client.py` takes to the router. Uses the global fetch; no dependency.

export interface RepoIdentity {
  /** The key `repo` is compared on. Memoised since the last `beginScan`. Throws when the registry cannot answer. */
  keyOf(repo: string): Promise<string>;
  /** Forget what was answered: the next scan asks again. */
  beginScan(): void;
}

export class RepoIdentityError extends Error {}

export type RepoIdentityOptions = {
  /** The registry's MCP endpoint (`paperclip.registryUrl`). */
  url: string;
  /** Bearer credential for the router, when it requires one. */
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type Answer = { kind?: unknown; key?: unknown };

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
function answerOf(result: unknown): Answer {
  const r = (result ?? {}) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  if (r.isError) throw new RepoIdentityError(`repo_identity failed: ${r.content?.[0]?.text ?? "tool error"}`);
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent as Answer;
  const text = r.content?.find((c) => c.type === "text")?.text;
  try {
    return JSON.parse(text ?? "") as Answer;
  } catch {
    throw new RepoIdentityError("repo_identity answered with no result");
  }
}

export function createRepoIdentity(opts: RepoIdentityOptions): RepoIdentity {
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 10_000;
  let memo = new Map<string, Promise<string>>();
  let session: Promise<string | null> | null = null;
  let id = 0;

  const post = async (payload: object, sessionId: string | null) => {
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
      throw new RepoIdentityError(`registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new RepoIdentityError(`registry answered ${res.status}`);
    return { res, body: await res.text() };
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

  const ask = async (repo: string): Promise<string> => {
    const sid = await open();
    const call = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "repo_identity", arguments: { repo } } }, sid);
    const msg = rpcMessage(call.body, call.res.headers.get("content-type") ?? "");
    if (msg.error) throw new RepoIdentityError(`repo_identity failed: ${msg.error.message ?? "error"}`);
    const a = answerOf(msg.result);
    if (a.kind !== "slashbin" && a.kind !== "other" && a.kind !== "unknown") throw new RepoIdentityError(`repo_identity answered an unknown kind for ${repo}`);
    // Only a Slashbin or exactly-registered repo has a key worth comparing; anything else is itself.
    return a.kind !== "unknown" && typeof a.key === "string" && a.key ? a.key : repo;
  };

  return {
    keyOf(repo) {
      let p = memo.get(repo);
      if (!p) {
        p = ask(repo);
        memo.set(repo, p);
        // A failed answer is not remembered: the next scan, or the next call, asks again.
        p.catch(() => { if (memo.get(repo) === p) memo.delete(repo); });
      }
      return p;
    },
    beginScan() {
      memo = new Map();
      session = null;
    },
  };
}
