import type { AgentConfig } from "../config.js";
import { GitHubIssueConnector } from "../github-work-source.js";
import type { ForemanPlugin } from "./contract.js";

/** The work-source id that selects this plugin; the default. */
export const GITHUB_WORK_SOURCE = "github";

/**
 * GitHub issues as the work source (EM#1150 f4): selects approved issues and
 * turns each lifecycle move into its labels (github-work-source.ts). On unless
 * the config names another work source. The only place outside the GitHub code
 * that constructs the connector; the core reaches it through the registry.
 *
 * PR, branch and merge operations (the code host) are not here yet.
 */
export class GitHubPlugin implements ForemanPlugin {
  readonly id = "github";
  readonly roles = ["workSource"] as const;
  /** Stateless: its holds and announcements live in github-work-source.ts's module state, as before. */
  readonly workSource = new GitHubIssueConnector();

  enabled(config: AgentConfig): boolean {
    return (config.workSource ?? GITHUB_WORK_SOURCE) === GITHUB_WORK_SOURCE;
  }

  disabledReason(config: AgentConfig): string | undefined {
    return `GitHub work source off: workSource is "${config.workSource}"`;
  }
}
