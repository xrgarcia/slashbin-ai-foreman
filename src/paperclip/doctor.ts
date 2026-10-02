// `paperclip:doctor` (EM#417): a read-only check of the Paperclip integration,
// run before the mirror is trusted. Six named checks, always all six, in order;
// one `PASS: <name> — ...` or `FAIL: <name> — <reason>` line each.
//
// Read-only by construction: every request goes through a fetch that refuses
// any method but GET, so no check can create or change anything in Paperclip.
// It needs no GitHub token and makes no GitHub call. Each request is bounded by
// a timeout, so an unreachable or hung server fails a check instead of hanging.

import type { AgentConfig, PaperclipConfig } from "../config.js";
import { PaperclipClient, PaperclipClientError, type PaperclipAgent } from "./client.js";

/** The checks, in the order they run and print. */
export const DOCTOR_CHECKS = [
  "health",
  "company",
  "agent-registered",
  "wake-on-demand",
  "heartbeat-enabled",
  "config-complete",
] as const;

export type DoctorCheckName = (typeof DOCTOR_CHECKS)[number];

export type DoctorResult = {
  name: DoctorCheckName;
  ok: boolean;
  detail: string;
};

export type DoctorOptions = {
  /** Injected for tests; defaults to the global fetch. Only GET ever reaches it. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 5000 ms. */
  timeoutMs?: number;
  /** Where each line goes. Default console.log. */
  print?: (line: string) => void;
};

export const DOCTOR_TIMEOUT_MS = 5000;

/** `fetch` that only sends GET, with a timeout and a short reason on failure. */
export function readOnlyFetch(inner: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") throw new Error(`paperclip:doctor is read-only; refused ${method}`);
    try {
      return await inner(input, { ...init, method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new Error(failureReason(err, timeoutMs));
    }
  };
}

function failureReason(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `no answer within ${timeoutMs} ms`;
  }
  // Node's fetch reports "fetch failed" and puts the useful part on `cause`.
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  if (cause?.code) return `unreachable (${cause.code})`;
  if (cause?.message) return `unreachable (${cause.message})`;
  return err instanceof Error ? err.message : String(err);
}

/** The reason a client call failed, without the response body. */
function reason(err: unknown): string {
  if (err instanceof PaperclipClientError) {
    return err.status === 0 ? err.body : `returned ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The base URL with any user:password removed, for printing. */
function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function heartbeatFlag(agent: PaperclipAgent, flag: "wakeOnDemand" | "enabled"): unknown {
  const rc = agent.runtimeConfig;
  if (typeof rc !== "object" || rc === null) return undefined;
  const hb = (rc as { heartbeat?: unknown }).heartbeat;
  if (typeof hb !== "object" || hb === null) return undefined;
  return (hb as Record<string, unknown>)[flag];
}

function flagCheck(
  name: "wake-on-demand" | "heartbeat-enabled",
  flag: "wakeOnDemand" | "enabled",
  agent: PaperclipAgent | undefined,
): DoctorResult {
  if (!agent) return { name, ok: false, detail: "agent not found" };
  const value = heartbeatFlag(agent, flag);
  if (value === false) return { name, ok: true, detail: "off" };
  const shown = value === undefined
    ? "unset (Paperclip treats it as on)"
    : JSON.stringify(value);
  return {
    name,
    ok: false,
    detail: `runtimeConfig.heartbeat.${flag} is ${shown}; run npm run paperclip:register to turn it off`,
  };
}

/** Run all six checks against `cfg`. Never throws. */
export async function diagnosePaperclip(cfg: PaperclipConfig, opts: DoctorOptions = {}): Promise<DoctorResult[]> {
  const timeoutMs = opts.timeoutMs ?? DOCTOR_TIMEOUT_MS;
  const fetchImpl = readOnlyFetch(opts.fetch ?? globalThis.fetch, timeoutMs);
  const url = displayUrl(cfg.url);
  const companyId = cfg.companyId ?? "";
  const agentId = cfg.agentId ?? "";
  const client = new PaperclipClient({ url: cfg.url, companyId, fetch: fetchImpl });
  const results: DoctorResult[] = [];

  // 1. health
  try {
    await client.health();
    results.push({ name: "health", ok: true, detail: `Paperclip at ${url} responds` });
  } catch (err) {
    results.push({ name: "health", ok: false, detail: `${url}/api/health ${reason(err)}` });
  }

  // 2. company. The agents list is fetched once and reused by check 3; it also
  // stands in for the company route on a Paperclip that has no such route.
  let agents: { ok: true; list: unknown } | { ok: false; why: string } | undefined;
  const loadAgents = async () => {
    if (agents) return agents;
    try {
      agents = { ok: true, list: await client.listAgents() };
    } catch (err) {
      agents = { ok: false, why: reason(err) };
    }
    return agents;
  };

  if (!companyId) {
    results.push({ name: "company", ok: false, detail: "no paperclip.companyId configured" });
  } else {
    try {
      await client.getCompany();
      results.push({ name: "company", ok: true, detail: `${companyId} exists` });
    } catch (err) {
      const fallback = err instanceof PaperclipClientError && err.status === 404 ? await loadAgents() : undefined;
      if (fallback?.ok) {
        results.push({ name: "company", ok: true, detail: `${companyId} exists (its agents list answers)` });
      } else {
        results.push({ name: "company", ok: false, detail: `GET /api/companies/${companyId} ${reason(err)}` });
      }
    }
  }

  // 3. agent-registered
  let agent: PaperclipAgent | undefined;
  if (!agentId) {
    results.push({
      name: "agent-registered",
      ok: false,
      detail: "no paperclip.agentId configured; run npm run paperclip:register",
    });
  } else if (!companyId) {
    results.push({ name: "agent-registered", ok: false, detail: "no paperclip.companyId to list agents in" });
  } else {
    const a = await loadAgents();
    if (!a.ok) {
      results.push({ name: "agent-registered", ok: false, detail: `GET /api/companies/${companyId}/agents ${a.why}` });
    } else if (!Array.isArray(a.list)) {
      results.push({ name: "agent-registered", ok: false, detail: "the agents list is not an array" });
    } else {
      agent = (a.list as PaperclipAgent[]).find((x) => x?.id === agentId);
      results.push(agent
        ? { name: "agent-registered", ok: true, detail: `${agentId} found` }
        : { name: "agent-registered", ok: false, detail: `${agentId} not in agents list` });
    }
  }

  // 4–5. Both wake paths must be off, or Paperclip may start runs for the Foreman.
  results.push(flagCheck("wake-on-demand", "wakeOnDemand", agent));
  results.push(flagCheck("heartbeat-enabled", "enabled", agent));

  // 6. config-complete: independent of Paperclip being reachable.
  const missing: string[] = [];
  if (cfg.enabled !== true) missing.push("enabled is not true");
  if (!companyId) missing.push("companyId is empty");
  if (!agentId) missing.push("agentId is empty");
  results.push(missing.length === 0
    ? { name: "config-complete", ok: true, detail: "enabled=true, companyId non-empty, agentId non-empty" }
    : { name: "config-complete", ok: false, detail: missing.join(", ") });

  return results;
}

export function formatDoctorResult(r: DoctorResult): string {
  return `${r.ok ? "PASS" : "FAIL"}: ${r.name} — ${r.detail}`;
}

/** Run the checks on `config.paperclip`, print one line each; true when all pass. */
export async function runDoctor(config: Pick<AgentConfig, "paperclip">, opts: DoctorOptions = {}): Promise<boolean> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const results = await diagnosePaperclip(config.paperclip, opts);
  for (const r of results) print(formatDoctorResult(r));
  return results.every((r) => r.ok);
}
