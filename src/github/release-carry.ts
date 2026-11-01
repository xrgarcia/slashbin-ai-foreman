// What a release PR carries (slashbin-ai-foreman#90). A release PR (base →
// production) promotes ALL of the base branch, but used to list only the
// `ready for prod release` issues, so the rest of `develop` shipped unlisted
// and unverified (Slashbin-console#1297 inside release PR #1302, jerky_shipping
// #647/#649 inside #655, jerky_public_api #163 inside #170).
//
// Owner decision (Ray, 2026-10-27): features accumulating on `develop` go out
// together. So the release is never refused; instead every issue whose merge
// it carries is ADOPTED into it: labelled like an authorized issue, listed in
// the PR body, and verified in production and closed the same way. Merges with
// no issue are listed by PR number.
//
// Amended (EM#879, foreman#128): adoption lists, it does not sign. The release
// is held (release-signoff.ts) until the EM applies `ready for prod release`.
//
// The merges in `production..base` are read from the compare API; each is tied
// to its issues the way the Foreman ties any PR to an issue
// (`extractImplementedIssues`: a closing/relating keyword, or a `(#N)` suffix
// in the title). A merge whose PR names no issue is listed by PR number, except
// the ones the Foreman files no issue for: the main → develop sync PR (its head
// is the production branch) and a dependency-bot PR (a `dependencyBranchPrefixes`
// head). Commits that carry no PR number (the individual commits inside a
// merge commit) are not merges and are not read.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { formatGhError, getOpenIssues, hasLabel } from "./cache.js";
import { commentOnIssue } from "./ci-gate.js";
import { gh } from "./gh.js";
import { hasCommentContaining } from "./pr-comments.js";
import { extractImplementedIssues, type PrCommit } from "./discovery.js";
import type { PromotionIssue } from "./promotion.js";
import type { CarriedMerge, ReleaseCarry } from "../code-host.js";
export type { CarriedMerge, ReleaseCarry } from "../code-host.js";

export const NO_CARRY: ReleaseCarry = { adopted: [], prsByIssue: new Map(), unlinked: [] };

export const CARRIED_MARK = "<!-- foreman:release-carried";

interface PrView {
  state: string;
  title: string;
  body: string;
  headRefName: string;
  commits: PrCommit[];
}

// One read per PR within a pass; cleared at the start of each pass so a corrected PR body is re-read.
const prViews = new Map<string, PrView>();

/** Forget the cached PR reads. For tests. */
export function resetReleaseCarry(): void {
  prViews.clear();
}

const MERGE_COMMIT_RE = /^Merge pull request #(\d+)\b/;
const SQUASH_SUFFIX_RE = /\(#(\d+)\)\s*$/;

/** The PR a commit headline merged: a merge commit or a squash `(#N)` suffix, or null. Pure. */
export function mergedPrNumber(headline: string): number | null {
  const m = MERGE_COMMIT_RE.exec(headline) ?? SQUASH_SUFFIX_RE.exec(headline);
  return m ? Number(m[1]) : null;
}

function readPr(repo: string, pr: number, cwd: string): PrView {
  const key = `${repo}#${pr}`;
  const known = prViews.get(key);
  if (known) return known;
  const out = gh(["pr", "view", String(pr), "--repo", repo, "--json", "state,title,body,headRefName,commits"], cwd);
  const v = JSON.parse(out || "{}") as Partial<PrView>;
  const view: PrView = {
    state: v.state ?? "",
    title: v.title ?? "",
    body: v.body ?? "",
    headRefName: v.headRefName ?? "",
    commits: Array.isArray(v.commits) ? v.commits : [],
  };
  prViews.set(key, view);
  return view;
}

/**
 * The PRs merged into the base branch that production lacks, each with the
 * issues it implements. Null when GitHub could not be read: the release then
 * proceeds with the authorized issues only, as it did before this read existed.
 */
export function listCarriedMerges(repoConfig: RepoConfig, logger: Logger, unresolved?: number[]): CarriedMerge[] | null {
  const { githubRepo: repo, productionBranch, baseBranch, repoPath: cwd } = repoConfig;
  prViews.clear();
  try {
    const out = gh([
      "api", `repos/${repo}/compare/${productionBranch}...${baseBranch}?per_page=100`, "--paginate",
      "--jq", '.commits[] | {sha: .sha, headline: (.commit.message | split("\\n")[0])} | @json',
    ], cwd);
    const prefixes = repoConfig.github.dependencyBranchPrefixes;
    const seen = new Set<number>();
    const merges: CarriedMerge[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const c = JSON.parse(line) as { sha?: unknown; headline?: unknown };
      if (typeof c.sha !== "string" || typeof c.headline !== "string") continue;
      const pr = mergedPrNumber(c.headline);
      if (pr === null || seen.has(pr)) continue;
      seen.add(pr);
      // A `(#N)` suffix on a commit inside a merge is usually an ISSUE number, so
      // the number may not be a PR at all: skip it, never abandon the inventory.
      let view: PrView;
      try { view = readPr(repo, pr, cwd); } catch (err) {
        // Not-a-PR is the normal case for an issue number; any other failure leaves a merge
        // unread, so the caller that must be sure of the inventory is told which one.
        const f = formatGhError(err);
        // Judge by gh's stderr alone: the error message embeds the command, so a PR numbered 404 would match.
        if (unresolved && !/could not resolve to a pull ?request/i.test(f.stderr ?? "")) unresolved.push(pr);
        continue;
      }
      if (view.state !== "MERGED") continue;
      const issues = extractImplementedIssues({ title: view.title, body: view.body, commits: view.commits })
        .filter((n) => n !== pr);
      const exempt = issues.length === 0 &&
        (view.headRefName === productionBranch || prefixes.some((p) => view.headRefName.startsWith(p)));
      merges.push({ pr, sha: c.sha, title: view.title || c.headline, issues, exempt });
    }
    return merges;
  } catch (err) {
    logger.warn(`Release carry: could not list the merges ${productionBranch}..${baseBranch} carries; releasing the authorized issues only`, {
      ...formatGhError(err), repo,
    });
    return null;
  }
}

/**
 * Split the carried merges into what the release was authorized for and the
 * rest, issue by issue: a merge linked to several issues adopts each one that is not authorized.
 * `titleOf` gives an open issue's title, or null (not open: left out). Pure,
 * exported for tests.
 */
export function planCarry(
  merges: CarriedMerge[],
  authorized: ReadonlySet<number>,
  titleOf: (issue: number) => string | null,
): ReleaseCarry {
  const prsByIssue = new Map<number, number[]>();
  const unlinked: ReleaseCarry["unlinked"] = [];
  for (const m of merges) {
    if (m.exempt) continue;
    if (m.issues.length === 0) { unlinked.push({ pr: m.pr, title: m.title }); continue; }
    // Per issue: a merge-mate being authorized does not authorize this one.
    for (const n of m.issues) {
      if (!authorized.has(n)) prsByIssue.set(n, [...(prsByIssue.get(n) ?? []), m.pr]);
    }
  }
  const adopted: PromotionIssue[] = [];
  for (const n of [...prsByIssue.keys()].sort((a, b) => a - b)) {
    const title = titleOf(n);
    if (title !== null) adopted.push({ number: n, title });
  }
  return { adopted, prsByIssue, unlinked: unlinked.sort((a, b) => a.pr - b.pr) };
}

/**
 * Read what `develop` carries that the release does not list. `authorized` is
 * every issue the release lists or will list. An adopted issue is LISTED in the
 * release (so the SRE verifies it) but is NOT signed off: `ready for prod
 * release` is the EM's production sign-off and the Foreman never applies it
 * (slashbin-ai-foreman#128: Slashbin-console#1455 shipped #1434 and #1453 with
 * labels the Foreman had written). The release holds, failing its sign-off
 * status, until the EM signs each one; then the ordinary promote path moves it
 * to `release pending`.
 */
export function adoptCarried(repoConfig: RepoConfig, authorized: ReadonlySet<number>, logger: Logger): ReleaseCarry {
  const merges = listCarriedMerges(repoConfig, logger);
  if (merges === null) return NO_CARRY;
  const open = new Map(getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger).map((i) => [i.number, i]));
  const plan = planCarry(merges, authorized, (n) => open.get(n)?.title ?? null);
  const { readyForProd } = repoConfig.lifecycleLabels;
  const adopted: PromotionIssue[] = [];
  for (const i of plan.adopted) {
    adopted.push(i);
    logger.info(
      `Release carry: #${i.number} merged to ${repoConfig.baseBranch} (PR ${plan.prsByIssue.get(i.number)?.map((p) => `#${p}`).join(", ")}) ` +
      `without "${readyForProd}"; listing it in the release, which is held until the EM signs it off`,
    );
  }
  for (const u of plan.unlinked) {
    logger.warn(`Release carry: PR #${u.pr} (${u.title}) merged to ${repoConfig.baseBranch} and links to no issue; listed in the release PR by number`);
  }
  const notOpen = [...plan.prsByIssue.keys()].filter((n) => !open.has(n));
  if (notOpen.length > 0) logger.info(`Release carry: ${notOpen.map((n) => `#${n}`).join(", ")} merged but not open; nothing to adopt`);
  return { adopted, prsByIssue: plan.prsByIssue, unlinked: plan.unlinked };
}

/** The body section naming merges that link to no issue. By PR number without `#`: the body's `#N` are issues. */
export function unlinkedSection(unlinked: ReleaseCarry["unlinked"]): string {
  if (unlinked.length === 0) return "";
  return `\n\n### Merges with no linked issue\n${unlinked.map((u) => `- PR ${u.pr}: ${u.title.replace(/#/g, "")}`).join("\n")}`;
}

/** One comment on each adopted issue once its release PR exists; the marker keeps it to one. */
export async function noteCarried(
  repoConfig: RepoConfig,
  carry: ReleaseCarry,
  releasePr: number,
  authorized: number[],
  logger: Logger,
): Promise<void> {
  for (const i of carry.adopted) {
    const mark = `${CARRIED_MARK} pr=${releasePr} -->`;
    try {
      if (await hasCommentContaining(repoConfig, i.number, mark)) continue;
      const prs = carry.prsByIssue.get(i.number) ?? [];
      const alongside = authorized.length > 0 ? ` alongside ${authorized.map((n) => `#${n}`).join(", ")}` : "";
      commentOnIssue(repoConfig, i.number, [
        mark,
        `**Carried to production in release PR #${releasePr}${alongside}, awaiting the EM's sign-off.** Its merge (PR ${prs.map((p) => `#${p}`).join(", ")}) is on ` +
        `\`${repoConfig.baseBranch}\`, and a release promotes all of \`${repoConfig.baseBranch}\`, so this issue is listed in the release. ` +
        `The release will not merge until this issue carries \`${repoConfig.lifecycleLabels.readyForProd}\`; once it does, it gets the same ` +
        "production verification and closes the same way.",
      ].join("\n"));
    } catch (err) {
      logger.warn(`Release carry: could not comment on #${i.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
