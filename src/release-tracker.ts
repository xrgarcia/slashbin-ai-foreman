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
import { loadPrRecord, updatePrRecord } from "./issue-records.js";
import { codeHost } from "./plugins/registry.js";
import type { ProdRelease } from "./state.js";

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
  releaseState: (pr: number) => "OPEN" | "MERGED" | "CLOSED" | null;
  /** Record the mark for PR `pr` (null clears it); resolves false when it could not be saved, and nothing is announced. */
  save: (pr: number, v: SavedRelease | null) => Promise<boolean>;
  emit: (event: ReleaseEvent) => Promise<void>;
  /** The release stage owns the release PR; carried onto every event. */
  owned?: boolean;
}

/** Issue numbers a release PR body lists as `#N`, in order, once each. */
export function releaseIssues(body: string): number[] {
  const seen = new Set<number>();
  for (const m of body.matchAll(/#(\d+)/g)) seen.add(Number(m[1]));
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
  const state = d.releaseState(saved.pr);
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

const sweeps = new Map<string, Sweep>();
const sweeping = new Map<string, Promise<Sweep | null>>();
/** PR numbers the import found before the first sweep. */
const hints = new Map<string, Set<number>>();

/** The one-time import knows these PRs hold release entries: the sweep reads them whether or not GitHub lists them. */
export function noteReleasePrs(githubRepo: string, prs: Iterable<number>): void {
  const sweep = sweeps.get(githubRepo);
  const into = sweep ? sweep.unsure : (hints.get(githubRepo) ?? hints.set(githubRepo, new Set()).get(githubRepo)!);
  for (const n of prs) into.add(n);
}

const hasStage = (c: RepoConfig) => c.baseBranch !== c.productionBranch;

/** Read the repo's release PRs once per process. Null when GitHub could not list them: nothing acts on a release until it can. */
async function swept(repoConfig: RepoConfig, logger: Logger): Promise<Sweep | null> {
  const id = repoConfig.githubRepo;
  const done = sweeps.get(id);
  if (done) return done;
  const running = sweeping.get(id);
  if (running) return running;
  const run = (async (): Promise<Sweep | null> => {
    const numbers = new Set<number>(hints.get(id) ?? []);
    if (hasStage(repoConfig)) {
      try {
        for (const p of codeHost().closedPrsForBranch(id, repoConfig.baseBranch, repoConfig.productionBranch, repoConfig.repoPath)) numbers.add(p.number);
        const open = codeHost().findOpenPromotionPR(id, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger);
        if (open) numbers.add(open.number);
      } catch (err) {
        logger.debug(`Could not list ${id}'s release PRs: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }
    const sweep: Sweep = { live: new Set(), tracked: new Set(), unsure: new Set() };
    for (const n of numbers) {
      const record = await loadPrRecord(repoConfig, n);
      if (!record) sweep.unsure.add(n);
      else {
        if (record.release) sweep.live.add(n);
        if (record.tracked) sweep.tracked.add(n);
      }
    }
    sweeps.set(id, sweep);
    hints.delete(id);
    return sweep;
  })().finally(() => sweeping.delete(id));
  sweeping.set(id, run);
  return run;
}

/** What the stage may act on: the releases it carries, and the PRs whose record could not be read. Null when the repo's release PRs are unknown. */
export interface Releases {
  releases: ProdRelease[];
  unreadable: ReadonlySet<number>;
}

/** Read the record of every release the repo carries, once. */
export async function loadReleases(repoConfig: RepoConfig, logger: Logger): Promise<Releases | null> {
  const sweep = await swept(repoConfig, logger);
  if (!sweep) return null;
  const releases: ProdRelease[] = [];
  const unreadable = new Set<number>();
  for (const n of new Set([...sweep.live, ...sweep.unsure])) {
    const record = await loadPrRecord(repoConfig, n);
    if (!record) { unreadable.add(n); continue; }
    sweep.unsure.delete(n);
    if (record.release) { sweep.live.add(n); releases.push(record.release); } else sweep.live.delete(n);
    if (record.tracked) sweep.tracked.add(n); else sweep.tracked.delete(n);
  }
  releases.sort((a, b) => a.pr - b.pr);
  return { releases, unreadable };
}

/** Save `rel` on its PR's record. False when it could not be saved: the caller does not act on the strength of it. */
export async function putRelease(repoConfig: RepoConfig, rel: ProdRelease): Promise<boolean> {
  const ok = await updatePrRecord(repoConfig, rel.pr, (d) => { d.release = rel; });
  if (ok) sweeps.get(repoConfig.githubRepo)?.live.add(rel.pr);
  return ok;
}

/** Remove PR `pr`'s release from its record. */
export async function dropRelease(repoConfig: RepoConfig, pr: number): Promise<boolean> {
  const ok = await updatePrRecord(repoConfig, pr, (d) => { delete d.release; });
  if (ok) sweeps.get(repoConfig.githubRepo)?.live.delete(pr);
  return ok;
}

/** Mark PR `pr` as a release the stage carries without having read its record yet (found by a listing). */
export function noteLiveRelease(githubRepo: string, pr: number): void {
  sweeps.get(githubRepo)?.live.add(pr);
}

/**
 * Follow the release PR from open to merged: announce an open one once, and a tracked PR's end once.
 * Every tracked PR that is not the open one is settled first. A record that cannot be read leaves its PR alone.
 */
export async function followReleasePrs(
  repoConfig: RepoConfig,
  logger: Logger,
  emit: (event: ReleaseEvent) => Promise<void>,
  owned: boolean,
): Promise<void> {
  const sweep = await swept(repoConfig, logger);
  if (!sweep) return;
  const id = repoConfig.githubRepo;
  const open = codeHost().findOpenPromotionPR(id, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger);
  const save = async (pr: number, v: SavedRelease | null): Promise<boolean> => {
    const ok = await updatePrRecord(repoConfig, pr, (d) => { if (v) d.tracked = v; else delete d.tracked; });
    if (ok) { if (v) sweep.tracked.add(pr); else sweep.tracked.delete(pr); }
    return ok;
  };
  const common = {
    repo: id,
    productionBranch: repoConfig.productionBranch,
    releaseState: (pr: number) => codeHost().getPrState(id, pr, repoConfig.repoPath, logger),
    save,
    emit,
    owned,
  };
  for (const n of [...sweep.tracked]) {
    if (n === open?.number) continue;
    const record = await loadPrRecord(repoConfig, n);
    if (!record) continue;
    if (!record.tracked) { sweep.tracked.delete(n); continue; }
    await trackRelease({ ...common, saved: record.tracked, findOpenRelease: () => null });
  }
  if (open) {
    const record = await loadPrRecord(repoConfig, open.number);
    if (!record) return;
    await trackRelease({ ...common, saved: record.tracked ?? null, findOpenRelease: () => open });
  }
}

/** Tests only: forget the sweep. */
export function resetReleaseTrackerForTests(): void {
  sweeps.clear();
  sweeping.clear();
  hints.clear();
}
