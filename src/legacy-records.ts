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
// f4 moves the rest and ends the file:
//
//   - the questions to the EM that name no issue (`repoUnstick`, and `unstick` entries of issue 0) move into the
//     repo's own record (issue-records.ts `RepoRecord`), merged under what the store holds;
//   - a standing `branchBlock` is derived from git now: its announced issues keep `divergenceTold`, its ruled ids
//     become the repo record's `divergenceRuled`, and the block itself goes. A block whose episode git no longer
//     shows is dropped;
//   - `cardBlocks` carry no repo, so they move into the first configured repo's record; the mirror's store reads
//     every repo's blocks and re-files a block under its card's own repo the next time it saves it;
//   - `implemented` (derived from labels), `promotionHeldNoted` (memory only), the empty shells earlier steps
//     left, and every repo entry no configured repo matches are dropped;
//   - an entry leaves the file only after its save succeeded; one that could not be read or saved stays, and its
//     repo is withheld until it is moved;
//   - when nothing is left the file is deleted. A file that cannot be parsed is left alone, with a warning.
//
// Idempotent: a second run finds nothing left to import, and no file.

import type { ItemRecord } from "./adapters.js";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { importIssueRecord, importPrRecord, setRepoUnimported, setUnimported, setUnimportedPrs, setUnresolvedBranches } from "./issue-records.js";
import { activeWorkSource, codeHost } from "./plugins/registry.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { importRepoRecord, type CardBlockRecord, type NoCommitStreak, type ProdRelease } from "./issue-records.js";
import { standingDivergence } from "./divergence.js";
import { legacyStatePath } from "./state-dir.js";
import type { UnstickEntry } from "./unstick.js";
import type { SavedRelease } from "./release-tracker.js";
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
export function importLegacyRecords(repoConfig: RepoConfig, logger: Logger, configured?: readonly RepoConfig[]): Promise<void> {
  const name = repoConfig.name;
  if (done.has(name) || (retryAt.get(name) ?? 0) > Date.now()) return Promise.resolve();
  const inFlight = running.get(name);
  if (inFlight) return inFlight;
  const run = importOnce(repoConfig, logger, configured)
    .catch((err) => {
      retryAt.set(name, Date.now() + RETRY_MS);
      logger.warn(`Legacy record import for ${repoConfig.githubRepo} failed, retrying later: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => running.delete(name));
  running.set(name, run);
  return run;
}

async function importOnce(repoConfig: RepoConfig, logger: Logger, configured?: readonly RepoConfig[]): Promise<void> {
  const name = repoConfig.name;
  if (!activeWorkSource()) return;
  const issuesPending = await importIssues(repoConfig, logger);
  const prsPending = await importPrs(repoConfig, logger);
  const repoPending = await importRepoLevel(repoConfig, logger);
  // The card blocks name no repo: the first configured repo's pass moves them all.
  const blocksPending = configured && configured[0]?.name === name ? await importCardBlocks(repoConfig, logger) : 0;
  // Dead fields, empty shells and repos no configured repo matches; the file goes when nothing is left.
  const orphans = editLegacyFile(() => {}, configured ? new Set(configured.map((r) => r.name)) : undefined);
  if (orphans.length > 0) logger.info(`Legacy state: dropped ${orphans.length} repo entr(ies) no configured repo matches (${orphans.join(", ")})`);
  if (issuesPending + prsPending + repoPending + blocksPending === 0) done.add(name);
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

// --- The legacy file --------------------------------------------------------------------------------
// This module is the only reader and writer of `.agent-state.json`. Every change reads the file, edits it and
// writes it back with no await between, so two repos importing at once cannot overwrite each other.

type LegacyRepo = Record<string, unknown>;
interface LegacyFile {
  repos: Record<string, LegacyRepo>;
  cardBlocks?: Record<string, CardBlockRecord>;
}

/** Fields that hold something a person or a pass still needs, until moved. */
const LIVE_FIELDS = [
  "failed", "skipped", "held", "verifyHeld", "unstick", "prodVerified", "promotionStallNoted",
  "rejectedBranches", "release", "prodReleases", "noCommitStreaks", "repoUnstick", "branchBlock",
] as const;
/** Fields nothing needs any more: derived from labels (`implemented`), memory only (`promotionHeldNoted`), long gone (`trackedPRs`). */
const DEAD_FIELDS = ["implemented", "promotionHeldNoted", "trackedPRs"] as const;

let warnedUnparsable = false;

/** The file's content; null when absent, or when it cannot be parsed (left alone). The v1 flat format holds nothing live and reads as empty. */
function readLegacyFile(): LegacyFile | null {
  const path = legacyStatePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && parsed.version === 2 && parsed.repos && typeof parsed.repos === "object") {
      return {
        repos: parsed.repos as Record<string, LegacyRepo>,
        ...(parsed.cardBlocks && typeof parsed.cardBlocks === "object" ? { cardBlocks: parsed.cardBlocks as Record<string, CardBlockRecord> } : {}),
      };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { repos: {} };
  } catch {
    // fall through: unparsable
  }
  if (!warnedUnparsable) {
    warnedUnparsable = true;
    console.warn(`[foreman] ${path} cannot be parsed; it is left alone and nothing is imported from it`);
  }
  return null;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) ? v.length === 0 : typeof v === "object" && Object.keys(v as object).length === 0);
}

/**
 * Drop what holds nothing: dead fields, empty tables, repos left with no field, and (when `configured` is given)
 * repos no configured repo matches. Deletes the file when nothing is left. Returns the orphan repo names dropped.
 */
function settle(file: LegacyFile, configured: ReadonlySet<string> | undefined): string[] {
  const orphans: string[] = [];
  for (const [name, repo] of Object.entries(file.repos)) {
    if (!repo || typeof repo !== "object" || (configured && !configured.has(name))) {
      orphans.push(name);
      delete file.repos[name];
      continue;
    }
    for (const f of DEAD_FIELDS) delete repo[f];
    for (const f of Object.keys(repo)) if (isEmpty(repo[f])) delete repo[f];
    if (Object.keys(repo).length === 0) delete file.repos[name];
  }
  if (isEmpty(file.cardBlocks)) delete file.cardBlocks;
  return orphans;
}

/** Read, change, settle and write back the file (or delete it when nothing is left). Returns the orphans dropped. */
function editLegacyFile(change: (file: LegacyFile) => void, configured?: ReadonlySet<string>): string[] {
  const file = readLegacyFile();
  if (!file) return [];
  change(file);
  const orphans = settle(file, configured);
  const path = legacyStatePath();
  try {
    if (Object.keys(file.repos).length === 0 && !file.cardBlocks) rmSync(path, { force: true });
    else writeFileSync(path, JSON.stringify({ version: 2, repos: file.repos, ...(file.cardBlocks ? { cardBlocks: file.cardBlocks } : {}) }, null, 2) + "\n");
  } catch {
    // Best-effort: what could not be written stays, and the next run finds it again.
  }
  return orphans;
}

type Table = Record<string, unknown>;
const tableOf = (repo: LegacyRepo | undefined, field: string): Table => ((repo?.[field] ?? {}) as Table);

/** What the file still holds for each issue of `repoName`, as the record the store keeps. */
function legacyIssueEntries(repoName: string): Map<number, Record<string, unknown>> {
  const repo = readLegacyFile()?.repos[repoName];
  const out = new Map<number, Record<string, unknown>>();
  if (!repo) return out;
  const entry = (n: number) => out.get(n) ?? out.set(n, {}).get(n)!;
  for (const field of ["failed", "skipped", "held", "verifyHeld", "prodVerified"] as const) {
    for (const [key, value] of Object.entries(tableOf(repo, field))) {
      if (Number.isInteger(Number(key)) && Number(key) > 0) entry(Number(key))[field] = value;
    }
  }
  for (const [key, value] of Object.entries(tableOf(repo, "unstick") as Record<string, UnstickEntry>)) {
    if (value.issue > 0) entry(value.issue).unstick = { ...(entry(value.issue).unstick as object | undefined), [key]: value };
  }
  for (const n of (repo.promotionStallNoted ?? []) as number[]) entry(n).promotionStallNoted = true;
  return out;
}

/** Remove the legacy entries of `issues` from the file (they are in the store, or no longer matter). */
function dropLegacyIssueEntries(repoName: string, issues: ReadonlySet<number>): void {
  if (issues.size === 0) return;
  editLegacyFile((file) => {
    const repo = file.repos[repoName];
    if (!repo) return;
    for (const field of ["failed", "skipped", "held", "verifyHeld", "prodVerified"] as const) {
      const keep = Object.entries(tableOf(repo, field)).filter(([k]) => !issues.has(Number(k)));
      if (keep.length > 0) repo[field] = Object.fromEntries(keep);
      else delete repo[field];
    }
    const keep = Object.entries(tableOf(repo, "unstick") as Record<string, UnstickEntry>).filter(([, e]) => !issues.has(e.issue));
    if (keep.length > 0) repo.unstick = Object.fromEntries(keep);
    else delete repo.unstick;
    const noted = ((repo.promotionStallNoted ?? []) as number[]).filter((n) => !issues.has(n));
    if (noted.length > 0) repo.promotionStallNoted = noted;
    else delete repo.promotionStallNoted;
  });
}

/** What the file still holds that is keyed by a pull request or a branch. */
interface LegacyPrEntries {
  releases: Map<number, ProdRelease>;
  tracked?: SavedRelease;
  streaks: Map<number, NoCommitStreak>;
  rejected: Map<string, string>;
}

function legacyPrEntries(repoName: string): LegacyPrEntries {
  const repo = readLegacyFile()?.repos[repoName];
  const out: LegacyPrEntries = { releases: new Map(), streaks: new Map(), rejected: new Map() };
  if (!repo) return out;
  for (const [k, v] of Object.entries(tableOf(repo, "prodReleases") as Record<string, ProdRelease>)) if (Number(k) > 0) out.releases.set(Number(k), v);
  for (const [k, v] of Object.entries(tableOf(repo, "noCommitStreaks") as Record<string, NoCommitStreak>)) if (Number(k) > 0) out.streaks.set(Number(k), v);
  for (const [k, v] of Object.entries(tableOf(repo, "rejectedBranches") as Record<string, string>)) if (typeof v === "string") out.rejected.set(k, v);
  const tracked = repo.release as SavedRelease | undefined;
  if (tracked && Number(tracked.pr) > 0) out.tracked = tracked;
  return out;
}

function dropLegacyPrEntries(repoName: string, drop: { releases?: ReadonlySet<number>; streaks?: ReadonlySet<number>; rejected?: ReadonlySet<string>; tracked?: boolean }): void {
  editLegacyFile((file) => {
    const repo = file.repos[repoName];
    if (!repo) return;
    const prune = (field: string, gone: ReadonlySet<string | number> | undefined) => {
      if (!gone || gone.size === 0) return;
      const keep = Object.entries(tableOf(repo, field)).filter(([k]) => !gone.has(k) && !gone.has(Number(k)));
      if (keep.length > 0) repo[field] = Object.fromEntries(keep);
      else delete repo[field];
    };
    prune("prodReleases", drop.releases);
    prune("noCommitStreaks", drop.streaks);
    prune("rejectedBranches", drop.rejected);
    if (drop.tracked) delete repo.release;
  });
}

/** Move the repo-level entries (EM#1244 f4); resolves how many could not be saved. */
async function importRepoLevel(repoConfig: RepoConfig, logger: Logger): Promise<number> {
  const name = repoConfig.name;
  const repo = readLegacyFile()?.repos[name];
  if (!repo) {
    setRepoUnimported(repoConfig.githubRepo, false);
    return 0;
  }
  const questions: Record<string, UnstickEntry> = { ...(tableOf(repo, "repoUnstick") as Record<string, UnstickEntry>) };
  for (const [k, e] of Object.entries(tableOf(repo, "unstick") as Record<string, UnstickEntry>)) if (e && !(e.issue > 0)) questions[k] = e;
  const bb = repo.branchBlock as { mergeBase?: string; announced?: number[]; ruled?: string[] } | undefined;
  if (isEmpty(questions) && !bb) {
    setRepoUnimported(repoConfig.githubRepo, false);
    return 0;
  }
  // Withheld until settled: a repo whose questions are not in its record yet must not read as one with none.
  setRepoUnimported(repoConfig.githubRepo, true);
  let pending = 0;
  let movedQuestions = 0;
  if (!isEmpty(questions)) {
    const ok = await importRepoRecord(repoConfig, (d) => { d.unstick = { ...questions, ...(d.unstick ?? {}) }; });
    if (ok) {
      movedQuestions = Object.keys(questions).length;
      editLegacyFile((file) => {
        const r = file.repos[name];
        if (!r) return;
        delete r.repoUnstick;
        const rest = Object.entries(tableOf(r, "unstick") as Record<string, UnstickEntry>).filter(([, e]) => e.issue > 0);
        if (rest.length > 0) r.unstick = Object.fromEntries(rest);
        else delete r.unstick;
      });
    } else pending++;
  }
  if (bb) {
    // Only an episode git still shows is carried over; a reconciled one holds nothing.
    const standing = bb.mergeBase !== undefined && standingDivergence(repoConfig)?.mergeBase === bb.mergeBase;
    let ok = true;
    if (standing) {
      const ruled = (bb.ruled ?? []).filter((x) => typeof x === "string");
      if (ruled.length > 0) ok = await importRepoRecord(repoConfig, (d) => { d.divergenceRuled = [...new Set([...(d.divergenceRuled ?? []), ...ruled])]; });
      for (const n of bb.announced ?? []) {
        if (ok && !(await importIssueRecord(repoConfig, n, (d) => { d.divergenceTold = d.divergenceTold ?? bb.mergeBase; }))) ok = false;
      }
    }
    if (ok) editLegacyFile((file) => { delete file.repos[name]?.branchBlock; });
    else pending++;
  }
  setRepoUnimported(repoConfig.githubRepo, pending > 0);
  logger.info(
    `Legacy repo records of ${repoConfig.githubRepo}: ${movedQuestions} EM question(s) moved to the repo's record` +
    (bb ? `, the branch divergence block ${pending > 0 ? "kept" : "settled"}` : "") +
    (pending > 0 ? `; ${pending} not saved yet, withheld until they are` : ""),
  );
  return pending;
}

/** The file's card blocks go into `home`'s record, one block at a time, each leaving the file once saved. */
async function importCardBlocks(home: RepoConfig, logger: Logger): Promise<number> {
  const blocks = readLegacyFile()?.cardBlocks;
  if (!blocks || isEmpty(blocks)) return 0;
  let moved = 0, pending = 0;
  for (const [id, block] of Object.entries(blocks)) {
    if (!block || typeof block !== "object") { editLegacyFile((f) => { delete f.cardBlocks?.[id]; }); continue; }
    const ok = await importRepoRecord(home, (d) => { d.cardBlocks = { [id]: block, ...(d.cardBlocks ?? {}) }; });
    if (ok) { moved++; editLegacyFile((f) => { delete f.cardBlocks?.[id]; }); }
    else pending++;
  }
  logger.info(`Legacy card blocks: ${moved} moved to ${home.githubRepo}'s record${pending > 0 ? `, ${pending} not saved yet` : ""}`);
  return pending;
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
