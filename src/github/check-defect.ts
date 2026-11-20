// Finding the defect issue a check-defect hand-off produced (slashbin-ai-foreman#366). The EM files the defect and
// links each affected issue to it as a blocker; the Foreman only reads that back, by the `checkId: <id>` line in the
// defect's body.

import type { RepoConfig } from "../config.js";
import { blockersOf } from "./blockers.js";
import { readIssueBody } from "./readiness.js";
import { canonicalRepo, isOwnRow } from "./repo-identity.js";

/** True when `body` has a line carrying `checkId: <checkId>` as a whole token (`o/r:a` is not found in `o/r:a-b`). Pure, exported for tests. */
export function bodyNamesCheck(body: string, checkId: string): boolean {
  const marker = `checkId: ${checkId}`;
  for (const line of body.split("\n")) {
    for (let at = line.indexOf(marker); at >= 0; at = line.indexOf(marker, at + 1)) {
      const next = line[at + marker.length];
      if (next === undefined || !/[\w./:-]/.test(next)) return true;
    }
  }
  return false;
}

/**
 * The blocker of one of `affected` (own repo's rows only) whose body names `checkId`, with whether it is closed; null
 * when none does. Throws when a link or a body cannot be read: a guess is not a fact.
 */
export async function checkDefectOf(
  config: RepoConfig, affected: readonly number[], checkId: string,
): Promise<{ repo: string; issue: number; closed: boolean } | null> {
  const repo = await canonicalRepo(config.githubRepo, config.repoPath);
  const seen = new Set<number>();
  for (const n of affected) {
    for (const b of await blockersOf(config.githubRepo, n, config.repoPath)) {
      if (seen.has(b.number)) continue;
      seen.add(b.number);
      if (!(await isOwnRow(b.repository_url, config.githubRepo, config.repoPath))) continue;
      if (bodyNamesCheck(await readIssueBody(config, b.number), checkId)) return { repo, issue: b.number, closed: b.state === "closed" };
    }
  }
  return null;
}
