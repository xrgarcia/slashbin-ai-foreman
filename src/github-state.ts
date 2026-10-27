import { readFileSync, writeFileSync } from "node:fs";
import type { Logger } from "./logger.js";

/**
 * The Foreman's own view of open work on GitHub, for every configured repo,
 * refreshed by ONE bulk GraphQL query instead of per-repo `gh issue list` /
 * `gh pr list` calls.
 *
 * 2026-10-02: with no build running, the Foreman spent ~4,500 GraphQL points an
 * hour of a 5,000 cap just looking for work — 20 repos each listing open issues
 * and open PRs every 30 s, through two per-repo snapshots that each cost a
 * request on every refresh. The work itself barely changes between polls.
 *
 * So the snapshots now live here, for all repos at once:
 *   - a FULL refresh (every open issue + open PR, all repos, one query; paged
 *     per repo only past 100) at startup and every `fullRefreshMs`;
 *   - between those, a DELTA refresh: per repo, only issues and PRs updated
 *     since that repo was last synced — the 10 most recently updated of each,
 *     which on an idle fleet is nothing. A repo with more than 10 changes gets
 *     a full refresh of its own in the same pass.
 * A delta costs ~2–3 points for 20 repos, where the per-repo snapshots cost 40.
 *
 * Freshness is unchanged: the state is refreshed when older than `refreshMs`
 * (the old snapshot TTL), and a repo the Foreman — or a session it ran — just
 * wrote to is marked dirty and re-synced before the next read.
 *
 * The state is persisted next to `.agent-state.json`, so a restart resumes with
 * a delta instead of a cold full poll.
 *
 * Off unless `configureGitHubState` is called (the daemon does): callers fall
 * back to their own per-repo `gh` calls, so tests and library users that never
 * configure it see the old behaviour.
 */

export interface StateIssue {
  number: number;
  title: string;
  labels: { name: string }[];
  updatedAt: string;
}

export interface StatePr {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  updatedAt: string;
}

/** What the Foreman itself is doing to an item, from the work-source reports. */
export interface ActivityEntry {
  step: string;
  at: string;
  prUrl?: string;
}

interface RepoView {
  issues: StateIssue[];
  prs: StatePr[];
  /** ISO time the last successful sync of this repo STARTED — the next delta's `since`. */
  syncedAt: string | null;
  /** ISO time of the last full sync of this repo. */
  fullAt: string | null;
  /** Bumped whenever a delta sees a PR leave the open set (merged or closed). */
  closedVersion: number;
}

interface Persisted {
  version: 1;
  savedAt: string;
  repos: Record<string, RepoView>;
  activity: Record<string, Record<string, ActivityEntry>>;
}

export interface GitHubStateOptions {
  repos: string[];
  /** Refresh when the state is older than this — the old snapshot TTL. */
  refreshMs: number;
  /** A full refresh at least this often (default 15 min). */
  fullRefreshMs?: number;
  /** Most open issues per repo a full refresh reads (the old snapshot limit). */
  issueLimit?: number;
  /** Where the state is persisted; omit to keep it in memory only. */
  persistPath?: string;
  /** Run `gh` with the Foreman token. Injected so this module has no gh of its own. */
  run: (args: string[]) => string;
  logger: Logger;
  now?: () => number;
}

/** Changes per repo a delta reads before it falls back to a full sync of that repo. */
const DELTA_WINDOW = 10;
/** A delta re-reads this much before `syncedAt`: clock skew, and GitHub write latency. */
const DELTA_OVERLAP_MS = 120_000;
const DEFAULT_FULL_REFRESH_MS = 15 * 60_000;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

let opts: GitHubStateOptions | null = null;
let views = new Map<string, RepoView>();
let activity: Record<string, Record<string, ActivityEntry>> = {};
let lastRefreshAt = 0;
/** The last failed refresh — re-thrown, not re-run, for a short while (see ensureFresh). */
let lastFailure: { at: number; err: unknown } | null = null;
const FAILURE_COOLDOWN_MS = 15_000;
const dirty = new Set<string>();

function now(): number {
  return opts?.now ? opts.now() : Date.now();
}

/** Turn the state on. Loads the persisted copy when there is one. */
export function configureGitHubState(o: GitHubStateOptions): void {
  opts = o;
  views = new Map();
  activity = {};
  lastRefreshAt = 0;
  lastFailure = null;
  dirty.clear();
  for (const repo of o.repos) {
    if (!REPO_RE.test(repo)) throw new Error(`github-state: not an owner/name repo: ${repo}`);
  }
  if (o.persistPath) {
    try {
      const saved = JSON.parse(readFileSync(o.persistPath, "utf-8")) as Persisted;
      if (saved.version === 1) {
        for (const repo of o.repos) {
          const v = saved.repos?.[repo];
          if (v && Array.isArray(v.issues) && Array.isArray(v.prs)) views.set(repo, v);
        }
        activity = saved.activity ?? {};
        o.logger.info("github-state: resumed from disk", { repos: views.size, savedAt: saved.savedAt });
      }
    } catch { /* no saved state — the first refresh is a full one */ }
  }
}

/** Follow a hot-reloaded repo list: new repos get a full sync on first read, removed ones are dropped. */
export function setGitHubStateRepos(repos: string[]): void {
  if (!opts) return;
  const valid = repos.filter((r) => REPO_RE.test(r));
  opts = { ...opts, repos: valid };
  for (const r of [...views.keys()]) if (!valid.includes(r)) views.delete(r);
}

/** Turn the state off (tests). */
export function resetGitHubState(): void {
  opts = null;
  lastFailure = null;
  views = new Map();
  activity = {};
  lastRefreshAt = 0;
  dirty.clear();
}

export function isGitHubStateEnabled(repo?: string): boolean {
  return opts !== null && (repo === undefined || opts.repos.includes(repo));
}

/** A write the Foreman made (or a session it ran may have made) to this repo. */
export function markRepoDirty(repo: string): void {
  if (opts?.repos.includes(repo)) dirty.add(repo);
}

export function markAllDirty(): void {
  for (const r of opts?.repos ?? []) dirty.add(r);
}

/** Every open issue in `repo`, refreshing first if stale. */
export function stateOpenIssues(repo: string): StateIssue[] {
  ensureFresh(repo);
  return views.get(repo)?.issues ?? [];
}

/** Every open PR in `repo`, refreshing first if stale. */
export function stateOpenPrs(repo: string): StatePr[] {
  ensureFresh(repo);
  return views.get(repo)?.prs ?? [];
}

/** Changes whenever a PR in `repo` was seen merged or closed — a cache key for merged/closed PR reads. */
export function closedVersion(repo: string): number {
  ensureFresh(repo);
  return views.get(repo)?.closedVersion ?? 0;
}

/** The state's own query count and GraphQL points since the last call — for the hourly gh-usage line. */
export function takeGitHubStateUsage(): { stateQueries: number; statePoints: number } {
  const out = { stateQueries: queriesRun, statePoints: pointsSpent };
  queriesRun = 0;
  pointsSpent = 0;
  return out;
}

/** Record a step the Foreman took on an item (from the work-source observer). */
export function recordActivity(repo: string, issueNumber: number, step: string, prUrl?: string): void {
  if (!opts) return;
  const items = (activity[repo] ??= {});
  const prior = items[String(issueNumber)];
  items[String(issueNumber)] = { step, at: new Date(now()).toISOString(), prUrl: prUrl ?? prior?.prUrl };
  markRepoDirty(repo);
  persist();
}

/** Forget an item the Foreman is done with. */
export function clearActivity(repo: string, issueNumber: number): void {
  if (!opts || !activity[repo]?.[String(issueNumber)]) return;
  delete activity[repo][String(issueNumber)];
  persist();
}

/** Items the Foreman is working on in `repo`, by issue number. */
export function activityFor(repo: string): Record<string, ActivityEntry> {
  return { ...(activity[repo] ?? {}) };
}

/** Everything, for diagnostics. */
export function gitHubStateSnapshot(): { enabled: boolean; queriesRun: number; pointsSpent: number; lastRefreshAt: string | null; repos: Record<string, { openIssues: number; openPrs: number; syncedAt: string | null; fullAt: string | null }>; activity: Record<string, Record<string, ActivityEntry>> } {
  const repos: Record<string, { openIssues: number; openPrs: number; syncedAt: string | null; fullAt: string | null }> = {};
  for (const [r, v] of views) repos[r] = { openIssues: v.issues.length, openPrs: v.prs.length, syncedAt: v.syncedAt, fullAt: v.fullAt };
  return { enabled: opts !== null, queriesRun, pointsSpent, lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null, repos, activity: structuredClone(activity) };
}

// ---------------------------------------------------------------------------

function ensureFresh(repo: string): void {
  if (!opts || !opts.repos.includes(repo)) return;
  const t = now();
  const stale = t - lastRefreshAt >= opts.refreshMs || !views.has(repo);
  if (!stale && !dirty.has(repo)) return;
  // A failed bulk query fails every repo's read at once. Without this, each of
  // the 20 repo loops would re-run the whole fleet query to fail again.
  if (lastFailure && t - lastFailure.at < FAILURE_COOLDOWN_MS) throw lastFailure.err;
  try {
    if (stale) refreshAll();
    else refresh([...dirty]);
    lastFailure = null;
  } catch (err) {
    lastFailure = { at: t, err };
    throw err;
  }
}

/** Refresh every configured repo in one pass. */
export function refreshAll(): void {
  if (!opts) return;
  refresh(opts.repos);
  lastRefreshAt = now();
}

function refresh(repos: string[]): void {
  if (!opts) return;
  const o = opts;
  const t = now();
  const fullEvery = o.fullRefreshMs ?? DEFAULT_FULL_REFRESH_MS;
  const full: string[] = [];
  const delta: string[] = [];
  for (const r of repos) {
    const v = views.get(r);
    if (!v || !v.syncedAt || !v.fullAt || t - Date.parse(v.fullAt) >= fullEvery) full.push(r);
    else delta.push(r);
  }
  const startedAt = new Date(t).toISOString();
  const overflow: string[] = [];

  // One query for every repo — full blocks and delta blocks side by side.
  const blocks: string[] = [];
  const aliases = new Map<string, { repo: string; kind: "full" | "delta" }>();
  [...full, ...delta].forEach((repo, i) => {
    const kind = full.includes(repo) ? "full" : "delta";
    const alias = `r${i}`;
    aliases.set(alias, { repo, kind });
    blocks.push(repoBlock(alias, repo, kind, kind === "delta" ? sinceFor(views.get(repo)!) : undefined));
  });
  if (blocks.length === 0) return;

  const data = graphql(`query { ${blocks.join("\n")} }`);
  for (const [alias, { repo, kind }] of aliases) {
    const node = data[alias] as RepoNode | null | undefined;
    if (!node) {
      o.logger.warn("github-state: repo missing from bulk response — keeping its last state", { repo });
      continue;
    }
    if (kind === "full") {
      applyFull(repo, node, startedAt);
    } else if (!applyDelta(repo, node, startedAt)) {
      overflow.push(repo);
    }
    dirty.delete(repo);
  }

  // More than DELTA_WINDOW changes since the last sync: read that repo whole.
  if (overflow.length > 0) {
    const fb = overflow.map((repo, i) => repoBlock(`r${i}`, repo, "full"));
    const d2 = graphql(`query { ${fb.join("\n")} }`);
    overflow.forEach((repo, i) => {
      const node = d2[`r${i}`] as RepoNode | null | undefined;
      if (node) applyFull(repo, node, startedAt);
    });
  }
  persist();
}

function sinceFor(v: RepoView): string {
  return new Date(Date.parse(v.syncedAt!) - DELTA_OVERLAP_MS).toISOString();
}

const ISSUE_FIELDS = "number title state updatedAt labels(first: 50) { nodes { name } }";
const PR_FIELDS = "number url title body state headRefName baseRefName headRefOid updatedAt";

function repoBlock(alias: string, repo: string, kind: "full" | "delta", since?: string, issuesAfter?: string): string {
  const [owner, name] = repo.split("/");
  const order = "orderBy: { field: UPDATED_AT, direction: DESC }";
  if (kind === "full") {
    const after = issuesAfter ? `, after: ${JSON.stringify(issuesAfter)}` : "";
    return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
  issues(states: OPEN, first: 100, ${order}${after}) { pageInfo { hasNextPage endCursor } nodes { ${ISSUE_FIELDS} } }
  pullRequests(states: OPEN, first: 100, ${order}) { pageInfo { hasNextPage endCursor } nodes { ${PR_FIELDS} } }
}`;
  }
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
  issues(first: ${DELTA_WINDOW}, filterBy: { since: ${JSON.stringify(since)} }, ${order}) { pageInfo { hasNextPage endCursor } nodes { ${ISSUE_FIELDS} } }
  pullRequests(first: ${DELTA_WINDOW}, ${order}) { pageInfo { hasNextPage endCursor } nodes { ${PR_FIELDS} } }
}`;
}

interface Conn<T> { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: T[] }
interface IssueNode { number: number; title: string; state: string; updatedAt: string; labels?: { nodes?: { name: string }[] } }
interface PrNode { number: number; url: string; title: string; body?: string | null; state: string; headRefName: string; baseRefName: string; headRefOid: string; updatedAt: string }
interface RepoNode { issues?: Conn<IssueNode>; pullRequests?: Conn<PrNode> }

/** GraphQL points the state's own queries spent, as GitHub reported them. */
let pointsSpent = 0;
let queriesRun = 0;

function graphql(query: string): Record<string, unknown> {
  const out = opts!.run(["api", "graphql", "-f", `query=${query.replace(/^query \{/, "query { rateLimit { cost } ")}`]);
  const parsed = JSON.parse(out || "{}") as { data?: Record<string, unknown>; errors?: { message?: string; path?: unknown[] }[] };
  // A repo that no longer resolves comes back as a null block plus an error;
  // the rest of the response is still good, so only an empty `data` is fatal.
  if (!parsed.data) {
    throw new Error(`github-state: bulk query failed: ${(parsed.errors ?? []).map((e) => e.message).join("; ") || "no data"}`);
  }
  queriesRun++;
  const cost = (parsed.data.rateLimit as { cost?: number } | undefined)?.cost;
  if (typeof cost === "number") pointsSpent += cost;
  if (parsed.errors?.length) {
    opts!.logger.warn("github-state: bulk query returned errors", { errors: parsed.errors.map((e) => e.message).slice(0, 5) });
  }
  return parsed.data;
}

function toIssue(n: IssueNode): StateIssue {
  return { number: n.number, title: n.title, labels: (n.labels?.nodes ?? []).map((l) => ({ name: l.name })), updatedAt: n.updatedAt };
}

function toPr(n: PrNode): StatePr {
  return {
    number: n.number, url: n.url, title: n.title, body: n.body ?? "",
    headRefName: n.headRefName, baseRefName: n.baseRefName, headRefOid: n.headRefOid, updatedAt: n.updatedAt,
  };
}

/** Newest first, the order `gh issue list` / `gh pr list` returned. */
function byNumberDesc<T extends { number: number }>(xs: T[]): T[] {
  return xs.sort((a, b) => b.number - a.number);
}

function applyFull(repo: string, node: RepoNode, startedAt: string): void {
  const o = opts!;
  const limit = o.issueLimit ?? 500;
  const issues = (node.issues?.nodes ?? []).map(toIssue);
  let page = node.issues?.pageInfo;
  // Past 100 open issues: page this one repo until done or at the limit.
  while (page?.hasNextPage && page.endCursor && issues.length < limit) {
    const d = graphql(`query { ${repoBlock("r0", repo, "full", undefined, page.endCursor)} }`);
    const n = d.r0 as RepoNode | null;
    issues.push(...(n?.issues?.nodes ?? []).map(toIssue));
    page = n?.issues?.pageInfo;
  }
  if (issues.length >= limit) {
    o.logger.warn("github-state: open-issue limit reached — discovery may be missing issues; raise issueSnapshotLimit", { repo, limit });
  }
  if (node.pullRequests?.pageInfo?.hasNextPage) {
    o.logger.warn("github-state: more than 100 open PRs — only the 100 most recently updated are tracked", { repo });
  }
  const prior = views.get(repo);
  views.set(repo, {
    issues: byNumberDesc(issues.slice(0, limit)),
    prs: byNumberDesc((node.pullRequests?.nodes ?? []).map(toPr)),
    syncedAt: startedAt,
    fullAt: startedAt,
    // A full read cannot tell which PRs closed since the last one — assume some did.
    closedVersion: (prior?.closedVersion ?? 0) + 1,
  });
}

/** Apply a delta. False when it saw a full window — the caller re-reads the repo whole. */
function applyDelta(repo: string, node: RepoNode, startedAt: string): boolean {
  const v = views.get(repo)!;
  const since = sinceFor(v);
  const issueNodes = node.issues?.nodes ?? [];
  const prNodes = (node.pullRequests?.nodes ?? []).filter((p) => p.updatedAt >= since);
  if (node.issues?.pageInfo?.hasNextPage || prNodes.length >= DELTA_WINDOW) return false;

  const issues = new Map(v.issues.map((i) => [i.number, i]));
  for (const n of issueNodes) {
    if (n.state === "OPEN") issues.set(n.number, toIssue(n));
    else issues.delete(n.number);
  }
  const prs = new Map(v.prs.map((p) => [p.number, p]));
  let closed = v.closedVersion;
  for (const n of prNodes) {
    if (n.state === "OPEN") prs.set(n.number, toPr(n));
    else {
      prs.delete(n.number);
      closed++;
    }
  }
  views.set(repo, {
    issues: byNumberDesc([...issues.values()]),
    prs: byNumberDesc([...prs.values()]),
    syncedAt: startedAt,
    fullAt: v.fullAt,
    closedVersion: closed,
  });
  return true;
}

function persist(): void {
  if (!opts?.persistPath) return;
  const out: Persisted = { version: 1, savedAt: new Date(now()).toISOString(), repos: Object.fromEntries(views), activity };
  try {
    writeFileSync(opts.persistPath, JSON.stringify(out));
  } catch {
    // Best-effort, like .agent-state.json — the next refresh rebuilds it.
  }
}
