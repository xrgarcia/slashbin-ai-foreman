// The one-time import of the issue-keyed records `.agent-state.json` used to hold
// (EM#1244 f2). Before f2 the file kept every issue's skip, hold, verify hold,
// unstick questions, passed prod verification and promotion-stall notice; they
// now live in the work source's record store (issue-records.ts). The first pass
// on a repo after the upgrade carries each live entry across:
//
//   - an entry whose issue GitHub reads closed is dropped: a closed issue holds
//     nothing (closed-holds.ts used to say the same, per pass);
//   - every other entry is saved into the issue's record, merged under what the
//     store already holds, and removed from the file only once the save succeeded;
//   - an entry whose save failed stays in the file for the next run, and until it
//     is imported the issue is withheld (issue-records.ts), never read as empty.
//
// f3 adds the PR-keyed fields: the release a PR is (`prodReleases`), the single `release` pointer, the
// no-commit streak of a PR and the head a rejected branch was alerted at (`rejectedBranches`). They move into
// the PR's record (issue-records.ts `PrRecord`) under the same rules, and the rule for "finished" is:
//
//   - a release entry is finished when its PR reads CLOSED (unmerged: a deploy that never merged and left its
//     entry behind). A merged release is never finished at import: it still owes its verification, its soak or
//     its closing comment, so it is imported in whatever phase it was in;
//   - a no-commit streak is finished when its PR reads merged or closed (a streak only matters while the PR is
//     open);
//   - a rejected-branch entry is finished when the branch's last closed-unmerged PR is not at the alerted head
//     (the branch moved, or the PR is gone): nothing standing is left to suppress. Otherwise it moves onto that PR;
//   - the `release` pointer is never finished at import: the tracker announces how the PR ended, once, and clears it.
//
// A PR that cannot be read counts as live: it is imported, never dropped. A branch whose last closed PR cannot
// be looked up stays in the file, and until it resolves the reconciler leaves that branch's alert alone.
//
// Idempotent: a second run finds nothing left to import. Deleted with the file (f4).

import type { ItemRecord } from "./adapters.js";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { importIssueRecord, importPrRecord, setUnimported, setUnimportedPrs, setUnresolvedBranches } from "./issue-records.js";
import { activeWorkSource, codeHost } from "./plugins/registry.js";
import { dropLegacyIssueEntries, dropLegacyPrEntries, legacyIssueEntries, legacyPrEntries } from "./state.js";
import { noteReleasePrs } from "./release-tracker.js";
import { noteStreakPrs } from "./no-commit-streak.js";

/** How long a repo whose import was incomplete waits before the next attempt. */
const RETRY_MS = 5 * 60_000;

/** Repos fully imported this process. */
const done = new Set<string>();
/** Imports running now, so the lanes of one repo share one. */
const running = new Map<string, Promise<void>>();
/** When an incomplete import may run again, by repo. */
const retryAt = new Map<string, number>();

/** `stored` over `legacy`: a field the store already holds is newer than the file's copy and wins; unstick questions merge by key. */
export function mergeLegacy(stored: ItemRecord, legacy: ItemRecord): ItemRecord {
  const merged: Record<string, unknown> = { ...legacy, ...stored };
  if (legacy.unstick || stored.unstick) merged.unstick = { ...(legacy.unstick as object | undefined), ...(stored.unstick as object | undefined) };
  return merged;
}

/** Import `repoConfig`'s legacy issue entries once per process (retrying an incomplete run after a while). Never throws. */
export function importLegacyRecords(repoConfig: RepoConfig, logger: Logger): Promise<void> {
  const name = repoConfig.name;
  if (done.has(name) || (retryAt.get(name) ?? 0) > Date.now()) return Promise.resolve();
  const inFlight = running.get(name);
  if (inFlight) return inFlight;
  const run = importOnce(repoConfig, logger)
    .catch((err) => {
      retryAt.set(name, Date.now() + RETRY_MS);
      logger.warn(`Legacy record import for ${repoConfig.githubRepo} failed, retrying later: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => running.delete(name));
  running.set(name, run);
  return run;
}

async function importOnce(repoConfig: RepoConfig, logger: Logger): Promise<void> {
  const name = repoConfig.name;
  if (!activeWorkSource()) return;
  const issuesPending = await importIssues(repoConfig, logger);
  const prsPending = await importPrs(repoConfig, logger);
  if (issuesPending === 0 && prsPending === 0) done.add(name);
  else retryAt.set(name, Date.now() + RETRY_MS);
}

/** Move the issue-keyed entries; resolves how many could not be saved. */
async function importIssues(repoConfig: RepoConfig, logger: Logger): Promise<number> {
  const name = repoConfig.name;
  const legacy = legacyIssueEntries(name);
  if (legacy.size === 0) {
    setUnimported(repoConfig.githubRepo, new Set());
    return 0;
  }
  // Until this import has settled each entry, every issue holding one is withheld: a lookup that throws below
  // must not leave them reading as issues with nothing recorded.
  setUnimported(repoConfig.githubRepo, new Set(legacy.keys()));
  const closed = await closedIssues(repoConfig, [...legacy.keys()], logger);
  const imported = new Set<number>();
  const pending = new Set<number>();
  for (const [n, entry] of legacy) {
    if (closed.has(n)) continue;
    const ok = await importIssueRecord(repoConfig, n, (draft) => { Object.assign(draft, mergeLegacy(draft as Record<string, unknown>, entry)); });
    if (ok) imported.add(n);
    else pending.add(n);
  }
  dropLegacyIssueEntries(name, new Set([...closed, ...imported]));
  setUnimported(repoConfig.githubRepo, pending);
  logger.info(
    `Legacy records of ${repoConfig.githubRepo}: ${imported.size} issue(s) moved to the work source, ${closed.size} closed issue(s) dropped` +
    (pending.size > 0 ? `, ${pending.size} not saved yet (${[...pending].map((n) => `#${n}`).join(", ")}) — withheld until they are` : ""),
  );
  return pending.size;
}

/** Move the PR-keyed entries (EM#1244 f3); resolves how many could not be saved or resolved. */
async function importPrs(repoConfig: RepoConfig, logger: Logger): Promise<number> {
  const name = repoConfig.name;
  const id = repoConfig.githubRepo;
  const legacy = legacyPrEntries(name);
  if (legacy.releases.size + legacy.streaks.size + legacy.rejected.size === 0 && !legacy.tracked) {
    setUnimportedPrs(id, new Set());
    setUnresolvedBranches(id, new Set());
    return 0;
  }
  // Withheld until settled, as the issues are: a lookup that throws must not leave a PR reading as one with nothing recorded.
  setUnimportedPrs(id, new Set([...legacy.releases.keys(), ...legacy.streaks.keys(), ...(legacy.tracked ? [legacy.tracked.pr] : [])]));
  setUnresolvedBranches(id, new Set(legacy.rejected.keys()));
  noteReleasePrs(id, [...legacy.releases.keys(), ...(legacy.tracked ? [legacy.tracked.pr] : [])]);
  noteStreakPrs(id, legacy.streaks.keys());

  const stateOf = (pr: number) => codeHost().getPrState(id, pr, repoConfig.repoPath, logger);
  const pending = new Set<number>();
  const droppedReleases = new Set<number>();
  const droppedStreaks = new Set<number>();
  const droppedBranches = new Set<string>();
  let movedReleases = 0, movedStreaks = 0, movedBranches = 0, droppedTracked = false;

  for (const [pr, rel] of legacy.releases) {
    if (stateOf(pr) === "CLOSED") { droppedReleases.add(pr); continue; }
    if (await importPrRecord(repoConfig, pr, (d) => { d.release = d.release ?? rel; })) { droppedReleases.add(pr); movedReleases++; }
    else pending.add(pr);
  }
  for (const [pr, streak] of legacy.streaks) {
    const state = stateOf(pr);
    if (state === "CLOSED" || state === "MERGED") { droppedStreaks.add(pr); continue; }
    if (await importPrRecord(repoConfig, pr, (d) => { d.noCommit = d.noCommit ?? streak; })) { droppedStreaks.add(pr); movedStreaks++; }
    else pending.add(pr);
  }
  if (legacy.tracked) {
    const tracked = legacy.tracked;
    if (await importPrRecord(repoConfig, tracked.pr, (d) => { d.tracked = d.tracked ?? tracked; })) { droppedTracked = true; }
    else pending.add(tracked.pr);
  }
  const unresolved = new Set<string>();
  for (const [branch, head] of legacy.rejected) {
    let last: { number: number; headRefOid: string } | undefined;
    try {
      last = codeHost().closedPrsForBranch(id, branch, repoConfig.baseBranch, repoConfig.repoPath)
        .filter((p) => !p.mergedAt && p.headRefOid)
        .sort((a, b) => String(b.closedAt ?? "").localeCompare(String(a.closedAt ?? "")))[0];
    } catch {
      unresolved.add(branch);
      continue;
    }
    if (!last || last.headRefOid !== head) { droppedBranches.add(branch); continue; }
    const pr = last.number;
    if (await importPrRecord(repoConfig, pr, (d) => { d.rejectedHead = d.rejectedHead ?? head; })) { droppedBranches.add(branch); movedBranches++; }
    else { pending.add(pr); unresolved.add(branch); }
  }
  dropLegacyPrEntries(name, { releases: droppedReleases, streaks: droppedStreaks, rejected: droppedBranches, tracked: droppedTracked });
  setUnimportedPrs(id, pending);
  setUnresolvedBranches(id, unresolved);
  logger.info(
    `Legacy PR records of ${id}: ${movedReleases} release(s), ${movedStreaks} no-commit streak(s), ${movedBranches} rejected branch(es)` +
    `${droppedTracked ? ", the release pointer" : ""} moved to the work source; ${droppedReleases.size - movedReleases + droppedStreaks.size - movedStreaks + droppedBranches.size - movedBranches} finished entr(ies) dropped` +
    (pending.size + unresolved.size > 0 ? `; ${pending.size + unresolved.size} not saved yet, withheld until they are` : ""),
  );
  return pending.size + unresolved.size;
}

/** The issues of `numbers` the source reads closed; an issue that cannot be read counts as open (it is imported). */
async function closedIssues(repoConfig: RepoConfig, numbers: number[], logger: Logger): Promise<Set<number>> {
  const source = activeWorkSource();
  if (!source?.states) return new Set();
  const open = new Set(codeHost().openIssueLabels(repoConfig, logger).map((i) => i.number));
  const candidates = numbers.filter((n) => !open.has(n));
  if (candidates.length === 0) return new Set();
  const states = await source.states(repoConfig, candidates, logger);
  return new Set(candidates.filter((n) => {
    const s = states.get(n);
    return s !== undefined && s !== "open";
  }));
}

/** Tests only: forget what was imported. */
export function resetLegacyImportForTests(): void {
  done.clear();
  running.clear();
  retryAt.clear();
}
