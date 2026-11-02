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
// Idempotent: a second run finds nothing left to import. Deleted with the file (f4).

import type { ItemRecord } from "./adapters.js";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { importIssueRecord, setUnimported, type IssueRecord } from "./issue-records.js";
import { activeWorkSource, codeHost } from "./plugins/registry.js";
import { dropLegacyIssueEntries, legacyIssueEntries } from "./state.js";

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
  const source = activeWorkSource();
  if (!source) return;
  const legacy = legacyIssueEntries(name);
  if (legacy.size === 0) {
    done.add(name);
    setUnimported(repoConfig.githubRepo, new Set());
    return;
  }
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
  if (pending.size === 0) done.add(name);
  else retryAt.set(name, Date.now() + RETRY_MS);
  logger.info(
    `Legacy records of ${repoConfig.githubRepo}: ${imported.size} issue(s) moved to the work source, ${closed.size} closed issue(s) dropped` +
    (pending.size > 0 ? `, ${pending.size} not saved yet (${[...pending].map((n) => `#${n}`).join(", ")}) — withheld until they are` : ""),
  );
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
