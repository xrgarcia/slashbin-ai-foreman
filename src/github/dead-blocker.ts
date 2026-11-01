// A build that ends with no PR must say so to whoever waits on it.
//
// Origin: 2026-10-26. Two `approved` dependency-landing chores ended with "No PR
// produced" / "No code change to land" — Slashbin-Ingest-Gateway#222 (all 11
// PRs fail npm ci) and jerky_skuvault_service#478 (all 16 already on features).
// Each stayed open and `approved`, so every issue GitHub records as blocked by
// it (gateway#227, an S1 security fix; skuvault#489) was never picked up, and
// nothing re-evaluated them: ~13h of S1 stall.
//
// Two outcomes, two exits:
//  - nothing to land, everything already present: the issue is DONE. Close it as
//    completed with the evidence (`closeAlreadyLanded`); a closed blocker holds
//    nothing (blockers.ts), so its dependents run on their own.
//  - cannot land, a cause outside the build: the issue stays open and takes the
//    blocked label, and every open issue it blocks is told, once, that its
//    blocker is dead (`announceDeadBlocker`) — a comment, the blocked label, and
//    the EM's escalation — rather than waiting silently on a build that will not come.

import type { RepoConfig } from "../config.js";
import { gh } from "./gh.js";
import type { Announced } from "../code-host.js";
export type { Announced } from "../code-host.js";

/** An issue as `GET /repos/{o}/{r}/issues/{n}/dependencies/blocking` returns it. */
export interface Dependent {
  number: number;
  state: string;
  labels: { name: string }[];
  /** `https://api.github.com/repos/owner/name`; absent reads as the blocker's own repo. */
  repository_url?: string;
}

/** Every issue GitHub records as blocked BY `issue`. Throws on a gh failure. */
export function dependentsOf(repo: string, issue: number, cwd: string): Dependent[] {
  return JSON.parse(gh(["api", `repos/${repo}/issues/${issue}/dependencies/blocking`], cwd) || "[]");
}

/** `owner/repo` of a dependent, defaulting to `own` when the API row names none. */
export function dependentRepo(d: Dependent, own: string): string {
  return d.repository_url?.match(/repos\/([^/]+\/[^/]+)$/)?.[1] ?? own;
}

/** `#N`, or `owner/repo#N` for a dependent in another repo. */
export function dependentRef(d: Dependent, own: string): string {
  const repo = dependentRepo(d, own);
  return repo === own ? `#${d.number}` : `${repo}#${d.number}`;
}

/**
 * A skip is a dead blocker only when its cause is outside the build and will not
 * clear by itself. A diverged feature branch resolves on its own. The other
 * transient wait, an open PR occupying the branch, is recognised by the caller
 * with `prBlockingSkip` (phases/implement.ts), which owns that wording.
 */
export function isDeadBlockerReason(reason: string): boolean {
  return !/diverged from origin\//i.test(reason);
}

/** The comment left on a dependent whose blocker will not land. */
export function deadBlockerComment(blockerRef: string, reason: string, blockedLabel: string): string {
  return [
    `**Blocker will not land on its own: ${blockerRef}.**`,
    "",
    `This issue is blocked by ${blockerRef} (GitHub dependency). The Foreman's build on it ended with no PR and cannot continue without a person: ${reason}`,
    "",
    `The Foreman will not pick this issue up while it waits on ${blockerRef}, so it has been labelled \`${blockedLabel}\` and escalated to the EM. ` +
      `Resolve the blocker (or remove the dependency), then remove the \`${blockedLabel}\` label here to release it.`,
  ].join("\n");
}

/** The comment that closes an issue whose work is already present. */
export function alreadyLandedComment(reason: string, baseBranch: string): string {
  return [
    `**Nothing left to land — closing as completed.**`,
    "",
    `The Foreman's build found the work of this issue already present on \`${baseBranch}\`, so no PR was produced: ${reason}`,
    "",
    "Issues blocked by this one are released by the close.",
  ].join("\n");
}

/** Close `num` as completed, commenting the evidence first. Throws on a failed write. */
export function closeAlreadyLanded(config: RepoConfig, num: number, reason: string): void {
  gh(["issue", "comment", String(num), "--repo", config.githubRepo, "--body", alreadyLandedComment(reason, config.featureBranch)], config.repoPath);
  gh(["issue", "close", String(num), "--repo", config.githubRepo, "--reason", "completed"], config.repoPath);
}

/**
 * Tell every open dependent of `blocker` that it is dead: comment, add the
 * blocked label, and return the ones told so the caller can escalate them and
 * remember them. `already` (refs told before) are not told again; `open` is
 * every open dependent, told now or before, so the caller can retry an escalation that did not land. A failed write
 * on one dependent never stops the next; the failures are returned, never lost.
 * Throws only when the dependents cannot be read at all.
 */
export function announceDeadBlocker(
  config: RepoConfig,
  blocker: number,
  reason: string,
  already: readonly string[] = [],
): { told: Announced[]; failed: { ref: string; error: string }[]; open: Announced[] } {
  const open = dependentsOf(config.githubRepo, blocker, config.repoPath).filter((d) => d.state !== "closed");
  const told: Announced[] = [];
  const everyOpen: Announced[] = open.map((d) => ({ ref: dependentRef(d, config.githubRepo), repo: dependentRepo(d, config.githubRepo), number: d.number }));
  const failed: { ref: string; error: string }[] = [];
  for (const d of open) {
    const ref = dependentRef(d, config.githubRepo);
    if (already.includes(ref)) continue;
    const repo = dependentRepo(d, config.githubRepo);
    try {
      gh(["issue", "comment", String(d.number), "--repo", repo, "--body", deadBlockerComment(`${config.githubRepo}#${blocker}`, reason, config.github.blockedLabel)], config.repoPath);
      if (!d.labels.some((l) => l.name === config.github.blockedLabel)) {
        gh(["issue", "edit", String(d.number), "--repo", repo, "--add-label", config.github.blockedLabel], config.repoPath);
      }
      told.push({ ref, repo, number: d.number });
    } catch (err) {
      failed.push({ ref, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { told, failed, open: everyOpen };
}

/** Add the blocked label to the blocker itself, so the Foreman never re-picks a build it cannot finish. Throws on a failed write. */
export function holdBlocker(config: RepoConfig, num: number): void {
  gh(["issue", "edit", String(num), "--repo", config.githubRepo, "--add-label", config.github.blockedLabel], config.repoPath);
}
