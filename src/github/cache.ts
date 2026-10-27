// Per-cycle read caches: the open-issue and open-PR snapshots, and keyed deep reads.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import {
  closedVersion, isGitHubStateEnabled, markAllDirty, markRepoDirty, stateOpenIssues, stateOpenPrs,
} from "../github-state.js";
import { gh } from "./gh.js";


// ---------------------------------------------------------------------------
// Open-issue snapshot: one `gh issue list` per repo per cycle
// ---------------------------------------------------------------------------

/**
 * The six discovery lookups in this file (`approved` ×2, `pr under review` ×2,
 * `pr pending actions`, `ready for prod release`) each used to issue their own
 * `gh issue list --state open` against the SAME repo. Every `gh issue list`
 * spends a GraphQL request, and GraphQL is capped at 5,000/hour per token.
 *
 * 2026-07-30: 20 repos × ~6 lookups × a 60s poll interval ≈ 7,200 GraphQL
 * calls/hour against that 5,000 ceiling. The Foreman token sat permanently
 * exhausted — 22,466 rejections in 24 hours — so roughly one lookup in six
 * failed outright. A failed lookup silently skips that phase for that repo
 * that cycle: an `approved` issue goes unimplemented, a
 * `ready for prod release` unpromoted, recovering only on a later cycle that
 * happens to win the quota race.
 *
 * The fix is that all six lookups are label subsets of ONE query. We fetch
 * `--state open` once per repo, cache it briefly, and filter in memory:
 * 6 calls → 1 (≈1,200/hour, comfortably inside budget) with the poll interval
 * left where operations wants it at 60s. Fetching every open issue instead of
 * a label-filtered slice costs no extra requests — the request count is driven
 * by pages, not by predicates.
 *
 * Correctness: the snapshot is dropped whenever the Foreman mutates an issue in
 * that repo (see `invalidateSnapshotIfMutating`), so a label written by an
 * earlier phase is never read back stale later in the same cycle. A label
 * changed EXTERNALLY — the EM applying `approved` — is picked up on the next
 * refresh, i.e. at worst one TTL late, which is a delay the poll interval
 * already implies.
 *
 * Additive and OSS-safe: `issueCacheTtlMs: 0` restores the old behaviour of one
 * live query per lookup.
 */
export interface IssueSnapshot {
  number: number;
  title: string;
  labels: { name: string }[];
}

export const DEFAULT_ISSUE_CACHE_TTL_MS = 30_000;
export const DEFAULT_ISSUE_SNAPSHOT_LIMIT = 500;

export let issueCacheTtlMs = DEFAULT_ISSUE_CACHE_TTL_MS;
export let issueSnapshotLimit = DEFAULT_ISSUE_SNAPSHOT_LIMIT;
export const issueSnapshots = new Map<string, { fetchedAt: number; issues: IssueSnapshot[] }>();

/**
 * Apply daemon-level cache settings. Called once at startup; defaults stand if
 * it is never called, so nothing downstream has to know this exists.
 */
export function configureIssueCache(opts: { ttlMs?: number; snapshotLimit?: number }): void {
  if (typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0) {
    issueCacheTtlMs = opts.ttlMs;
  }
  if (typeof opts.snapshotLimit === "number" && Number.isFinite(opts.snapshotLimit) && opts.snapshotLimit > 0) {
    issueSnapshotLimit = Math.floor(opts.snapshotLimit);
  }
  issueSnapshots.clear();
  prSnapshots.clear();
}

/**
 * Drop a repo's cached snapshot when a command mutates issue state, so a later
 * phase re-reads what this cycle just wrote. Keyed off the `--repo` argument;
 * `list`/`view` are reads and left alone.
 */
export function invalidateSnapshotIfMutating(args: string[]): void {
  const repoIdx = args.indexOf("--repo");
  const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;

  // `gh api --method POST/PATCH/PUT/DELETE` can label, merge, or retarget
  // anything, and the URL shape varies too much to attribute reliably. Clear
  // everything — conservative, and a cache miss only costs one request.
  const methodIdx = args.indexOf("--method");
  if (args[0] === "api" && methodIdx >= 0 && args[methodIdx + 1] !== "GET") {
    issueSnapshots.clear();
    prSnapshots.clear();
    const m = /^repos\/([^/]+\/[^/]+)\//.exec(args.find((a) => a.startsWith("repos/")) ?? "");
    if (m) markRepoDirty(m[1]);
    else markAllDirty();
    return;
  }

  if (!repo) return;

  // Read-only subcommands leave state alone; everything else may change it.
  const READ_ONLY = new Set(["list", "view", "diff", "checks", "status"]);
  if (READ_ONLY.has(args[1])) return;

  markRepoDirty(repo);
  if (args[0] === "issue") issueSnapshots.delete(repo);
  // A PR merge closes the PR *and* moves the issue labels that track it, so a
  // `pr` mutation has to drop both — otherwise a later phase this cycle reads a
  // merged PR back as open.
  if (args[0] === "pr") {
    prSnapshots.delete(repo);
    issueSnapshots.delete(repo);
  }
}

/**
 * Force the next `getOpenIssues(repo)` to hit the network.
 *
 * `invalidateSnapshotIfMutating` only sees the Foreman's OWN `gh` calls. The
 * review phase runs in a SEPARATE Claude process, so every label it writes is
 * invisible to this cache — read back inside the TTL, an issue the review just
 * advanced still looks like it never moved. Any check that reads labels a
 * foreign process may have just written must drop the snapshot first.
 */
export function dropIssueSnapshot(repo: string): void {
  issueSnapshots.delete(repo);
  markRepoDirty(repo);
}

/**
 * Each open issue's number and label names, from the same cache as every other
 * read. What observers mirror the board from: GitHub is the record, so a card
 * that drifted from it is put back on the next cycle.
 */
export function openIssueLabels(config: RepoConfig, logger: Logger): Array<{ number: number; labels: string[] }> {
  return getOpenIssues(config.githubRepo, config.repoPath, logger).map((i) => ({ number: i.number, labels: i.labels.map((l) => l.name) }));
}

/** Every open issue in the repo, from cache when warm. */
export function getOpenIssues(repo: string, cwd: string, logger: Logger): IssueSnapshot[] {
  // The fleet-wide state (github-state.ts) answers for every configured repo
  // from one bulk query. `issueCacheTtlMs: 0` still means "always live".
  if (issueCacheTtlMs > 0 && isGitHubStateEnabled(repo)) return stateOpenIssues(repo);

  const cached = issueSnapshots.get(repo);
  if (cached && issueCacheTtlMs > 0 && Date.now() - cached.fetchedAt < issueCacheTtlMs) {
    return cached.issues;
  }

  const json = gh([
    "issue", "list",
    "--repo", repo,
    "--state", "open",
    "--json", "number,title,labels",
    "--limit", String(issueSnapshotLimit),
  ], cwd);
  const issues: IssueSnapshot[] = JSON.parse(json || "[]");

  // No silent caps. Hitting the limit means discovery may be blind to issues it
  // is supposed to see, which would look exactly like "no work to do".
  if (issues.length >= issueSnapshotLimit) {
    logger.warn(
      "Open-issue snapshot hit its limit — discovery may be missing issues; raise issueSnapshotLimit",
      { repo, limit: issueSnapshotLimit, returned: issues.length },
    );
  }

  if (issueCacheTtlMs > 0) issueSnapshots.set(repo, { fetchedAt: Date.now(), issues });
  return issues;
}

/** True when `issue` carries a label named `name`. */
export function hasLabel(issue: IssueSnapshot, name: string): boolean {
  return issue.labels.some((l) => l.name === name);
}

/**
 * The same collapse for OPEN pull requests, and for the same reason.
 *
 * Roughly three `gh pr list --state open` calls run per repo per cycle no matter
 * whether there is any work — the reconcile phase's sync-PR check
 * (`develop ← main`), the promote phase's open-promotion-PR check
 * (`main ← develop`), and the review phase's orphan-adoption probe, which runs
 * precisely when there is nothing to review, i.e. most cycles. Each spends a
 * GraphQL request. At 20 repos on a 60s interval that is ~3,600/hour on its own,
 * and it is why collapsing the issue lookups alone left the token at 5,279/hour
 * against a 5,000 ceiling — measured, after that first fix.
 *
 * Every one of those calls is a `--head`/`--base` slice of "open PRs in this
 * repo", so they share one snapshot and filter in memory.
 *
 * Deliberately NOT served from here: `--state merged` queries (a different set)
 * and the one call that needs `files` (a per-PR file list, far heavier than the
 * scalar fields below). Those stay live.
 */
export interface PrSnapshot {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
}

export const prSnapshots = new Map<string, { fetchedAt: number; prs: PrSnapshot[] }>();

/**
 * Drop what the Foreman holds about `repo`'s open PRs, so the next read asks
 * GitHub. A session runs `gh pr create` in its own process, which the
 * mutation hook in `gh()` never sees: without this, the check that the
 * session's PR exists read the list cached before it, found nothing, and
 * booked a built PR as "PR creation could not be verified"
 * (slashbin_mcp_services PR #240, 2026-10-09).
 */
export function forgetOpenPrs(repo: string): void {
  prSnapshots.delete(repo);
  markRepoDirty(repo);
}

/** Every open PR in the repo, from cache when warm. */
export function getOpenPrs(repo: string, cwd: string): PrSnapshot[] {
  if (issueCacheTtlMs > 0 && isGitHubStateEnabled(repo)) return stateOpenPrs(repo);

  const cached = prSnapshots.get(repo);
  if (cached && issueCacheTtlMs > 0 && Date.now() - cached.fetchedAt < issueCacheTtlMs) {
    return cached.prs;
  }

  const json = gh([
    "pr", "list",
    "--repo", repo,
    "--state", "open",
    "--json", "number,url,title,body,headRefName,baseRefName",
    "--limit", "100",
  ], cwd);
  const prs: PrSnapshot[] = JSON.parse(json || "[]");

  if (issueCacheTtlMs > 0) prSnapshots.set(repo, { fetchedAt: Date.now(), prs });
  return prs;
}

/**
 * Whether PR #`prNumber` is still open, from the same per-cycle snapshot every
 * other open-PR question reads — so asking costs no `gh` call when it is warm.
 * Null when it cannot say: the list failed, or it is full (`--limit 100`), where
 * a missing PR may just be past the page.
 */
export function isPrOpen(repo: string, prNumber: number, cwd: string): boolean | null {
  try {
    const prs = getOpenPrs(repo, cwd);
    if (prs.some((p) => p.number === prNumber)) return true;
    return prs.length >= 100 ? null : false;
  } catch {
    return null;
  }
}

/**
 * Open PRs matching a head/base pair, newest first — the shape the old
 * `--head X --base Y --limit N` calls returned.
 */
export function findOpenPrs(
  repo: string,
  cwd: string,
  opts: { head?: string; base?: string; limit?: number },
): PrSnapshot[] {
  const matches = getOpenPrs(repo, cwd).filter(
    (p) =>
      (opts.head === undefined || p.headRefName === opts.head) &&
      (opts.base === undefined || p.baseRefName === opts.base),
  );
  return opts.limit === undefined ? matches : matches.slice(0, opts.limit);
}

/**
 * The open `head → base` PR the fleet state already knows about, or undefined
 * when the state is off or has none. Undefined is "ask GitHub", never "no PR":
 * a session the Foreman just ran may have opened one the state has not seen yet,
 * and a caller that reads absence as "no PR" would open a duplicate.
 */
export function knownOpenPr(
  repo: string,
  head: string,
  base: string,
): { number: number; url: string; headRefOid: string } | undefined {
  if (issueCacheTtlMs <= 0 || !isGitHubStateEnabled(repo)) return undefined;
  const pr = stateOpenPrs(repo).find((p) => p.headRefName === head && p.baseRefName === base);
  return pr ? { number: pr.number, url: pr.url, headRefOid: pr.headRefOid } : undefined;
}

/**
 * Deep reads keyed on what the fleet state says about the repo, so they repeat
 * only when the thing they read can have changed. `key` returns null when the
 * state cannot vouch (off, or the PR is not in it) — then the read is live.
 */
export const deepReadCache = new Map<string, { key: string; json: string }>();

export function ghKeyed(id: string, key: () => string | null, args: string[], cwd: string): string {
  let k: string | null = null;
  try { k = key(); } catch { k = null; }
  if (k !== null) {
    const hit = deepReadCache.get(id);
    if (hit && hit.key === k) return hit.json;
  }
  const json = gh(args, cwd);
  if (k !== null) deepReadCache.set(id, { key: k, json });
  return json;
}

/** The open `head → base` PR's head commit and last update, or null when the state cannot say. */
export function openPrVersion(repo: string, head: string, base: string): string | null {
  if (issueCacheTtlMs <= 0 || !isGitHubStateEnabled(repo)) return null;
  const pr = stateOpenPrs(repo).find((p) => p.headRefName === head && p.baseRefName === base);
  return pr ? `${pr.number}:${pr.headRefOid}@${pr.updatedAt}` : null;
}

/** Changes whenever a PR in the repo was seen merged or closed, or null when the state is off. */
export function closedPrVersion(repo: string): string | null {
  if (issueCacheTtlMs <= 0 || !isGitHubStateEnabled(repo)) return null;
  return String(closedVersion(repo));
}

/**
 * Extract the actionable bits of a thrown gh CLI error so callers can log
 * something useful instead of swallowing the failure. execFileSync attaches
 * `stderr` (Buffer) and `status` (exit code) to the Error it throws.
 */
export interface GhFailure {
  message: string;
  stderr: string;
  status: number | null;
}

export function formatGhError(err: unknown): GhFailure {
  const e = err as Error & { stderr?: Buffer | string; status?: number | null };
  const stderr =
    typeof e?.stderr === "string"
      ? e.stderr
      : e?.stderr?.toString() ?? "";
  return {
    message: e?.message ?? String(err),
    stderr: stderr.trim(),
    status: e?.status ?? null,
  };
}
