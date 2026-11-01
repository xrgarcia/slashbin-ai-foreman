// The gh CLI runner: retries transient failures, signals upstream limits, and
// runs as the Tech Lead identity when a review needs it.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { ghResource, recordGhCall, type GhResource } from "../gh-usage.js";
import { isUpstreamBlocked, setUpstreamProbe, signalUpstreamLimit, UpstreamBackoffError, type UpstreamProbeResult } from "../upstream-backoff.js";
import { formatGhError, invalidateSnapshotIfMutating } from "./cache.js";
import { backoffDelay, backoffSettings } from "../backoff.js";



/** Block the thread for `ms` without busy-waiting. Only hit on the rare retry
 *  path; keeps the gh() wrapper synchronous so no caller signature changes. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * A gh failure is *transient* (safe to retry) only when it's network/connectivity
 * or a server-side 5xx/timeout — NOT auth, 404, or 422 validation, which won't
 * improve on retry (those fall through to an immediate throw). Allowlist by design.
 * A host↔GitHub blip ("error connecting to api.github.com") was stalling the whole
 * fleet ("No work across all repos"); retrying absorbs it instead of erroring the cycle.
 */
export function isTransientGhError(err: unknown): boolean {
  const { message, stderr } = formatGhError(err);
  const blob = `${message}\n${stderr}`.toLowerCase();
  return (
    blob.includes("error connecting to api.github.com") ||
    blob.includes("timed out") || blob.includes("timeout") ||
    blob.includes("etimedout") || blob.includes("econnreset") ||
    blob.includes("enotfound") || blob.includes("eai_again") ||
    blob.includes("dial tcp") ||
    blob.includes("bad gateway") || blob.includes("service unavailable") ||
    blob.includes("http 502") || blob.includes("http 503") || blob.includes("http 504")
  );
}

/**
 * A rate-limit rejection is NOT transient — retrying it inside the same cycle
 * only spends more of an already-exhausted budget. It gets its own classifier
 * for one reason: so it is *nameable* in the log.
 *
 * 2026-07-30: the daemon emitted 22,466 of these in 24 hours (~1,100/hour,
 * unbroken for 21+ hours) and every one surfaced as a generic
 * "Failed to check for approved issues" — the same line a real outage prints.
 * A quota problem that is indistinguishable from a dead Foreman is a
 * diagnosability defect on top of the quota defect, so we label it explicitly.
 */
export function isRateLimitGhError(err: unknown): boolean {
  const { message, stderr } = formatGhError(err);
  const blob = `${message}\n${stderr}`.toLowerCase();
  return (
    blob.includes("api rate limit already exceeded") ||
    blob.includes("api rate limit exceeded") ||
    blob.includes("secondary rate limit") ||
    blob.includes("was submitted too quickly") ||
    blob.includes("http 429")
  );
}

/**
 * An expected refusal from `runGh` while the GitHub back-off is active — no gh
 * was spawned. Lookups log it at debug: a deliberate pause is not an outage
 * (2026-10-02: 330 ERROR lines in one morning, every one of them this).
 */
export function isBackoffRefusal(err: unknown): err is UpstreamBackoffError {
  return err instanceof UpstreamBackoffError;
}

/** The most output one gh call may return before it fails: 64 MiB. */
export const GH_MAX_BUFFER = 64 * 1024 * 1024;

/** execFileSync gh with retry+backoff on transient (network/5xx/timeout) failures. */
export function runGh(args: string[], cwd: string, token: string): string {
  // A limit is account-wide: while GitHub is backing off, spawning gh only
  // spends more of a spent quota. The module's own probe decides when to resume.
  if (isUpstreamBlocked("github")) throw new UpstreamBackoffError("GitHub back-off active");
  let lastErr: unknown;
  const retry = backoffSettings().gh;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      recordGhCall(args);
      return execFileSync("gh", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        // execFileSync's default is 1 MiB, and exceeding it fails the call as
        // ENOBUFS. The fleet-wide startup snapshot (github-state.ts, every open
        // PR body in 22 repos) crossed it on 2026-10-14: every gh read in every
        // repo failed from the restart on, and nothing ran.
        maxBuffer: GH_MAX_BUFFER,
        env: { ...process.env, GH_TOKEN: token },
      }).trim();
    } catch (err) {
      lastErr = err;
      if (isRateLimitGhError(err)) {
        // Deliberately not retried: the budget is already gone. Name it loudly
        // and once, then let the caller's own error path handle the cycle.
        console.warn(`[gh] RATE LIMIT EXHAUSTED — GitHub API quota is spent, skipping: gh ${args.slice(0, 3).join(" ")}`);
        const { message, stderr } = formatGhError(err);
        signalUpstreamLimit("github", stderr.split("\n")[0] || message.split("\n")[0], {
          token,
          resource: ghResource(args),
        });
        throw err;
      }
      if (attempt < retry.maxAttempts && isTransientGhError(err)) {
        const wait = backoffDelay(attempt, retry);
        const { message, stderr } = formatGhError(err);
        console.warn(`[gh] transient failure (attempt ${attempt}/${retry.maxAttempts}), retrying in ${wait}ms: ${stderr.split("\n")[0] || message}`);
        sleepSync(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `runGh` without blocking the event loop: the same back-off gate, retry on transient
 * failures and rate-limit handling, but `execFile` and a timer between attempts. For
 * work that runs beside the poll loop (a report posted after a verify pass).
 */
export async function runGhAsync(args: string[], cwd: string, token: string): Promise<string> {
  if (isUpstreamBlocked("github")) throw new UpstreamBackoffError("GitHub back-off active");
  let lastErr: unknown;
  const retry = backoffSettings().gh;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      recordGhCall(args);
      const { stdout } = await execFileAsync("gh", args, {
        cwd, encoding: "utf-8", timeout: 30_000, maxBuffer: GH_MAX_BUFFER, env: { ...process.env, GH_TOKEN: token },
      });
      return stdout.trim();
    } catch (err) {
      lastErr = err;
      if (isRateLimitGhError(err)) {
        console.warn(`[gh] RATE LIMIT EXHAUSTED — GitHub API quota is spent, skipping: gh ${args.slice(0, 3).join(" ")}`);
        const { message, stderr } = formatGhError(err);
        signalUpstreamLimit("github", stderr.split("\n")[0] || message.split("\n")[0], { token, resource: ghResource(args) });
        throw err;
      }
      if (attempt < retry.maxAttempts && isTransientGhError(err)) {
        const wait = backoffDelay(attempt, retry);
        const { message, stderr } = formatGhError(err);
        console.warn(`[gh] transient failure (attempt ${attempt}/${retry.maxAttempts}), retrying in ${wait}ms: ${stderr.split("\n")[0] || message}`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Async `gh` as the Foreman (see `gh`). */
export async function ghAsync(args: string[], cwd: string): Promise<string> {
  const foremanToken = process.env.FOREMAN_GITHUB_TOKEN;
  if (!foremanToken) throw new Error("FOREMAN_GITHUB_TOKEN not set — cannot operate as Foreman");
  invalidateSnapshotIfMutating(args);
  return runGhAsync(args, cwd, foremanToken);
}

/** Run gh CLI using the Foreman token (slashbin-foreman account). */
export function gh(args: string[], cwd: string): string {
  const foremanToken = process.env.FOREMAN_GITHUB_TOKEN;
  if (!foremanToken) throw new Error("FOREMAN_GITHUB_TOKEN not set — cannot operate as Foreman");
  invalidateSnapshotIfMutating(args);
  return runGh(args, cwd, foremanToken);
}

/**
 * Run gh CLI as the Tech Lead (slasbhin-techlead), for exactly two writes on a
 * sync PR the Foreman authored: the approval branch protection needs (the
 * Foreman cannot approve its own PR), and the merge, which must come from an
 * account Railway links to a workspace member or the dev deploy waits for a
 * manual approval. Every approval is the Tech Lead's; the EM coordinates
 * and does not review (Ray, 2026-10-10). A sync PR's head is `main`, so the
 * approval vouches for no new code.
 */
export function ghAsTechLead(args: string[], cwd: string): string {
  const token = process.env.TECHLEAD_GITHUB_KEY;
  if (!token) throw new Error("TECHLEAD_GITHUB_KEY not set — cannot approve or merge a sync PR");
  invalidateSnapshotIfMutating(args);
  return runGh(args, cwd, token);
}

interface RateResource {
  remaining?: number;
  reset?: number;
}

const PROBE_GRAPHQL = ["api", "graphql", "-f", "query={rateLimit{remaining resetAt}}"];

/**
 * Probe the bucket that tripped, with the token that tripped it — deliberately
 * NOT via `runGh` (which refuses while blocked) and not counted as usage.
 *  - graphql: `gh api graphql` rateLimit. Clears only on remaining > 0; on 0
 *    its resetAt bounds the next window. A refused probe lands in catch.
 *  - core (or unknown): `gh api rate_limit` resources.core, as before.
 * No stored token (ambient gh auth): probe with the ambient auth.
 * A probe that itself fails never clears; it extends on the computed window.
 */
export function probeGitHub(trip: { token?: string; resource?: GhResource }): UpstreamProbeResult {
  const env = trip.token ? { ...process.env, GH_TOKEN: trip.token } : { ...process.env };
  const opts = { encoding: "utf-8" as const, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], timeout: 30_000, env };
  try {
    if (trip.resource === "graphql") {
      const rl = JSON.parse(execFileSync("gh", PROBE_GRAPHQL, opts))?.data?.rateLimit;
      if (typeof rl?.remaining === "number" && rl.remaining > 0) return { clear: true };
      const parsed = typeof rl?.resetAt === "string" ? Date.parse(rl.resetAt) : NaN;
      return { clear: false, resetAtMs: Number.isFinite(parsed) ? parsed : undefined };
    }
    const core = JSON.parse(execFileSync("gh", ["api", "rate_limit"], opts))?.resources?.core as RateResource | undefined;
    if (typeof core?.remaining === "number" && core.remaining > 0) return { clear: true };
    return { clear: false, resetAtMs: typeof core?.reset === "number" ? core.reset * 1000 : undefined };
  } catch (err) {
    console.warn(`[upstream] GitHub rate_limit probe failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return { clear: false };
  }
}

// Every gh call that can trip the GitHub back-off runs through this module, so it
// is loaded whenever a GitHub window can end.
setUpstreamProbe("github", probeGitHub);
