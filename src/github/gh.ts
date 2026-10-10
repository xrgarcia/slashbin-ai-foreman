// The gh CLI runner: retries transient failures, signals upstream limits, and
// runs as the Tech Lead identity when a review needs it.

import { execFileSync } from "node:child_process";
import { ghResource, recordGhCall } from "../gh-usage.js";
import { isUpstreamBlocked, signalUpstreamLimit, UpstreamBackoffError } from "../upstream-backoff.js";
import { formatGhError, invalidateSnapshotIfMutating } from "./cache.js";


export const GH_MAX_ATTEMPTS = 3;
export const GH_BACKOFF_MS = [1000, 3000, 9000];

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

/** execFileSync gh with retry+backoff on transient (network/5xx/timeout) failures. */
export function runGh(args: string[], cwd: string, token: string): string {
  // A limit is account-wide: while GitHub is backing off, spawning gh only
  // spends more of a spent quota. The module's own probe decides when to resume.
  if (isUpstreamBlocked("github")) throw new UpstreamBackoffError("GitHub back-off active");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GH_MAX_ATTEMPTS; attempt++) {
    try {
      recordGhCall(args);
      return execFileSync("gh", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
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
      if (attempt < GH_MAX_ATTEMPTS && isTransientGhError(err)) {
        const wait = GH_BACKOFF_MS[attempt - 1];
        const { message, stderr } = formatGhError(err);
        console.warn(`[gh] transient failure (attempt ${attempt}/${GH_MAX_ATTEMPTS}), retrying in ${wait}ms: ${stderr.split("\n")[0] || message}`);
        sleepSync(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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
