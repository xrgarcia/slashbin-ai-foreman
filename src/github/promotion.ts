// The promotion (release) PR: find ready issues, open or update the PR.

import type { LifecycleLabels } from "../config.js";
import type { Logger } from "../logger.js";
import { findOpenPrs, formatGhError, getOpenIssues, hasLabel } from "./cache.js";
import { gh, isBackoffRefusal } from "./gh.js";


// --- Promotion PR Creation ---

export interface PromotionIssue {
  number: number;
  title: string;
}

export function findReadyForProdIssues(
  repo: string,
  cwd: string,
  labels: LifecycleLabels,
  logger: Logger
): PromotionIssue[] {
  try {
    return getOpenIssues(repo, cwd, logger)
      .filter((i) => hasLabel(i, labels.readyForProd))
      .map((i) => ({ number: i.number, title: i.title }));
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger.debug("Failed to query ready-for-prod issues — GitHub back-off active");
      return [];
    }
    logger.error("Failed to query ready-for-prod issues", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface OpenPromotionPR {
  number: number;
  url: string;
  body: string;
}

export function findOpenPromotionPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): OpenPromotionPR | null {
  try {
    const prs: OpenPromotionPR[] = findOpenPrs(repo, cwd, { base: productionBranch, head: baseBranch, limit: 1 });
    return prs.length > 0 ? prs[0] : null;
  } catch (err) {
    logger?.warn("findOpenPromotionPR: gh pr list failed", { ...formatGhError(err) });
    return null;
  }
}

/**
 * A PR's state on GitHub, read live: the fleet state holds open PRs only, so a
 * PR that left it may have merged or been closed unmerged. Null when the read
 * failed.
 */
export function getPrState(repo: string, prNumber: number, cwd: string, logger?: Logger): "OPEN" | "MERGED" | "CLOSED" | null {
  try {
    const out = gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "state"], cwd);
    const state = (JSON.parse(out || "{}") as { state?: string }).state;
    return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
  } catch (err) {
    logger?.warn(`getPrState: gh pr view #${prNumber} failed`, { ...formatGhError(err) });
    return null;
  }
}

export function updatePromotionPR(
  repo: string,
  prNumber: number,
  issues: PromotionIssue[],
  cwd: string,
): boolean {
  const issueList = issues
    .map((i) => `- #${i.number}: ${i.title}`)
    .join("\n");

  const title = issues.length === 1
    ? `release: ${issues[0].title}`
    : `release: promote ${issues.length} changes to production`;

  const body = `## Production Promotion

### Issues included
${issueList}

---
Automated by slashbin-ai-agent`;

  // REST, NOT `gh pr edit` (2026-07-27).
  //
  // `gh pr edit` resolves the PR through GraphQL and requests `projectCards` —
  // GitHub's Projects *classic*, now sunset. The API rejects that field, gh
  // exits 1, and the edit DOES NOT APPLY:
  //
  //   GraphQL: Projects (classic) is being deprecated in favor of the new
  //   Projects experience (repository.pullRequest.projectCards)
  //
  // Reproduced twice against jerky_data_receiver#241 — exit 1, title unchanged.
  // This silently blocked EVERY repo that already had an open promotion PR,
  // from ~04:11Z until it was found at ~21:10Z: the promote phase kept logging
  // "Found N issue(s) ready for prod release" and then failing to act. Creating
  // a NEW promotion PR still worked, which is why some promotions got through
  // and others did not — a confusing signal that delayed the diagnosis.
  //
  // The REST endpoint touches no Projects field at all, so the deprecation
  // cannot affect it. Do not "simplify" this back to `gh pr edit`.
  const [owner, name] = repo.split("/");
  try {
    gh([
      "api", "--method", "PATCH",
      `repos/${owner}/${name}/pulls/${prNumber}`,
      "-f", `title=${title}`,
      "-f", `body=${body}`,
      "--silent",
    ], cwd);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    console.error(`updatePromotionPR failed: ${msg}${stderr ? ` | stderr: ${stderr}` : ""}`);
    return false;
  }
}

/**
 * Count files that differ between base and head branches.
 * Returns -1 if the check fails. Used as a precondition for promotion PRs
 * so the Foreman never opens a no-op PR when develop is ahead of main
 * only by sync merge commits with no file diff.
 */
export function countBranchDiffFiles(
  repo: string,
  base: string,
  head: string,
  cwd: string,
  logger: Logger,
): number {
  try {
    const json = gh([
      "api",
      `repos/${repo}/compare/${base}...${head}`,
      "--jq", "{ahead: .ahead_by, files: (.files // [] | length)}",
    ], cwd);
    const parsed = JSON.parse(json || "{}") as { ahead?: number; files?: number };
    return typeof parsed.files === "number" ? parsed.files : -1;
  } catch (err) {
    logger.warn(`countBranchDiffFiles failed for ${repo} (${base}...${head}): ${err instanceof Error ? err.message : String(err)}`);
    return -1;
  }
}

/**
 * Strip the `ready for prod release` label from issues once a promotion PR
 * has been created for them. Prevents a race with the EM verification script:
 * after a promotion PR merges, the Foreman's next poll would otherwise still
 * see the label (EM strips it only at close time, 1-2 min later) and create
 * a phantom follow-up promotion PR.
 */
export function stripReadyForProdLabel(
  repo: string,
  issueNumbers: number[],
  cwd: string,
  labels: LifecycleLabels,
  logger: Logger,
): void {
  for (const num of issueNumbers) {
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", repo,
        "--remove-label", labels.readyForProd,
      ], cwd);
      logger.info(`Stripped "${labels.readyForProd}" from #${num} — promotion PR owns it now`);
    } catch (err) {
      logger.warn(`Failed to strip "${labels.readyForProd}" from #${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function createPromotionPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  issues: PromotionIssue[],
  cwd: string,
  logger?: Logger,
): string | null {
  const issueList = issues
    .map((i) => `- #${i.number}: ${i.title}`)
    .join("\n");

  const title = issues.length === 1
    ? `release: ${issues[0].title}`
    : `release: promote ${issues.length} changes to production`;

  const body = `## Production Promotion

### Issues included
${issueList}

---
Automated by slashbin-ai-agent`;

  try {
    const result = gh([
      "pr", "create",
      "--repo", repo,
      "--base", productionBranch,
      "--head", baseBranch,
      "--title", title,
      "--body", body,
    ], cwd);

    // Extract PR URL from output
    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    return match ? match[0] : null;
  } catch (err) {
    logger?.warn("createPromotionPR: gh pr create failed", {
      ...formatGhError(err),
      repo,
      productionBranch,
      baseBranch,
      issueNumbers: issues.map((i) => i.number),
    });
    return null;
  }
}
