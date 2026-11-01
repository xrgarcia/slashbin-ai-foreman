/**
 * A closed issue holds nothing. The Foreman's state keeps a skip, a review or
 * verify hold, a failure count and an unstick entry per issue, and nothing
 * removed them when the issue was closed from outside (a person, the EM, the
 * SRE): jerky_ops#138 still read "Holding 1 skipped issue" after it closed, and
 * its card kept being parked in Blocked (2026-10-26). Each pass, an entry whose
 * issue is no longer open is read live and, when GitHub says closed, dropped.
 * An issue that cannot be read keeps its entry.
 */

import type { RepoConfig } from "./config.js";
import type { WorkSourceAdapter } from "./adapters.js";
import type { Logger } from "./logger.js";
import { loadRepoState, saveRepoState } from "./state.js";
import { codeHost } from "./plugins/registry.js";

/** Drop the repo's state entries for issues GitHub reads closed; the numbers dropped. */
export async function pruneClosedHolds(
  repoConfig: RepoConfig,
  source: WorkSourceAdapter,
  logger: Logger,
  /** The open issues' numbers (tests inject them). */
  openNumbers: () => number[] = () => codeHost().openIssueLabels(repoConfig, logger).map((i) => i.number),
): Promise<number[]> {
  if (!source.states) return [];
  const state = loadRepoState(repoConfig.name);
  const named = new Set<number>();
  for (const table of [state.skipped, state.held, state.verifyHeld, state.failed]) for (const k of Object.keys(table ?? {})) named.add(Number(k));
  for (const e of Object.values(state.unstick ?? {})) named.add(e.issue);
  if (!named.size) return [];
  const open = new Set(openNumbers());
  const candidates = [...named].filter((n) => Number.isInteger(n) && !open.has(n));
  if (!candidates.length) return [];
  const live = await source.states(repoConfig, candidates, logger);
  const shut = candidates.filter((n) => {
    const s = live.get(n);
    return s !== undefined && s !== "open";
  });
  if (!shut.length) return [];
  const gone = new Set(shut);
  const drop = <T>(table: Record<number, T> | undefined): Record<number, T> | undefined =>
    table ? Object.fromEntries(Object.entries(table).filter(([k]) => !gone.has(Number(k)))) as Record<number, T> : table;
  const next = loadRepoState(repoConfig.name);
  next.skipped = drop(next.skipped);
  next.held = drop(next.held);
  next.verifyHeld = drop(next.verifyHeld);
  next.failed = drop(next.failed) ?? {};
  if (next.unstick) next.unstick = Object.fromEntries(Object.entries(next.unstick).filter(([, e]) => !gone.has(e.issue)));
  saveRepoState(repoConfig.name, next);
  logger.info(`Cleared the Foreman's holds on closed issue(s): ${shut.map((n) => `#${n}`).join(", ")}`);
  return shut;
}
