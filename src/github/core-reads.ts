// The gh calls the core used to spawn itself (EM#1150 f5), moved here verbatim so
// the core reaches GitHub only through the code-host plugin. Each keeps its exact
// arguments, token and error behaviour: the core still decides what a result means.

import { spawnSync } from "node:child_process";
import type { IssueTextRow } from "../code-host.js";
import type { RepoConfig } from "../config.js";
import { gh } from "./gh.js";

/** `lastEditedAt` of issue `n` as GraphQL returns it: undefined when absent, null when never edited. Throws on a failed read. */
export function issueLastEditedAt(repoConfig: RepoConfig, n: number): string | null | undefined {
  const [owner, name] = repoConfig.githubRepo.split("/");
  const out = gh(["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${n}`, "-f",
    "query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){lastEditedAt}}}"], repoConfig.repoPath);
  return JSON.parse(out || "{}")?.data?.repository?.issue?.lastEditedAt;
}

const jsonLines = (out: string) => out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Every comment on issue `n`, id prefixed `comment:`. Throws on a failed read. */
export function issueCommentRows(repo: string, n: number, cwd: string): IssueTextRow[] {
  return jsonLines(gh(["api", "--paginate", `repos/${repo}/issues/${n}/comments?per_page=100`, "--jq",
    `.[] | {id: ("comment:" + (.id|tostring)), issue: ${n}, author: (.user.login // ""), at: .created_at, body: (.body // "")} | @json`], cwd));
}

/** Every open issue (not PR) `creator` opened, id prefixed `issue:`. Throws on a failed read. */
export function openIssueRowsBy(repo: string, creator: string, cwd: string): IssueTextRow[] {
  return jsonLines(gh(["api", "--paginate", `repos/${repo}/issues?state=open&creator=${creator}&per_page=100`, "--jq",
    `.[] | select(.pull_request | not) | {id: ("issue:" + (.number|tostring)), issue: .number, author: (.user.login // ""), at: .created_at, body: (.body // ""), title: .title} | @json`], cwd));
}

/** The open PR `head → base`, live (at most one). Throws on a failed read. */
export function openPrsForBranch(repo: string, head: string, base: string, cwd: string): { number: number; url: string }[] {
  const json = gh([
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
export function closedPrsForBranch(repo: string, head: string, base: string, cwd: string): {
  number: number; url: string; mergedAt: string | null; headRefOid: string; closedAt: string | null;
}[] {
  const json = gh([
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

/** Open a PR `head → base`; gh's output (the PR URL). Throws on failure. */
export function createPr(config: RepoConfig, pr: { base: string; head: string; title: string; body: string }): string {
  return gh([
    "pr", "create",
    "--repo", config.githubRepo,
    "--base", pr.base,
    "--head", pr.head,
    "--title", pr.title,
    "--body", pr.body,
  ], config.repoPath);
}

/** Every label name on the repo. Throws on a failed read. */
export function labelNames(repo: RepoConfig): string[] {
  const out = gh(["api", "-X", "GET", `repos/${repo.githubRepo}/labels`, "--paginate", "--jq", ".[].name"], repo.repoPath);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Create one label. Throws on failure (an existing one included). */
export function createLabel(repo: RepoConfig, name: string, color: string): void {
  gh(["api", "-X", "POST", `repos/${repo.githubRepo}/labels`, "-f", `name=${name}`, "-f", `color=${color}`], repo.repoPath);
}

/**
 * The open feature PR's URL, asked of gh directly with the ambient auth: the
 * implement session's fallback when its output names no PR. Outside runGh, as it
 * always was; the caller checks the GitHub back-off first. Undefined when none.
 */
export function featurePrUrlFallback(config: RepoConfig): string | undefined {
  const fallback = spawnSync("gh", [
    "pr", "list",
    "--repo", config.githubRepo,
    "--head", config.featureBranch,
    "--base", config.baseBranch,
    "--state", "open",
    "--limit", "1",
    "--json", "url",
    "--jq", ".[0].url",
  ], { cwd: config.repoPath, encoding: "utf-8", timeout: 15_000 });
  return fallback.stdout?.trim();
}
