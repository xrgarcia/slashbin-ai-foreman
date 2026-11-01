// PR comments: one paginated, non-blocking lookup shared by everything that asks
// "did this PR already get a comment like this?", and the async post.
import type { RepoConfig } from "../config.js";
import { ghAsync } from "./gh.js";

/** Every comment body on issue-or-PR `num`, all pages, oldest first. Throws on a failed read. */
export async function commentBodies(config: RepoConfig, num: number): Promise<string[]> {
  const out = await ghAsync([
    "api", `repos/${config.githubRepo}/issues/${num}/comments?per_page=100`, "--paginate",
    "--jq", ".[].body | @json",
  ], config.repoPath);
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as string);
}

/** A comment with the id and time GitHub gave it. */
export interface CommentFact { id: number; body: string; at: string }

/** Every comment on issue-or-PR `num`, oldest first, with id and creation time. Throws on a failed read. */
export async function commentFacts(config: RepoConfig, num: number): Promise<CommentFact[]> {
  const out = await ghAsync([
    "api", `repos/${config.githubRepo}/issues/${num}/comments?per_page=100`, "--paginate",
    "--jq", ".[] | {id, body, at: .created_at} | @json",
  ], config.repoPath);
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CommentFact);
}

/** True when any comment body on `num`, across all pages, satisfies `match`. */
export async function anyCommentMatches(config: RepoConfig, num: number, match: (body: string) => boolean): Promise<boolean> {
  return (await commentBodies(config, num)).some(match);
}

/** A comment starts with `heading` (the QA report's key). */
export const hasCommentStartingWith = (config: RepoConfig, num: number, heading: string): Promise<boolean> =>
  anyCommentMatches(config, num, (b) => b.startsWith(heading));

/** A comment contains `mark` anywhere (the carry and sign-off markers). */
export const hasCommentContaining = (config: RepoConfig, num: number, mark: string): Promise<boolean> =>
  anyCommentMatches(config, num, (b) => b.includes(mark));

/** Comment on PR `pr`. Throws on a failed write. */
export async function commentOnPr(config: RepoConfig, pr: number, body: string): Promise<void> {
  await ghAsync(["pr", "comment", String(pr), "--repo", config.githubRepo, "--body", body], config.repoPath);
}
