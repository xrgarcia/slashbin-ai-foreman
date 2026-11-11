// Which branches the Foreman owns (#208). Every issue is built on its own branch
// `<branchPrefix><issue>-<slug>` cut from baseBranch. A PR is Foreman-owned iff its head
// starts with branchPrefix, or equals the LEGACY shared featureBranch (so PRs open at the
// cutover drain normally). This is the ONE ownership test: revise, reconcile and branch
// deletion all go through it, so a human-named head is never pushed to, revised or deleted.

import type { RepoConfig } from "./config.js";

export const DEFAULT_BRANCH_PREFIX = "foreman/";

type OwnershipConfig = Pick<RepoConfig, "featureBranch"> & { branchPrefix?: string };

/** The configured prefix; the default when the config predates it. Never empty. */
export function branchPrefixOf(config: { branchPrefix?: string }): string {
  return config.branchPrefix || DEFAULT_BRANCH_PREFIX;
}

/** The legacy shared branch `head` names (never the base), if the config sets one. */
export function isLegacyFeatureHead(config: OwnershipConfig, head: string): boolean {
  return !!config.featureBranch && head === config.featureBranch;
}

/** True iff the Foreman owns `head`: starts with branchPrefix, or is the legacy featureBranch. */
export function isForemanOwnedHead(config: OwnershipConfig, head: string | undefined | null): boolean {
  if (!head) return false;
  return head.startsWith(branchPrefixOf(config)) || isLegacyFeatureHead(config, head);
}

/** Lowercase, non-alphanumerics to `-`, collapsed, trimmed, at most `max` chars with no trailing `-`. */
export function slugify(title: string, max = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** The exact branch an issue is built on: `<branchPrefix><issue>-<slug>` (`<prefix><issue>` when the title has no slug). */
export function foremanBranchName(config: { branchPrefix?: string }, issueNumber: number, title: string): string {
  const slug = slugify(title);
  return `${branchPrefixOf(config)}${issueNumber}${slug ? `-${slug}` : ""}`;
}
