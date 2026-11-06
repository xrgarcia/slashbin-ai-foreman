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
  /**
   * Run `gh` with the Foreman token, without blocking the event loop. Injected so this
   * module has no gh of its own.
   */
  runAsync: (args: string[]) => Promise<string>;
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
/** An unreachable repo (NOT_FOUND, FORBIDDEN...) is left out of the bulk query this long before it is tried again. */
const UNREACHABLE_RETRY_MS = 10 * 60_000;

interface GraphqlError { message?: string; type?: string; path?: unknown[] }
/** A repo the bulk query could not resolve: why, and when to try it again. */
interface Unreachable { type: string; message: string; retryAt: number }

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
  /** Repos the bulk query could not resolve. Reads of these throw; no other repo is affected. */
  private readonly unreachable = new Map<string, Unreachable>();
  /** GraphQL points the state's own queries spent, as GitHub reported them. */
  private pointsSpent = 0;
  private queriesRun = 0;
  /** The async refresh in flight, shared by every concurrent `warm`. */
  private inFlight: Promise<void> | null = null;
  /** Bumped on every write mark; per repo, the value at its last mark. */
  private writeSeq = 0;
  private readonly wroteAt = new Map<string, number>();

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
    this.inFlight = null;
    this.dirty.clear();
    this.unreachable.clear();
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
    if (!this.opts?.repos.includes(repo)) return;
    this.dirty.add(repo);
    this.wroteAt.set(repo, ++this.writeSeq);
  }

  markAllDirty(): void {
    for (const r of this.opts?.repos ?? []) this.markRepoDirty(r);
  }

  /**
   * A write landed on `repo` after a refresh that started at `seq` sent its query:
   * that answer may predate the write, so it is not applied and the repo stays dirty.
   * Only an async refresh can interleave with a write.
   */
  private wroteSince(repo: string, seq: number): boolean {
    return (this.wroteAt.get(repo) ?? 0) > seq;
  }

  /** Every open issue in `repo`, refreshing first if stale. */
  async openIssues(repo: string): Promise<StateIssue[]> {
    await this.ensureFresh(repo);
    return this.views.get(repo)?.issues ?? [];
  }

  /** Every open PR in `repo`, refreshing first if stale. */
  async openPrs(repo: string): Promise<StatePr[]> {
    await this.ensureFresh(repo);
    return this.views.get(repo)?.prs ?? [];
  }

  /** Changes whenever a PR in `repo` was seen merged or closed — a cache key for merged/closed PR reads. */
  async closedVersion(repo: string): Promise<number> {
    await this.ensureFresh(repo);
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
  async refreshAll(): Promise<void> {
    if (!this.opts) return;
    await this.driveAsync(this.refresh(this.opts.repos), this.opts.runAsync);
    this.lastRefreshAt = this.now();
  }

  /**
   * Bring the view up to date without blocking the event loop: the stale state
   * (every repo) or the dirty repos, through `runAsync`. The daemon awaits it
   * before each lane pass, so the pass's synchronous reads find a fresh view.
   * Concurrent calls share one in-flight refresh.
   *
   * 2026-11-06: GitHub answered with TLS handshake timeouts for 20 minutes, and
   * the synchronous bulk query inside a read froze every lane and every observer
   * with it; the board went blank while Paperclip was up.
   */
  warm(): Promise<void> {
    const o = this.opts;
    if (!o) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const t = this.now();
    const stale = t - this.lastRefreshAt >= o.refreshMs || o.repos.some((r) => !this.views.has(r));
    if (!stale && this.dirty.size === 0) return Promise.resolve();
    if (this.lastFailure && t - this.lastFailure.at < FAILURE_COOLDOWN_MS) return Promise.reject(this.lastFailure.err);
    const run = (async () => {
      try {
        await this.driveAsync(this.refresh(stale ? o.repos : [...this.dirty]), o.runAsync);
        if (stale) this.lastRefreshAt = this.now();
        this.lastFailure = null;
      } catch (err) {
        this.lastFailure = { at: this.now(), err };
        throw err;
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = run;
    return run;
  }

  /**
   * Bring `repo`'s view up to date before a read, through the async runner: the event
   * loop keeps turning while GitHub answers (or does not). A merely stale view is
   * served as it is while a refresh is already in flight; a repo this process wrote
   * to waits for it (read your writes).
   */
  private async ensureFresh(repo: string): Promise<void> {
    if (!this.opts || !this.opts.repos.includes(repo)) return;
    const t = this.now();
    // A repo GitHub cannot resolve fails its own reads only, and is not re-queried until its retry time.
    const bad = this.unreachable.get(repo);
    if (bad && t < bad.retryAt) throw unreachableError(repo, bad);
    const stale = t - this.lastRefreshAt >= this.opts.refreshMs || !this.views.has(repo);
    if (!stale && !this.dirty.has(repo)) return;
    // An async refresh is already bringing the view up to date: a merely stale
    // view is served as it is rather than waiting on a second query. A write this
    // repo saw still refreshes (read your writes).
    if (this.inFlight && this.views.has(repo) && !this.dirty.has(repo)) return;
    // A failed bulk query fails every repo's read at once. Without this, each of
    // the 20 repo loops would re-run the whole fleet query to fail again.
    if (this.lastFailure && t - this.lastFailure.at < FAILURE_COOLDOWN_MS) throw this.lastFailure.err;
    // `warm` shares the refresh in flight and records a failure for the cooldown above.
    // An in-flight refresh may have started before the write that dirtied this repo
    // (its answer is then not applied), so a still-dirty repo gets one more pass.
    await this.warm();
    if (this.dirty.has(repo)) await this.warm();
    const still = this.unreachable.get(repo);
    if (still) throw unreachableError(repo, still);
  }

  /** Run a refresh's queries through the async runner: the event loop keeps turning. */
  private async driveAsync(steps: RefreshSteps, runAsync: (args: string[]) => Promise<string>): Promise<void> {
    let r = steps.next();
    while (!r.done) {
      const query = r.value;
      let out: string;
      try {
        out = await graphqlBodyAsync(() => runAsync(graphqlArgs(query)));
      } catch (err) {
        r = steps.throw(err);
        continue;
      }
      r = steps.next(out);
    }
  }

  /**
   * One refresh, as a sequence of GraphQL queries: it yields each query and is
   * resumed with the response body, so the sync and async drivers share it.
   */
  private *refresh(repos: string[]): RefreshSteps {
    if (!this.opts) return;
    const o = this.opts;
    const t = this.now();
    const fullEvery = o.fullRefreshMs ?? DEFAULT_FULL_REFRESH_MS;
    const full: string[] = [];
    const delta: string[] = [];
    for (const r of repos) {
      const bad = this.unreachable.get(r);
      if (bad && t < bad.retryAt) {
        this.dirty.delete(r);
        continue;
      }
      const v = this.views.get(r);
      if (!v || !v.syncedAt || !v.fullAt || t - Date.parse(v.fullAt) >= fullEvery) full.push(r);
      else delta.push(r);
    }
    const startedAt = new Date(t).toISOString();
    const startSeq = this.writeSeq;
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

    const { data, errors } = this.parseGraphql(yield `query { ${blocks.join("\n")} }`);
    for (const [alias, { repo, kind }] of aliases) {
      if (this.wroteSince(repo, startSeq)) continue;
      const node = data[alias] as RepoNode | null | undefined;
      if (!node) {
        // GitHub names the alias in each error's path: that repo failed, the others did not.
        const err = errors.find((e) => e.path?.[0] === alias);
        if (err) {
          this.markUnreachable(repo, err);
          this.dirty.delete(repo);
          continue;
        }
        o.logger.warn("github-state: repo missing from bulk response — keeping its last state", { repo });
        continue;
      }
      this.clearUnreachable(repo);
      if (kind === "full") {
        yield* this.applyFull(repo, node, startedAt, startSeq);
      } else if (!this.applyDelta(repo, node, startedAt)) {
        overflow.push(repo);
      }
      if (!this.wroteSince(repo, startSeq)) this.dirty.delete(repo);
    }

    // More than DELTA_WINDOW changes since the last sync: read that repo whole.
    if (overflow.length > 0) {
      const fb = overflow.map((repo, i) => repoBlock(`r${i}`, repo, "full"));
      const d2 = this.parseGraphql(yield `query { ${fb.join("\n")} }`).data;
      for (const [i, repo] of overflow.entries()) {
        const node = d2[`r${i}`] as RepoNode | null | undefined;
        if (node && !this.wroteSince(repo, startSeq)) yield* this.applyFull(repo, node, startedAt, startSeq);
      }
    }
    this.persist();
  }

  private parseGraphql(out: string): { data: Record<string, unknown>; errors: GraphqlError[] } {
    const parsed = JSON.parse(out || "{}") as { data?: Record<string, unknown>; errors?: GraphqlError[] };
    // A repo that does not resolve comes back as a null block plus an error with that alias in its
    // path; the rest of the response is still good, so only an empty `data` is fatal.
    if (!parsed.data) {
      throw new Error(`github-state: bulk query failed: ${(parsed.errors ?? []).map((e) => e.message).join("; ") || "no data"}`);
    }
    this.queriesRun++;
    const cost = (parsed.data.rateLimit as { cost?: number } | undefined)?.cost;
    if (typeof cost === "number") this.pointsSpent += cost;
    const errors = parsed.errors ?? [];
    // Errors tied to a repo alias are logged once per repo by markUnreachable; the rest are logged here.
    const other = errors.filter((e) => !(typeof e.path?.[0] === "string" && /^r\d+$/.test(e.path[0]) && parsed.data![e.path[0]] == null));
    if (other.length) {
      this.opts!.logger.warn("github-state: bulk query returned errors", { errors: other.map((e) => e.message).slice(0, 5) });
    }
    return { data: parsed.data, errors };
  }

  /** One WARN per state change (new, or a different error type) — a retry that fails the same way is silent. */
  private markUnreachable(repo: string, err: GraphqlError): void {
    const type = err.type ?? "UNKNOWN";
    const prior = this.unreachable.get(repo);
    const message = err.message ?? type;
    this.unreachable.set(repo, { type, message, retryAt: this.now() + UNREACHABLE_RETRY_MS });
    if (!prior || prior.type !== type) {
      this.opts!.logger.warn("github-state: repo unreachable — its lanes fail, every other repo is unaffected", { repo, type, error: message, retryMinutes: UNREACHABLE_RETRY_MS / 60_000 });
    }
  }

  private clearUnreachable(repo: string): void {
    if (this.unreachable.delete(repo)) this.opts!.logger.info("github-state: repo reachable again", { repo });
  }

  private *applyFull(repo: string, node: RepoNode, startedAt: string, startSeq: number): RefreshSteps {
    const o = this.opts!;
    const limit = o.issueLimit ?? 500;
    const issues = (node.issues?.nodes ?? []).map(toIssue);
    let page = node.issues?.pageInfo;
    // Past 100 open issues: page this one repo until done or at the limit.
    while (page?.hasNextPage && page.endCursor && issues.length < limit) {
      const d = this.parseGraphql(yield `query { ${repoBlock("r0", repo, "full", undefined, page.endCursor)} }`).data;
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
    // A write landed while the pages were read: keep the repo dirty for the next refresh.
    if (this.wroteSince(repo, startSeq)) return;
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

/** A refresh: yields each GraphQL query, resumed with its response body. */
type RefreshSteps = Generator<string, void, string>;

function graphqlArgs(query: string): string[] {
  return ["api", "graphql", "-f", `query=${query.replace(/^query \{/, "query { rateLimit { cost } ")}`];
}

/**
 * `gh api graphql` exits non-zero when any alias errored, but still prints the JSON body
 * (partial `data` plus `errors`). Use that body; a failure with no data is a real failure.
 */
function bodyFromFailure(err: unknown): string {
  const body = (err as { stdout?: Buffer | string } | null)?.stdout;
  const out = typeof body === "string" ? body : body?.toString() ?? "";
  let usable = false;
  try { usable = !!(JSON.parse(out) as { data?: unknown }).data; } catch { /* not JSON */ }
  if (!usable) throw err;
  return out;
}

async function graphqlBodyAsync(run: () => Promise<string>): Promise<string> {
  try { return await run(); } catch (err) { return bodyFromFailure(err); }
}

function unreachableError(repo: string, bad: Unreachable): Error {
  return new Error(`github-state: ${repo} unreachable (${bad.type}): ${bad.message}`);
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
