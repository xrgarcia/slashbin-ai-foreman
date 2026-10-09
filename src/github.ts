import { execFileSync } from "node:child_process";
import type { AgentConfig, LifecycleLabels, RepoConfig } from "./config.js";
import type { PriorState, WorkItem, WorkSourceAdapter, WorkState } from "./adapters.js";
import type { Logger } from "./logger.js";
import { ghResource, recordGhCall } from "./gh-usage.js";
import { isUpstreamBlocked, signalUpstreamLimit, UpstreamBackoffError } from "./upstream-backoff.js";
import {
  closedVersion, isGitHubStateEnabled, markAllDirty, markRepoDirty, stateOpenIssues, stateOpenPrs,
} from "./github-state.js";

const GH_MAX_ATTEMPTS = 3;
const GH_BACKOFF_MS = [1000, 3000, 9000];

/** Block the thread for `ms` without busy-waiting. Only hit on the rare retry
 *  path; keeps the gh() wrapper synchronous so no caller signature changes. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * A gh failure is *transient* (safe to retry) only when it's network/connectivity
 * or a server-side 5xx/timeout — NOT auth, 404, or 422 validation, which won't
 * improve on retry (those fall through to an immediate throw). Allowlist by design.
 * A host↔GitHub blip ("error connecting to api.github.com") was stalling the whole
 * fleet ("No work across all repos"); retrying absorbs it instead of erroring the cycle.
 */
function isTransientGhError(err: unknown): boolean {
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
function isRateLimitGhError(err: unknown): boolean {
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
function isBackoffRefusal(err: unknown): err is UpstreamBackoffError {
  return err instanceof UpstreamBackoffError;
}

/** execFileSync gh with retry+backoff on transient (network/5xx/timeout) failures. */
function runGh(args: string[], cwd: string, token: string): string {
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

/** Run gh CLI using the EM token (slashbin-engineering-manager account). */
function ghAsEM(args: string[], cwd: string): string {
  const emToken = process.env.EM_GITHUB_TOKEN;
  if (!emToken) throw new Error("EM_GITHUB_TOKEN not set — cannot approve/merge as EM");
  invalidateSnapshotIfMutating(args);
  return runGh(args, cwd, emToken);
}

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
interface IssueSnapshot {
  number: number;
  title: string;
  labels: { name: string }[];
}

const DEFAULT_ISSUE_CACHE_TTL_MS = 30_000;
const DEFAULT_ISSUE_SNAPSHOT_LIMIT = 500;

let issueCacheTtlMs = DEFAULT_ISSUE_CACHE_TTL_MS;
let issueSnapshotLimit = DEFAULT_ISSUE_SNAPSHOT_LIMIT;
const issueSnapshots = new Map<string, { fetchedAt: number; issues: IssueSnapshot[] }>();

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
function invalidateSnapshotIfMutating(args: string[]): void {
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
function getOpenIssues(repo: string, cwd: string, logger: Logger): IssueSnapshot[] {
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
function hasLabel(issue: IssueSnapshot, name: string): boolean {
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
interface PrSnapshot {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
}

const prSnapshots = new Map<string, { fetchedAt: number; prs: PrSnapshot[] }>();

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
function getOpenPrs(repo: string, cwd: string): PrSnapshot[] {
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
function findOpenPrs(
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
const deepReadCache = new Map<string, { key: string; json: string }>();

function ghKeyed(id: string, key: () => string | null, args: string[], cwd: string): string {
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
function openPrVersion(repo: string, head: string, base: string): string | null {
  if (issueCacheTtlMs <= 0 || !isGitHubStateEnabled(repo)) return null;
  const pr = stateOpenPrs(repo).find((p) => p.headRefName === head && p.baseRefName === base);
  return pr ? `${pr.number}:${pr.headRefOid}@${pr.updatedAt}` : null;
}

/** Changes whenever a PR in the repo was seen merged or closed, or null when the state is off. */
function closedPrVersion(repo: string): string | null {
  if (issueCacheTtlMs <= 0 || !isGitHubStateEnabled(repo)) return null;
  return String(closedVersion(repo));
}

/**
 * Extract the actionable bits of a thrown gh CLI error so callers can log
 * something useful instead of swallowing the failure. execFileSync attaches
 * `stderr` (Buffer) and `status` (exit code) to the Error it throws.
 */
interface GhFailure {
  message: string;
  stderr: string;
  status: number | null;
}

function formatGhError(err: unknown): GhFailure {
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

/** Most issues in the Foreman's own per-pass discovery batch (see discoveryBatch). */
const MAX_BATCH_SIZE = 3;

/**
 * Extract the issue numbers a PR actually IMPLEMENTS (closes/relates), as
 * opposed to merely mentions in prose. An issue counts as implemented when:
 *   - it appears after a closing/relating keyword (Closes/Fixes/Resolves/
 *     Related to/Refs/See #N) anywhere in title, body, or commit messages, OR
 *   - it appears as a `(#N)` suffix in the PR TITLE or a commit HEADLINE
 *     (the canonical `feat: foo (#N)` form).
 *
 * A bare `#N`, or a `(#N)` mention in the free-text BODY (e.g.
 * "tracked separately in #3", "the forthcoming handler (#2)"), does NOT
 * count — those are forward references to sibling issues, not implementations.
 * Counting them orphaned cmneb_public_api #2/#3 (slashbin-ai-foreman#28):
 * a schema PR's body mentioning the not-yet-built endpoint issue marked that
 * issue "implemented"/"covered", so it was never picked up.
 */
export function extractImplementedIssues(opts: {
  title?: string;
  body?: string;
  commitHeadlines?: string[];
  commitBodies?: string[];
  /**
   * STRICT mode — accept only *closing* keywords (`closes`/`fixes`/`resolves`),
   * dropping the weak affinity keywords (`related to`, `refs`, `see`).
   *
   * Default (false) is the historical predicate, correct for the PR-labeling path
   * where the consequence is merely ADDING `pr under review` — over-matching there
   * is cheap and recoverable.
   *
   * Strict is required by any TERMINAL transition (one that strips the trigger
   * label and declares work done), where a false positive permanently marks
   * unbuilt work as complete. "Related to #N" is not a claim of implementation —
   * and the Foreman's OWN reconciler writes `- Related to #N` into every recovery
   * PR body (reconciler.ts), so the loose predicate would terminally close issues
   * nobody built. That is slashbin-ai-foreman#28's bug with a worse blast radius.
   */
  strict?: boolean;
}): number[] {
  const { title = "", body = "", commitHeadlines = [], commitBodies = [], strict = false } = opts;
  const keywordRe = strict
    ? /\b(?:closes?|fixes?|resolves?)\s*:?\s*#(\d+)/gi
    : /\b(?:related\s+to|closes?|fixes?|resolves?|refs?|see)\s*:?\s*#(\d+)/gi;
  const suffixRe = /\(#(\d+)\)/g;
  const found = new Set<number>();

  // Keyword references are explicit intent — authoritative anywhere.
  const keywordText = [title, body, ...commitHeadlines, ...commitBodies].join("\n");
  for (const m of keywordText.matchAll(keywordRe)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) found.add(n);
  }
  // `(#N)` suffix is authoritative ONLY in the title or a commit headline —
  // never the free-text body, where it is a prose mention of a sibling issue.
  const suffixText = [title, ...commitHeadlines].join("\n");
  for (const m of suffixText.matchAll(suffixRe)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) found.add(n);
  }
  return Array.from(found).sort((a, b) => a - b);
}

/**
 * The Foreman's own discovery batch, cut from the work a source offered:
 * ascending (lowest numbers — dependencies — first), capped at MAX_BATCH_SIZE,
 * 1 on a greenfield repo. This is what the orchestrator acts on per issue
 * (run gate, inline prompt, batch-wide skip, labeling fallback). It is NOT what
 * a skill is handed: a skill chooses by priority across every offered item,
 * and capping that list would hide a high-priority issue behind three older ones.
 */
export function discoveryBatch(config: RepoConfig, offered: number[], logger: Logger): number[] {
  if (offered.length === 0) return [];
  // Sort ascending so lowest issue numbers (dependencies) come first
  const uncovered = [...offered].sort((a, b) => a - b);

  // Greenfield detection: if repo has very few tracked files, limit to 1 issue
  // The skill implements one-at-a-time anyway, but a focused prompt is more reliable
  let effectiveBatchSize = MAX_BATCH_SIZE;
  try {
    const fileCount = gh(["ls-files", "--cached"], config.repoPath).split("\n").filter(Boolean).length;
    if (fileCount < 10) {
      effectiveBatchSize = 1;
      logger.info(`Greenfield repo detected (${fileCount} files) — limiting to 1 issue per cycle`);
    }
  } catch { /* ignore — use default batch size */ }

  const batch = uncovered.slice(0, effectiveBatchSize);
  if (uncovered.length > MAX_BATCH_SIZE) {
    logger.info(`Found ${uncovered.length} actionable issue(s), capping batch to ${MAX_BATCH_SIZE}: ${batch.map(n => `#${n}`).join(", ")} (${uncovered.length - MAX_BATCH_SIZE} deferred to next cycle)`);
  } else {
    logger.info(`Found ${uncovered.length} actionable issue(s) with no linked PR: ${batch.map(n => `#${n}`).join(", ")}`);
  }
  return batch;
}

/**
 * GitHub issues as a work source — the first `WorkSourceAdapter` connector.
 *
 * `selectWork` is everything this source offers the implement stage: open
 * issues carrying the trigger label, not `blocked`, in no lifecycle state,
 * implemented by no open or merged PR — uncapped, in `gh issue list` order.
 * The orchestrator cuts its own capped `discoveryBatch` from it, and hands the
 * whole offer (less backed-off issues) to a skill.
 *
 * `selectEligible` is the same filter WITHOUT the PR cross-check and the cap —
 * every issue a session could still be asked to build. It is GitHub-specific
 * bookkeeping (label widening after a run, the review checkout's queue count),
 * not part of the adapter contract.
 *
 * Reporting is issue labels. `reportState` writes exactly the `gh issue edit`
 * each transition wrote before it moved behind the adapter. `claim`,
 * `reportPrLink` and `reportBlocked` write nothing on GitHub: the PR body's
 * `Related to #N` already carries the link and the implement agent writes the
 * skip comment itself — a write here would change what GitHub sees.
 *
 * Never sets `ready for prod release`: that label is the EM outcome-gate's
 * signature (separation of duties, 2026-07-27), and `WorkState` has no member
 * that maps to it. Putting a gate back that a review removed (`restoreEmGate`)
 * is code-host logic and stays outside the connector.
 *
 * Stateless: construct one where it is used.
 */
/** repo → the covered issue set last announced by implement's "all have linked PRs" skip. */
const coveredSkipAnnounced = new Map<string, string>();

export class GitHubIssueConnector implements WorkSourceAdapter {
  async selectWork(repoConfig: RepoConfig, _config: AgentConfig, logger: Logger): Promise<WorkItem[]> {
    return this.selectUncovered(repoConfig, logger).map((n) => ({ issueNumber: n, repo: repoConfig.githubRepo }));
  }

  async claim(_item: WorkItem, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {}

  async reportPrLink(_item: WorkItem, _prUrl: string, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {}

  async reportBlocked(_item: WorkItem, _reason: string, _repoConfig: RepoConfig, _logger: Logger): Promise<void> {}

  async reportState(
    item: WorkItem,
    from: PriorState,
    to: WorkState,
    repoConfig: RepoConfig,
    logger: Logger,
  ): Promise<boolean> {
    const n = item.issueNumber;
    switch (`${from}→${to}`) {
      case "new→inReview": return this.implementationDone(repoConfig, n, logger);
      case "changesRequested→inReview": return this.revisionDone(repoConfig, n, logger);
      case "inReview→approved": return this.reviewOutcome(repoConfig, n, "prApproved", logger);
      case "inReview→merged": return this.reviewOutcome(repoConfig, n, "prMerged", logger);
      case "merged→approved": return this.verifyPassed(repoConfig, n, logger);
      case "inReview→changesRequested": return this.reviewOutcome(repoConfig, n, "prPendingActions", logger);
      case "new→approved": return this.alreadyMerged(repoConfig, n, "prApproved", logger);
      case "new→merged": return this.alreadyMerged(repoConfig, n, "prMerged", logger);
      case "unknown→approved": return this.deadZoneResolve(repoConfig, n, "pass", logger);
      case "unknown→changesRequested": return this.deadZoneResolve(repoConfig, n, "fail", logger);
      case "unknown→merged": return this.deadZoneResolve(repoConfig, n, "merged", logger);
      case "unknown→queued": return this.orphanRelease(repoConfig, n, logger);
      default:
        logger.warn(`GitHub work source: no transition ${String(from)} → ${String(to)} for #${n} — nothing written`);
        return false;
    }
  }

  /**
   * After a successful implementation (or a reconciliation PR): add
   * `prUnderReview` so the EM knows a PR is ready for review.
   */
  private implementationDone(config: RepoConfig, num: number, logger: Logger): boolean {
    const labels = config.lifecycleLabels;
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--add-label", labels.prUnderReview,
      ], config.repoPath);
      logger.info(`Added "${labels.prUnderReview}" to issue #${num} after implementation`);
      return true;
    } catch (err) {
      logger.warn(`Failed to add "${labels.prUnderReview}" on #${num}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** After a successful revision: remove `prPendingActions`, add `prUnderReview`. */
  private revisionDone(config: RepoConfig, num: number, logger: Logger): boolean {
    const labels = config.lifecycleLabels;
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--remove-label", labels.prPendingActions,
        "--add-label", labels.prUnderReview,
      ], config.repoPath);
      logger.info(`Transitioned issue #${num} labels: "${labels.prPendingActions}" → "${labels.prUnderReview}"`);
      return true;
    } catch (err) {
      logger.warn(`Failed to transition labels on #${num}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Move an issue out of `pr under review` into a review outcome: the outcome
   * its own review run reported (written immediately after that run), or
   * `pr pending actions` when red CI bounces the PR back to revise.
   *
   * Why the post-review write exists at all: the merge is performed by code, but
   * the record of what the merge MEANT was left to the review agent to remember to
   * write. Measured over 7 days (2026-07-29 → 08-04): 53 merges, 12 issues left
   * mislabeled — ~23%. In the worked example (slashbin-io-worker#575) the agent
   * merged, verified, reported `verdict=APPROVE merged=yes deploy=SUCCESS`, named
   * the target label 24 times in its own output, and never executed the write.
   *
   * Sibling of the dead-zone resolve, which repairs the same state a cycle later
   * from a FRESH verification. This one needs no re-verification because the
   * verdict is the one the review just produced.
   *
   * Never applies `ready for prod release`: `outcome` names a lifecycle KEY, not a
   * label, and the type admits only the review outcomes.
   */
  private reviewOutcome(config: RepoConfig, issueNumber: number, outcome: ReviewOutcome, logger: Logger): boolean {
    const { prUnderReview } = config.lifecycleLabels;
    const nextLabel = config.lifecycleLabels[outcome];
    try {
      gh([
        "issue", "edit", String(issueNumber),
        "--repo", config.githubRepo,
        "--remove-label", prUnderReview,
        "--add-label", nextLabel,
      ], config.repoPath);
      logger.info(`Transitioned issue #${issueNumber} labels: "${prUnderReview}" → "${nextLabel}"`);
      return true;
    } catch (err) {
      logger.warn(
        `Failed to transition labels on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Dev verification passed (EM#440): `prMerged` → `prApproved`. The verifier
   * writes no label itself; this is the only writer of the step.
   */
  private verifyPassed(config: RepoConfig, issueNumber: number, logger: Logger): boolean {
    const { prMerged, prApproved } = config.lifecycleLabels;
    try {
      gh([
        "issue", "edit", String(issueNumber),
        "--repo", config.githubRepo,
        "--remove-label", prMerged,
        "--add-label", prApproved,
      ], config.repoPath);
      logger.info(`Transitioned issue #${issueNumber} labels: "${prMerged}" → "${prApproved}" (dev verification passed)`);
      return true;
    } catch (err) {
      logger.warn(
        `Failed to transition labels on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * TERMINAL transition (slashbin-ai-foreman#32): the issue's work is already
   * merged to the base branch. Strip the trigger label so the issue permanently
   * leaves the actionable set, and add `pr approved` — meaning "implemented and
   * merged, awaiting the EM outcome-gate."
   *
   * It must NOT be `ready for prod release`: that label authorizes production.
   * Granting it here would let the Foreman authorize its own release.
   *
   * Stripping `triggerLabel` is the load-bearing half: without it the issue stays
   * "actionable" forever and the Foreman burns a full Claude session every
   * back-off window concluding there is nothing to do.
   */
  private alreadyMerged(config: RepoConfig, num: number, outcome: "prApproved" | "prMerged", logger: Logger): boolean {
    const next = config.lifecycleLabels[outcome];
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--remove-label", config.triggerLabel,
        "--add-label", next,
      ], config.repoPath);
      logger.info(
        `Terminal transition on #${num}: removed "${config.triggerLabel}", added "${next}" (work already merged to ${config.baseBranch})`,
      );
      return true;
    } catch (err) {
      logger.warn(
        `Failed terminal transition on #${num}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Move a dead-zoned issue out of `pr under review` once a FRESH verification has
   * produced a verdict: `pr approved` on PASS, `pr pending actions` on FAIL.
   *
   * Deliberately never applies `ready for prod release` — the most this can do is
   * restore the issue to the state a healthy review run would have left it in.
   */
  private deadZoneResolve(config: RepoConfig, issueNumber: number, verdict: "pass" | "fail" | "merged", logger: Logger): boolean {
    const { prUnderReview, prPendingActions } = config.lifecycleLabels;
    // "merged": no verdict here — hand the issue to the verify stage (EM#441).
    const nextLabel = config.lifecycleLabels[verdict === "pass" ? "prApproved" : verdict === "merged" ? "prMerged" : "prPendingActions"];
    try {
      // Remove only what is actually present. `gh` errors on removing an absent
      // label, and since the dead zone covers `pr pending actions` as well as
      // `pr under review`, a hard `--remove-label` of `prUnderReview` would throw
      // on exactly the issues the widened detector catches.
      dropIssueSnapshot(config.githubRepo);
      const issue = getOpenIssues(config.githubRepo, config.repoPath, logger)
        .find((i) => i.number === issueNumber);
      if (!issue) {
        logger.debug(`Dead-zone resolve skipped for #${issueNumber} — no longer open`);
        return false;
      }

      const args = ["issue", "edit", String(issueNumber), "--repo", config.githubRepo];
      const stripped: string[] = [];
      for (const l of [prUnderReview, prPendingActions]) {
        // Never strip the label we are about to add — that is a no-op edit that
        // reads as a transition.
        if (l !== nextLabel && hasLabel(issue, l)) {
          args.push("--remove-label", l);
          stripped.push(l);
        }
      }
      if (!hasLabel(issue, nextLabel)) args.push("--add-label", nextLabel);
      // Kept exactly as it was before the move behind the adapter (byte-for-byte
      // GitHub behaviour). NOTE: the base argv is 5 long, so this never fires and
      // an already-resolved issue gets a flagless `gh issue edit` that fails into
      // the catch below — still `false`, but via a failed call, not no call.
      if (args.length === 4) {
        logger.debug(`Dead-zone resolve on #${issueNumber} is already in the target state`);
        return false;
      }

      gh(args, config.repoPath);
      logger.info(
        `Dead-zone resolved on #${issueNumber}: removed ${stripped.map((s) => `"${s}"`).join(", ") || "(nothing)"}, ` +
        `added "${nextLabel}" (re-verification ${verdict.toUpperCase()})`,
      );
      return true;
    } catch (err) {
      logger.warn(
        `Failed to resolve dead zone on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Return an orphaned issue to the implement queue by stripping whichever
   * lifecycle label is stranding it. The trigger label (`approved`) is left alone
   * — it is still authorized, it just never got built.
   */
  private orphanRelease(config: RepoConfig, issueNumber: number, logger: Logger): boolean {
    try {
      dropIssueSnapshot(config.githubRepo);
      const issue = getOpenIssues(config.githubRepo, config.repoPath, logger)
        .find((i) => i.number === issueNumber);
      if (!issue) return false;

      const args = ["issue", "edit", String(issueNumber), "--repo", config.githubRepo];
      // `gh` errors when removing a label that is not present, so only remove what is.
      for (const l of [config.lifecycleLabels.prUnderReview, config.lifecycleLabels.prPendingActions]) {
        if (hasLabel(issue, l)) args.push("--remove-label", l);
      }
      if (args.length === 5) return false; // nothing to strip — state changed under us

      gh(args, config.repoPath);
      logger.warn(
        `Released orphaned issue #${issueNumber} back to the implement queue — it carried a lifecycle label ` +
        `but no open PR covers it and nothing merged, so the work never landed.`,
      );
      return true;
    } catch (err) {
      logger.warn(
        `Failed to release orphaned issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Return all trigger-labelled open issues in the repo that have not yet
   * progressed through the lifecycle (no configured lifecycle label, not
   * `blocked`). This is the filter `selectWork` applies BEFORE the
   * PR-uncovered cross-check + batch cap — i.e. the full set of issues the
   * implementation skill might still be asked to build.
   *
   * Used by the orchestrator's labeling step to widen the intersection of
   * "issues referenced by the new PR" with "issues that should accept
   * `pr under review`": a repo-local skill makes its OWN selection from the
   * entire approved set (priority + smaller-scope-first), which can differ
   * from the discovery batch (PR-uncovered subset, capped at MAX_BATCH_SIZE).
   * Without this widening, when the skill picks an approved issue that wasn't
   * in the discovery batch, the resulting PR gets a real merge but no
   * `pr under review` label, leaving the EM with no signal.
   * (slashbin-ai-foreman#18)
   *
   * Returns [] on any gh failure (treat as "nothing to widen to" rather
   * than throwing — the caller already has the discovery batch as a
   * fallback, and a labeling miss is recoverable).
   */
  async selectEligible(repoConfig: RepoConfig, logger: Logger): Promise<WorkItem[]> {
    try {
      return this.eligible(repoConfig, logger).map((n) => ({ issueNumber: n, repo: repoConfig.githubRepo }));
    } catch (err) {
      logger.warn("selectEligible failed; returning [] (labeling will fall back to discovery batch)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Trigger-labelled, not `blocked`, no lifecycle label. Throws on gh failure. */
  private eligible(config: RepoConfig, logger: Logger): number[] {
    const issues = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, config.triggerLabel));

    const lifecycleLabelValues = Object.values(config.lifecycleLabels);

    const actionable: number[] = [];
    for (const issue of issues) {
      const labels = issue.labels.map((l) => l.name);
      if (labels.includes("blocked")) continue;
      if (lifecycleLabelValues.some((l) => labels.includes(l))) continue;
      actionable.push(issue.number);
    }
    return actionable;
  }

  /**
   * Gate check: eligible issues that don't already have a PR. Returns every
   * uncovered issue number, in the order `gh issue list` returned them (the
   * order a self-selecting skill saw), or [] if none or on any failure.
   */
  private selectUncovered(config: RepoConfig, logger: Logger): number[] {
    const repo = config.githubRepo;

    try {
      const actionable = this.eligible(config, logger);

      if (actionable.length === 0) return [];

      // Loop detection: check if all actionable issues already have a PR (open or merged)
      // that references them. If so, skip — the Foreman already did the work.
      // Check both open and merged PRs to catch issues where the PR was already merged
      // but the issue label wasn't updated.
      const openPrs = findOpenPrs(repo, config.repoPath, { base: config.baseBranch, limit: 50 });

      const mergedPrJson = ghKeyed(`merged20:${repo}:${config.baseBranch}`, () => closedPrVersion(repo), [
        "pr", "list",
        "--repo", repo,
        "--state", "merged",
        "--base", config.baseBranch,
        "--json", "number,title,body",
        "--limit", "20",
      ], config.repoPath);

      const mergedPrs: { number: number; title: string; body: string }[] = JSON.parse(mergedPrJson || "[]");
      const allPrs = [...openPrs, ...mergedPrs];

      // An issue is "covered" only if some PR IMPLEMENTS it (close/relate keyword,
      // or `(#N)` in the title) — NOT merely mentions it in body prose. The old
      // bare-`#N` test over concatenated title+body orphaned issues that a sibling
      // PR's body referenced (e.g. a schema PR body saying "tracked separately in
      // #3" made #3 look covered, so it was never implemented). (slashbin-ai-foreman#28)
      const covered = new Set<number>();
      for (const pr of allPrs) {
        for (const n of extractImplementedIssues({ title: pr.title, body: pr.body })) {
          covered.add(n);
        }
      }

      const uncovered: number[] = [];
      for (const issueNum of actionable) {
        if (!covered.has(issueNum)) {
          uncovered.push(issueNum);
        }
      }

      if (uncovered.length > 0) {
        coveredSkipAnnounced.delete(repo);
        return uncovered;
      }

      // A standing condition, not an event: announce it once per episode (the
      // same covered set), not every cycle. Dead-zone recovery picks up the
      // merged ones; this line only says why implement is idle.
      const episode = [...actionable].sort((a, b) => a - b).join(",");
      const msg = `Skipped ${repo}: ${actionable.length} approved issue(s), all have linked PRs (open or merged)`;
      if (coveredSkipAnnounced.get(repo) === episode) logger.debug(msg);
      else {
        coveredSkipAnnounced.set(repo, episode);
        logger.info(msg);
      }
      return [];
    } catch (err) {
      if (isBackoffRefusal(err)) {
        logger.debug("Failed to check for approved issues — GitHub back-off active");
        return [];
      }
      logger.error("Failed to check for approved issues", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}

// --- Revision Gate ---

export interface PendingRevisionPR {
  number: number;
  url: string;
  headRefName: string;
  /** The PR's head commit: an unblock check compares it to where the Foreman stopped. */
  headRefOid?: string;
}

export interface PendingRevisionInfo {
  issueNumbers: number[];
  pr: PendingRevisionPR;
}

/**
 * Gate check: are there any issues with the `prPendingActions` label?
 * These are issues where the reviewer requested changes on the linked PR
 * and the Foreman needs to revise the code.
 *
 * The review workflow applies `prPendingActions` to the ISSUE (not the PR),
 * so we query issues and then confirm they have an open feature PR.
 *
 * Returns the pending revision details, or null if no work.
 */
export function findPendingRevisions(
  config: RepoConfig,
  logger: Logger
): PendingRevisionInfo | null {
  try {
    // Find issues labeled `prPendingActions` + the trigger label (approved)
    const pendingLabel = config.lifecycleLabels.prPendingActions;
    const pendingActions = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, pendingLabel));
    const issues = pendingActions.filter((i) => hasLabel(i, config.triggerLabel));

    // An issue asked to revise but no longer carrying the trigger label is
    // SKIPPED here, and that is deliberate — revoking `approved` is how work is
    // called off, and revise must honour it rather than press on.
    //
    // But silent is wrong. The issue keeps `pr pending actions`, so
    // `GitHubIssueConnector.selectWork` skips it too, and it belongs to no phase at all.
    // Deliberately stopped and accidentally stranded produced the identical
    // observation — nothing — until this line existed. Say which one it is.
    const withheld = pendingActions.filter((i) => !hasLabel(i, config.triggerLabel));
    if (withheld.length > 0) {
      logger.warn(
        `${config.name}: ${withheld.length} issue(s) labeled "${pendingLabel}" without "${config.triggerLabel}" — ` +
        `revise will NOT act on them and no other phase owns them. Intentional if the work was called off; ` +
        `otherwise re-apply "${config.triggerLabel}" or clear the lifecycle label: ` +
        withheld.map((i) => `#${i.number}`).join(", "),
      );
    }

    if (issues.length === 0) return null;

    // Confirm there's an open feature PR (features → develop)
    const prs: PendingRevisionPR[] = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    if (prs.length > 0) {
      logger.info(`Found ${issues.length} issue(s) pending revision with open PR #${prs[0].number}: ${issues.map(i => `#${i.number}`).join(", ")}`);
      return { issueNumbers: issues.map(i => i.number), pr: prs[0] };
    }

    logger.debug(`Found ${issues.length} issue(s) with "${pendingLabel}" but no open feature PR`);
    return null;
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger.debug("Failed to check for pending revisions — GitHub back-off active");
      return null;
    }
    logger.error("Failed to check for pending revisions", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Backwards-compatible boolean wrapper for the implement-phase gate. */
export function hasPendingRevisions(
  config: RepoConfig,
  logger: Logger
): boolean {
  return findPendingRevisions(config, logger) !== null;
}

export interface ReviewCandidate {
  prNumber: number;
  prUrl: string;
  issueNumbers: number[];
  /**
   * The subset of `issueNumbers` adopted by the orphan fallback — the ones the
   * caller must report `new → inReview` for. Empty on the normal path, where
   * every issue already carries `pr under review`.
   */
  adopted: number[];
  /**
   * True when the PR's current verdict is CHANGES_REQUESTED but its issues still
   * sit at `pr under review`: the review landed, its label move did not. The
   * caller reports them `inReview → changesRequested` instead of reviewing.
   */
  stranded?: boolean;
}

/**
 * Gate check for the review phase: is there an open feature PR whose linked
 * issue(s) are labeled `pr under review` (set by implement/revise) and that has
 * NOT already been reviewed by the EM at its current head?
 *
 * Idempotency is primarily label-driven and self-cleaning: a full-fidelity review
 * run either merges an approved PR (closes it → out of scope here) or posts
 * REQUEST_CHANGES and relabels the issue `pr pending actions` (→ owned by the
 * revise phase, excluded below). The freshness guard (`hasFreshReview`) covers the
 * remaining window where a review run crashed after posting its verdict but before
 * relabeling — without it the same PR would be re-reviewed every cycle.
 *
 * Self-heal fallback: when no issue carries `pr under review` but an open feature
 * PR exists, the implement phase opened the PR but never applied the label (the
 * transition step swallows errors, and the process can die between `gh pr create`
 * and the implement stage's `new → inReview` report). GitHub — the actual open PR — is the
 * source of truth for whether review is needed; the label is a tracking artifact.
 * `adoptOrphanedReviewCandidate` finds linked issues from the PR title/body and
 * returns them as `adopted` — the caller reports them `new → inReview` through
 * the work source (on GitHub: `pr under review`) — so the review runs
 * this cycle instead of hanging forever waiting for a label that never lands.
 *
 * Returns null when there's nothing to review.
 */
export function findPRsNeedingReview(
  config: RepoConfig,
  reviewerLogin: string | undefined,
  logger: Logger,
): ReviewCandidate | null {
  try {
    const { prUnderReview, prPendingActions } = config.lifecycleLabels;
    const issues = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, prUnderReview));
    // Exclude issues also labeled `pr pending actions` — the revise phase owns those.
    const reviewable = issues.filter((i) => !hasLabel(i, prPendingActions));
    if (reviewable.length === 0) {
      return adoptOrphanedReviewCandidate(config, reviewerLogin, logger);
    }

    // Confirm an open feature PR exists (features → develop).
    const prs: { number: number; url: string }[] = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    if (prs.length === 0) {
      logger.debug(`${config.name}: ${reviewable.length} issue(s) labeled "${prUnderReview}" but no open feature PR`);
      return null;
    }
    const pr = prs[0];

    if (hasFreshReview(config, pr.number, reviewerLogin, logger)) {
      // A revision that declares "no code change" returns the issues to review
      // WITHOUT moving the head, so by commit time the old verdict still looks
      // current and the PR would sit unreviewed forever (worker#694, 2026-10-03).
      // The relabel is the reply; a verdict older than it is not current.
      if (!returnedToReviewSinceVerdict(config, pr.number, reviewable.map((i) => i.number), reviewerLogin, logger)) {
        // A review run that dies after posting CHANGES_REQUESTED but before moving
        // the labels leaves the issues here: reviewed, so never reviewed again, and
        // never `pr pending actions`, so never revised (mcp_services#240,
        // 2026-10-09: a TLS timeout on the label step parked it 7 hours).
        if (currentVerdictRequestsChanges(config, pr.number, reviewerLogin, logger)) {
          logger.warn(`${config.name}: PR #${pr.number} has a current CHANGES_REQUESTED verdict but its issues are still "${prUnderReview}" — stranded; the review phase sends them to revise`);
          return { prNumber: pr.number, prUrl: pr.url, issueNumbers: reviewable.map((i) => i.number), adopted: [], stranded: true };
        }
        logger.debug(`${config.name}: PR #${pr.number} already has a current ${reviewerLogin ?? "reviewer"} review — skipping re-review`);
        return null;
      }
      logger.info(`${config.name}: PR #${pr.number} was returned to review after its last verdict with no new commit — re-reviewing`);
    }

    logger.info(
      `${config.name}: PR #${pr.number} needs review (issues: ${reviewable.map((i) => `#${i.number}`).join(", ")})`,
    );
    return { prNumber: pr.number, prUrl: pr.url, issueNumbers: reviewable.map((i) => i.number), adopted: [] };
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger.debug("Failed to check for PRs needing review — GitHub back-off active");
      return null;
    }
    logger.error("Failed to check for PRs needing review", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fallback for `findPRsNeedingReview`: an open feature PR exists but no linked
 * issue carries `pr under review`. The implement phase opened the PR then failed
 * (silently) to apply the label — or crashed between `gh pr create` and
 * the `new → inReview` report. Recover by extracting linked issue refs from
 * the PR title/body, returning those that still carry the trigger label as
 * `adopted` (the caller reports them `new → inReview`), and returning a
 * candidate so the review runs this cycle.
 *
 * Safety filters (only adopt issues we clearly own):
 *  - OPEN state
 *  - carries `config.triggerLabel` (default `approved`)
 *  - NOT `pr pending actions` (revise phase owns those)
 *  - NOT `ready for prod release` (already advanced)
 */
function adoptOrphanedReviewCandidate(
  config: RepoConfig,
  reviewerLogin: string | undefined,
  logger: Logger,
): ReviewCandidate | null {
  const prs: { number: number; url: string; title: string; body: string }[] = findOpenPrs(
    config.githubRepo,
    config.repoPath,
    { head: config.featureBranch, base: config.baseBranch, limit: 1 },
  );
  if (prs.length === 0) return null;
  const pr = prs[0];

  if (hasFreshReview(config, pr.number, reviewerLogin, logger)) return null;

  const { prUnderReview, prPendingActions, readyForProd } = config.lifecycleLabels;
  const refs = new Set<number>();
  const combined = `${pr.title}\n${pr.body ?? ""}`;
  for (const m of combined.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n !== pr.number) refs.add(n);
  }
  if (refs.size === 0) {
    logger.debug(`${config.name}: PR #${pr.number} has no "${prUnderReview}" label and no linked issues found in title/body`);
    return null;
  }

  // This probe runs on every idle cycle while a feature PR waits for review.
  // With the fleet state on, the open-issue list already answers "open, and
  // with which labels" for every ref — absent from it means not open.
  const known = issueCacheTtlMs > 0 && isGitHubStateEnabled(config.githubRepo)
    ? new Map(stateOpenIssues(config.githubRepo).map((i) => [i.number, i]))
    : null;
  const adopted: number[] = [];
  for (const num of refs) {
    try {
      const info: { state: string; labels: { name: string }[] } = known
        ? { state: known.has(num) ? "OPEN" : "CLOSED", labels: known.get(num)?.labels ?? [] }
        : JSON.parse(gh([
          "issue", "view", String(num),
          "--repo", config.githubRepo,
          "--json", "state,labels",
        ], config.repoPath));
      if (info.state !== "OPEN") continue;
      const names = new Set(info.labels.map((l) => l.name));
      if (!names.has(config.triggerLabel)) continue;
      if (names.has(prPendingActions)) continue;
      if (names.has(readyForProd)) continue;
      logger.warn(`${config.name}: adopted orphaned issue #${num} → PR #${pr.number} (implement phase never applied "${prUnderReview}")`);
      adopted.push(num);
    } catch (err) {
      logger.debug(`${config.name}: could not inspect referenced #${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (adopted.length === 0) {
    logger.debug(`${config.name}: PR #${pr.number} is orphaned but no referenced issue is a review candidate (missing ${config.triggerLabel}, or owned by revise/prod)`);
    return null;
  }

  logger.info(`${config.name}: adopted orphaned PR #${pr.number} for review (issues: ${adopted.map((n) => `#${n}`).join(", ")})`);
  return { prNumber: pr.number, prUrl: pr.url, issueNumbers: adopted, adopted };
}

export interface MergedIssueRef {
  issueNumber: number;
  prNumber: number;
  prUrl: string;
  mergedAt: string;
}

/**
 * THE shared primitive: of `candidates`, which issues' work is already MERGED to
 * `baseBranch`? Resolved by running each recently-merged PR through the STRICT
 * implemented-issue predicate — a merged PR must say it *closed* the issue
 * (`closes`/`fixes`/`resolves #N`, or `(#N)` in the title / a commit headline).
 * A mere "related to #N" does not count. See extractImplementedIssues({strict}).
 *
 * Two callers, two DIFFERENT policies — the distinction that matters is
 * *did a gate reject this work?*:
 *   - implement-skip (slashbin-ai-foreman#32): no gate ever ran, the work is just
 *     merged with no lifecycle label → AUTO-ADVANCE to the terminal state.
 *   - findStuckMergedIssues: post-merge verify FAILED → NEVER auto-advance
 *     (a gate rejected it); surface to the EM instead.
 *
 * Conservative: returns [] on any lookup failure — under-advancing is safe
 * (status quo), over-advancing marks unbuilt work as done.
 */
export function findIssuesMergedToBase(
  config: RepoConfig,
  candidates: number[],
  logger: Logger,
): MergedIssueRef[] {
  if (candidates.length === 0) return [];
  try {
    // The merged set only grows when a PR merges, which the fleet state sees.
    const json = ghKeyed(`merged:${config.githubRepo}:${config.baseBranch}`, () => closedPrVersion(config.githubRepo), [
      "pr", "list",
      "--repo", config.githubRepo,
      "--state", "merged",
      "--base", config.baseBranch,
      "--json", "number,url,title,body,commits,mergedAt",
      "--limit", "30",
    ], config.repoPath);
    const prs = JSON.parse(json || "[]") as {
      number: number;
      url: string;
      title?: string;
      body?: string;
      commits?: { messageHeadline?: string; messageBody?: string }[];
      mergedAt?: string;
    }[];

    const wanted = new Set(candidates);
    const hits = new Map<number, MergedIssueRef>();
    for (const pr of prs) {
      const commits = pr.commits ?? [];
      const closed = extractImplementedIssues({
        title: pr.title || "",
        body: pr.body || "",
        commitHeadlines: commits.map((c) => c.messageHeadline || ""),
        commitBodies: commits.map((c) => c.messageBody || ""),
        strict: true,
      });
      for (const n of closed) {
        // Never match a PR against its OWN number: GitHub's squash-merge appends
        // "(#<pr>)" to the commit headline, which the `(#N)` rule would otherwise
        // read as "this PR closed issue #<pr>". Harmless today (issues and PRs
        // share one number sequence, so a PR number is never an issue number) —
        // guarded anyway so it can't become a real false-advance later.
        if (n === pr.number) continue;
        // Keep the FIRST (most recent — gh lists newest-first) merged PR per issue.
        if (wanted.has(n) && !hits.has(n) && pr.mergedAt) {
          hits.set(n, {
            issueNumber: n,
            prNumber: pr.number,
            prUrl: pr.url,
            mergedAt: pr.mergedAt,
          });
        }
      }
    }
    return [...hits.values()].sort((a, b) => a.issueNumber - b.issueNumber);
  } catch (err) {
    logger.warn("findIssuesMergedToBase: gh pr list failed — advancing nothing", {
      ...formatGhError(err),
      repo: config.githubRepo,
    });
    return [];
  }
}

export type StuckMergedIssue = MergedIssueRef;

/** Grace window before a merged-but-unadvanced issue is treated as dead-zoned,
 *  giving an in-flight post-merge verify time to advance it. Prevents flapping
 *  on freshly-merged PRs the review agent is still finishing. */
const STUCK_MERGE_GRACE_MS = 15 * 60 * 1000;

/**
 * Detect issues DEAD-ZONED by a failed post-merge verify: labeled `pr under
 * review` with their feature PR already MERGED to the base branch, yet never
 * advanced to `ready for prod release`. `findPRsNeedingReview` only fires while
 * the PR is OPEN; once it merges, a failed post-merge verify leaves the issue
 * pinned at `pr under review` with NO phase that ever recovers it. This surfaces
 * those so the EM can re-verify and advance/flag by hand.
 *
 * DETECTION ONLY — this function never mutates labels. It does NOT follow that
 * nothing can be done: re-running the post-merge verification and advancing on
 * PASS / flagging on FAIL is exactly what the alert asks the EM to do by hand,
 * and it is not a rubber stamp because the verdict comes from the verifier, not
 * from the agent that dropped the ball. That repair lives in the orchestrator
 * (`recoverDeadZonedIssue`); the split keeps "what is broken" separable from
 * "what we did about it". What remains forbidden is advancing WITHOUT a fresh
 * verification — a post-merge FAIL must still HOLD.
 *
 * Conservative by design (returns [] on any ambiguity):
 *  - skips main-only repos (no features→develop lifecycle)
 *  - ignores `pr approved` / `ready for prod release` (already advanced)
 *  - ignores issues REFERENCED BY an open feature PR (normal review-pending;
 *    tryReview owns those specific issues)
 *  - only flags PRs merged more than STUCK_MERGE_GRACE_MS ago (no flap on fresh merges)
 *
 * An issue with ONLY the trigger label is the same dead zone by a third door
 * (slashbin-ai-foreman#73): implement treats it as covered once its PR merged,
 * and no lifecycle label ever arrives. It is included when it carries no
 * lifecycle label and is not `blocked`.
 *
 * `pr pending actions` USED to be excluded here on the grounds that "revise owns
 * it". That was only true while a feature PR is open: `findPendingRevisions`
 * returns null the moment there is none, at `debug` level, so a revision request
 * whose PR merged or closed underneath it was owned by nobody and logged
 * nowhere. It is the same dead zone as `pr under review`, one label over, and it
 * is now included.
 */
export function findStuckMergedIssues(
  config: RepoConfig,
  logger: Logger,
): StuckMergedIssue[] {
  if (config.baseBranch === config.featureBranch) return [];
  try {
    const { prUnderReview, prPendingActions, prMerged, prApproved, readyForProd } = config.lifecycleLabels;
    const lifecycle = Object.values(config.lifecycleLabels);
    const issues = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) =>
        hasLabel(i, prUnderReview) || hasLabel(i, prPendingActions) ||
        // Trigger label only, no lifecycle label: implement skips it as covered
        // once its PR merged, and before slashbin-ai-foreman#73 nothing else
        // looked at it — the third door into the same dead zone.
        (hasLabel(i, config.triggerLabel) && !hasLabel(i, "blocked") && !lifecycle.some((l) => hasLabel(i, l))));
    const candidates = issues.filter(
      // `pr merged` belongs to the verify stage, which owns its retries.
      (i) => !(
        hasLabel(i, prMerged) || hasLabel(i, prApproved) || hasLabel(i, readyForProd)
      ),
    );
    if (candidates.length === 0) return [];

    // An open feature PR means the issues THAT PR COVERS are normal
    // review-pending — tryReview owns those. It says nothing about any other
    // issue in the repo.
    //
    // This used to `return []` for the whole repo the moment any feature PR was
    // open. Because the feature branch is long-lived and shared, a repo with
    // active work almost always has one — so a single open PR concealed every
    // dead-zoned issue behind it, and the dead zone became least visible exactly
    // when the repo was busiest. Scope the exclusion to the referenced issues.
    //
    // Fail CLOSED on an unreadable reference list: if we cannot tell which
    // issues the open PR covers, suppress the whole repo as before rather than
    // risk "recovering" an issue whose PR is still open and under review.
    const openFeaturePrs = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    let reviewPending: number[] = [];
    if (openFeaturePrs.length > 0) {
      const referenced = getReferencedIssuesFromOpenPR(
        config.githubRepo,
        config.featureBranch,
        config.baseBranch,
        config.repoPath,
        logger,
      );
      if (referenced === null) {
        logger.debug(
          `${config.name}: open feature PR present but its referenced issues are unreadable — suppressing dead-zone detection this pass`,
        );
        return [];
      }
      reviewPending = referenced;
    }
    const unowned = candidates.filter((i) => !reviewPending.includes(i.number));
    if (unowned.length === 0) return [];

    // Resolve merged work via the SHARED strict primitive — not a bare `#N` scan.
    // A bare-`#N` match would false-positive on an incidental prose mention
    // (slashbin-ai-foreman#28), flagging issues that were never actually merged.
    const merged = findIssuesMergedToBase(
      config,
      unowned.map((i) => i.number),
      logger,
    );

    const nowMs = Date.now();
    return merged.filter(
      (m) => nowMs - new Date(m.mergedAt).getTime() > STUCK_MERGE_GRACE_MS,
    );
  } catch (err) {
    logger.debug(
      `findStuckMergedIssues failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Detect issues ORPHANED by work that never landed: labeled `pr under review`
 * or `pr pending actions`, with **no open feature PR covering them and nothing
 * merged to the base branch**. The PR was closed without merging, or the
 * implement run recorded a label and then died before opening one.
 *
 * This is the third dead zone and the only one where the work does not exist:
 *
 *   | label               | PR open   | PR merged        | PR closed / none |
 *   |---------------------|-----------|------------------|------------------|
 *   | pr under review     | tryReview | findStuckMerged  | HERE             |
 *   | pr pending actions  | tryRevise | findStuckMerged  | HERE             |
 *
 * The lifecycle label is what makes it invisible: `GitHubIssueConnector.selectWork` skips
 * ANY issue carrying one, so an issue whose PR vanished keeps its `approved`
 * label, is never re-implemented, is never reviewed, and produces no log line
 * above `debug`. It simply stops existing as far as the pipeline is concerned.
 *
 * Recovery is the opposite of the merged case: there is nothing to verify, so
 * the correct action is to RETURN IT TO THE QUEUE — strip the lifecycle label
 * and let the implement phase pick it up again on its `approved` label. That is
 * safe precisely because nothing merged; re-implementing cannot duplicate work
 * that does not exist.
 *
 * Conservative by design:
 *  - skips main-only repos
 *  - ignores `pr approved` / `ready for prod release` (past this stage)
 *  - ignores issues an open feature PR references, and fails CLOSED when that
 *    reference list is unreadable
 *  - requires the issue to have been in this state longer than the grace window,
 *    so a PR being opened right now is never mistaken for one that never was
 */
export function findOrphanedLifecycleIssues(
  config: RepoConfig,
  logger: Logger,
): number[] {
  if (config.baseBranch === config.featureBranch) return [];
  try {
    const { prUnderReview, prPendingActions, prMerged, prApproved, readyForProd } = config.lifecycleLabels;
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);
    const candidates = open.filter(
      (i) =>
        (hasLabel(i, prUnderReview) || hasLabel(i, prPendingActions)) &&
        !hasLabel(i, prMerged) &&
        !hasLabel(i, prApproved) &&
        !hasLabel(i, readyForProd),
    );
    if (candidates.length === 0) return [];

    const openFeaturePrs = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    let reviewPending: number[] = [];
    if (openFeaturePrs.length > 0) {
      const referenced = getReferencedIssuesFromOpenPR(
        config.githubRepo,
        config.featureBranch,
        config.baseBranch,
        config.repoPath,
        logger,
      );
      // Unreadable reference list — cannot tell what the open PR covers, so
      // releasing anything risks re-implementing work that is in flight.
      if (referenced === null) return [];
      reviewPending = referenced;
    }

    const unowned = candidates.filter((i) => !reviewPending.includes(i.number));
    if (unowned.length === 0) return [];

    // Anything already merged belongs to findStuckMergedIssues, which re-verifies
    // rather than re-queues. Only what NEVER landed is an orphan.
    const merged = new Set(
      findIssuesMergedToBase(config, unowned.map((i) => i.number), logger).map((m) => m.issueNumber),
    );

    return unowned.filter((i) => !merged.has(i.number)).map((i) => i.number);
  } catch (err) {
    logger.debug(
      `findOrphanedLifecycleIssues failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * POST-CONDITION CHECK for a finished review run: of `issueNumbers`, which are
 * still pinned at `pr under review` with no lifecycle label beyond it?
 *
 * The review phase reports its own outcome via a self-declared status trailer.
 * A trailer is a CLAIM; the labels are the STATE. When the two disagree the
 * labels win, because the next phase reads labels and nothing ever reads the
 * trailer again. Checking them directly is what makes the orphan detectable
 * without any cooperation from the agent that created it.
 *
 * Reads FRESH — the review runs in a separate process whose label writes never
 * invalidate our snapshot cache, so a cached read here would report the
 * pre-review state and manufacture a false orphan on every successful run.
 *
 * Returns [] on any lookup failure: a check that cannot see the truth must not
 * assert one.
 */
export function findIssuesStillUnderReview(
  config: RepoConfig,
  issueNumbers: number[],
  logger: Logger,
): number[] {
  if (issueNumbers.length === 0) return [];
  try {
    dropIssueSnapshot(config.githubRepo);
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);
    return issueNumbers.filter((num) => {
      const issue = open.find((i) => i.number === num);
      // Absent from the open set = closed. The review closed it out; not stuck.
      if (!issue) return false;
      const { prUnderReview, prMerged, prApproved, prPendingActions, readyForProd } = config.lifecycleLabels;
      if (!hasLabel(issue, prUnderReview)) return false;
      return !(
        hasLabel(issue, prMerged) ||
        hasLabel(issue, prApproved) ||
        hasLabel(issue, prPendingActions) ||
        hasLabel(issue, readyForProd)
      );
    });
  } catch (err) {
    logger.debug(
      `findIssuesStillUnderReview failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * The lifecycle states a review can end in, as `LifecycleLabels` keys.
 * `prMerged` when dev verification is its own stage (EM#440): the reviewer
 * merged, and `pr approved` waits on the verifier.
 */
export type ReviewOutcome = "prApproved" | "prMerged" | "prPendingActions";

/**
 * The outcome each of `issueNumbers` carries in `issues`: `pr approved` or
 * `pr pending actions`. An issue that is closed, already `ready for prod`, or
 * has neither is absent. Pure.
 */
export function reviewOutcomesOf(
  config: Pick<RepoConfig, "lifecycleLabels">,
  issues: ReadonlyArray<{ number: number; labels: ReadonlyArray<{ name: string }> }>,
  issueNumbers: ReadonlyArray<number>,
): Map<number, ReviewOutcome> {
  const { prApproved, prMerged, prPendingActions, readyForProd } = config.lifecycleLabels;
  const out = new Map<number, ReviewOutcome>();
  for (const n of issueNumbers) {
    const issue = issues.find((i) => i.number === n);
    if (!issue) continue;
    const has = (name: string) => issue.labels.some((l) => l.name === name);
    if (has(readyForProd)) continue;
    if (has(prApproved)) out.set(n, "prApproved");
    else if (has(prMerged)) out.set(n, "prMerged");
    else if (has(prPendingActions)) out.set(n, "prPendingActions");
  }
  return out;
}

/**
 * The outcome labels a review run left on its issues, read fresh from GitHub.
 * Empty when the read fails: the caller only reports, never decides, on it.
 */
export function readReviewOutcomes(
  config: RepoConfig,
  issueNumbers: number[],
  logger: Logger,
): Map<number, ReviewOutcome> {
  if (issueNumbers.length === 0) return new Map();
  try {
    dropIssueSnapshot(config.githubRepo);
    return reviewOutcomesOf(config, getOpenIssues(config.githubRepo, config.repoPath, logger), issueNumbers);
  } catch (err) {
    logger.debug(`readReviewOutcomes failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

/**
 * Open issues waiting on dev verification (EM#440): labelled `prMerged` and not
 * yet `prApproved` / `ready for prod`. Read fresh — the reviewer that wrote the
 * label is a foreign process. [] on a failed read: nothing is verified blind.
 */
export function findIssuesAwaitingVerify(config: RepoConfig, logger: Logger): number[] {
  try {
    const { prMerged, prApproved, readyForProd } = config.lifecycleLabels;
    dropIssueSnapshot(config.githubRepo);
    return getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, prMerged) && !hasLabel(i, prApproved) && !hasLabel(i, readyForProd))
      .map((i) => i.number)
      .sort((a, b) => a - b);
  } catch (err) {
    logger.warn(`findIssuesAwaitingVerify failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export interface TimelineLabelEvent {
  event?: string;
  label?: { name?: string };
  created_at?: string;
}

/**
 * Did the EM outcome-gate label (`labels.readyForProd` — the label that authorizes
 * production, which only the EM outcome-gate applies and nothing in the review
 * path may take away) get REMOVED at or after `sinceMs`?
 *
 * Pure, so the rule can be tested without a network. The rule that matters is
 * time-symmetry: this asks "was it taken away during the window", never "did it
 * exist before the window". The previous guard asked the second question and
 * therefore missed every gate signed while a review was already running — which
 * is the normal case, not the edge case.
 */
export function wasGateRevokedSince(
  events: TimelineLabelEvent[],
  sinceMs: number,
  labels: LifecycleLabels,
): boolean {
  return events.some((e) =>
    e.event === "unlabeled" &&
    e.label?.name === labels.readyForProd &&
    typeof e.created_at === "string" &&
    Number.isFinite(Date.parse(e.created_at)) &&
    Date.parse(e.created_at) >= sinceMs,
  );
}

/**
 * Which of `issueNumbers` had the EM outcome-gate label REMOVED since `sinceIso`.
 *
 * Detected from the issue's own label timeline, not from a snapshot taken before
 * the run. That distinction is the entire point, and the first version of this
 * guard got it wrong: it captured which issues held the gate BEFORE the review
 * started, then restored those. That handles a gate signed before the run and
 * completely misses a gate signed DURING it — which is the actual reported
 * scenario, and the one that recurred on Slashbin-io-docs#269 (review triggered
 * 13:52:25Z, gate signed 13:57:41Z, agent removed it 13:58:20Z, guard restored
 * nothing because its snapshot predated the signature).
 *
 * Reading the timeline is time-symmetric: an `unlabeled` event inside the run
 * window is a revocation regardless of when the label was applied.
 *
 * Only consulted for issues that do NOT currently carry the label, so the healthy
 * path costs nothing beyond the open-issue snapshot already in hand. Returns []
 * on any failure — a lookup that fails must never manufacture authorization.
 */
export function findRevokedEmGates(
  config: RepoConfig,
  issueNumbers: number[],
  sinceIso: string,
  logger: Logger,
): number[] {
  if (issueNumbers.length === 0) return [];
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return [];

  const revoked: number[] = [];
  try {
    dropIssueSnapshot(config.githubRepo);
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);

    for (const num of issueNumbers) {
      const issue = open.find((i) => i.number === num);
      // Closed, or the gate is still there — nothing was revoked.
      if (!issue || hasLabel(issue, config.lifecycleLabels.readyForProd)) continue;

      try {
        const raw = gh([
          "api", `repos/${config.githubRepo}/issues/${num}/timeline?per_page=100`,
          "-H", "Accept: application/vnd.github.mockingbird-preview+json",
        ], config.repoPath);
        const events: TimelineLabelEvent[] = JSON.parse(raw || "[]");
        if (wasGateRevokedSince(events, since, config.lifecycleLabels)) revoked.push(num);
      } catch (err) {
        logger.warn(
          `Could not read the label timeline for #${num}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    logger.warn(`findRevokedEmGates failed for ${config.githubRepo}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return revoked;
}

export interface EmGateRestoreStep {
  number: number;
  /** The review wrote `pr approved` in the gate's place — strip it on the way back. */
  dropPrApproved: boolean;
}

/**
 * Decide, with no I/O, which issues need their EM outcome-gate put back.
 *
 * Split out from `restoreEmGate` so the decision is testable without a network:
 * the rules about what counts as "revoked" are the part worth pinning, and the
 * `gh` call around them is not.
 *
 * Restores only issues that (a) carried the gate before the run, (b) are still
 * open, and (c) no longer carry it. A closed issue needs no gate — the promotion
 * either happened or the work was abandoned, and re-labeling a closed issue would
 * put it back in the Foreman's pickup list for no reason.
 */
export function planEmGateRestore(
  hadGate: number[],
  open: { number: number; labels: { name: string }[] }[],
  labels: LifecycleLabels,
): EmGateRestoreStep[] {
  const steps: EmGateRestoreStep[] = [];
  for (const num of hadGate) {
    const issue = open.find((i) => i.number === num);
    if (!issue) continue;                                   // closed — nothing to restore
    const names = new Set(issue.labels.map((l) => l.name));
    if (names.has(labels.readyForProd)) continue;           // still signed — healthy path
    steps.push({ number: num, dropPrApproved: names.has(labels.prApproved) });
  }
  return steps;
}

/**
 * Put back any EM outcome-gate label that disappeared across a review run.
 *
 * The review agent writes issue labels itself, so the Foreman cannot intercept
 * that write — it can only detect the damage and undo it. This is the structural
 * half of a rule that until now existed only as a sentence in the review prompt.
 *
 * Why it matters that this is silent without the check: `tryPromotion` calls
 * `findReadyForProdIssues`, which filters on exactly this label, and returns
 * early on an empty set. A revoked gate produces no PR, no error and no log line
 * — indistinguishable from having nothing to promote. Observed on
 * Slashbin-io-docs, 2026-08-04: the gate was signed at 20:20:15Z, overwritten
 * with `pr approved` at 20:22:12Z by a review run that started at 20:11:59Z, and
 * the promotion sat stalled for an hour until a human noticed the absence.
 *
 * A review verdict is never authority to revoke production authorization, so
 * restoring is unconditional. `pr approved` is stripped only when present — it is
 * the label the review wrote in the gate's place, and the two are different
 * lifecycle states, not additive ones.
 *
 * Returns the issues actually restored (usually none — the healthy path).
 */
export function restoreEmGate(
  config: RepoConfig,
  hadGate: number[],
  logger: Logger,
): number[] {
  if (hadGate.length === 0) return [];
  const { readyForProd, prApproved } = config.lifecycleLabels;
  const restored: number[] = [];
  try {
    dropIssueSnapshot(config.githubRepo);
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);
    for (const step of planEmGateRestore(hadGate, open, config.lifecycleLabels)) {
      const { number: num, dropPrApproved } = step;
      const args = [
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--add-label", readyForProd,
      ];
      // Only remove what is actually there; `gh` errors on removing an absent label.
      if (dropPrApproved) args.push("--remove-label", prApproved);

      try {
        gh(args, config.repoPath);
        restored.push(num);
        logger.warn(
          `Restored "${readyForProd}" on #${num} — the review run removed it. ` +
          `A review verdict does not authorize or revoke production; only the EM outcome-gate does.`,
        );
      } catch (err) {
        logger.error(
          `Failed to restore "${readyForProd}" on #${num} — promotion is STALLED until a human re-applies it: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    logger.warn(`restoreEmGate failed for ${config.githubRepo}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return restored;
}

/**
 * Whether a review counts as the configured reviewer's. With no `reviewerLogin`
 * configured, every author counts: the freshness guard then treats a verdict by
 * anyone as current, which can skip a review but can never loop one.
 */
function byReviewer(review: { author?: { login?: string } }, reviewerLogin: string | undefined): boolean {
  return reviewerLogin === undefined || review.author?.login === reviewerLogin;
}

/**
 * True when the PR already has an APPROVED/CHANGES_REQUESTED review by
 * `reviewerLogin` submitted at or after the PR's latest commit (i.e. the current
 * head has already been reviewed). On any lookup failure returns false — we'd
 * rather (rarely) re-review than silently never review.
 */
/**
 * hasFreshReview answers, keyed by the PR's head commit and last-update time
 * from the fleet state. A new commit moves the head; a submitted review bumps
 * the PR's updatedAt — either one misses this cache. Without it, every idle
 * cycle re-read the reviews of every open feature PR waiting on a human.
 */
const freshReviewCache = new Map<string, { key: string; fresh: boolean }>();

function hasFreshReview(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
): boolean {
  let cacheKey: string | null = null;
  const id = `${config.githubRepo}#${prNumber}`;
  try {
    if (issueCacheTtlMs > 0 && isGitHubStateEnabled(config.githubRepo)) {
      const pr = stateOpenPrs(config.githubRepo).find((p) => p.number === prNumber);
      if (pr) {
        cacheKey = `${pr.headRefOid}@${pr.updatedAt}@${reviewerLogin ?? ""}`;
        const hit = freshReviewCache.get(id);
        if (hit && hit.key === cacheKey) return hit.fresh;
      }
    }
  } catch { /* state unavailable — read live */ }
  const fresh = readFreshReview(config, prNumber, reviewerLogin, logger);
  if (cacheKey && fresh !== null) freshReviewCache.set(id, { key: cacheKey, fresh });
  return fresh ?? false;
}

/** Null when the lookup failed — not cached, reads as "no fresh review". */
function readFreshReview(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
): boolean | null {
  try {
    const json = gh([
      "pr", "view", String(prNumber),
      "--repo", config.githubRepo,
      "--json", "reviews,commits",
    ], config.repoPath);
    const data = JSON.parse(json || "{}") as {
      commits?: { committedDate?: string }[];
      reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
    };
    const commits = data.commits ?? [];
    const reviews = data.reviews ?? [];
    if (commits.length === 0) return false;

    const lastCommitMs = commits
      .map((c) => (c.committedDate ? new Date(c.committedDate).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);

    return reviews.some(
      (r) =>
        byReviewer(r, reviewerLogin) &&
        (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") &&
        !!r.submittedAt &&
        new Date(r.submittedAt).getTime() >= lastCommitMs,
    );
  } catch (err) {
    logger.debug(`hasFreshReview lookup failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * True when the reviewer's latest verdict on the PR is CHANGES_REQUESTED. Asked
 * only once the verdict is known to be current and not answered by a return to
 * review, so a true here means the verdict's label move never happened. Lookup
 * failure → false: the pre-existing skip, never a spurious revise.
 */
function currentVerdictRequestsChanges(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
): boolean {
  try {
    const data = JSON.parse(gh(["pr", "view", String(prNumber), "--repo", config.githubRepo, "--json", "reviews"], config.repoPath) || "{}") as {
      reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
    };
    const verdicts = (data.reviews ?? [])
      .filter((r) => byReviewer(r, reviewerLogin) && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") && r.submittedAt)
      .sort((a, b) => new Date(a.submittedAt!).getTime() - new Date(b.submittedAt!).getTime());
    return verdicts[verdicts.length - 1]?.state === "CHANGES_REQUESTED";
  } catch (err) {
    logger.debug(`currentVerdictRequestsChanges lookup failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * True when a linked issue was labelled `prUnderReview` AFTER the reviewer's
 * latest CHANGES_REQUESTED verdict — the reviser answered without a commit.
 *
 * Only a CHANGES_REQUESTED verdict qualifies: an APPROVED PR waiting on merge
 * is genuinely current. In normal flow CHANGES_REQUESTED moves the issues to
 * `prPendingActions`, which `findPRsNeedingReview` excludes, so this lookup
 * runs only in the stuck state it exists for. Lookup failure → false: the
 * pre-existing behaviour, never a spurious review.
 */
function returnedToReviewSinceVerdict(
  config: RepoConfig,
  prNumber: number,
  issueNumbers: number[],
  reviewerLogin: string | undefined,
  logger: Logger,
): boolean {
  try {
    const data = JSON.parse(gh(["pr", "view", String(prNumber), "--repo", config.githubRepo, "--json", "reviews"], config.repoPath) || "{}") as {
      reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
    };
    const verdicts = (data.reviews ?? [])
      .filter((r) => byReviewer(r, reviewerLogin) && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") && r.submittedAt)
      .sort((a, b) => new Date(a.submittedAt!).getTime() - new Date(b.submittedAt!).getTime());
    const last = verdicts[verdicts.length - 1];
    if (!last || last.state !== "CHANGES_REQUESTED") return false;
    const verdictMs = new Date(last.submittedAt!).getTime();
    const label = config.lifecycleLabels.prUnderReview;
    for (const n of issueNumbers) {
      // One timestamp per line: --paginate emits one --jq result per page.
      const times = gh([
        "api", `repos/${config.githubRepo}/issues/${n}/events`, "--paginate",
        "--jq", `.[] | select(.event == "labeled" and .label.name == ${JSON.stringify(label)}) | .created_at`,
      ], config.repoPath).split("\n").filter(Boolean);
      if (times.some((t) => new Date(t).getTime() > verdictMs)) return true;
    }
    return false;
  } catch (err) {
    logger.debug(`returnedToReviewSinceVerdict lookup failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// --- CI gate in front of review ---------------------------------------------
//
// A review is a full EM session (median 13 min). Spending one on a PR whose own
// CI is red buys a REQUEST_CHANGES that says "CI is red" — the builder could have
// learned that for free. So the review phase reads the PR's checks first:
// red → straight back to revise with the failing checks named, still running →
// wait a pass, green or no CI at all → review as before.

/** One entry of `gh pr view --json statusCheckRollup`: a CheckRun or a StatusContext. */
export interface CheckRollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export interface CheckVerdict {
  /** `none` = the repo runs no CI on this PR; review proceeds exactly as before. */
  state: "none" | "pending" | "passing" | "failing";
  failing: { name: string; url?: string }[];
  pending: string[];
}

const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED", "EXPECTED"]);

/**
 * Reduce a check rollup to one verdict. Pure, so it is tested without GitHub.
 *
 * The rollup can carry the same check name more than once (a push run and a
 * pull_request run, or a re-run after a flake). A name counts as failing only
 * when NO entry of that name succeeded — a re-run that went green clears it.
 * CANCELLED, SKIPPED and NEUTRAL are not failures: a superseded run is cancelled,
 * and path-filtered jobs skip.
 */
export function summarizeCheckRollup(rollup: CheckRollupEntry[]): CheckVerdict {
  if (rollup.length === 0) return { state: "none", failing: [], pending: [] };

  const byName = new Map<string, CheckRollupEntry[]>();
  for (const e of rollup) {
    const name = e.name ?? e.context ?? "(unnamed check)";
    byName.set(name, [...(byName.get(name) ?? []), e]);
  }

  const failing: { name: string; url?: string }[] = [];
  const pending: string[] = [];
  for (const [name, entries] of byName) {
    const outcome = (e: CheckRollupEntry): string =>
      (e.__typename === "StatusContext" ? e.state : e.status === "COMPLETED" ? e.conclusion : e.status ?? e.state) ?? "";
    if (entries.some((e) => outcome(e) === "SUCCESS")) continue;
    if (entries.some((e) => PENDING_STATES.has(outcome(e)))) {
      pending.push(name);
      continue;
    }
    const red = entries.find((e) => FAILING_CONCLUSIONS.has(outcome(e)));
    if (red) failing.push({ name, url: red.detailsUrl ?? red.targetUrl });
  }

  if (pending.length > 0) return { state: "pending", failing, pending };
  if (failing.length > 0) return { state: "failing", failing, pending };
  return { state: "passing", failing, pending };
}

/** Read the PR's checks. A lookup failure answers `none`, i.e. review as before. */
export function getPRCheckVerdict(config: RepoConfig, prNumber: number, logger: Logger): CheckVerdict {
  try {
    const raw = gh([
      "pr", "view", String(prNumber),
      "--repo", config.githubRepo,
      "--json", "statusCheckRollup",
    ], config.repoPath);
    const data = JSON.parse(raw || "{}") as { statusCheckRollup?: CheckRollupEntry[] };
    return summarizeCheckRollup(data.statusCheckRollup ?? []);
  } catch (err) {
    logger.warn(`${config.name}: could not read checks on PR #${prNumber} — reviewing without the CI gate: ${err instanceof Error ? err.message : String(err)}`);
    return { state: "none", failing: [], pending: [] };
  }
}

/** Marker on every CI-gate bounce comment; counted to cap the bounce loop. */
export const CI_GATE_MARKER = "<!-- foreman-ci-gate -->";

/** Consecutive bounces allowed before the PR goes to review anyway. A check the
 *  builder cannot turn green (a broken workflow, a red base branch) must still
 *  reach a reviewer instead of cycling builder sessions forever. */
export const MAX_CI_BOUNCES = 2;

/**
 * How many CI-gate bounces this PR has had since the reviewer last reviewed it.
 * A reviewer verdict resets the count: it means the PR reached review.
 */
export function countCiBouncesSinceReview(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string | undefined,
  logger: Logger,
): number {
  try {
    const raw = gh([
      "pr", "view", String(prNumber),
      "--repo", config.githubRepo,
      "--json", "comments,reviews",
    ], config.repoPath);
    const data = JSON.parse(raw || "{}") as {
      comments?: { body?: string; createdAt?: string }[];
      reviews?: { author?: { login?: string }; submittedAt?: string }[];
    };
    const lastReviewMs = (data.reviews ?? [])
      .filter((r) => byReviewer(r, reviewerLogin) && r.submittedAt)
      .map((r) => new Date(r.submittedAt as string).getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    return (data.comments ?? []).filter(
      (c) => c.body?.includes(CI_GATE_MARKER) && c.createdAt && new Date(c.createdAt).getTime() > lastReviewMs,
    ).length;
  } catch (err) {
    logger.debug(`countCiBouncesSinceReview failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    // Unknown count → treat as capped, so a lookup failure can never start a loop.
    return MAX_CI_BOUNCES;
  }
}

/** The bounce comment the revise skill reads. */
export function ciBounceComment(verdict: CheckVerdict): string {
  const lines = verdict.failing.map((f) => `- **${f.name}**${f.url ? ` — ${f.url}` : ""}`);
  return [
    CI_GATE_MARKER,
    "**CI is red — sent back before review.** The review was not run; a reviewer would have blocked on this first.",
    "",
    "Failing checks:",
    ...lines,
    "",
    "Reproduce each one locally, fix the code (never the test), push, and the PR returns to review once CI is green.",
  ].join("\n");
}

/**
 * Send a red-CI PR back to revise: comment the failing checks on the PR. The
 * caller then reports each linked work item `inReview → changesRequested`
 * through its work source (on GitHub: `pr under review` → `pr pending actions`,
 * the label the revise phase picks up). The comment is PR-level and stays here.
 */
export function bounceForRedCI(
  config: RepoConfig,
  prNumber: number,
  verdict: CheckVerdict,
): void {
  gh([
    "pr", "comment", String(prNumber),
    "--repo", config.githubRepo,
    "--body", ciBounceComment(verdict),
  ], config.repoPath);
}

/**
 * Comment on a work item's issue. Used for announcements that belong to the
 * code host rather than the work source — a diverged feature branch (foreman#44)
 * is a git fact, so it is said on GitHub whatever source supplied the work.
 */
export function commentOnIssue(config: RepoConfig, issueNumber: number, body: string): void {
  gh([
    "issue", "comment", String(issueNumber),
    "--repo", config.githubRepo,
    "--body", body,
  ], config.repoPath);
}

// --- Promotion PR Creation ---

export interface PromotionIssue {
  number: number;
  title: string;
}

export function findReadyForProdIssues(
  repo: string,
  cwd: string,
  labels: LifecycleLabels,
  logger: Logger
): PromotionIssue[] {
  try {
    return getOpenIssues(repo, cwd, logger)
      .filter((i) => hasLabel(i, labels.readyForProd))
      .map((i) => ({ number: i.number, title: i.title }));
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger.debug("Failed to query ready-for-prod issues — GitHub back-off active");
      return [];
    }
    logger.error("Failed to query ready-for-prod issues", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface OpenPromotionPR {
  number: number;
  url: string;
  body: string;
}

export function findOpenPromotionPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): OpenPromotionPR | null {
  try {
    const prs: OpenPromotionPR[] = findOpenPrs(repo, cwd, { base: productionBranch, head: baseBranch, limit: 1 });
    return prs.length > 0 ? prs[0] : null;
  } catch (err) {
    logger?.warn("findOpenPromotionPR: gh pr list failed", { ...formatGhError(err) });
    return null;
  }
}

/**
 * A PR's state on GitHub, read live: the fleet state holds open PRs only, so a
 * PR that left it may have merged or been closed unmerged. Null when the read
 * failed.
 */
export function getPrState(repo: string, prNumber: number, cwd: string, logger?: Logger): "OPEN" | "MERGED" | "CLOSED" | null {
  try {
    const out = gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "state"], cwd);
    const state = (JSON.parse(out || "{}") as { state?: string }).state;
    return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
  } catch (err) {
    logger?.warn(`getPrState: gh pr view #${prNumber} failed`, { ...formatGhError(err) });
    return null;
  }
}

export function updatePromotionPR(
  repo: string,
  prNumber: number,
  issues: PromotionIssue[],
  cwd: string,
): boolean {
  const issueList = issues
    .map((i) => `- #${i.number}: ${i.title}`)
    .join("\n");

  const title = issues.length === 1
    ? `release: ${issues[0].title}`
    : `release: promote ${issues.length} changes to production`;

  const body = `## Production Promotion

### Issues included
${issueList}

---
Automated by slashbin-ai-agent`;

  // REST, NOT `gh pr edit` (2026-07-27).
  //
  // `gh pr edit` resolves the PR through GraphQL and requests `projectCards` —
  // GitHub's Projects *classic*, now sunset. The API rejects that field, gh
  // exits 1, and the edit DOES NOT APPLY:
  //
  //   GraphQL: Projects (classic) is being deprecated in favor of the new
  //   Projects experience (repository.pullRequest.projectCards)
  //
  // Reproduced twice against jerky_data_receiver#241 — exit 1, title unchanged.
  // This silently blocked EVERY repo that already had an open promotion PR,
  // from ~04:11Z until it was found at ~21:10Z: the promote phase kept logging
  // "Found N issue(s) ready for prod release" and then failing to act. Creating
  // a NEW promotion PR still worked, which is why some promotions got through
  // and others did not — a confusing signal that delayed the diagnosis.
  //
  // The REST endpoint touches no Projects field at all, so the deprecation
  // cannot affect it. Do not "simplify" this back to `gh pr edit`.
  const [owner, name] = repo.split("/");
  try {
    gh([
      "api", "--method", "PATCH",
      `repos/${owner}/${name}/pulls/${prNumber}`,
      "-f", `title=${title}`,
      "-f", `body=${body}`,
      "--silent",
    ], cwd);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    console.error(`updatePromotionPR failed: ${msg}${stderr ? ` | stderr: ${stderr}` : ""}`);
    return false;
  }
}

/**
 * Count files that differ between base and head branches.
 * Returns -1 if the check fails. Used as a precondition for promotion PRs
 * so the Foreman never opens a no-op PR when develop is ahead of main
 * only by sync merge commits with no file diff.
 */
export function countBranchDiffFiles(
  repo: string,
  base: string,
  head: string,
  cwd: string,
  logger: Logger,
): number {
  try {
    const json = gh([
      "api",
      `repos/${repo}/compare/${base}...${head}`,
      "--jq", "{ahead: .ahead_by, files: (.files // [] | length)}",
    ], cwd);
    const parsed = JSON.parse(json || "{}") as { ahead?: number; files?: number };
    return typeof parsed.files === "number" ? parsed.files : -1;
  } catch (err) {
    logger.warn(`countBranchDiffFiles failed for ${repo} (${base}...${head}): ${err instanceof Error ? err.message : String(err)}`);
    return -1;
  }
}

/**
 * Strip the `ready for prod release` label from issues once a promotion PR
 * has been created for them. Prevents a race with the EM verification script:
 * after a promotion PR merges, the Foreman's next poll would otherwise still
 * see the label (EM strips it only at close time, 1-2 min later) and create
 * a phantom follow-up promotion PR.
 */
export function stripReadyForProdLabel(
  repo: string,
  issueNumbers: number[],
  cwd: string,
  labels: LifecycleLabels,
  logger: Logger,
): void {
  for (const num of issueNumbers) {
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", repo,
        "--remove-label", labels.readyForProd,
      ], cwd);
      logger.info(`Stripped "${labels.readyForProd}" from #${num} — promotion PR owns it now`);
    } catch (err) {
      logger.warn(`Failed to strip "${labels.readyForProd}" from #${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function createPromotionPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  issues: PromotionIssue[],
  cwd: string,
  logger?: Logger,
): string | null {
  const issueList = issues
    .map((i) => `- #${i.number}: ${i.title}`)
    .join("\n");

  const title = issues.length === 1
    ? `release: ${issues[0].title}`
    : `release: promote ${issues.length} changes to production`;

  const body = `## Production Promotion

### Issues included
${issueList}

---
Automated by slashbin-ai-agent`;

  try {
    const result = gh([
      "pr", "create",
      "--repo", repo,
      "--base", productionBranch,
      "--head", baseBranch,
      "--title", title,
      "--body", body,
    ], cwd);

    // Extract PR URL from output
    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    return match ? match[0] : null;
  } catch (err) {
    logger?.warn("createPromotionPR: gh pr create failed", {
      ...formatGhError(err),
      repo,
      productionBranch,
      baseBranch,
      issueNumbers: issues.map((i) => i.number),
    });
    return null;
  }
}

// --- Session reports (observers only) ---

/** Each of `numbers` with its open issue's title, from the cycle's issue snapshot. Empty on a failed read. */
export function issueTitles(config: RepoConfig, numbers: ReadonlyArray<number>, logger: Logger): Record<number, string> {
  const out: Record<number, string> = {};
  try {
    for (const i of getOpenIssues(config.githubRepo, config.repoPath, logger)) {
      if (numbers.includes(i.number) && i.title) out[i.number] = i.title;
    }
  } catch (err) {
    logger.debug(`issueTitles failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/** A PR's title and diff stat, for a session summary. Null when it could not be read. */
export function readPrDigest(
  repo: string,
  pr: string | number,
  cwd: string,
  logger: Logger,
): { number: number; url: string; title: string; additions: number; deletions: number; changedFiles: number } | null {
  try {
    const out = gh(["pr", "view", String(pr), "--repo", repo, "--json", "number,url,title,additions,deletions,changedFiles"], cwd);
    const j = JSON.parse(out || "{}");
    return typeof j.number === "number" ? j : null;
  } catch (err) {
    logger.debug(`readPrDigest: gh pr view ${pr} failed: ${formatGhError(err).message}`);
    return null;
  }
}

/**
 * The body of the newest review posted on `pr` at or after `since` (ISO), the
 * one a review session just wrote. Null when there is none or the read failed.
 */
export function readLatestReviewBody(repo: string, pr: number, since: string, cwd: string, logger: Logger): string | null {
  try {
    const out = gh(["api", `repos/${repo}/pulls/${pr}/reviews?per_page=100`], cwd);
    const reviews = (JSON.parse(out || "[]") as Array<{ body?: string; submitted_at?: string }>)
      .filter((r) => (r.body ?? "").trim() && Date.parse(r.submitted_at ?? "") >= Date.parse(since));
    return reviews.length ? reviews[reviews.length - 1].body ?? null : null;
  } catch (err) {
    logger.debug(`readLatestReviewBody: PR #${pr} failed: ${formatGhError(err).message}`);
    return null;
  }
}

/**
 * How many CHANGES_REQUESTED reviews a PR has collected — the number of review
 * rounds it has been sent back on. Read from GitHub each time, never counted
 * locally. Null when it cannot be read.
 */
export function countChangesRequested(repo: string, pr: number, cwd: string, logger: Logger): number | null {
  try {
    const out = gh(["api", `repos/${repo}/pulls/${pr}/reviews?per_page=100`], cwd);
    return (JSON.parse(out || "[]") as Array<{ state?: string }>).filter((r) => r.state === "CHANGES_REQUESTED").length;
  } catch (err) {
    logger.debug(`countChangesRequested: PR #${pr} failed: ${formatGhError(err).message}`);
    return null;
  }
}

// --- Post-Implementation Self-Check ---

/**
 * After a PR is created, verify it has actual file changes.
 * Returns the count of changed files, or -1 if check fails.
 * Logs the changed files for traceability (Second Way).
 */
export function checkPRHasChanges(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger: Logger,
): number {
  try {
    const json = gh([
      "pr", "list",
      "--repo", repo,
      "--head", headBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "number,files",
      "--limit", "1",
    ], cwd);

    const prs = JSON.parse(json || "[]");
    if (prs.length === 0) return -1;

    const files: { path: string }[] = prs[0].files || [];
    if (files.length === 0) {
      logger.warn("PR has no file changes — implementation may have failed silently");
      return 0;
    }

    logger.info(`PR #${prs[0].number} modifies ${files.length} file(s): ${files.map((f: { path: string }) => f.path).join(", ")}`);
    return files.length;
  } catch (err) {
    logger.warn("checkPRHasChanges: gh pr list failed", { ...formatGhError(err) });
    return -1;
  }
}

/**
 * Read the current HEAD SHA of a remote branch via the GitHub API.
 * Returns null on lookup failure so callers can decide how to react —
 * a transient gh error should not be conflated with a real "branch unchanged"
 * signal.
 */
export function getRemoteBranchSha(
  repo: string,
  branch: string,
  cwd: string,
  logger: Logger,
): string | null {
  try {
    const sha = gh([
      "api",
      `repos/${repo}/branches/${encodeURIComponent(branch)}`,
      "--jq", ".commit.sha",
    ], cwd);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (err) {
    logger.warn("getRemoteBranchSha: gh api failed", { ...formatGhError(err), repo, branch });
    return null;
  }
}

// --- Branch Sync ---

export interface BranchDrift {
  developBehindMain: number;
  developAheadOfMain: number;
  /** Files differing between main and develop. Zero means merge-commit-only drift. */
  developAheadFiles: number;
}

/**
 * Check if develop has drifted behind main due to accumulated merge commits.
 * Returns the drift counts, or null if the check fails.
 */
export function checkBranchDrift(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  cwd: string,
  logger: Logger,
): BranchDrift | null {
  try {
    const json = gh([
      "api", `repos/${repo}/compare/${productionBranch}...${baseBranch}`,
      "--jq", '{"ahead": .ahead_by, "behind": .behind_by, "files": ((.files // []) | length)}',
    ], cwd);

    const result = JSON.parse(json);
    return {
      developAheadOfMain: result.ahead,
      developBehindMain: result.behind,
      // Changed files between main and develop. `ahead > 0 && files === 0` is the
      // NORMAL steady state, not a stall: the main -> develop sync PR leaves a
      // merge commit on develop that main does not have, carrying no file change.
      // Counting commits alone flags every repo, forever. GitHub truncates this
      // array on very large diffs but never empties it, so 0 really means 0.
      developAheadFiles: result.files ?? 0,
    };
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger.debug("Failed to check branch drift — GitHub back-off active");
      return null;
    }
    logger.error("Failed to check branch drift", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check if a sync PR (main → develop) already exists.
 */
export function findOpenSyncPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): OpenPromotionPR | null {
  try {
    const prs: OpenPromotionPR[] = findOpenPrs(repo, cwd, { base: baseBranch, head: productionBranch, limit: 1 });
    return prs.length > 0 ? prs[0] : null;
  } catch (err) {
    logger?.warn("findOpenSyncPR: gh pr list failed", { ...formatGhError(err) });
    return null;
  }
}

/**
 * Create a sync PR to merge main back into develop, then immediately
 * approve + merge it. Created as slashbin-foreman (Foreman token), approved
 * and merged as slashbin-engineering-manager (EM token) to satisfy
 * branch protection's "no self-approval" rule.
 *
 * This eliminates the stale sync PR race condition where develop
 * advances between PR creation and external merge.
 */
export function createSyncPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  behindBy: number,
  cwd: string,
  logger?: Logger,
): string | null {
  try {
    const result = gh([
      "pr", "create",
      "--repo", repo,
      "--base", baseBranch,
      "--head", productionBranch,
      "--title", `chore: sync ${baseBranch} with ${productionBranch} (merge commits backfill)`,
      "--body", `## Branch Sync\n\nSync \`${baseBranch}\` with \`${productionBranch}\` to backfill ${behindBy} merge commit(s) from prior promotions. No code changes — only merge commit history alignment.\n\n---\nAutomated by slashbin-ai-agent`,
    ], cwd);

    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    const prUrl = match ? match[0] : null;

    if (!prUrl) return null;

    // Extract PR number from URL
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    if (!prNumberMatch) return prUrl;

    const prNumber = prNumberMatch[1];

    // Immediately approve + merge using the EM token
    try {
      ghAsEM([
        "pr", "review", prNumber,
        "--repo", repo,
        "--approve",
        "--body", "Automated sync — approved by EM.",
      ], cwd);

      ghAsEM([
        "pr", "merge", prNumber,
        "--repo", repo,
        "--merge",
      ], cwd);

      logger?.info(`Sync PR #${prNumber} created and merged immediately`);
    } catch (mergeErr) {
      // Expected on any repo with required status checks: the merge is attempted
      // seconds after creation, while build/test/typecheck are still IN_PROGRESS,
      // so branch protection refuses it. Not fatal — `tryMergeSyncPR` retries on a
      // later cycle once the checks land. See its comment for why that retry is
      // load-bearing rather than cosmetic.
      logger?.warn(`Sync PR #${prNumber} created but immediate auto-merge failed (will retry next cycle): ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
    }

    return prUrl;
  } catch (err) {
    logger?.warn("createSyncPR: gh pr create failed", { ...formatGhError(err), repo, behindBy });
    return null;
  }
}

/**
 * Merge an already-open sync PR. Returns true only if it is merged afterwards.
 *
 * WHY THIS EXISTS (2026-07-30). `createSyncPR` approves and merges the instant it
 * creates the PR — seconds later, while required status checks are still
 * IN_PROGRESS. On any repo with branch protection that merge is refused. The old
 * code caught that, said "the PR still exists for manual merge", and moved on;
 * the caller then logged "Sync PR created and auto-merged" regardless, and on
 * every later cycle logged "Sync PR already open" and returned early WITHOUT ever
 * retrying. So the merge never happened, the log claimed it had, and the sync PR
 * stayed open forever.
 *
 * That is not cosmetic. `develop` stays behind `main`, which makes the next
 * promotion PR `BEHIND`, which branch protection refuses to merge. Observed on
 * `Slashbin-console#779`: open 2h48m across ~140 no-op cycles, blocking the
 * promotion of #782 until it was merged by hand. The same "created and
 * auto-merged" line had already been logged for #438, #559 and #783.
 *
 * Idempotent by construction: re-approving an approved PR and merging a merged
 * PR are both no-ops we treat as success, so retrying every cycle is safe.
 */
export function tryMergeSyncPR(
  repo: string,
  prNumber: number,
  cwd: string,
  logger?: Logger,
): boolean {
  try {
    // Re-approve defensively: on the retry path the original approval is already
    // there, and gh treats a repeat approval as a no-op.
    try {
      ghAsEM([
        "pr", "review", String(prNumber),
        "--repo", repo,
        "--approve",
        "--body", "Automated sync — approved by EM.",
      ], cwd);
    } catch {
      // Already approved, or approval not required. Not a reason to skip the merge.
    }

    ghAsEM([
      "pr", "merge", String(prNumber),
      "--repo", repo,
      "--merge",
    ], cwd);
    return true;
  } catch (err) {
    // Still blocked (checks pending, conflict, protection). Report at debug so a
    // normal cycle isn't noisy — the caller reports the durable state.
    logger?.debug(`Sync PR #${prNumber} not mergeable yet: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// --- Dependency PRs (Dependabot) ---

/**
 * Open Dependabot PRs into any of `bases`, and nothing else.
 *
 * **Why a list and not one branch (owner decision, 2026-09-07).** Dependabot is
 * moving from `target-branch: develop` to `target-branch: features`, so that a
 * dependency bump travels `features → develop → main` like every other change
 * instead of landing on `develop` and leaving `features` behind. That retarget
 * happens one repo at a time and cannot be simultaneous with this code change:
 * whichever went first, every dependency PR in the gap would be invisible here
 * and would sit unmerged with nothing logged. Accepting both branches for the
 * duration is the additive half of that swap. Drop `develop` once no repo aims
 * dependabot at it.
 *
 * Dependabot PRs never carry a linked issue, so the review phase cannot see
 * them: it is scoped to `features → develop` PRs and every step after the merge
 * (labelling, follow-up filing, the outcome trailer) is expressed in terms of an
 * issue. Rather than widen the skill that reviews and merges ALL feature work —
 * the highest-blast-radius thing here — these get their own mechanical path,
 * shaped exactly like the `main → develop` sync merge above: a narrow rule, no
 * agent, no issue.
 *
 * **The head-branch test is the safety property, not the label.** Dependabot
 * labels its PRs `dependencies` by default, but a label is something any account
 * can apply; `dependabot/*` is a branch only Dependabot writes. Selecting on the
 * branch means a mislabelled human PR can never be swept into an unreviewed
 * merge.
 */
/**
 * The branches a dependency PR may legitimately target, for one repo.
 *
 * BOTH the feature branch and the base branch, because a dependency update is
 * now work on either one and a mechanical merge on neither.
 *
 * **This function used to be `dependencyMergeBases` and it named the branches a
 * bump could be MERGED into without a session. That phase is gone.** Retargeting
 * Dependabot at `features` only governs pull requests it opens from now on; on
 * 2026-09-07 twenty-four of the twenty-eight already open were sitting on
 * `develop`, where the merge phase would have swept them in on a green check
 * rollup — no session, no build, no boot. Excluding `features` from a mechanical
 * merge while leaving `develop` in it moved the defect one branch over rather
 * than removing it.
 *
 * The production branch (`main` by default) stays excluded outright: a dependency update must never be worked
 * against the production branch, which is what `jerky_shipping#237` closed on
 * the producing side.
 *
 * Pure, exported and tested because that exclusion is the safety property.
 */
export function dependencyBatchBases(
  featureBranch: string | undefined,
  baseBranch: string | undefined,
  productionBranch: string,
): string[] {
  return [...new Set([featureBranch, baseBranch])]
    .filter((b): b is string => !!b && b !== productionBranch);
}

export function findDependencyPRs(
  repo: string,
  cwd: string,
  bases: readonly string[],
  logger?: Logger,
): PrSnapshot[] {
  const allowed = new Set(bases);
  try {
    return getOpenPrs(repo, cwd).filter(
      (p) => allowed.has(p.baseRefName) && p.headRefName.startsWith("dependabot/"),
    );
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger?.debug("findDependencyPRs: gh pr list failed — GitHub back-off active");
      return [];
    }
    logger?.warn("findDependencyPRs: gh pr list failed", { ...formatGhError(err), repo, bases: [...allowed] });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dependency BATCH issues — the path for bumps aimed at the feature branch
// ---------------------------------------------------------------------------

/**
 * Every dependency-batch issue title starts with this, and that prefix is the
 * whole idempotency mechanism: at most one open batch issue per repo, matched
 * off the open-issue snapshot that is already fetched every cycle. No marker
 * label to create on twenty repos, no extra API call, and nothing to drift.
 */
export const DEPENDENCY_BATCH_TITLE_PREFIX = "chore(deps): validate and land ";

/** One dependency PR, reduced to what the issue body needs to say about it. */
export interface DependencyChange {
  number: number;
  packages: string[];
  from?: string;
  to?: string;
  /** True when the leading version component moves. `0.x` counts every minor. */
  major: boolean;
}

/**
 * Read a Dependabot PR title into packages and versions.
 *
 * Dependabot writes four shapes, all of them seen live on 2026-09-07:
 *   `chore(deps): bump vite from 5.4.21 to 8.2.2`
 *   `chore(deps-dev): bump react-dom and @types/react-dom in /desktop`
 *   `chore(deps): bump qs and express`
 *   `Bump form-data from 4.0.5 to 4.0.6`
 *
 * A grouped bump carries no versions in its title, so `from`/`to` stay undefined
 * and `major` is false — deliberately understated rather than guessed. The issue
 * body says to read the PR for those, because inventing a version here would put
 * a wrong number in front of the person deciding whether to approve.
 */
export function describeDependencyPR(number: number, title: string): DependencyChange {
  const versioned = /\bbump\s+(.+?)\s+from\s+(\S+)\s+to\s+(\S+)/i.exec(title);
  if (versioned) {
    return {
      number,
      packages: [versioned[1].trim()],
      from: versioned[2],
      to: versioned[3],
      major: isMajorBump(versioned[2], versioned[3]),
    };
  }
  const grouped = /\bbump\s+(.+?)(?:\s+in\s+\S+)?\s*$/i.exec(title);
  const packages = grouped
    ? grouped[1].split(/\s*,\s*|\s+and\s+/).map((p) => p.trim()).filter(Boolean)
    : [];
  return { number, packages, major: false };
}

/**
 * Does this version move break compatibility by semver convention?
 *
 * `0.x` is the case that matters here and the one a naive major-compare gets
 * wrong: under semver a `0.y` release may break on every minor, which is exactly
 * how `esbuild` 0.25 → 0.28 behaves. Treating that as "not a major" would file
 * a batch issue claiming a breaking upgrade is routine.
 */
export function isMajorBump(from: string, to: string): boolean {
  const parse = (v: string) => v.replace(/^[^0-9]*/, "").split(".").map((n) => parseInt(n, 10));
  const [fMaj, fMin] = parse(from);
  const [tMaj, tMin] = parse(to);
  if (!Number.isFinite(fMaj) || !Number.isFinite(tMaj)) return false;
  if (fMaj !== tMaj) return true;
  if (fMaj === 0) return Number.isFinite(fMin) && Number.isFinite(tMin) && fMin !== tMin;
  return false;
}

/**
 * The batch issue for a set of dependency PRs — title and body, pure.
 *
 * **Why an issue at all (owner decision, 2026-09-07).** Every stage after
 * implement is keyed on an issue: the review phase starts from issues labelled
 * `pr under review` and only then looks for the PR, promotion queries issues
 * carrying the EM gate, and the promotion PR body is a list of issue numbers. A
 * dependency PR with no issue can reach `develop` and then has no route to
 * `main` at all. Filing one puts an upgrade through the same pipeline as every
 * other change — including the implement session that actually builds it, starts
 * the app and smoke-tests it, which is the step a CI-rollup merge never did.
 *
 * Filed with the trigger label only on a pre-approved repo — see
 * `createDependencyBatchIssue`.
 */
export function buildDependencyBatchIssue(
  featureBranch: string,
  changes: readonly DependencyChange[],
): { title: string; body: string } {
  const majors = changes.filter((c) => c.major);
  const n = changes.length;
  const title =
    `${DEPENDENCY_BATCH_TITLE_PREFIX}${n} dependency update${n === 1 ? "" : "s"} on \`${featureBranch}\`` +
    (majors.length > 0 ? ` (${majors.length} major)` : "");

  const row = (c: DependencyChange) => {
    const pkg = c.packages.length ? c.packages.join(", ") : "(see PR)";
    const move = c.from && c.to ? `\`${c.from}\` → \`${c.to}\`` : "grouped — read the PR";
    return `| #${c.number} | ${pkg} | ${move} | ${c.major ? "**yes**" : "no"} |`;
  };

  const body = [
    `## Problem`,
    ``,
    `${n} Dependabot pull request${n === 1 ? "" : "s"} target \`${featureBranch}\` and ${n === 1 ? "is" : "are"} not merged.`,
    `They do not reach \`develop\` on their own: a bump aimed at the feature branch has no`,
    `mechanical merge path, because a CI check rollup proves the code compiles and never`,
    `proves the application still runs.`,
    ``,
    majors.length > 0
      ? `**${majors.length} of these ${majors.length === 1 ? "is a" : "are"} major version change${majors.length === 1 ? "" : "s"}.** A major bump is the class most likely to break a runtime while passing every check.`
      : `None of these crosses a major version.`,
    ``,
    `| PR | Package(s) | Version | Major |`,
    `|---|---|---|---|`,
    ...changes.map(row),
    ``,
    `## Required Changes`,
    ``,
    `Land every PR above on \`${featureBranch}\`, or leave behind the ones that cannot be landed`,
    `and say which and why. Merging them is not the work — **exercising them is**:`,
    ``,
    `1. Merge the branches into \`${featureBranch}\` locally.`,
    `2. Install from the lockfile as the deploy does, not with a resolver flag that papers over a peer conflict.`,
    `3. Build.`,
    `4. **Start the application and confirm it serves.** A dependency upgrade that compiles and does not boot is the failure this issue exists to catch.`,
    `5. Exercise the flows the changed packages sit under — a web framework means a real request through a real route; a date or validation library means the code paths that parse and format.`,
    ``,
    `If a PR fails any step, do not force it. Drop it from the batch, keep the rest, and record`,
    `the failure and the step it failed at.`,
    ``,
    `## Acceptance`,
    ``,
    `- **No-Script:** the caller-facing surface of a dependency upgrade is the running application itself, and the evidence is the smoke test the implement session performs against it — build, boot, and a real request through the flows the changed packages sit under. A committed script would assert the lockfile, which is the half that already passes today.`,
    ``,
    `### Automated checks`,
    ``,
    `- The repo's build succeeds.`,
    `- The repo's test suite passes.`,
    `- The application starts and answers its health route.`,
    ``,
    `### Human validation`,
    ``,
    `- Confirm the PR names each landed package and its version, and names any PR dropped from the batch with the step it failed at.`,
    ``,
    `## Pre-Flight`,
    ``,
    `- **Design locked.** Land and exercise the listed PRs; drop and report the ones that fail. No open decision.`,
    `- **Preconditions:** none. The PRs already exist and target \`${featureBranch}\`.`,
    `- **Dev-safety: read-only, no customer writes.** A dependency upgrade changes no request handler, no worker and no outbound integration by itself. The smoke test exercises the app's own routes; it writes to no external system.`,
    ``,
    `## References`,
    ``,
    ...changes.map((c) => `- #${c.number}`),
    ``,
    `_Filed automatically by the Foreman: Dependabot PRs targeting \`${featureBranch}\` accumulate with no merge path until one of these exists._`,
  ].join("\n");

  return { title, body };
}

/**
 * The open dependency-batch issue for a repo, if one exists.
 *
 * Reads the per-cycle open-issue snapshot rather than issuing its own query, so
 * this costs nothing on the twenty-repo sweep.
 */
export function findOpenDependencyBatchIssue(
  repo: string,
  cwd: string,
  logger: Logger,
): IssueSnapshot | undefined {
  return getOpenIssues(repo, cwd, logger)
    .find((i) => i.title.startsWith(DEPENDENCY_BATCH_TITLE_PREFIX));
}

/**
 * The `gh` argv that files a batch issue. Pure and exported because the label
 * on it is the whole behaviour, in both directions: drop it on a pre-approved
 * repo and that repo's batches stall unapproved again (as every repo's did from
 * 2026-09-07 to 2026-09-29); add it on a repo the owner never pre-approved and
 * the Foreman flies work nobody authorized. `label` is null for the latter.
 */
export function dependencyBatchIssueCreateArgs(
  repo: string,
  title: string,
  body: string,
  label: string | null,
): string[] {
  const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
  return label ? [...args, "--label", label] : args;
}

/**
 * File one dependency-batch issue — carrying `label` when the repo is
 * pre-approved, bare otherwise. Returns its number, or null if `gh` refused.
 *
 * **Pre-authorized (owner decision, 2026-09-29).** From 2026-09-07 these were
 * filed WITHOUT the trigger label so the owner would approve each batch by hand.
 * None was ever approved: six sat open for 22 days, and because an open batch
 * blocks the next one, every Dependabot PR opened after them — security updates
 * included — never reached a session at all. A gate nobody operates is not a
 * gate, it is a stall.
 *
 * Standing authorization is safe here because the flight carries its own
 * checks: the session drops any bump that fails to build or boot, the review
 * phase reviews the resulting `features → develop` PR like any other, the merge
 * deploys to dev, and nothing reaches `main` without the EM outcome gate. This
 * is maintenance on existing code — the class of work the Foreman may approve
 * for itself (slashbin-ai-foreman#37) — never a new feature or a spec change.
 *
 * **Scoped per repo (same day, owner correction).** The authorization covers
 * slashbin.io repos only; a customer's repo is the customer's call. It is an
 * opt-in `dependencyPreApproved` flag on the repo's config, default off, so a
 * newly onboarded repo can never inherit it by omission.
 */
export function createDependencyBatchIssue(
  repo: string,
  cwd: string,
  title: string,
  body: string,
  label: string | null,
  logger?: Logger,
): number | null {
  try {
    const out = gh(dependencyBatchIssueCreateArgs(repo, title, body, label), cwd);
    const m = /\/issues\/(\d+)/.exec(out);
    return m ? parseInt(m[1], 10) : null;
  } catch (err) {
    logger?.warn("createDependencyBatchIssue: gh issue create failed", { ...formatGhError(err), repo });
    return null;
  }
}

/*
 * `tryMergeDependencyPR` lived here and merged a Dependabot PR whenever its
 * check rollup was green. It was deleted on 2026-09-07: a rollup proves the code
 * compiles and the unit tests pass, and never that the application still starts.
 * Dependency updates now go through `buildDependencyBatchIssue` and the implement
 * session, which builds and boots. Nothing merges a dependency PR without one.
 */

// --- PR Verification ---

export function verifyPRExists(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): boolean {
  try {
    const prs = findOpenPrs(repo, cwd, { head: headBranch, base: baseBranch, limit: 1 });
    return prs.length > 0;
  } catch (err) {
    logger?.warn("verifyPRExists: gh pr list failed", { ...formatGhError(err), repo, headBranch, baseBranch });
    return false;
  }
}

/**
 * Read the open feature PR's body + title + commit messages and extract every
 * issue number referenced via standard GitHub keywords ("Related to #N",
 * "Closes #N", "Fixes #N", "Resolves #N", "Refs #N", "See #N"). Used by the
 * orchestrator to know which subset of `actionableIssues` the implementation
 * skill actually addressed — under the canonical one-issue-per-invocation
 * skill (jerky_data_receiver#43 and friends), the skill picks one issue from a
 * batch but the orchestrator must NOT label the unpicked issues as
 * `pr under review`, or they get stuck waiting forever for revision activity.
 *
 * Returns the parsed issue numbers (deduped). On lookup or parse failure
 * returns null so callers can fall back to existing behavior rather than
 * silently dropping issues from the label transition.
 */
export function getReferencedIssuesFromOpenPR(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): number[] | null {
  try {
    // A new commit moves the head and an edited title/body bumps updatedAt, so
    // the PR's version from the fleet state is a safe key for what it implements.
    const json = ghKeyed(`refs:${repo}:${headBranch}:${baseBranch}`, () => openPrVersion(repo, headBranch, baseBranch), [
      "pr", "list",
      "--repo", repo,
      "--head", headBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "number,title,body,commits",
      "--limit", "1",
    ], cwd);
    const prs = JSON.parse(json || "[]");
    if (prs.length === 0) return null;
    const pr = prs[0];

    // Count an issue as referenced only if the PR IMPLEMENTS it (close/relate
    // keyword anywhere, or `(#N)` in the title / a commit headline) — never a
    // bare `(#N)` mention in the free-text body. A schema PR whose body said
    // "the forthcoming handler (#2) will..." otherwise falsely marked #2
    // implemented, orphaning it. (slashbin-ai-foreman#28)
    const commits = (pr.commits || []) as { messageHeadline?: string; messageBody?: string }[];
    return extractImplementedIssues({
      title: pr.title || "",
      body: pr.body || "",
      commitHeadlines: commits.map((c) => c.messageHeadline || ""),
      commitBodies: commits.map((c) => c.messageBody || ""),
    });
  } catch (err) {
    logger?.warn("getReferencedIssuesFromOpenPR: gh pr list failed", { ...formatGhError(err), repo, headBranch, baseBranch });
    return null;
  }
}


/**
 * The work in flight a custom stage runs against: the open feature → base PR,
 * its head, and the issues it implements (same reading as
 * getReferencedIssuesFromOpenPR). `null` when no such PR is open. Throws when
 * the lookup itself fails — a stage that gates must not read "could not look"
 * as "nothing to check".
 */
export function findOpenFeaturePR(
  config: RepoConfig,
): { number: number; headSha: string; issueNumbers: number[] } | null {
  // Fleet state on: no open feature PR in it means nothing to check — at most
  // one refresh late, which only defers a stage, never skips one for good.
  // A thrown refresh propagates: the caller holds the later stages on it.
  if (issueCacheTtlMs > 0 && isGitHubStateEnabled(config.githubRepo)
    && !knownOpenPr(config.githubRepo, config.featureBranch, config.baseBranch)) {
    return null;
  }
  const json = ghKeyed(`feature:${config.githubRepo}`, () => openPrVersion(config.githubRepo, config.featureBranch, config.baseBranch), [
    "pr", "list",
    "--repo", config.githubRepo,
    "--head", config.featureBranch,
    "--base", config.baseBranch,
    "--state", "open",
    "--json", "number,title,body,commits,headRefOid",
    "--limit", "1",
  ], config.repoPath);
  const prs = JSON.parse(json || "[]") as Array<{
    number: number; title?: string; body?: string; headRefOid?: string;
    commits?: { messageHeadline?: string; messageBody?: string }[];
  }>;
  if (prs.length === 0) return null;
  const pr = prs[0];
  const commits = pr.commits || [];
  return {
    number: pr.number,
    headSha: pr.headRefOid || "",
    issueNumbers: extractImplementedIssues({
      title: pr.title || "",
      body: pr.body || "",
      commitHeadlines: commits.map((c) => c.messageHeadline || ""),
      commitBodies: commits.map((c) => c.messageBody || ""),
    }),
  };
}

/**
 * Decide, with no I/O, what a FAILED review run actually earned.
 *
 * Split out from `tryReview` for the same reason as `planEmGateRestore`: the
 * rule is the part worth pinning, and the `gh` calls around it are not.
 *
 * A review run that dies is not automatically a review that achieved nothing.
 * On 2026-09-22 one merged `jerky_skuvault_service#362`, verified it, then spent
 * its remaining 52 minutes polling a backfill that needed longer than the budget
 * it was never told about. The wall-clock kill reported `Review failed (1/2):
 * timed out`, skipped every post-condition check — they all lived inside the
 * success branch — and left the issue dead-zoned for 55 minutes. The merge had
 * already happened; the retry had nothing to retry. Issue #41.
 *
 * So the question is not "did the process exit cleanly" but "did the work land":
 *
 *  - Nothing merged → a plain failure. Charge the retry, exactly as before.
 *  - Something merged → the work landed and the run outlived it. Reconcile the
 *    labels this cycle instead of waiting for the dead-zone sweep, and do NOT
 *    charge a retry: the next cycle would find the PR merged and no work to do.
 *
 * `stillUnderReview` is asked for separately because a run can merge AND label
 * correctly before dying — in which case there is nothing left to reconcile and
 * only the retry accounting changes.
 */
export interface FailedReviewPlan {
  /** True when at least one of the run's issues reached the base branch. */
  workLanded: boolean;
  /** PRs the run merged, deduped, ascending. */
  mergedPrs: number[];
  /** Merged issues still sitting at `pr under review` — the labels to repair. */
  toReconcile: number[];
  /** Whether this run counts against the review retry/backoff counter. */
  chargeRetry: boolean;
}

export function planFailedReviewOutcome(
  mergedRefs: { issueNumber: number; prNumber: number }[],
  stillUnderReview: number[],
): FailedReviewPlan {
  if (mergedRefs.length === 0) {
    return { workLanded: false, mergedPrs: [], toReconcile: [], chargeRetry: true };
  }

  const mergedIssues = new Set(mergedRefs.map((m) => m.issueNumber));
  return {
    workLanded: true,
    mergedPrs: [...new Set(mergedRefs.map((m) => m.prNumber))].sort((a, b) => a - b),
    // Only issues we can actually tie to a merge. An issue still under review
    // whose PR never merged is CORRECTLY under review, and relabeling it would
    // be the same overreach the dead-zone guard exists to prevent.
    toReconcile: stillUnderReview.filter((n) => mergedIssues.has(n)),
    chargeRetry: false,
  };
}
