// A dark issue ships switched off, so it never holds a release (slashbin-ai-foreman#353).
//
// Origin (#353, 2026-11-18/19): a service repo's issue. A git-document mirror merged to `develop` before it had run
// against the real corpus, failed dev acceptance one defect at a time (nine correctives in 24 hours), and held
// its release, with seven signed issues, out of production the whole time: a release promotes all of
// `develop` (foreman#90), and the EM sign-off gate (foreman#128) holds it while any issue it carries is unsigned.
// An issue whose Pre-Flight names `Dark flag: <ENV_NAME>` lands behind an env flag that is off unless set, so the
// release carries its code switched off. Turning it on in production is a separate, signed step.
//
// The line can be written before the code that reads the flag lands (the EM switches a broken chain off at once, so
// the switch-off issue can build): for a release, a flag counts only once the code it ships names it.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { gitResult } from "../git-exec.js";
import { readIssueBody } from "./readiness.js";

/** `Dark flag: NAME`, with optional list marker, bold and backticks. */
const DARK_LINE = /^\s*(?:[-*]\s+)?\**dark flag:?\**:?\**\s*`?([A-Za-z0-9_]+)`?\s*(?:$|[\s.;,(—-])/i;
/** An env-variable name in capitals (`MCS_GIT_MIRROR_ENABLED`): "none" or "n/a" names no flag. */
const ENV_NAME = /^[A-Z][A-Z0-9_]+$/;

/** The env flag the `## Pre-Flight` section of `body` names as `Dark flag: <NAME>`, or null. Pure. */
export function darkFlag(body: string): string | null {
  let inPreFlight = false;
  let fenced = false;
  for (const line of (body ?? "").split(/\r?\n/)) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = line.match(/^##\s+(.*?)\s*#*\s*$/);
    if (heading) { inPreFlight = /^pre-flight$/i.test(heading[1]); continue; }
    if (!inPreFlight) continue;
    const m = line.match(DARK_LINE);
    if (m && ENV_NAME.test(m[1])) return m[1];
  }
  return null;
}

/** Whether the code at `ref` (fetched from origin) names `flag` as a whole word. False when it cannot be read. */
async function flagInCode(config: RepoConfig, ref: string, flag: string): Promise<boolean> {
  const fetched = await gitResult(["fetch", "--quiet", "origin", ref], config.repoPath);
  if (fetched.status !== 0) return false;
  return (await gitResult(["grep", "-q", "-w", "-F", "-e", flag, "FETCH_HEAD", "--"], config.repoPath)).status === 0;
}

/**
 * Of `issues`, the ones whose Pre-Flight names a dark flag, with the flag. With `shipped`, a release's head (a branch
 * or a commit), only those whose flag that code names: a flag line written before its code lands is not dark yet.
 * A body or a tree that cannot be read is not dark: the issue keeps holding, which is the safe side.
 */
export async function darkIssues(config: RepoConfig, issues: readonly number[], logger: Logger, shipped?: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const n of new Set(issues)) {
    let flag: string | null;
    try {
      flag = darkFlag(await readIssueBody(config, n));
    } catch (err) {
      logger.warn(`#${n}: its Pre-Flight could not be read, so it is not treated as dark: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
      continue;
    }
    if (!flag) continue;
    if (shipped && !(await flagInCode(config, shipped, flag))) {
      logger.info(`#${n}: its Pre-Flight names \`${flag}\`, but ${shipped} does not; it is not dark in this release yet`);
      continue;
    }
    out.set(n, flag);
  }
  return out;
}
