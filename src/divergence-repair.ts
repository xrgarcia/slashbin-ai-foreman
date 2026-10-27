// The Foreman carries out the EM's divergence ruling (foreman#104).
//
// A diverged feature branch blocks the repo (`RepoState.branchBlock`, announced
// by phases/common.ts). The unstick stage asks the EM which side wins; the EM
// answers with a GitHub comment authored by EM_LOGIN containing exactly one line
//
//   **EM divergence ruling** winner=<base|branch> mergeBase=<40 hex>
//
// (the grammar is shared with the EM CLI: change both or neither). The EM never
// touches the clone (docs/runbooks/foreman-operations.md), so the Foreman does:
//   base wins   -> push the old head to backup/<feature>-<YYYYMMDD-HHMM>, reset
//                  the feature branch to the base, push with a lease on the old head
//   branch wins -> merge the base into the feature branch, push (no force)
// The block is released afterwards by the existing divergenceCleared check.
// A ruling is acted on once: its id is recorded in `branchBlock.ruled` before
// any git runs, so a failure is reported once and never retried.
//
// Where a ruling can be: a comment on one of the announced issues, or — when
// the unstick call was for issue 0 (repo-level, nothing announced) and the EM
// had no issue to comment on — the BODY of an open issue titled
// EM_DIVERGENCE_ISSUE_TITLE that the EM created.

import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { commentOnIssue, gh } from "./github.js";
import { divergenceStillHolds, formatGitError, git } from "./reconciler.js";
import { loadRepoState, saveRepoState, type BranchBlock } from "./state.js";

/** The only author whose ruling is honoured. */
export const EM_DIVERGENCE_RULER = "slashbin-engineering-manager";
/** Title of the issue the EM creates for a repo-level (issue 0) call; its body carries the ruling. */
export const EM_DIVERGENCE_ISSUE_TITLE = "EM unstick (divergence): repo-level ruling";
export const EM_DIVERGENCE_RULING_PATTERN = /^\*\*EM divergence ruling\*\* winner=(base|branch) mergeBase=([0-9a-f]{40})\s*$/m;

/** A comment or an issue body that might hold a ruling. `id` is `comment:<id>` or `issue:<n>`. */
export interface RulingCandidate {
  id: string;
  /** The issue it was found on. */
  issue: number;
  author: string;
  at: string;
  body: string;
  /** Issue-body candidates only. */
  title?: string;
}
export interface Ruling { id: string; issue: number; winner: "base" | "branch" }

/** Pure: the newest unhandled ruling for this episode, or null. */
export function pickRuling(cands: readonly RulingCandidate[], block: Pick<BranchBlock, "since" | "mergeBase" | "ruled">): Ruling | null {
  const since = Date.parse(block.since);
  let best: (Ruling & { at: number }) | null = null;
  for (const c of cands) {
    if (c.author.toLowerCase() !== EM_DIVERGENCE_RULER) continue;
    if (c.id.startsWith("issue:") && c.title !== EM_DIVERGENCE_ISSUE_TITLE) continue;
    const at = Date.parse(c.at);
    if (Number.isNaN(at) || Number.isNaN(since) || at <= since) continue;
    if ((block.ruled ?? []).includes(c.id)) continue;
    const m = EM_DIVERGENCE_RULING_PATTERN.exec(c.body);
    if (!m || m[2] !== block.mergeBase) continue;
    if (!best || at > best.at) best = { id: c.id, issue: c.issue, winner: m[1] as "base" | "branch", at };
  }
  return best ? { id: best.id, issue: best.issue, winner: best.winner } : null;
}

const jsonLines = (out: string) => out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Read the places a ruling can be. Throws on a failed read (the caller treats that as "no ruling this cycle"). */
export function readRulingCandidates(repoConfig: RepoConfig, block: BranchBlock): RulingCandidate[] {
  const { githubRepo: repo, repoPath: cwd } = repoConfig;
  const out: RulingCandidate[] = [];
  for (const n of block.announced.filter((x) => x > 0)) {
    const rows = jsonLines(gh(["api", "--paginate", `repos/${repo}/issues/${n}/comments?per_page=100`, "--jq",
      `.[] | {id: ("comment:" + (.id|tostring)), issue: ${n}, author: (.user.login // ""), at: .created_at, body: (.body // "")} | @json`], cwd));
    out.push(...rows);
  }
  const issues = jsonLines(gh(["api", "--paginate", `repos/${repo}/issues?state=open&creator=${EM_DIVERGENCE_RULER}&per_page=100`, "--jq",
    `.[] | select(.pull_request | not) | {id: ("issue:" + (.number|tostring)), issue: .number, author: (.user.login // ""), at: .created_at, body: (.body // ""), title: .title} | @json`], cwd));
  out.push(...issues);
  return out;
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

function describe(err: unknown): string {
  const f = formatGitError(err);
  return (f.stderr || f.error).split("\n").slice(0, 6).join("\n").slice(0, 800);
}

/** Carry out the ruling in the Foreman's own clone. Throws on any git error. */
function carryOut(repoConfig: RepoConfig, winner: "base" | "branch", now: Date, logger: Logger): void {
  const { repoPath: cwd, baseBranch: base, featureBranch: f } = repoConfig;
  git(["fetch", "origin", base, f, "--quiet"], cwd);
  const oldHead = git(["rev-parse", `origin/${f}`], cwd);
  git(["checkout", "-B", f, `origin/${f}`], cwd);
  if (winner === "base") {
    const backup = `backup/${f}-${stamp(now)}`;
    git(["push", "origin", `${oldHead}:refs/heads/${backup}`], cwd);
    logger.info(`Divergence repair on ${repoConfig.name}: old ${f} head ${oldHead.slice(0, 12)} saved to ${backup}`);
    git(["reset", "--hard", `origin/${base}`], cwd);
    git(["push", "origin", f, `--force-with-lease=refs/heads/${f}:${oldHead}`], cwd);
  } else {
    try {
      git(["merge", "--no-edit", `origin/${base}`], cwd);
    } catch (err) {
      try { git(["merge", "--abort"], cwd); } catch { /* nothing to abort */ }
      throw err;
    }
    git(["push", "origin", f], cwd);
  }
}

export interface RepairDeps {
  readCandidates?: (repoConfig: RepoConfig, block: BranchBlock) => RulingCandidate[];
  comment?: typeof commentOnIssue;
  now?: () => Date;
}

/**
 * If the EM has ruled on the recorded divergence, carry the ruling out.
 * Returns "none" (no usable ruling), "repaired", or "failed" (reported once,
 * block kept, ruling never retried). Never throws.
 */
export async function repairDivergence(
  repoConfig: RepoConfig,
  logger: Logger,
  deps: RepairDeps = {},
): Promise<"none" | "repaired" | "failed"> {
  const block = loadRepoState(repoConfig.name).branchBlock;
  if (!block) return "none";
  let ruling: Ruling | null;
  try {
    ruling = pickRuling((deps.readCandidates ?? readRulingCandidates)(repoConfig, block), block);
  } catch (err) {
    logger.debug(`Divergence ruling unreadable on ${repoConfig.name} — trying next cycle: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return "none";
  }
  if (!ruling) return "none";

  // Recorded before any git runs: a crash mid-repair must not retry the ruling.
  const fresh = loadRepoState(repoConfig.name);
  fresh.branchBlock = { ...fresh.branchBlock!, ruled: [...(fresh.branchBlock!.ruled ?? []), ruling.id] };
  saveRepoState(repoConfig.name, fresh);

  logger.warn(`EM ruled ${ruling.winner} wins on ${repoConfig.name} (${ruling.id}) — repairing ${repoConfig.featureBranch}`);
  try {
    carryOut(repoConfig, ruling.winner, (deps.now ?? (() => new Date()))(), logger);
    if (divergenceStillHolds(repoConfig) !== false) throw new Error(`${repoConfig.featureBranch} still diverges from ${repoConfig.baseBranch} after the repair`);
    logger.info(`Divergence on ${repoConfig.name} repaired: ${ruling.winner} won`);
    return "repaired";
  } catch (err) {
    const why = err instanceof Error && !(err as { stderr?: unknown }).stderr ? err.message : describe(err);
    logger.warn(`Divergence repair failed on ${repoConfig.name}: ${why.split("\n")[0]}`);
    const targets = block.announced.length > 0 ? block.announced : ruling.issue > 0 ? [ruling.issue] : [];
    const body = [
      "**Foreman: divergence repair failed**",
      "",
      `The EM ruled \`${ruling.winner}\` wins on \`${repoConfig.featureBranch}\` vs \`${repoConfig.baseBranch}\`, but carrying it out failed. The block stays; this ruling will not be retried.`,
      "",
      "```",
      why,
      "```",
    ].join("\n");
    for (const n of targets) {
      try { (deps.comment ?? commentOnIssue)(repoConfig, n, body); }
      catch (e) { logger.warn(`Could not post the divergence repair failure on #${n}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
    }
    return "failed";
  }
}
