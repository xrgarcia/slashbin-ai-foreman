// The gh calls the core used to spawn itself (EM#1150 f5), moved here verbatim so
// the core reaches GitHub only through the code-host plugin. Each keeps its exact
// arguments, token and error behaviour: the core still decides what a result means.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeploymentView, IssueTextRow } from "../code-host.js";
import type { RepoConfig } from "../config.js";
import { ghAsync } from "./gh.js";
import { branchPrefixOf, isForemanOwnedHead, isLegacyFeatureHead } from "../foreman-branch.js";

/** `lastEditedAt` of issue `n` as GraphQL returns it: undefined when absent, null when never edited. Throws on a failed read. */
export async function issueLastEditedAt(repoConfig: RepoConfig, n: number): Promise<string | null | undefined> {
  const [owner, name] = repoConfig.githubRepo.split("/");
  const out = await ghAsync(["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${n}`, "-f",
    "query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){lastEditedAt}}}"], repoConfig.repoPath);
  return JSON.parse(out || "{}")?.data?.repository?.issue?.lastEditedAt;
}

const jsonLines = (out: string) => out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Every comment on issue `n`, id prefixed `comment:`. Throws on a failed read. */
export async function issueCommentRows(repo: string, n: number, cwd: string): Promise<IssueTextRow[]> {
  return jsonLines(await ghAsync(["api", "--paginate", `repos/${repo}/issues/${n}/comments?per_page=100`, "--jq",
    `.[] | {id: ("comment:" + (.id|tostring)), issue: ${n}, author: (.user.login // ""), at: .created_at, body: (.body // "")} | @json`], cwd));
}

/**
 * Every deployment GitHub holds for commit `sha`, each with its newest status (Railway posts both for
 * every deploy, to `<project> / <environment>`). A deployment with no status yet reads `pending`.
 * Throws on a failed read.
 */
export async function deploymentsForSha(repoConfig: RepoConfig, sha: string): Promise<DeploymentView[]> {
  const rows = jsonLines(await ghAsync(["api", "--paginate", `repos/${repoConfig.githubRepo}/deployments?sha=${sha}&per_page=100`, "--jq",
    ".[] | {id, environment} | @json"], repoConfig.repoPath)) as Array<{ id: number; environment: string }>;
  const out: DeploymentView[] = [];
  for (const d of rows) {
    const status = jsonLines(await ghAsync(["api", `repos/${repoConfig.githubRepo}/deployments/${d.id}/statuses?per_page=1`, "--jq",
      ".[0] // empty | {state, at: .created_at} | @json"], repoConfig.repoPath))[0] as { state: string; at: string } | undefined;
    out.push({ environment: d.environment ?? "", state: (status?.state ?? "pending").toLowerCase(), at: status?.at ?? "" });
  }
  return out;
}

/** Every open issue (not PR) `creator` opened, id prefixed `issue:`. Throws on a failed read. */
export async function openIssueRowsBy(repo: string, creator: string, cwd: string): Promise<IssueTextRow[]> {
  return jsonLines(await ghAsync(["api", "--paginate", `repos/${repo}/issues?state=open&creator=${creator}&per_page=100`, "--jq",
    `.[] | select(.pull_request | not) | {id: ("issue:" + (.number|tostring)), issue: .number, author: (.user.login // ""), at: .created_at, body: (.body // ""), title: .title} | @json`], cwd));
}

/** The open PR `head → base`, live (at most one). Throws on a failed read. */
export async function openPrsForBranch(repo: string, head: string, base: string, cwd: string): Promise<{ number: number; url: string }[]> {
  const json = await ghAsync([
    "pr", "list",
    "--repo", repo,
    "--head", head,
    "--base", base,
    "--state", "open",
    "--json", "number,url",
    "--limit", "1",
  ], cwd);
  return JSON.parse(json || "[]");
}

/** The last 20 closed PRs `head → base`, merged or not. Throws on a failed read. */
export async function closedPrsForBranch(repo: string, head: string, base: string, cwd: string): Promise<{
  number: number; url: string; mergedAt: string | null; headRefOid: string; closedAt: string | null;
}[]> {
  const json = await ghAsync([
    "pr", "list",
    "--repo", repo,
    "--head", head,
    "--base", base,
    "--state", "closed",
    "--json", "number,url,mergedAt,headRefOid,closedAt",
    "--limit", "20",
  ], cwd);
  return JSON.parse(json || "[]");
}

/** Most PRs one `head → base` listing may return before it is treated as incomplete. */
export const ALL_PRS_LIMIT = 5000;

/**
 * EVERY PR `head → base`, open, merged and closed, with no date window (gh pages through the list). Throws on a
 * failed read, and when the list reaches ALL_PRS_LIMIT: a listing that may have been cut short is not a listing.
 */
export async function allPrsForBranch(repo: string, head: string, base: string, cwd: string): Promise<{ number: number; state: string }[]> {
  const json = await ghAsync([
    "pr", "list",
    "--repo", repo,
    "--head", head,
    "--base", base,
    "--state", "all",
    "--json", "number,state",
    "--limit", String(ALL_PRS_LIMIT),
  ], cwd);
  const prs = JSON.parse(json || "[]") as { number: number; state: string }[];
  if (prs.length >= ALL_PRS_LIMIT) throw new Error(`${repo}: ${head} → ${base} lists ${prs.length}+ PRs; the listing may be incomplete`);
  return prs;
}

/** Open a PR `head → base`; gh's output (the PR URL). Throws on failure. */
export async function createPr(config: RepoConfig, pr: { base: string; head: string; title: string; body: string }): Promise<string> {
  return await ghAsync([
    "pr", "create",
    "--repo", config.githubRepo,
    "--base", pr.base,
    "--head", pr.head,
    "--title", pr.title,
    "--body", pr.body,
  ], config.repoPath);
}

const execFileAsync = promisify(execFile);

/** Every label name on the repo. Throws on a failed read. */
export async function labelNames(repo: RepoConfig): Promise<string[]> {
  const out = await ghAsync(["api", "-X", "GET", `repos/${repo.githubRepo}/labels`, "--paginate", "--jq", ".[].name"], repo.repoPath);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Create one label. Throws on failure (an existing one included). */
export async function createLabel(repo: RepoConfig, name: string, color: string): Promise<void> {
  await ghAsync(["api", "-X", "POST", `repos/${repo.githubRepo}/labels`, "-f", `name=${name}`, "-f", `color=${color}`], repo.repoPath);
}

/**
 * The open Foreman-owned PR's URL (a head in `branches` first, else any Foreman head), asked of
 * gh directly with the ambient auth: the implement session's fallback when its output names no
 * PR. Outside runGhAsync, as it always was (async now, so a hung gh never freezes the loop); the caller checks the GitHub back-off first. Undefined
 * when none. Heads are filtered through the one ownership test, so a human branch never answers.
 */
export async function featurePrUrlFallback(config: RepoConfig, branches: readonly string[] = []): Promise<string | undefined> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("gh", [
    "pr", "list",
    "--repo", config.githubRepo,
    "--base", config.baseBranch,
    "--state", "open",
    "--limit", "100",
    "--json", "url,headRefName",
  ], { cwd: config.repoPath, encoding: "utf-8", timeout: 15_000 }));
  } catch {
    // A failed or timed-out gh answered nothing, as spawnSync did.
  }
  try {
    const prs = JSON.parse(stdout || "[]") as { url: string; headRefName: string }[];
    const owned = prs.filter((p) => isForemanOwnedHead(config, p.headRefName));
    return (owned.find((p) => branches.includes(p.headRefName)) ?? owned[0])?.url;
  } catch {
    return undefined;
  }
}

/**
 * Delete a merged Foreman PR's head branch (#208). Only a head the Foreman owns by PREFIX is
 * ever deleted: a human-named head, the legacy shared featureBranch, the base and the production
 * branch are refused (false). True when the ref is gone (already-gone counts). Throws on a failed call.
 */
export async function deleteMergedBranch(config: RepoConfig, head: string): Promise<boolean> {
  if (!head.startsWith(branchPrefixOf(config)) || !isForemanOwnedHead(config, head)) return false;
  if (isLegacyFeatureHead(config, head) || head === config.baseBranch || head === config.productionBranch) return false;
  try {
    await ghAsync(["api", "-X", "DELETE", `repos/${config.githubRepo}/git/refs/heads/${head}`], config.repoPath);
  } catch (err) {
    const msg = err instanceof Error ? `${err.message} ${(err as { stderr?: unknown }).stderr ?? ""}` : String(err);
    if (/Reference does not exist|HTTP 422|HTTP 404|Not Found/i.test(msg)) return true;
    throw err;
  }
  return true;
}
