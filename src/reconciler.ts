import { execFileSync } from "node:child_process";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { gh, verifyPRExists } from "./github.js";

export interface ReconciliationResult {
  reconciled: boolean;
  prUrl?: string;
  issueNumbers: number[];
  commitCount: number;
  error?: string;
}

interface OrphanedCommit {
  hash: string;
  message: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

function getOrphanedCommits(
  repoPath: string,
  featureBranch: string,
  baseBranch: string,
  logger: Logger,
): OrphanedCommit[] {
  try {
    // Ensure local refs are up to date
    git(["fetch", "origin", featureBranch, baseBranch], repoPath);
  } catch (err) {
    logger.warn("git fetch failed, skipping reconciliation", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  try {
    const log = git(
      ["log", `origin/${baseBranch}..origin/${featureBranch}`, "--format=%H %s"],
      repoPath,
    );

    if (!log) return [];

    return log.split("\n").map((line) => {
      const spaceIdx = line.indexOf(" ");
      return {
        hash: line.slice(0, spaceIdx),
        message: line.slice(spaceIdx + 1),
      };
    });
  } catch (err) {
    logger.debug("Failed to get orphaned commits", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function extractIssueNumbers(commits: OrphanedCommit[]): number[] {
  const issueNums = new Set<number>();
  for (const commit of commits) {
    const matches = commit.message.matchAll(/#(\d+)/g);
    for (const match of matches) {
      issueNums.add(Number(match[1]));
    }
  }
  return [...issueNums].sort((a, b) => a - b);
}

function hasOpenPR(
  githubRepo: string,
  featureBranch: string,
  baseBranch: string,
  cwd: string,
): { number: number; url: string } | null {
  try {
    const json = gh([
      "pr", "list",
      "--repo", githubRepo,
      "--head", featureBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "number,url",
      "--limit", "1",
    ], cwd);
    const prs: { number: number; url: string }[] = JSON.parse(json || "[]");
    return prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}

function createReconciliationPR(
  config: RepoConfig,
  issueNumbers: number[],
  commitCount: number,
  logger: Logger,
): string | null {
  const issueList = issueNumbers.length > 0
    ? issueNumbers.map((n) => `- Closes #${n}`).join("\n")
    : "_No linked issues found in commit messages_";

  const title = issueNumbers.length === 1
    ? `feat: implement #${issueNumbers[0]}`
    : `feat: implement ${commitCount} change(s) from features`;

  const body = `## Feature PR (Reconciled)

This PR was created automatically by Foreman's reconciliation phase.
Orphaned commits were found on \`${config.featureBranch}\` with no open PR targeting \`${config.baseBranch}\`.

### Linked Issues
${issueList}

### Commits
${commitCount} commit(s) on \`${config.featureBranch}\` ahead of \`${config.baseBranch}\`

---
_Automated by slashbin-ai-agent (reconciler)_`;

  try {
    const result = gh([
      "pr", "create",
      "--repo", config.githubRepo,
      "--base", config.baseBranch,
      "--head", config.featureBranch,
      "--title", title,
      "--body", body,
    ], config.repoPath);

    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    return match ? match[0] : null;
  } catch (err) {
    logger.error("Failed to create reconciliation PR", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function reconcileRepo(
  config: RepoConfig,
  logger: Logger,
): ReconciliationResult {
  // Skip main-only repos (like docs site)
  if (config.baseBranch === config.featureBranch) {
    return { reconciled: false, issueNumbers: [], commitCount: 0 };
  }

  // Check for orphaned commits
  const orphans = getOrphanedCommits(
    config.repoPath,
    config.featureBranch,
    config.baseBranch,
    logger,
  );

  if (orphans.length === 0) {
    return { reconciled: false, issueNumbers: [], commitCount: 0 };
  }

  logger.info(`Found ${orphans.length} commit(s) on ${config.featureBranch} ahead of ${config.baseBranch}`);

  // Check if PR already exists
  const existingPR = hasOpenPR(
    config.githubRepo,
    config.featureBranch,
    config.baseBranch,
    config.repoPath,
  );

  if (existingPR) {
    logger.debug(`PR already exists: #${existingPR.number} — no reconciliation needed`);
    return { reconciled: false, issueNumbers: [], commitCount: orphans.length };
  }

  // Extract issue numbers from commit messages
  const issueNumbers = extractIssueNumbers(orphans);
  logger.info(`Extracted issue numbers from commits: ${issueNumbers.join(", ") || "none"}`);

  // Create the missing PR
  const prUrl = createReconciliationPR(config, issueNumbers, orphans.length, logger);

  if (!prUrl) {
    return {
      reconciled: false,
      issueNumbers,
      commitCount: orphans.length,
      error: "Failed to create reconciliation PR",
    };
  }

  // Verify PR was actually created
  const verified = verifyPRExists(
    config.githubRepo,
    config.featureBranch,
    config.baseBranch,
    config.repoPath,
  );

  if (!verified) {
    logger.warn("PR URL returned but verification failed — PR may not exist");
    return {
      reconciled: false,
      issueNumbers,
      commitCount: orphans.length,
      error: "PR creation could not be verified",
    };
  }

  logger.info(`Reconciliation PR created and verified: ${prUrl}`);
  return {
    reconciled: true,
    prUrl,
    issueNumbers,
    commitCount: orphans.length,
  };
}
