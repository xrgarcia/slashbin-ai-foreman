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
 * The state is persisted in the Foreman's state directory, so a restart resumes with
 * a delta instead of a cold full poll.
 *
 * Off until `configure` is called (the daemon does, through the plugin): callers fall
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

const FAILURE_COOLDOWN_MS = 15_000;

/**
 * The fleet state. Its memory lives on the instance: the GitHub plugin owns the
 * one the daemon uses (`fleetState`), and a test builds its own.
 */
export class GitHubState {
  private opts: GitHubStateOptions | null = null;
  private views = new Map<string, RepoView>();
  private activity: Record<string, Record<string, ActivityEntry>> = {};
  private lastRefreshAt = 0;
  /** The last failed refresh — re-thrown, not re-run, for a short while (see ensureFresh). */
  private lastFailure: { at: number; err: unknown } | null = null;
  private readonly dirty = new Set<string>();
  /** GraphQL points the state's own queries spent, as GitHub reported them. */
  private pointsSpent = 0;
  private queriesRun = 0;

  private now(): number {
    return this.opts?.now ? this.opts.now() : Date.now();
  }

  /** Turn the state on. Loads the persisted copy when there is one. */
  configure(o: GitHubStateOptions): void {
    for (const repo of o.repos) {
      if (!REPO_RE.test(repo)) throw new Error(`github-state: not an owner/name repo: ${repo}`);
    }
    this.opts = o;
    this.views = new Map();
    this.activity = {};
    this.lastRefreshAt = 0;
    this.lastFailure = null;
    this.dirty.clear();
    if (o.persistPath) {
      try {
        const saved = JSON.parse(readFileSync(o.persistPath, "utf-8")) as Persisted;
        if (saved.version === 1) {
          for (const repo of o.repos) {
            const v = saved.repos?.[repo];
            if (v && Array.isArray(v.issues) && Array.isArray(v.prs)) this.views.set(repo, v);
          }
          this.activity = saved.activity ?? {};
          o.logger.info("github-state: resumed from disk", { repos: this.views.size, savedAt: saved.savedAt });
        }
      } catch { /* no saved state — the first refresh is a full one */ }
    }
  }

  /** Follow a hot-reloaded repo list: new repos get a full sync on first read, removed ones are dropped. */
  setRepos(repos: string[]): void {
    if (!this.opts) return;
    const valid = repos.filter((r) => REPO_RE.test(r));
    this.opts = { ...this.opts, repos: valid };
    for (const r of [...this.views.keys()]) if (!valid.includes(r)) this.views.delete(r);
  }

  isEnabled(repo?: string): boolean {
    return this.opts !== null && (repo === undefined || this.opts.repos.includes(repo));
  }

  /** A write the Foreman made (or a session it ran may have made) to this repo. */
  markRepoDirty(repo: string): void {
    if (this.opts?.repos.includes(repo)) this.dirty.add(repo);
  }

  markAllDirty(): void {
    for (const r of this.opts?.repos ?? []) this.dirty.add(r);
  }

  /** Every open issue in `repo`, refreshing first if stale. */
  openIssues(repo: string): StateIssue[] {
    this.ensureFresh(repo);
    return this.views.get(repo)?.issues ?? [];
  }

  /** Every open PR in `repo`, refreshing first if stale. */
  openPrs(repo: string): StatePr[] {
    this.ensureFresh(repo);
    return this.views.get(repo)?.prs ?? [];
  }

  /** Changes whenever a PR in `repo` was seen merged or closed — a cache key for merged/closed PR reads. */
  closedVersion(repo: string): number {
    this.ensureFresh(repo);
    return this.views.get(repo)?.closedVersion ?? 0;
  }

  /** The state's own query count and GraphQL points since the last call — for the hourly gh-usage line. */
  takeUsage(): { stateQueries: number; statePoints: number } {
    const out = { stateQueries: this.queriesRun, statePoints: this.pointsSpent };
    this.queriesRun = 0;
    this.pointsSpent = 0;
    return out;
  }

  /** Record a step the Foreman took on an item (from the work-source observer). */
  recordActivity(repo: string, issueNumber: number, step: string, prUrl?: string): void {
    if (!this.opts) return;
    const items = (this.activity[repo] ??= {});
    const prior = items[String(issueNumber)];
    items[String(issueNumber)] = { step, at: new Date(this.now()).toISOString(), prUrl: prUrl ?? prior?.prUrl };
    this.markRepoDirty(repo);
    this.persist();
  }

  /** Forget an item the Foreman is done with. */
  clearActivity(repo: string, issueNumber: number): void {
    if (!this.opts || !this.activity[repo]?.[String(issueNumber)]) return;
    delete this.activity[repo][String(issueNumber)];
    this.persist();
  }

  /** Items the Foreman is working on in `repo`, by issue number. */
  activityFor(repo: string): Record<string, ActivityEntry> {
    return { ...(this.activity[repo] ?? {}) };
  }

  /** Everything, for diagnostics. */
  snapshot(): { enabled: boolean; queriesRun: number; pointsSpent: number; lastRefreshAt: string | null; repos: Record<string, { openIssues: number; openPrs: number; syncedAt: string | null; fullAt: string | null }>; activity: Record<string, Record<string, ActivityEntry>> } {
    const repos: Record<string, { openIssues: number; openPrs: number; syncedAt: string | null; fullAt: string | null }> = {};
    for (const [r, v] of this.views) repos[r] = { openIssues: v.issues.length, openPrs: v.prs.length, syncedAt: v.syncedAt, fullAt: v.fullAt };
    return { enabled: this.opts !== null, queriesRun: this.queriesRun, pointsSpent: this.pointsSpent, lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null, repos, activity: structuredClone(this.activity) };
  }

  /** Refresh every configured repo in one pass. */
  refreshAll(): void {
    if (!this.opts) return;
    this.refresh(this.opts.repos);
    this.lastRefreshAt = this.now();
  }

  private ensureFresh(repo: string): void {
    if (!this.opts || !this.opts.repos.includes(repo)) return;
    const t = this.now();
    const stale = t - this.lastRefreshAt >= this.opts.refreshMs || !this.views.has(repo);
    if (!stale && !this.dirty.has(repo)) return;
    // A failed bulk query fails every repo's read at once. Without this, each of
    // the 20 repo loops would re-run the whole fleet query to fail again.
    if (this.lastFailure && t - this.lastFailure.at < FAILURE_COOLDOWN_MS) throw this.lastFailure.err;
    try {
      if (stale) this.refreshAll();
      else this.refresh([...this.dirty]);
      this.lastFailure = null;
    } catch (err) {
      this.lastFailure = { at: t, err };
      throw err;
    }
  }

  private refresh(repos: string[]): void {
    if (!this.opts) return;
    const o = this.opts;
    const t = this.now();
    const fullEvery = o.fullRefreshMs ?? DEFAULT_FULL_REFRESH_MS;
    const full: string[] = [];
    const delta: string[] = [];
    for (const r of repos) {
      const v = this.views.get(r);
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
      blocks.push(repoBlock(alias, repo, kind, kind === "delta" ? sinceFor(this.views.get(repo)!) : undefined));
    });
    if (blocks.length === 0) return;

    const data = this.graphql(`query { ${blocks.join("\n")} }`);
    for (const [alias, { repo, kind }] of aliases) {
      const node = data[alias] as RepoNode | null | undefined;
      if (!node) {
        o.logger.warn("github-state: repo missing from bulk response — keeping its last state", { repo });
        continue;
      }
      if (kind === "full") {
        this.applyFull(repo, node, startedAt);
      } else if (!this.applyDelta(repo, node, startedAt)) {
        overflow.push(repo);
      }
      this.dirty.delete(repo);
    }

    // More than DELTA_WINDOW changes since the last sync: read that repo whole.
    if (overflow.length > 0) {
      const fb = overflow.map((repo, i) => repoBlock(`r${i}`, repo, "full"));
      const d2 = this.graphql(`query { ${fb.join("\n")} }`);
      overflow.forEach((repo, i) => {
        const node = d2[`r${i}`] as RepoNode | null | undefined;
        if (node) this.applyFull(repo, node, startedAt);
      });
    }
    this.persist();
  }

  private graphql(query: string): Record<string, unknown> {
    const out = this.opts!.run(["api", "graphql", "-f", `query=${query.replace(/^query \{/, "query { rateLimit { cost } ")}`]);
    const parsed = JSON.parse(out || "{}") as { data?: Record<string, unknown>; errors?: { message?: string; path?: unknown[] }[] };
    // A repo that no longer resolves comes back as a null block plus an error;
    // the rest of the response is still good, so only an empty `data` is fatal.
    if (!parsed.data) {
      throw new Error(`github-state: bulk query failed: ${(parsed.errors ?? []).map((e) => e.message).join("; ") || "no data"}`);
    }
    this.queriesRun++;
    const cost = (parsed.data.rateLimit as { cost?: number } | undefined)?.cost;
    if (typeof cost === "number") this.pointsSpent += cost;
    if (parsed.errors?.length) {
      this.opts!.logger.warn("github-state: bulk query returned errors", { errors: parsed.errors.map((e) => e.message).slice(0, 5) });
    }
    return parsed.data;
  }

  private applyFull(repo: string, node: RepoNode, startedAt: string): void {
    const o = this.opts!;
    const limit = o.issueLimit ?? 500;
    const issues = (node.issues?.nodes ?? []).map(toIssue);
    let page = node.issues?.pageInfo;
    // Past 100 open issues: page this one repo until done or at the limit.
    while (page?.hasNextPage && page.endCursor && issues.length < limit) {
      const d = this.graphql(`query { ${repoBlock("r0", repo, "full", undefined, page.endCursor)} }`);
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
    const prior = this.views.get(repo);
    this.views.set(repo, {
      issues: byNumberDesc(issues.slice(0, limit)),
      prs: byNumberDesc((node.pullRequests?.nodes ?? []).map(toPr)),
      syncedAt: startedAt,
      fullAt: startedAt,
      // A full read cannot tell which PRs closed since the last one — assume some did.
      closedVersion: (prior?.closedVersion ?? 0) + 1,
    });
  }

  /** Apply a delta. False when it saw a full window — the caller re-reads the repo whole. */
  private applyDelta(repo: string, node: RepoNode, startedAt: string): boolean {
    const v = this.views.get(repo)!;
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
    this.views.set(repo, {
      issues: byNumberDesc([...issues.values()]),
      prs: byNumberDesc([...prs.values()]),
      syncedAt: startedAt,
      fullAt: v.fullAt,
      closedVersion: closed,
    });
    return true;
  }

  private persist(): void {
    if (!this.opts?.persistPath) return;
    const out: Persisted = { version: 1, savedAt: new Date(this.now()).toISOString(), repos: Object.fromEntries(this.views), activity: this.activity };
    try {
      writeFileSync(this.opts.persistPath, JSON.stringify(out));
    } catch {
      // Best-effort — the next refresh rebuilds it.
    }
  }
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

/**
 * Process-wide: the fleet state behind the one `gh` runner. Every write through that
 * runner must mark it dirty, so a second instance would serve stale reads.
 */
export const fleetState = new GitHubState();
