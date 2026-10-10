// Dependency (Dependabot) PRs and the one batch issue that carries them.

import type { Logger } from "../logger.js";
import { IssueSnapshot, PrSnapshot, formatGhError, getOpenIssues, getOpenPrs } from "./cache.js";
import { gh, isBackoffRefusal } from "./gh.js";


// --- Dependency PRs (Dependabot) ---

/**
 * Open Dependabot PRs into any of `bases`, and nothing else.
 *
 * **Why a list and not one branch (owner decision, 2026-09-07).** Dependabot is
 * moving from `target-branch: develop` to `target-branch: features`, so that a
 * dependency bump travels `features → develop → main` like every other change
 * instead of landing on `develop` and leaving `features` behind. That retarget
 * happens one repo at a time and cannot be simultaneous with this code change:
 * whichever went first, every dependency PR in the gap would be invisible here
 * and would sit unmerged with nothing logged. Accepting both branches for the
 * duration is the additive half of that swap. Drop `develop` once no repo aims
 * dependabot at it.
 *
 * Dependabot PRs never carry a linked issue, so the review phase cannot see
 * them: it is scoped to `features → develop` PRs and every step after the merge
 * (labelling, follow-up filing, the outcome trailer) is expressed in terms of an
 * issue. Rather than widen the skill that reviews and merges ALL feature work —
 * the highest-blast-radius thing here — these get their own mechanical path,
 * shaped exactly like the `main → develop` sync merge above: a narrow rule, no
 * agent, no issue.
 *
 * **The head-branch test is the safety property, not the label.** Dependabot
 * labels its PRs `dependencies` by default, but a label is something any account
 * can apply; `dependabot/*` is a branch only Dependabot writes. Selecting on the
 * branch means a mislabelled human PR can never be swept into an unreviewed
 * merge.
 */
/**
 * The branches a dependency PR may legitimately target, for one repo.
 *
 * BOTH the feature branch and the base branch, because a dependency update is
 * now work on either one and a mechanical merge on neither.
 *
 * **This function used to be `dependencyMergeBases` and it named the branches a
 * bump could be MERGED into without a session. That phase is gone.** Retargeting
 * Dependabot at `features` only governs pull requests it opens from now on; on
 * 2026-09-07 twenty-four of the twenty-eight already open were sitting on
 * `develop`, where the merge phase would have swept them in on a green check
 * rollup — no session, no build, no boot. Excluding `features` from a mechanical
 * merge while leaving `develop` in it moved the defect one branch over rather
 * than removing it.
 *
 * The production branch (`main` by default) stays excluded outright: a dependency update must never be worked
 * against the production branch, which is what `jerky_shipping#237` closed on
 * the producing side.
 *
 * Pure, exported and tested because that exclusion is the safety property.
 */
export function dependencyBatchBases(
  featureBranch: string | undefined,
  baseBranch: string | undefined,
  productionBranch: string,
): string[] {
  return [...new Set([featureBranch, baseBranch])]
    .filter((b): b is string => !!b && b !== productionBranch);
}

export function findDependencyPRs(
  repo: string,
  cwd: string,
  bases: readonly string[],
  logger?: Logger,
): PrSnapshot[] {
  const allowed = new Set(bases);
  try {
    return getOpenPrs(repo, cwd).filter(
      (p) => allowed.has(p.baseRefName) && p.headRefName.startsWith("dependabot/"),
    );
  } catch (err) {
    if (isBackoffRefusal(err)) {
      logger?.debug("findDependencyPRs: gh pr list failed — GitHub back-off active");
      return [];
    }
    logger?.warn("findDependencyPRs: gh pr list failed", { ...formatGhError(err), repo, bases: [...allowed] });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dependency BATCH issues — the path for bumps aimed at the feature branch
// ---------------------------------------------------------------------------

/**
 * Every dependency-batch issue title starts with this, and that prefix is the
 * whole idempotency mechanism: at most one open batch issue per repo, matched
 * off the open-issue snapshot that is already fetched every cycle. No marker
 * label to create on twenty repos, no extra API call, and nothing to drift.
 */
export const DEPENDENCY_BATCH_TITLE_PREFIX = "chore(deps): validate and land ";

/** One dependency PR, reduced to what the issue body needs to say about it. */
export interface DependencyChange {
  number: number;
  packages: string[];
  from?: string;
  to?: string;
  /** True when the leading version component moves. `0.x` counts every minor. */
  major: boolean;
}

/**
 * Read a Dependabot PR title into packages and versions.
 *
 * Dependabot writes four shapes, all of them seen live on 2026-09-07:
 *   `chore(deps): bump vite from 5.4.21 to 8.2.2`
 *   `chore(deps-dev): bump react-dom and @types/react-dom in /desktop`
 *   `chore(deps): bump qs and express`
 *   `Bump form-data from 4.0.5 to 4.0.6`
 *
 * A grouped bump carries no versions in its title, so `from`/`to` stay undefined
 * and `major` is false — deliberately understated rather than guessed. The issue
 * body says to read the PR for those, because inventing a version here would put
 * a wrong number in front of the person deciding whether to approve.
 */
export function describeDependencyPR(number: number, title: string): DependencyChange {
  const versioned = /\bbump\s+(.+?)\s+from\s+(\S+)\s+to\s+(\S+)/i.exec(title);
  if (versioned) {
    return {
      number,
      packages: [versioned[1].trim()],
      from: versioned[2],
      to: versioned[3],
      major: isMajorBump(versioned[2], versioned[3]),
    };
  }
  const grouped = /\bbump\s+(.+?)(?:\s+in\s+\S+)?\s*$/i.exec(title);
  const packages = grouped
    ? grouped[1].split(/\s*,\s*|\s+and\s+/).map((p) => p.trim()).filter(Boolean)
    : [];
  return { number, packages, major: false };
}

/**
 * Does this version move break compatibility by semver convention?
 *
 * `0.x` is the case that matters here and the one a naive major-compare gets
 * wrong: under semver a `0.y` release may break on every minor, which is exactly
 * how `esbuild` 0.25 → 0.28 behaves. Treating that as "not a major" would file
 * a batch issue claiming a breaking upgrade is routine.
 */
export function isMajorBump(from: string, to: string): boolean {
  const parse = (v: string) => v.replace(/^[^0-9]*/, "").split(".").map((n) => parseInt(n, 10));
  const [fMaj, fMin] = parse(from);
  const [tMaj, tMin] = parse(to);
  if (!Number.isFinite(fMaj) || !Number.isFinite(tMaj)) return false;
  if (fMaj !== tMaj) return true;
  if (fMaj === 0) return Number.isFinite(fMin) && Number.isFinite(tMin) && fMin !== tMin;
  return false;
}

/**
 * The batch issue for a set of dependency PRs — title and body, pure.
 *
 * **Why an issue at all (owner decision, 2026-09-07).** Every stage after
 * implement is keyed on an issue: the review phase starts from issues labelled
 * `pr under review` and only then looks for the PR, promotion queries issues
 * carrying the EM gate, and the promotion PR body is a list of issue numbers. A
 * dependency PR with no issue can reach `develop` and then has no route to
 * `main` at all. Filing one puts an upgrade through the same pipeline as every
 * other change — including the implement session that actually builds it, starts
 * the app and smoke-tests it, which is the step a CI-rollup merge never did.
 *
 * Filed with the trigger label only on a pre-approved repo — see
 * `createDependencyBatchIssue`.
 */
export function buildDependencyBatchIssue(
  featureBranch: string,
  changes: readonly DependencyChange[],
): { title: string; body: string } {
  const majors = changes.filter((c) => c.major);
  const n = changes.length;
  const title =
    `${DEPENDENCY_BATCH_TITLE_PREFIX}${n} dependency update${n === 1 ? "" : "s"} on \`${featureBranch}\`` +
    (majors.length > 0 ? ` (${majors.length} major)` : "");

  const row = (c: DependencyChange) => {
    const pkg = c.packages.length ? c.packages.join(", ") : "(see PR)";
    const move = c.from && c.to ? `\`${c.from}\` → \`${c.to}\`` : "grouped — read the PR";
    return `| #${c.number} | ${pkg} | ${move} | ${c.major ? "**yes**" : "no"} |`;
  };

  const body = [
    `## Problem`,
    ``,
    `${n} Dependabot pull request${n === 1 ? "" : "s"} target \`${featureBranch}\` and ${n === 1 ? "is" : "are"} not merged.`,
    `They do not reach \`develop\` on their own: a bump aimed at the feature branch has no`,
    `mechanical merge path, because a CI check rollup proves the code compiles and never`,
    `proves the application still runs.`,
    ``,
    majors.length > 0
      ? `**${majors.length} of these ${majors.length === 1 ? "is a" : "are"} major version change${majors.length === 1 ? "" : "s"}.** A major bump is the class most likely to break a runtime while passing every check.`
      : `None of these crosses a major version.`,
    ``,
    `| PR | Package(s) | Version | Major |`,
    `|---|---|---|---|`,
    ...changes.map(row),
    ``,
    `## Required Changes`,
    ``,
    `Land every PR above on \`${featureBranch}\`, or leave behind the ones that cannot be landed`,
    `and say which and why. Merging them is not the work — **exercising them is**:`,
    ``,
    `1. Merge the branches into \`${featureBranch}\` locally.`,
    `2. Install from the lockfile as the deploy does, not with a resolver flag that papers over a peer conflict.`,
    `3. Build.`,
    `4. **Start the application and confirm it serves.** A dependency upgrade that compiles and does not boot is the failure this issue exists to catch.`,
    `5. Exercise the flows the changed packages sit under — a web framework means a real request through a real route; a date or validation library means the code paths that parse and format.`,
    ``,
    `If a PR fails any step, do not force it. Drop it from the batch, keep the rest, and record`,
    `the failure and the step it failed at.`,
    ``,
    `## Acceptance`,
    ``,
    `- **No-Script:** the caller-facing surface of a dependency upgrade is the running application itself, and the evidence is the smoke test the implement session performs against it — build, boot, and a real request through the flows the changed packages sit under. A committed script would assert the lockfile, which is the half that already passes today.`,
    ``,
    `### Automated checks`,
    ``,
    `- The repo's build succeeds.`,
    `- The repo's test suite passes.`,
    `- The application starts and answers its health route.`,
    ``,
    `### Human validation`,
    ``,
    `- Confirm the PR names each landed package and its version, and names any PR dropped from the batch with the step it failed at.`,
    ``,
    `## Pre-Flight`,
    ``,
    `- **Design locked.** Land and exercise the listed PRs; drop and report the ones that fail. No open decision.`,
    `- **Preconditions:** none. The PRs already exist and target \`${featureBranch}\`.`,
    `- **Dev-safety: read-only, no customer writes.** A dependency upgrade changes no request handler, no worker and no outbound integration by itself. The smoke test exercises the app's own routes; it writes to no external system.`,
    ``,
    `## References`,
    ``,
    ...changes.map((c) => `- #${c.number}`),
    ``,
    `_Filed automatically by the Foreman: Dependabot PRs targeting \`${featureBranch}\` accumulate with no merge path until one of these exists._`,
  ].join("\n");

  return { title, body };
}

/**
 * The open dependency-batch issue for a repo, if one exists.
 *
 * Reads the per-cycle open-issue snapshot rather than issuing its own query, so
 * this costs nothing on the twenty-repo sweep.
 */
export function findOpenDependencyBatchIssue(
  repo: string,
  cwd: string,
  logger: Logger,
): IssueSnapshot | undefined {
  return getOpenIssues(repo, cwd, logger)
    .find((i) => i.title.startsWith(DEPENDENCY_BATCH_TITLE_PREFIX));
}

/**
 * The `gh` argv that files a batch issue. Pure and exported because the label
 * on it is the whole behaviour, in both directions: drop it on a pre-approved
 * repo and that repo's batches stall unapproved again (as every repo's did from
 * 2026-09-07 to 2026-09-29); add it on a repo the owner never pre-approved and
 * the Foreman flies work nobody authorized. `label` is null for the latter.
 */
export function dependencyBatchIssueCreateArgs(
  repo: string,
  title: string,
  body: string,
  label: string | null,
): string[] {
  const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
  return label ? [...args, "--label", label] : args;
}

/**
 * File one dependency-batch issue — carrying `label` when the repo is
 * pre-approved, bare otherwise. Returns its number, or null if `gh` refused.
 *
 * **Pre-authorized (owner decision, 2026-09-29).** From 2026-09-07 these were
 * filed WITHOUT the trigger label so the owner would approve each batch by hand.
 * None was ever approved: six sat open for 22 days, and because an open batch
 * blocks the next one, every Dependabot PR opened after them — security updates
 * included — never reached a session at all. A gate nobody operates is not a
 * gate, it is a stall.
 *
 * Standing authorization is safe here because the flight carries its own
 * checks: the session drops any bump that fails to build or boot, the review
 * phase reviews the resulting `features → develop` PR like any other, the merge
 * deploys to dev, and nothing reaches `main` without the EM outcome gate. This
 * is maintenance on existing code — the class of work the Foreman may approve
 * for itself (slashbin-ai-foreman#37) — never a new feature or a spec change.
 *
 * **Scoped per repo (same day, owner correction).** The authorization covers
 * slashbin.io repos only; a customer's repo is the customer's call. It is an
 * opt-in `dependencyPreApproved` flag on the repo's config, default off, so a
 * newly onboarded repo can never inherit it by omission.
 */
export function createDependencyBatchIssue(
  repo: string,
  cwd: string,
  title: string,
  body: string,
  label: string | null,
  logger?: Logger,
): number | null {
  try {
    const out = gh(dependencyBatchIssueCreateArgs(repo, title, body, label), cwd);
    const m = /\/issues\/(\d+)/.exec(out);
    return m ? parseInt(m[1], 10) : null;
  } catch (err) {
    logger?.warn("createDependencyBatchIssue: gh issue create failed", { ...formatGhError(err), repo });
    return null;
  }
}

/*
 * `tryMergeDependencyPR` lived here and merged a Dependabot PR whenever its
 * check rollup was green. It was deleted on 2026-09-07: a rollup proves the code
 * compiles and the unit tests pass, and never that the application still starts.
 * Dependency updates now go through `buildDependencyBatchIssue` and the implement
 * session, which builds and boots. Nothing merges a dependency PR without one.
 */
