// The release gate: a release PR (base → production) promotes ALL of the base
// branch, so it may be opened, updated or deployed only when every merge it
// carries belongs to an issue the EM authorized (slashbin-ai-foreman#90).
//
// Recurred at least six times (Slashbin-console#1297 inside release PR #1302,
// jerky_shipping #647/#649 inside #655, jerky_public_api #163 inside #170):
// the PR listed only the authorized issues and shipped everything else on
// `develop` with them, past the EM gate and without an epic's grant.
//
// The merges in `production..base` are read from the compare API; each is tied
// to its issues the way the Foreman ties any PR to an issue
// (`extractImplementedIssues`: a closing/relating keyword, or a `(#N)` suffix
// in the title). A merge whose PR names no issue blocks too, unless it is one
// the Foreman files no issue for: the main → develop sync PR (its head is the
// production branch) and a dependency-bot PR (a `dependencyBranchPrefixes`
// head). Commits that carry no PR number (the individual commits inside a
// merge commit) are not merges and are not read.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { formatGhError } from "./cache.js";
import { commentOnIssue } from "./ci-gate.js";
import { gh } from "./gh.js";
import { extractImplementedIssues, type PrCommit } from "./discovery.js";
import { loadRepoState, saveRepoState } from "../state.js";

/** One PR merged into the base branch and not yet on production. */
export interface CarriedMerge {
  pr: number;
  sha: string;
  title: string;
  /** The issues the PR implements; empty when it names none. */
  issues: number[];
  /** A sync or dependency-bot PR: carries no issue and needs none. */
  exempt: boolean;
}

/** The merges a release would carry that no authorized issue covers. */
export interface ReleaseBlock {
  /** Issues that merged but are not authorized, with the PRs that merged them. */
  issues: Array<{ issue: number; prs: number[] }>;
  /** PRs that merged with no linked issue. */
  noIssue: Array<{ pr: number; title: string }>;
}

export const RELEASE_GATE_MARK = "<!-- foreman:release-gate-refusal";

interface PrView {
  title: string;
  body: string;
  headRefName: string;
  commits: PrCommit[];
}

// A merged PR's text does not change what it links to; one read per PR per run.
const prViews = new Map<string, PrView>();

/** Forget the cached PR reads. For tests. */
export function resetReleaseGate(): void {
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
  const out = gh(["pr", "view", String(pr), "--repo", repo, "--json", "title,body,headRefName,commits"], cwd);
  const v = JSON.parse(out || "{}") as Partial<PrView>;
  const view: PrView = {
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
 * issues it implements. Null when GitHub could not be read: the caller refuses
 * (a gate that cannot see fails closed), and the next cycle asks again.
 */
export function listCarriedMerges(
  repoConfig: RepoConfig,
  logger: Logger,
): CarriedMerge[] | null {
  const { githubRepo: repo, productionBranch, baseBranch, repoPath: cwd } = repoConfig;
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
      const view = readPr(repo, pr, cwd);
      const issues = extractImplementedIssues({ title: view.title, body: view.body, commits: view.commits })
        .filter((n) => n !== pr);
      const exempt = issues.length === 0 &&
        (view.headRefName === productionBranch || prefixes.some((p) => view.headRefName.startsWith(p)));
      merges.push({ pr, sha: c.sha, title: view.title || c.headline, issues, exempt });
    }
    return merges;
  } catch (err) {
    logger.warn(`Release gate: could not list the merges ${productionBranch}..${baseBranch} carries; refusing until it can`, {
      ...formatGhError(err), repo,
    });
    return null;
  }
}

/**
 * What stops a release: every carried merge must link to an issue in
 * `authorized`. A merge linked to several issues is covered when any of them
 * is authorized. Pure, exported for tests.
 */
export function evaluateRelease(
  merges: CarriedMerge[],
  authorized: ReadonlySet<number>,
): ReleaseBlock | null {
  const byIssue = new Map<number, number[]>();
  const noIssue: ReleaseBlock["noIssue"] = [];
  for (const m of merges) {
    if (m.exempt) continue;
    if (m.issues.length === 0) { noIssue.push({ pr: m.pr, title: m.title }); continue; }
    if (m.issues.some((n) => authorized.has(n))) continue;
    for (const n of m.issues) byIssue.set(n, [...(byIssue.get(n) ?? []), m.pr]);
  }
  if (byIssue.size === 0 && noIssue.length === 0) return null;
  return {
    issues: [...byIssue].map(([issue, prs]) => ({ issue, prs })).sort((a, b) => a.issue - b.issue),
    noIssue: noIssue.sort((a, b) => a.pr - b.pr),
  };
}

/** The key of one blocking set; the same set is the same key. Pure. */
export function blockKey(b: ReleaseBlock): string {
  return [...b.issues.map((i) => `i${i.issue}`), ...b.noIssue.map((p) => `p${p.pr}`)].join(",");
}

/** A one-line account of a block, for the log. Pure. */
export function describeBlock(b: ReleaseBlock): string {
  return [
    ...b.issues.map((i) => `#${i.issue} (PR ${i.prs.map((p) => `#${p}`).join(", ")})`),
    ...b.noIssue.map((p) => `PR #${p.pr} (no linked issue)`),
  ].join("; ");
}

function refusalComment(repoConfig: RepoConfig, b: ReleaseBlock, key: string): string {
  const { baseBranch: base, productionBranch: prod } = repoConfig;
  const { readyForProd } = repoConfig.lifecycleLabels;
  return [
    `${RELEASE_GATE_MARK} ${key} -->`,
    `**Release refused: \`${base}\` carries merged work that is not authorized for production.** A release PR promotes all of ` +
    `\`${base}\`, so the Foreman will not open, update or merge one while these are on it:`,
    "",
    ...b.issues.map((i) => `- #${i.issue}: merged by PR ${i.prs.map((p) => `#${p}`).join(", ")}, and it does not carry \`${readyForProd}\``),
    ...b.noIssue.map((p) => `- PR #${p.pr} (${p.title}): merged to \`${base}\` and links to no issue`),
    "",
    `To clear it, label each issue \`${readyForProd}\` (after the EM's release gate), or revert its merge from \`${base}\`. ` +
    `A merge with no issue needs an issue that carries \`${readyForProd}\`, or a revert. ` +
    `Nothing reaches \`${prod}\` until then. This comment is posted once per blocking set.`,
  ].join("\n");
}

function alreadyNoted(repoConfig: RepoConfig, n: number, key: string): boolean {
  const mark = `${RELEASE_GATE_MARK} ${key} -->`;
  const out = gh([
    "api", `repos/${repoConfig.githubRepo}/issues/${n}/comments?per_page=100`, "--paginate",
    "--jq", ".[] | {body: .body} | @json",
  ], repoConfig.repoPath);
  return out.split("\n").some((l) => l.trim() && ((JSON.parse(l) as { body?: string }).body ?? "").includes(mark));
}

/**
 * Say, on each authorized issue, what the release is refused for. Once per
 * blocking set: the set is remembered in the repo state (no GitHub read while
 * it is unchanged), and each issue's comments are checked for the marker
 * before posting (so a restart or a lost state does not repeat it). The log
 * line is the record when there is nobody to comment on.
 */
export function noteRefusedRelease(
  repoConfig: RepoConfig,
  authorizedIssues: number[],
  block: ReleaseBlock,
  logger: Logger,
): void {
  const key = blockKey(block);
  const st = loadRepoState(repoConfig.name);
  if (st.releaseGateNoted === key) {
    logger.debug(`Release refused (unchanged): ${describeBlock(block)}`);
    return;
  }
  logger.warn(
    `Release refused: ${repoConfig.baseBranch} carries merged work not authorized for ${repoConfig.productionBranch}: ${describeBlock(block)}`,
    { repo: repoConfig.githubRepo, blockedIssues: block.issues.map((i) => i.issue), noIssuePrs: block.noIssue.map((p) => p.pr) },
  );
  let complete = true;
  for (const n of authorizedIssues) {
    try {
      if (alreadyNoted(repoConfig, n, key)) continue;
      commentOnIssue(repoConfig, n, refusalComment(repoConfig, block, key));
      logger.info(`Release refused: commented on #${n}`);
    } catch (err) {
      complete = false;
      logger.warn(`Release refused: could not comment on #${n}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (authorizedIssues.length === 0) {
    logger.warn("Release refused: no authorized issue to comment on; the log is the record");
  }
  // A failed comment is retried next cycle; a complete one is not repeated.
  if (complete) {
    const fresh = loadRepoState(repoConfig.name);
    fresh.releaseGateNoted = key;
    saveRepoState(repoConfig.name, fresh);
  }
}

/** Forget the noted block once the release is clear, so a later block is named again. */
export function clearRefusedNote(repoConfig: RepoConfig): void {
  const st = loadRepoState(repoConfig.name);
  if (st.releaseGateNoted === undefined) return;
  delete st.releaseGateNoted;
  saveRepoState(repoConfig.name, st);
}

/**
 * The gate itself: true when the release may proceed. `authorized` is every
 * issue the release may carry; `commentOn` the issues the refusal is said on.
 * A refusal is logged and commented once per blocking set; a clear gate
 * forgets the note.
 */
export function releaseMayProceed(
  repoConfig: RepoConfig,
  authorized: ReadonlySet<number>,
  commentOn: number[],
  logger: Logger,
): boolean {
  const merges = listCarriedMerges(repoConfig, logger);
  if (merges === null) return false;
  const block = evaluateRelease(merges, authorized);
  if (!block) {
    clearRefusedNote(repoConfig);
    return true;
  }
  noteRefusedRelease(repoConfig, commentOn, block, logger);
  return false;
}
