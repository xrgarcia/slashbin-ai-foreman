// A repo's identity on GitHub. A repo transferred or renamed keeps answering API calls under its old name, but the
// rows it returns (`repository_url`) carry the canonical one; a config still naming the old repo would then read its
// own rows as another repo's (MCS#626, 2026-11-18). Open-source users transfer repos too: nothing here names an owner.

import { ghAsync } from "./gh.js";

const canonical = new Map<string, Promise<string>>();

/** `owner/name` of an API `repository_url`, or undefined when it names none. */
export function repoOfUrl(url: string | undefined): string | undefined {
  return url?.match(/repos\/([^/]+\/[^/]+)$/)?.[1];
}

/** Same repo? GitHub names are case-insensitive. Pure. */
export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The canonical `owner/name` GitHub reports for `repo`, memoized for the process. Throws when the call fails (a
 * missing answer read as "same name" would be a guess) and never caches the failure. An answer that is not
 * `owner/name` falls back to the configured name.
 */
export function canonicalRepo(repo: string, cwd: string): Promise<string> {
  const key = repo.toLowerCase();
  let p = canonical.get(key);
  if (!p) {
    p = ghAsync(["api", `repos/${repo}`, "--jq", ".full_name"], cwd).then((out) => {
      const name = out.trim();
      return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : repo;
    });
    canonical.set(key, p);
    p.catch(() => { if (canonical.get(key) === p) canonical.delete(key); });
  }
  return p;
}

/** Forget what was learned about `repo` (tests; a long-lived process may also call it after a transfer). */
export function dropCanonicalRepo(repo?: string): void {
  if (repo === undefined) canonical.clear(); else canonical.delete(repo.toLowerCase());
}

/** A row counts as `repo`'s own when its URL names the configured or the canonical name; no URL is own. */
export async function isOwnRow(url: string | undefined, repo: string, cwd: string): Promise<boolean> {
  const row = repoOfUrl(url);
  if (row === undefined || sameRepo(row, repo)) return true;
  return sameRepo(row, await canonicalRepo(repo, cwd));
}
