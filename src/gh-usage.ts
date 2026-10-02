import type { Logger } from "./logger.js";

/**
 * Per-interval accounting of spawned `gh` processes, by quota bucket.
 *
 * 2026-10-02: the Foreman spent ~4,770 GraphQL points an hour against a 5,000
 * cap while its startup estimate said 1,200, and nothing recorded which calls
 * spent it. Quota is spent per spawn, so `runGh` counts immediately before
 * each `execFileSync` — a retried spawn counts twice, a refused call (back-off
 * active, nothing spawned) counts zero.
 *
 * A leaf module on purpose: `upstream-backoff.ts` imports `ghResource`, and
 * `github.ts` already imports from `upstream-backoff.ts`.
 */

export type GhResource = "graphql" | "core";

/** `gh api <path>` is REST (core) unless the path is `graphql`; every other subcommand goes over GraphQL. */
export function ghResource(args: string[]): GhResource {
  if (args[0] === "api") return args[1] === "graphql" ? "graphql" : "core";
  return "graphql";
}

let counts = { graphql: 0, core: 0 };
let bySubcommand: Record<string, number> = {};
let timer: ReturnType<typeof setInterval> | null = null;

/** Count one spawned `gh` process. */
export function recordGhCall(args: string[]): void {
  counts[ghResource(args)]++;
  const key = args[0] === "api" && args[1] !== "graphql" ? "api rest" : `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
  bySubcommand[key] = (bySubcommand[key] ?? 0) + 1;
}

/** Current counters without resetting them. */
export function ghUsageSnapshot(): { total: number; graphql: number; core: number; bySubcommand: Record<string, number> } {
  return { total: counts.graphql + counts.core, ...counts, bySubcommand: { ...bySubcommand } };
}

/**
 * Log one info summary per interval and reset the counters. Emitted even at
 * total 0 — a zero hour is the signature of a back-off. The default (never
 * configured) is count-only, no log.
 */
export function configureGhUsage(opts: { intervalMs: number; logger: Logger }): void {
  if (timer) clearInterval(timer);
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 3_600_000;
  timer = setInterval(() => {
    opts.logger.info("gh-usage: gh calls in the last interval", { intervalMs, ...ghUsageSnapshot() });
    counts = { graphql: 0, core: 0 };
    bySubcommand = {};
  }, intervalMs);
  timer.unref?.();
}
