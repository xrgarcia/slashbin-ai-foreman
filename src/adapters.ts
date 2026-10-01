import type { RepoConfig, AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";

/**
 * One unit of work a source hands to the pipeline. Deliberately minimal: the
 * stage that receives it fetches whatever detail it needs from the source
 * itself, so a non-GitHub source (EM#417) never has to fake a GitHub shape.
 */
export interface WorkItem {
  issueNumber: number;
  repo: string;
}

/**
 * Where the Foreman's work comes from. The implement stage asks the source
 * which items to build this pass and hands exactly those to the agent — the
 * skill no longer chooses. GitHub issues are the first connector
 * (`GitHubIssueConnector` in github.ts); this module must stay free of any
 * source-specific code so another connector can import it alone.
 */
export interface WorkSourceAdapter {
  selectWork(
    repoConfig: RepoConfig,
    config: AgentConfig,
    logger: Logger,
  ): Promise<WorkItem[]>;
}
