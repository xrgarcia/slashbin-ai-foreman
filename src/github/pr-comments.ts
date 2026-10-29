// PR comments the Foreman posts itself and de-duplicates by heading.
import type { RepoConfig } from "../config.js";
import { gh } from "./gh.js";

/** True when PR `pr` already carries a comment whose body starts with `heading`. Throws on a failed read. */
export function prHasCommentWithHeading(config: RepoConfig, pr: number, heading: string): boolean {
  const out = gh([
    "api", `repos/${config.githubRepo}/issues/${pr}/comments?per_page=100`, "--paginate",
    "--jq", ".[].body | @json",
  ], config.repoPath);
  return out.split("\n").filter((l) => l.trim()).some((l) => (JSON.parse(l) as string).startsWith(heading));
}

/** Comment on PR `pr`. Throws on a failed write. */
export function commentOnPr(config: RepoConfig, pr: number, body: string): void {
  gh(["pr", "comment", String(pr), "--repo", config.githubRepo, "--body", body], config.repoPath);
}
