// The GitHub reads and writes the release stage makes (EM#578): an issue's
// live state, a release PR's live head, the latest merged release PR, and the
// annotated tag on a release's merge commit.
//
// A plain annotated tag ONLY, never a GitHub Release object: jerky_shipping's
// desktop pipeline reads published Releases to decide whether a commit is
// already released, so a Release on main's merge commit would suppress its
// desktop build. See `github.releaseTagFormat`.

import type { RepoConfig } from "../config.js";
import { gh } from "./gh.js";

/** An issue read live, open or closed: the snapshot holds open issues only. */
export interface IssueView {
  state: "OPEN" | "CLOSED";
  labels: string[];
}

/**
 * `gh issue view N --json state,labels`. Always with `--json`: without it gh
 * asks GraphQL for Projects (classic) and fails. Null when the issue does not
 * exist; any other failure throws.
 */
export function viewIssue(config: RepoConfig, num: number): IssueView | null {
  const out = gh(["issue", "view", String(num), "--repo", config.githubRepo, "--json", "state,labels"], config.repoPath);
  const v = JSON.parse(out || "null") as { state?: string; labels?: { name: string }[] } | null;
  if (!v?.state) return null;
  return { state: v.state === "OPEN" ? "OPEN" : "CLOSED", labels: (v.labels ?? []).map((l) => l.name) };
}

/** A release PR read live. */
export interface ReleasePrView {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** The full 40-character head SHA: what the Tech Lead approves and the SRE pins the merge to. */
  headSha: string;
  /** The merge commit, once merged. */
  mergeSha: string | null;
  /** ISO merge time, once merged. */
  mergedAt: string | null;
  body: string;
}

const PR_FIELDS = "number,url,state,headRefOid,mergeCommit,mergedAt,body";

interface RawPr { number: number; url: string; state: string; headRefOid: string; mergeCommit?: { oid?: string } | null; mergedAt?: string | null; body?: string }

function toView(raw: RawPr): ReleasePrView {
  const state = raw.state === "MERGED" || raw.state === "CLOSED" ? raw.state : "OPEN";
  return {
    number: raw.number, url: raw.url, state, headSha: raw.headRefOid,
    mergeSha: raw.mergeCommit?.oid ?? null, mergedAt: raw.mergedAt || null, body: raw.body ?? "",
  };
}

/** One PR, read live. Throws on a failed read. */
export function viewReleasePr(config: RepoConfig, pr: number): ReleasePrView {
  const out = gh(["pr", "view", String(pr), "--repo", config.githubRepo, "--json", PR_FIELDS], config.repoPath);
  return toView(JSON.parse(out));
}

/** The most recently merged base → production PR, or null when there is none. Throws on a failed read. */
export function latestMergedReleasePr(config: RepoConfig): ReleasePrView | null {
  const out = gh([
    "pr", "list", "--repo", config.githubRepo, "--state", "merged",
    "--base", config.productionBranch, "--head", config.baseBranch,
    "--json", PR_FIELDS, "--limit", "1",
  ], config.repoPath);
  const prs = JSON.parse(out || "[]") as RawPr[];
  return prs.length > 0 ? toView(prs[0]) : null;
}

/**
 * Base → production PRs merged at or after `sinceIso` (or the latest `limit`
 * without it), newest first, whoever merged them: the releases the release
 * stage adopts when it did not deploy them itself. Throws on a failed read.
 */
export function recentMergedReleasePrs(config: RepoConfig, sinceIso?: string, limit = 20): ReleasePrView[] {
  const out = gh([
    "pr", "list", "--repo", config.githubRepo, "--state", "merged",
    "--base", config.productionBranch, "--head", config.baseBranch,
    ...(sinceIso ? ["--search", `merged:>=${sinceIso.slice(0, 19)}`] : []),
    "--json", PR_FIELDS, "--limit", String(limit),
  ], config.repoPath);
  return (JSON.parse(out || "[]") as RawPr[]).map(toView).filter((p) => p.state === "MERGED");
}

interface CommentRow { url: string; body: string; at: string }

/** An issue's or PR's comments, oldest first. Throws on a failed read. */
function comments(config: RepoConfig, num: number): CommentRow[] {
  const out = gh([
    "api", `repos/${config.githubRepo}/issues/${num}/comments?per_page=100`, "--paginate",
    "--jq", ".[] | {url: .html_url, body: .body, at: .created_at} | @json",
  ], config.repoPath);
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CommentRow);
}

/** The heading the SRE (and, before it, the EM) puts on a release PR's production verification. */
export const PV_HEADING = "## Production Verification";

/** The latest Production Verification comment on release PR `pr`, or null. Throws on a failed read. */
export function findPvComment(config: RepoConfig, pr: number): { url: string; body: string } | null {
  const pv = comments(config, pr).filter((c) => c.body.startsWith(PV_HEADING));
  const last = pv.at(-1);
  return last ? { url: last.url, body: last.body } : null;
}

/**
 * What a Production Verification comment concluded, from its result table
 * (verify-prod's format: `| **Check** | RESULT | details |`). The soak row is
 * not read: the soak is its own step. Any FAIL or Grafana REGRESSIONS is
 * `prod-verify-failed`; NOT YET ELIGIBLE with a readable UTC time is
 * `wait-until-<UTC>` (the SRE's own window slug), without one, and any NOT
 * VERIFIED, `acceptance-not-verified`. WATCH passes: the deploy is healthy and
 * the dev proof stands, and the live outcome is left to a post-launch watch
 * rather than holding the release (owner, 2026-10-12). Null when no row reads:
 * the caller then runs the verification rather than guess. Pure, exported for tests.
 */
export function readPvResult(body: string): { pass: true } | { pass: false; hold: string } | null {
  const rows: Array<{ check: string; result: string }> = [];
  for (const line of body.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const check = cells[1].replace(/\*/g, "").replace(/`/g, "").trim();
    const result = cells[2].replace(/\*/g, "").trim();
    if (!check || /^-+$/.test(check) || /^check$/i.test(check) || /soak/i.test(check)) continue;
    rows.push({ check, result });
  }
  if (rows.length === 0) return null;
  if (rows.some((r) => /\bFAIL\b|REGRESSIONS/i.test(r.result))) return { pass: false, hold: "prod-verify-failed" };
  const wait = rows.find((r) => /NOT[ -]YET[ -]ELIGIBLE/i.test(r.result));
  if (wait) {
    const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(wait.result);
    return { pass: false, hold: m ? `wait-until-${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}Z` : "acceptance-not-verified" };
  }
  if (rows.some((r) => /NOT[ -]VERIFIED|PENDING/i.test(r.result))) return { pass: false, hold: "acceptance-not-verified" };
  if (rows.every((r) => /^(PASS|CLEAN|N\/?A|WATCH)\b/i.test(r.result))) return { pass: true };
  return { pass: false, hold: "acceptance-not-verified" };
}

/** How the SRE's promotion-verify sweep starts the hold comment it writes on an issue. */
export const SRE_SWEEP_HOLD = "**Production release check needs a person.**";

/**
 * The interim hold the SRE's promotion-verify sweep wrote on an issue (a
 * comment starting "**Production release check needs a person.**" plus the
 * `blocked` label): the release PR it names, or null when the issue carries
 * no such comment. The release stage adopts these. Throws on a failed read.
 */
export function findSreSweepHold(config: RepoConfig, num: number): { pr: number; url: string } | null {
  const hold = comments(config, num).filter((c) => c.body.startsWith(SRE_SWEEP_HOLD)).at(-1);
  if (!hold) return null;
  const m = /\/pull\/(\d+)/.exec(hold.body);
  return m ? { pr: Number(m[1]), url: hold.url } : null;
}

/** The SHA of the production branch's head. Throws on a failed read. */
export function productionHead(config: RepoConfig): string {
  return gh(["api", `repos/${config.githubRepo}/commits/${config.productionBranch}`, "--jq", ".sha"], config.repoPath).trim();
}

/** How many existing tags `ensureReleaseTag` dereferences when looking for one at the SHA. */
const TAG_LOOKBACK = 20;

/** The literal prefix of a tag format, up to its first placeholder: the `matching-refs` filter. */
export function tagPrefix(format: string): string {
  const i = format.indexOf("{");
  return i < 0 ? format : format.slice(0, i);
}

interface RefRow { ref: string; object: { sha: string; type: string } }

/** The commit a tag ref points at: an annotated tag is dereferenced once. */
function tagCommit(config: RepoConfig, row: RefRow): string | null {
  if (row.object.type === "commit") return row.object.sha;
  if (row.object.type !== "tag") return null;
  const out = gh(["api", `repos/${config.githubRepo}/git/tags/${row.object.sha}`, "--jq", ".object.sha"], config.repoPath);
  return out.trim() || null;
}

/**
 * The release tag on `sha`: an existing tag with the format's prefix that
 * already points there is reused (a retry after a crash, or a second pass over
 * the same merge); otherwise a new annotated tag `name` is created with
 * `message`: the tag object (`git/tags`), then its ref (`git/refs`). Never a
 * GitHub Release. Returns the tag name and whether it was created. Throws on a
 * failed write, or when `name` already exists on a different commit.
 */
export function ensureReleaseTag(
  config: RepoConfig,
  sha: string,
  name: string,
  message: string,
): { tag: string; created: boolean } {
  const repo = config.githubRepo;
  const prefix = tagPrefix(config.github.releaseTagFormat);
  const rows = JSON.parse(gh(["api", `repos/${repo}/git/matching-refs/tags/${prefix}`], config.repoPath) || "[]") as RefRow[];
  const exact = rows.find((r) => r.ref === `refs/tags/${name}`);
  if (exact) {
    if (tagCommit(config, exact) === sha) return { tag: name, created: false };
    throw new Error(`tag ${name} already exists on a different commit`);
  }
  for (const row of rows.slice(-TAG_LOOKBACK).reverse()) {
    if (tagCommit(config, row) === sha) return { tag: row.ref.replace(/^refs\/tags\//, ""), created: false };
  }
  const tagSha = gh([
    "api", "--method", "POST", `repos/${repo}/git/tags`,
    "-f", `tag=${name}`, "-f", `message=${message}`, "-f", `object=${sha}`, "-f", "type=commit",
    "--jq", ".sha",
  ], config.repoPath).trim();
  gh([
    "api", "--method", "POST", `repos/${repo}/git/refs`,
    "-f", `ref=refs/tags/${name}`, "-f", `sha=${tagSha}`, "--silent",
  ], config.repoPath);
  return { tag: name, created: true };
}

/** Add the blocked label to an issue (the release stage's STOP). Throws on a failed write. */
export function addBlockedLabel(config: RepoConfig, num: number): void {
  gh(["issue", "edit", String(num), "--repo", config.githubRepo, "--add-label", config.github.blockedLabel], config.repoPath);
}

/** Remove the blocked label from an issue (an SRE sweep hold the release stage took over). Throws on a failed write. */
export function removeBlockedLabel(config: RepoConfig, num: number): void {
  gh(["issue", "edit", String(num), "--repo", config.githubRepo, "--remove-label", config.github.blockedLabel], config.repoPath);
}

/**
 * Add issues to a release PR's "Issues included" list, after its last `- #N`
 * line. The SRE's prod verification reads the PR body for the issues whose
 * acceptance it grades, so an issue the release carries but its body omits is
 * never verified. REST, not `gh pr edit` (see updatePromotionPR). Throws on a
 * failed write.
 */
export function addReleasePrIssues(config: RepoConfig, pr: ReleasePrView, issues: { number: number; title: string }[]): void {
  const lines = pr.body.split("\n");
  let at = -1;
  lines.forEach((l, i) => { if (/^- #\d+/.test(l)) at = i; });
  const added = issues.map((i) => `- #${i.number}: ${i.title}`);
  if (at < 0) lines.push("", "### Issues included", ...added);
  else lines.splice(at + 1, 0, ...added);
  const [owner, name] = config.githubRepo.split("/");
  gh(["api", "--method", "PATCH", `repos/${owner}/${name}/pulls/${pr.number}`, "-f", `body=${lines.join("\n")}`, "--silent"], config.repoPath);
}
