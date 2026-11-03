// The human lane's one stage (registry lane `human`; `syncOnly` repos). The Foreman does not build
// there: a person implements the issue directly in Claude Code with the unified
// implement-approved-issues skill (direct mode, branch `feature/<N>-<slug>`). What the Foreman owns
// is that the skills the person runs are the current golden ones. For each open `approved-for-human`
// issue it puts a skill-sync commit on `feature/<N>-<slug>`, cut from fresh origin/<base>, which the
// direct-mode skill resumes (it finds `feature/<N>-*` on origin and merges origin/<base> into it).
//
// It opens no PR, adds no label, comments nowhere, implements nothing, and touches no checkout
// (SkillSync.deliverSkillsForIssue builds the commit with git plumbing). Nothing to do when
// origin/<base> already carries the current skills.

import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { codeHost } from "../plugins/registry.js";
import type { ForemanRuntime } from "../runtime.js";
import type { CycleEvent } from "./common.js";

/** The registry's human-lane issue label. */
export const HUMAN_LANE_LABEL = "approved-for-human";

/** Returns how many issues got a skill branch this pass. Never throws. */
export async function trySkillDeliver(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  events: CycleEvent[],
): Promise<number> {
  if (!repoConfig.syncOnly || !config.skillSync?.enabled) return 0;
  let delivered = 0;
  try {
    const issues = codeHost()
      .getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)
      .filter((i) => codeHost().hasLabel(i, HUMAN_LANE_LABEL))
      .sort((a, b) => a.number - b.number);
    for (const issue of issues) {
      const out = rt.skillSync.deliverSkillsForIssue(config.skillSync, repoConfig, issue, logger);
      // Current is repo-wide (origin/<base> carries the skills): no issue needs anything. A skip or failure repeats on the next issue.
      if (out.status !== "delivered" && out.status !== "exists") break;
      if (out.status === "delivered") {
        delivered++;
        events.push({ message: `${repoConfig.githubRepo}#${issue.number}: skills synced onto ${out.branch} (${out.skills.join(", ")})`, level: "info" });
      } else if (out.status === "exists") {
        logger.debug(`Skill delivery: #${issue.number} already has ${out.branch} — left alone`);
      }
    }
  } catch (err) {
    logger.warn(`Skill delivery for ${repoConfig.name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return delivered;
}
