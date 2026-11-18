import type { Logger } from "./logger.js";

/**
 * Per-interval accounting of spawned `gh` processes, by quota bucket.
 *
 * 2026-10-02: the Foreman spent ~4,770 GraphQL points an hour against a 5,000
 * cap while its startup estimate said 1,200, and nothing recorded which calls
 * spent it. Quota is spent per spawn, so `runGhAsync` counts immediately before
 * each `execFile` — a retried spawn counts twice, a refused call (back-off
 * active, nothing spawned) counts zero.
 *
 * A leaf module on purpose: `upstream-backoff.ts` imports `ghResource`, and
 * `github.ts` already imports from `upstream-backoff.ts`.
 */

export type GhResource = "graphql" | "core" | "search";

/**
 * `gh api <path>` is REST (core) unless the path is `graphql` or a `search/` endpoint; every other subcommand goes
 * over GraphQL. Search is its own bucket, 30 requests a minute (docs.github.com/en/rest/search/search#rate-limit).
 * 2026-11-18: a restart's burst of ~31 repo-record anchor searches tripped it every hour, and the trip was probed
 * and windowed as core, so a one-minute limit stopped every lane for an hour at a time.
 */
export function ghResource(args: string[]): GhResource {
  if (args[0] !== "api") return "graphql";
  const path = args.slice(1).find((a) => !a.startsWith("-") && a !== "GET" && a !== "POST" && a !== "PATCH" && a !== "PUT" && a !== "DELETE");
  if (path === "graphql") return "graphql";
  return path?.replace(/^\//, "").startsWith("search/") ? "search" : "core";
}

/** Process-wide: the gh call counters measure the process's one GitHub token budget. */
let counts = { graphql: 0, core: 0, search: 0 };
/** Process-wide: per-subcommand gh counts for the same process-wide budget. */
let bySubcommand: Record<string, number> = {};
/** Process-wide: REST calls by normalised endpoint, so an hour's core spend can be attributed. */
let byEndpoint: Record<string, number> = {};
/** Process-wide: every call by endpoint (REST) or subcommand, and the code that made it. */
let byCaller: Record<string, number> = {};
/** Process-wide: the one usage-report timer. */
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The endpoint of a REST `gh api` call with every id stripped, e.g.
 * `GET repos/:repo/issues/:n/comments`. 2026-11-14: the change-signal deploy cut
 * GraphQL state points 75% but left ~3,900 REST calls/hr that the hourly line
 * could only call "api rest"; attribution had to be modelled from code.
 */
export function restEndpointKey(args: string[]): string {
  let method = "GET";
  let path = "";
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--method") { method = (args[++i] ?? "GET").toUpperCase(); continue; }
    if (a.startsWith("-")) { if (!a.includes("=") && i + 1 < args.length && /^-(f|F|H|q|t|-field|-raw-field|-header|-jq|-template|-input|-cache)$/.test(a)) i++; continue; }
    if (!path) path = a;
  }
  const norm = path.replace(/^\//, "").split("?")[0]
    .replace(/^repos\/[^/]+\/[^/]+/, "repos/:repo")
    .replace(/\/compare\/.+$/, "/compare/:range")
    .replace(/\/(git\/(?:refs|ref)\/heads|branches)\/.+$/, "/$1/:ref")
    .split("/").map((seg) => (/^\d+$/.test(seg) ? ":n" : /^[0-9a-f]{40}$/.test(seg) ? ":sha" : seg)).join("/");
  return `${method} ${norm || "?"}`;
}

/** Frames that only relay a call, so they never name who made it. */
const RELAY = /[\\/](gh-usage|gh|code-host|plugins[\\/]github|github)\.(js|ts)\b|node:|node_modules/;

/**
 * Who made a call: the first two frames outside the gh relay, as `file:fn`.
 * 2026-11-14: six readers share `GET issues/:n/comments`; caching the one guessed
 * from code cut nothing (2,536 to 2,374/hr), because the endpoint alone could not
 * say which reader was hot.
 */
export function callerKey(stack: string | undefined): string {
  const frames: string[] = [];
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const m = line.match(/at (?:async )?(?:(\S+) \()?(?:file:\/\/)?([^():]+):\d+:\d+\)?\s*$/);
    if (!m || RELAY.test(m[2])) continue;
    const file = m[2].split(/[\\/]/).slice(-2).join("/").replace(/\.(js|ts)$/, "");
    frames.push(`${file}:${(m[1] ?? "?").replace(/^Object\./, "")}`);
    if (frames.length === 2) break;
  }
  return frames.join(" < ") || "?";
}

/** Count one spawned `gh` process. */
export function recordGhCall(args: string[]): void {
  counts[ghResource(args)]++;
  const rest = args[0] === "api" && args[1] !== "graphql";
  const key = rest ? "api rest" : `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
  bySubcommand[key] = (bySubcommand[key] ?? 0) + 1;
  const what = rest ? restEndpointKey(args) : key;
  if (rest) byEndpoint[what] = (byEndpoint[what] ?? 0) + 1;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 25;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  const c = `${what} <- ${callerKey(stack)}`;
  byCaller[c] = (byCaller[c] ?? 0) + 1;
}

/** The busiest REST endpoints, highest first, capped so the hourly line stays one readable line. */
function topEndpoints(limit = 15, from: Record<string, number> = byEndpoint): Record<string, number> {
  return Object.fromEntries(Object.entries(from).sort((a, b) => b[1] - a[1]).slice(0, limit));
}

/** Current counters without resetting them. */
export function ghUsageSnapshot(): { total: number; graphql: number; core: number; search: number; bySubcommand: Record<string, number> } {
  return { total: counts.graphql + counts.core + counts.search, ...counts, bySubcommand: { ...bySubcommand } };
}

/**
 * Log one info summary per interval and reset the counters. Emitted even at
 * total 0 — a zero hour is the signature of a back-off. The default (never
 * configured) is count-only, no log.
 */
export function configureGhUsage(opts: { intervalMs: number; logger: Logger; extra?: () => Record<string, unknown> }): void {
  if (timer) clearInterval(timer);
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 3_600_000;
  timer = setInterval(() => {
    const snap = ghUsageSnapshot();
    // Stringified: the text log format prints a nested object as [object Object],
    // which is how the first hourly line (2026-10-02 13:24) lost its breakdown.
    opts.logger.info("gh-usage: gh calls in the last interval", {
      intervalMs, ...snap, bySubcommand: JSON.stringify(snap.bySubcommand),
      restByEndpoint: JSON.stringify(topEndpoints()), byCaller: JSON.stringify(topEndpoints(15, byCaller)), ...(opts.extra?.() ?? {}),
    });
    counts = { graphql: 0, core: 0, search: 0 };
    bySubcommand = {};
    byEndpoint = {};
    byCaller = {};
  }, intervalMs);
  timer.unref?.();
}
