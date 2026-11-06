// Follows a repo's release PR (base → production) from open to merged, so an
// observer can show a promoted item as waiting on its release and then as in
// production. Promotion used to be a note only: nothing ever said when the
// release PR merged, so a finished item read as "in progress" until someone
// closed the issue (2026-10-02, Slashbin-console#1185 behind release PR #1206).
//
// The open PR comes from the fleet state, so a cycle with nothing changed costs
// no GitHub call. The one live read is the PR's final state, taken once, when
// the saved PR leaves the open set: merged and closed-unmerged look the same
// from the open set alone. The announced-open mark lives on the release PR's own
// record in the work source (EM#1244 f3), so a release that merges while the
// Foreman is down is still seen after the restart.
//
// The same module owns which release PRs a repo has: the open one plus the last
// closed ones GitHub lists (a release is always one of them), read once per
// process and then kept in memory, with the release records themselves in the
// store (`PrRecord.release`). A record that cannot be read is never an empty
// one: its release is left alone this pass.

import type { ReleaseEvent, WorkItem } from "./adapters.js";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { IssueRecordStore } from "./issue-records.js";
import { codeHost } from "./plugins/registry.js";
import type { ProdRelease } from "./issue-records.js";

/** The release PR a repo is waiting on, persisted between cycles. */
export interface SavedRelease {
  pr: number;
  url?: string;
  issues: number[];
}

export interface ReleaseTrackDeps {
  repo: string;
  productionBranch: string;
  /** What was saved last cycle, or null. */
  saved: SavedRelease | null | undefined;
  /** The open base → production PR, or null when there is none. */
  findOpenRelease: () => { number: number; url: string; body: string } | null;
  /** The PR's state on GitHub; null when it could not be read. */
  releaseState: (pr: number) => Promise<"OPEN" | "MERGED" | "CLOSED" | null>;
  /** Record the mark for PR `pr` (null clears it); resolves false when it could not be saved, and nothing is announced. */
  save: (pr: number, v: SavedRelease | null) => Promise<boolean>;
  emit: (event: ReleaseEvent) => Promise<void>;
  /** The release stage owns the release PR; carried onto every event. */
  owned?: boolean;
}

/**
 * Issue numbers a release PR body carries, in order, once each. Promote writes one
 * `- #N: <title>` line per issue, so only a line that opens `- #N` counts: a `#N` inside a
 * title (`follow-up to #11`, `EM#1284`, `owner/repo#12`) is a mention, not a carried
 * issue (foreman#86).
 */
export function releaseIssues(body: string): number[] {
  const seen = new Set<number>();
  for (const m of body.matchAll(/^- #(\d+)\b/gm)) seen.add(Number(m[1]));
  return [...seen];
}

/**
 * One cycle: an open release PR not yet saved (or carrying different issues) is
 * saved and announced `open`; a saved PR no longer open is read once and
 * announced `merged` or `closed`, then cleared. A read that fails keeps the
 * saved PR for the next cycle.
 */
export async function trackRelease(d: ReleaseTrackDeps): Promise<void> {
  const items = (ns: number[]): WorkItem[] => ns.map((issueNumber) => ({ issueNumber, repo: d.repo }));
  const open = d.findOpenRelease();
  const saved = d.saved ?? null;

  if (open) {
    const issues = releaseIssues(open.body);
    if (saved?.pr === open.number && saved.issues.join() === issues.join()) return;
    if (saved && saved.pr !== open.number) await settle(saved, d, items);
    if (!(await d.save(open.number, { pr: open.number, url: open.url, issues }))) return;
    await d.emit({ repo: d.repo, state: "open", pr: open.number, url: open.url, issues: items(issues), productionBranch: d.productionBranch, owned: d.owned === true });
    return;
  }
  if (saved) await settle(saved, d, items);
}

/** Announce how a saved release PR that left the open set ended, and clear it. */
async function settle(saved: SavedRelease, d: ReleaseTrackDeps, items: (ns: number[]) => WorkItem[]): Promise<void> {
  const state = await d.releaseState(saved.pr);
  if (state === null || state === "OPEN") return;
  if (!(await d.save(saved.pr, null))) return;
  await d.emit({
    repo: d.repo,
    state: state === "MERGED" ? "merged" : "closed",
    pr: saved.pr,
    url: saved.url,
    issues: items(saved.issues),
    productionBranch: d.productionBranch,
  });
}

// ---- the repo's release PRs ----

interface Sweep {
  /** PRs whose record holds a release the stage still carries. */
  live: Set<number>;
  /** PRs announced open whose end is not yet announced. */
  tracked: Set<number>;
  /** PRs whose record could not be read: looked at again each pass, acted on never. */
  unsure: Set<number>;
}

/** What the stage may act on: the releases it carries, and the PRs whose record could not be read. Null when the repo's release PRs are unknown. */
export interface Releases {
  releases: ProdRelease[];
  unreadable: ReadonlySet<number>;
}

const hasStage = (c: RepoConfig) => c.baseBranch !== c.productionBranch;

/** A runtime's view of every repo's release PRs, and the stage's reads and writes of their records. */
export class ReleaseTracker {
  private readonly sweeps = new Map<string, Sweep>();
  private readonly sweeping = new Map<string, Promise<Sweep | null>>();
  /** PR numbers the import found before the first sweep. */
  private readonly hints = new Map<string, Set<number>>();

  constructor(private readonly records: IssueRecordStore) {}

  /** The one-time import knows these PRs hold release entries: the sweep reads them whether or not GitHub lists them. */
  noteReleasePrs(githubRepo: string, prs: Iterable<number>): void {
    const sweep = this.sweeps.get(githubRepo);
    const into = sweep ? sweep.unsure : (this.hints.get(githubRepo) ?? this.hints.set(githubRepo, new Set()).get(githubRepo)!);
    for (const n of prs) into.add(n);
  }

  /** Read the repo's release PRs once per runtime. Null when GitHub could not list them: nothing acts on a release until it can. */
  private async swept(repoConfig: RepoConfig, logger: Logger): Promise<Sweep | null> {
    const id = repoConfig.githubRepo;
    const done = this.sweeps.get(id);
    if (done) return done;
    const running = this.sweeping.get(id);
    if (running) return running;
    const run = (async (): Promise<Sweep | null> => {
      const numbers = new Set<number>(this.hints.get(id) ?? []);
      if (hasStage(repoConfig)) {
        try {
          // Every release PR there has ever been (open, merged, closed), in one complete listing that throws when it
          // fails or may be cut short: a stored release or pointer can sit on any of them, however old, and a swallowed
          // failure would read as "none". Each PR's record is then read once.
          for (const p of await codeHost().allPrsForBranch(id, repoConfig.baseBranch, repoConfig.productionBranch, repoConfig.repoPath)) numbers.add(p.number);
        } catch (err) {
          logger.debug(`Could not list ${id}'s release PRs: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }
      const sweep: Sweep = { live: new Set(), tracked: new Set(), unsure: new Set() };
      for (const n of numbers) {
        const record = await this.records.loadPrRecord(repoConfig, n);
        if (!record) sweep.unsure.add(n);
        else {
          if (record.release) sweep.live.add(n);
          if (record.tracked) sweep.tracked.add(n);
        }
      }
      this.sweeps.set(id, sweep);
      this.hints.delete(id);
      return sweep;
    })().finally(() => this.sweeping.delete(id));
    this.sweeping.set(id, run);
    return run;
  }

  /** Read the record of every release the repo carries, once. */
  async loadReleases(repoConfig: RepoConfig, logger: Logger): Promise<Releases | null> {
    const sweep = await this.swept(repoConfig, logger);
    if (!sweep) return null;
    const releases: ProdRelease[] = [];
    const unreadable = new Set<number>();
    for (const n of new Set([...sweep.live, ...sweep.unsure])) {
      const record = await this.records.loadPrRecord(repoConfig, n);
      if (!record) { unreadable.add(n); continue; }
      sweep.unsure.delete(n);
      if (record.release) { sweep.live.add(n); releases.push(record.release); } else sweep.live.delete(n);
      if (record.tracked) sweep.tracked.add(n); else sweep.tracked.delete(n);
    }
    releases.sort((a, b) => a.pr - b.pr);
    return { releases, unreadable };
  }

  /** Save `rel` on its PR's record. False when it could not be saved: the caller does not act on the strength of it. */
  async putRelease(repoConfig: RepoConfig, rel: ProdRelease): Promise<boolean> {
    const ok = await this.records.updatePrRecord(repoConfig, rel.pr, (d) => { d.release = rel; });
    if (ok) this.sweeps.get(repoConfig.githubRepo)?.live.add(rel.pr);
    return ok;
  }

  /** Remove PR `pr`'s release from its record. */
  async dropRelease(repoConfig: RepoConfig, pr: number): Promise<boolean> {
    const ok = await this.records.updatePrRecord(repoConfig, pr, (d) => { delete d.release; });
    if (ok) this.sweeps.get(repoConfig.githubRepo)?.live.delete(pr);
    return ok;
  }

  /** Mark PR `pr` as a release the stage carries without having read its record yet (found by a listing). */
  noteLiveRelease(githubRepo: string, pr: number): void {
    this.sweeps.get(githubRepo)?.live.add(pr);
  }

  /**
   * Follow the release PR from open to merged: announce an open one once, and a tracked PR's end once.
   * Every tracked PR that is not the open one is settled first. A record that cannot be read leaves its PR alone.
   */
  async followReleasePrs(
    repoConfig: RepoConfig,
    logger: Logger,
    emit: (event: ReleaseEvent) => Promise<void>,
    owned: boolean,
  ): Promise<void> {
    const sweep = await this.swept(repoConfig, logger);
    if (!sweep) return;
    const id = repoConfig.githubRepo;
    const open = await codeHost().findOpenPromotionPR(id, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger);
    const save = async (pr: number, v: SavedRelease | null): Promise<boolean> => {
      const ok = await this.records.updatePrRecord(repoConfig, pr, (d) => { if (v) d.tracked = v; else delete d.tracked; });
      if (ok) { if (v) sweep.tracked.add(pr); else sweep.tracked.delete(pr); }
      return ok;
    };
    const common = {
      repo: id,
      productionBranch: repoConfig.productionBranch,
      releaseState: async (pr: number) => await codeHost().getPrState(id, pr, repoConfig.repoPath, logger),
      save,
      emit,
      owned,
    };
    for (const n of [...sweep.tracked]) {
      if (n === open?.number) continue;
      const record = await this.records.loadPrRecord(repoConfig, n);
      if (!record) continue;
      if (!record.tracked) { sweep.tracked.delete(n); continue; }
      await trackRelease({ ...common, saved: record.tracked, findOpenRelease: () => null });
    }
    if (open) {
      const record = await this.records.loadPrRecord(repoConfig, open.number);
      if (!record) return;
      await trackRelease({ ...common, saved: record.tracked ?? null, findOpenRelease: () => open });
    }
  }
}
