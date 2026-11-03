// The shared feature branch's divergence from its base, as the Foreman knows it (EM#1244 f4).
//
// It is DERIVED from git, never stored: `readDivergence` (reconciler.ts) reads it, and the implement stage's
// fast-forward reports it every pass it runs. What this module keeps is only the last observation per repo, in
// memory, so a pass that cannot ask git (a failed fetch, or a stage that returns before the fast-forward) still
// knows a divergence stands, and a reader that must not fetch (foremanHolds) has an answer. After a restart the
// first reader asks git once. What must survive a restart lives elsewhere: the issues told (`divergenceTold` on
// the issue's record) and the rulings already carried out (`divergenceRuled` on the repo's record).

import type { RepoConfig } from "./config.js";
import { readDivergence } from "./reconciler.js";

/** One divergence episode: the merge base identifies it (commits piling up on either side keep it). */
export interface Divergence {
  featureBranch: string;
  baseBranch: string;
  mergeBase: string;
  ahead: number;
  behind: number;
}

/** The last observation per repo name: a Divergence, or null for reconciled. No entry: never observed in this process. */
const observed = new Map<string, Divergence | null>();

function describe(config: RepoConfig, d: { ahead: number; behind: number; mergeBase: string }): Divergence {
  return { featureBranch: config.featureBranch, baseBranch: config.baseBranch, mergeBase: d.mergeBase, ahead: d.ahead, behind: d.behind };
}

/**
 * What git shows about the divergence on `config`'s repo: a Divergence, null (reconciled), or undefined (unknown:
 * git cannot be read and nothing was observed yet, which proves nothing). The first call in a process asks git;
 * later ones answer from the last observation, which the implement stage refreshes on every pass.
 */
export function knownDivergence(config: RepoConfig): Divergence | null | undefined {
  if (!observed.has(config.name)) {
    const d = readDivergence(config);
    if (d === undefined) return undefined;
    observed.set(config.name, d ? describe(config, d) : null);
  }
  return observed.get(config.name) ?? null;
}

/** The divergence standing on `config`'s repo, or null; an unknown state reads as null here (the fast-forward that follows asks again). Callers that must tell unknown from reconciled use `knownDivergence`. */
export function standingDivergence(config: RepoConfig): Divergence | null {
  return knownDivergence(config) ?? null;
}

/** Record what a fresh read showed: `d` diverged, null reconciled. Returns the previous observation. */
export function observeDivergence(config: RepoConfig, d: { ahead: number; behind: number; mergeBase: string } | null): { before: Divergence | null; now: Divergence | null } {
  const before = observed.get(config.name) ?? null;
  const now = d ? describe(config, d) : null;
  observed.set(config.name, now);
  return { before, now };
}

/** Tests only: forget every observation. */
export function resetDivergenceForTests(): void {
  observed.clear();
}
