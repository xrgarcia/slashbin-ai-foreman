import { GitHubIssueConnector } from "./github.js";
import type { WorkSourceAdapter } from "./adapters.js";
import type { RepoConfig } from "./config.js";

/**
 * The work source each repo selects from and reports to. GitHub issues unless
 * a source has been registered. Kept out of adapters.ts so that module never
 * imports a connector. Config-driven choice of source is EM#417's.
 */
let registered: WorkSourceAdapter | null = null;

export function registerWorkSource(adapter: WorkSourceAdapter | null): void {
  registered = adapter;
}

export function workSourceFor(_repoConfig: RepoConfig): WorkSourceAdapter {
  return registered ?? new GitHubIssueConnector();
}
