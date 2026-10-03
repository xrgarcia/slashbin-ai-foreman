// Follows a repo's release PR (base → production) from open to merged, so an
// observer can show a promoted item as waiting on its release and then as in
// production. Promotion used to be a note only: nothing ever said when the
// release PR merged, so a finished item read as "in progress" until someone
// closed the issue (2026-10-02, Slashbin-console#1185 behind release PR #1206).
//
// The open PR comes from the fleet state, so a cycle with nothing changed costs
// no GitHub call. The one live read is the PR's final state, taken once, when
// the saved PR leaves the open set: merged and closed-unmerged look the same
// from the open set alone. The saved PR is persisted per repo, so a release
// that merges while the Foreman is down is still seen after the restart.

import type { ReleaseEvent, WorkItem } from "./adapters.js";

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
  save: (v: SavedRelease | null) => void;
  emit: (event: ReleaseEvent) => Promise<void>;
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
    d.save({ pr: open.number, url: open.url, issues });
    await d.emit({ repo: d.repo, state: "open", pr: open.number, url: open.url, issues: items(issues), productionBranch: d.productionBranch });
    return;
  }
  if (saved) await settle(saved, d, items);
}

/** Announce how a saved release PR that left the open set ended, and clear it. */
async function settle(saved: SavedRelease, d: ReleaseTrackDeps, items: (ns: number[]) => WorkItem[]): Promise<void> {
  const state = d.releaseState(saved.pr);
  if (state === null || state === "OPEN") return;
  d.save(null);
  await d.emit({
    repo: d.repo,
    state: state === "MERGED" ? "merged" : "closed",
    pr: saved.pr,
    url: saved.url,
    issues: items(saved.issues),
    productionBranch: d.productionBranch,
  });
}
