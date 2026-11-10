// PR description read and write (foreman#116). REST, never `gh pr edit`: GraphQL requests the
// sunset Projects-classic field and the edit does not apply (see promotion.ts).
import type { RepoConfig } from "../config.js";
import { ghAsync } from "./gh.js";

/**
 * Rewrite PR `pr`'s description: `rewrite` gets the current body and returns the new one, or null for
 * no change. True when a new body was written. Throws when GitHub cannot read or write it.
 */
export async function editPrBody(config: RepoConfig, pr: number, rewrite: (current: string) => string | null): Promise<boolean> {
  const out = await ghAsync(["api", `repos/${config.githubRepo}/pulls/${pr}`, "--jq", ".body // \"\" | @json"], config.repoPath);
  const next = rewrite(JSON.parse(out.trim()) as string);
  if (next === null) return false;
  await ghAsync(["api", "--method", "PATCH", `repos/${config.githubRepo}/pulls/${pr}`, "-f", `body=${next}`, "--silent"], config.repoPath);
  return true;
}

/** The first-line subjects of the commits in `base..head`, oldest first. Throws on a failed read. */
export async function commitSubjects(repo: string, base: string, head: string, cwd: string): Promise<string[]> {
  const out = await ghAsync(["api", `repos/${repo}/compare/${base}...${head}`, "--jq", ".commits[] | (.commit.message | split(\"\\n\")[0]) | @json"], cwd);
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as string);
}
