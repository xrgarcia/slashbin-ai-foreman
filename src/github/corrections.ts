// The GitHub plugin's half of the correction relation (`Relation`, src/adapters.ts; slashbin-ai-foreman#267):
// translate what GitHub records into "issue F corrects issue N", once, here. The core never sees a title.
//
// `corrects`, strongest signal first:
//   1. F blocks N (N is "blocked by" F): N's verification waits on the fix. The exact link (dependentsOf).
//   2. F is a sub-issue of N.
//   3. F's title says `follow-up to #N`: kept so everything already filed still works.
// `mentions`: the issues of this repo F's body names (`#N`, `repo#N`, `owner/repo#N`). A mention never makes F a fix;
// the core uses it only to say that F looks like one (unlinked-fix). A new signal is added here and nowhere else.
// "This repo" is the configured name or the canonical one GitHub reports (a transferred repo), case-insensitively.

import type { Relation } from "../adapters.js";
import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { getOpenIssues } from "./cache.js";
import { dependentsOf } from "./dead-blocker.js";
import { ghAsync } from "./gh.js";
import { blockersOf } from "./blockers.js";
import { readIssueBody } from "./readiness.js";
import { canonicalRepo, isOwnRow } from "./repo-identity.js";

/** Every issue a title says it follows up ("— follow-up to #N"), in order. The one parser for that phrase. */
export function titleCorrects(title: string): number[] {
  return [...(title ?? "").matchAll(/follow-up to #(\d+)/gi)].map((m) => Number(m[1]));
}

/**
 * The issues of `githubRepo` (`owner/name`) that `body` names, in order, once each: `#N`, `name#N` and
 * `owner/name#N` (console#1476 named its parent as `console#1438 (parent: …)`, foreman#131).
 * Another repo's reference is not a mention of this one's issue. Pure.
 */
export function bodyMentions(body: string, githubRepo: string): number[] {
  const [owner, name] = githubRepo.toLowerCase().split("/");
  const out: number[] = [];
  for (const m of (body ?? "").matchAll(/(?<![\w/#-])(?:(?:([\w.-]+)\/)?([\w.-]+))?#(\d+)(?!\d)/g)) {
    const [, o, r, n] = m;
    if (r !== undefined && (r.toLowerCase() !== name || (o !== undefined && o.toLowerCase() !== owner))) continue;
    const num = Number(n);
    if (!out.includes(num)) out.push(num);
  }
  return out;
}

/** F's parent issue in this repo, or null. GitHub answers 404 when there is none. Throws on any other failure. */
async function parentOf(config: RepoConfig, n: number): Promise<number | null> {
  let raw: string;
  try {
    raw = await ghAsync(["api", `repos/${config.githubRepo}/issues/${n}/parent`], config.repoPath);
  } catch (err) {
    if (/\b404\b|Not Found|No parent issue/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
  const p = JSON.parse(raw || "null") as { number?: number; repository_url?: string } | null;
  if (typeof p?.number !== "number") return null;
  if (!(await isOwnRow(p.repository_url, config.githubRepo, config.repoPath))) return null;
  return p.number;
}

/**
 * Each of `issues`' relations. `corrects` is the union, strongest first, of the issues it blocks (this repo's rows
 * only), its parent and its title's `follow-up to #N`; `mentions` is what its body names in this repo. Throws when
 * a link or a body cannot be read: a missing link read as "no link" would be a guess.
 */
export async function relationsOf(config: RepoConfig, issues: readonly number[], logger: Logger): Promise<Map<number, Relation>> {
  const titles = new Map((await getOpenIssues(config.githubRepo, config.repoPath, logger)).map((i) => [i.number, i.title]));
  const out = new Map<number, Relation>();
  for (const n of new Set(issues)) {
    const blocks: number[] = [];
    for (const d of await dependentsOf(config.githubRepo, n, config.repoPath)) {
      if (await isOwnRow(d.repository_url, config.githubRepo, config.repoPath)) blocks.push(d.number);
    }
    const parent = await parentOf(config, n);
    const corrects = [...new Set([...blocks, ...(parent === null ? [] : [parent]), ...titleCorrects(titles.get(n) ?? "")])].filter((m) => m !== n);
    const mentions = bodyMentions(await readIssueBody(config, n), config.githubRepo).filter((m) => m !== n);
    out.set(n, { corrects, mentions });
  }
  return out;
}

/** The numbers of the rows that are this repo's own. */
async function keepOwn(rows: { number: number; repository_url?: string }[], config: RepoConfig): Promise<number[]> {
  const out: number[] = [];
  for (const r of rows) if (await isOwnRow(r.repository_url, config.githubRepo, config.repoPath)) out.push(r.number);
  return out;
}

/**
 * The issues of this repo that correct `holder`, read from its side: the issues it is blocked by, its sub-issues,
 * and the issues, open or closed, whose title says `follow-up to #holder`. Closed ones count: a corrective that merged and
 * closed is the very one the caller looks for. Throws when a link cannot be read: a missing link read as
 * "no corrective" would be a guess.
 */
export async function correctorsOf(config: RepoConfig, holder: number, logger: Logger): Promise<number[]> {
  const own = (rows: { number: number; repository_url?: string }[]) => keepOwn(rows, config);
  const blockers = await own(await blockersOf(config.githubRepo, holder, config.repoPath));
  const subs = await own(JSON.parse(await ghAsync(["api", `repos/${config.githubRepo}/issues/${holder}/sub_issues`], config.repoPath) || "[]"));
  // Every state: the corrective that merged is usually closed by now (security_tests#436 ends "follow-up to #407").
  // Search on a pre-transfer name answers `[]`, not an error: ask under the canonical name.
  const searchRepo = await canonicalRepo(config.githubRepo, config.repoPath);
  const found = JSON.parse(await ghAsync(["issue", "list", "--repo", searchRepo, "--state", "all", "--search", `"follow-up to #${holder}" in:title`, "--json", "number,title", "--limit", "100"], config.repoPath) || "[]") as { number: number; title: string }[];
  const titled = found.filter((i) => titleCorrects(i.title).includes(holder)).map((i) => i.number);
  return [...new Set([...blockers, ...subs, ...titled])].filter((m) => m !== holder);
}

/**
 * The correctives filed against `holder` since its PR `prNumber` merged: the issues of this repo that `holder` is
 * "blocked by" and that were created after that merge, open or closed, ascending. A blocker filed before the merge
 * is a prerequisite, not a corrective. Throws when either read fails: a count that is a guess is not a fact.
 */
export async function correctivesOf(config: RepoConfig, holder: number, prNumber: number): Promise<number[]> {
  const mergedAt = Date.parse((await ghAsync(["api", `repos/${config.githubRepo}/pulls/${prNumber}`, "--jq", ".merged_at // \"\""], config.repoPath)).trim());
  if (!Number.isFinite(mergedAt)) throw new Error(`PR #${prNumber} has no merge time`);
  const after = (await blockersOf(config.githubRepo, holder, config.repoPath)).filter((b) => Date.parse(b.created_at ?? "") > mergedAt);
  return (await keepOwn(after, config)).sort((a, b) => a - b);
}
