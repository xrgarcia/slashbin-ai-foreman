// Dependency (Dependabot) PRs and the one batch issue that carries them.

import type { Logger } from "../logger.js";
import { IssueSnapshot, PrSnapshot, forgetOpenPrs, formatGhError, getOpenIssues, getOpenPrs } from "./cache.js";
import type { RepoConfig } from "../config.js";
import { ghAsync, isBackoffRefusal } from "./gh.js";
import { DEFAULT_GITHUB_CONVENTIONS, type GithubConventions } from "./conventions.js";
import type { DependencyChange } from "../code-host.js";
export type { DependencyChange } from "../code-host.js";


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
  baseBranch: string | undefined,
  productionBranch: string,
  legacyFeatureBranch?: string,
): string[] {
  // The legacy shared branch stays DISCOVERABLE through the cutover (producers still target it); batches name baseBranch.
  return [...new Set([baseBranch, legacyFeatureBranch])]
    .filter((b): b is string => !!b && b !== productionBranch);
}

export async function findDependencyPRs(
  repo: string,
  cwd: string,
  bases: readonly string[],
  logger?: Logger,
  conventions: GithubConventions = DEFAULT_GITHUB_CONVENTIONS,
): Promise<PrSnapshot[]> {
  const allowed = new Set(bases);
  const prefixes = conventions.dependencyBranchPrefixes;
  try {
    return (await getOpenPrs(repo, cwd)).filter(
      (p) => allowed.has(p.baseRefName) && prefixes.some((x) => p.headRefName.startsWith(x)),
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
// Security-only selection
// ---------------------------------------------------------------------------

/**
 * The package names with an OPEN Dependabot alert on `repo`.
 *
 * **Throws on any failure** (alerts disabled answers 404, a network or token
 * error, a bad body). The caller treats a throw as "batch nothing this cycle":
 * an unreadable alert list must never degrade to "everything is a security
 * update", which is the behaviour this exists to remove.
 */
export async function fetchOpenAlertPackages(repo: string, cwd: string): Promise<Set<string>> {
  const out = await ghAsync([
    "api", "--paginate", `repos/${repo}/dependabot/alerts?state=open&per_page=100`,
    "--jq", ".[].dependency.package.name",
  ], cwd);
  return new Set(out.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean));
}

/**
 * Every package a Dependabot PR bumps, from its title and its body.
 *
 * A single-package title names it. A grouped PR's title usually names none
 * (`bump the npm_and_yarn group across 1 directory with 2 updates`), so the body
 * is read too: Dependabot lists `Updates \`pkg\` from X to Y`, `Bumps [pkg](url)
 * from`, and `Updates the requirements on [a](url) and [b](url)`. The title's
 * phrase for a group matches no alert, so unioning the two sources is safe. A PR
 * from which nothing can be read yields an empty list and is therefore not a
 * security update.
 */
export function dependencyPackagesOf(pr: Pick<PrSnapshot, "title" | "body">): string[] {
  const names = new Set<string>();
  for (const p of describeDependencyPR(0, pr.title).packages) names.add(p.toLowerCase());
  const body = pr.body ?? "";
  for (const m of body.matchAll(/Updates `([^`]+)` from/g)) names.add(m[1].toLowerCase());
  for (const m of body.matchAll(/Bumps \[([^\]]+)\]\(/g)) names.add(m[1].toLowerCase());
  for (const line of body.split("\n")) {
    if (!/Updates the requirements on/i.test(line)) continue;
    for (const m of line.matchAll(/\[([^\]]+)\]\(/g)) names.add(m[1].toLowerCase());
  }
  return [...names];
}

/**
 * A dependency PR is a security update iff a package it bumps has an open
 * Dependabot alert. Pure; the red-before-green test for the selection.
 */
export function selectSecurityPRs<T extends Pick<PrSnapshot, "title" | "body">>(
  prs: readonly T[],
  alertPackages: ReadonlySet<string>,
): T[] {
  return prs.filter((pr) => dependencyPackagesOf(pr).some((p) => alertPackages.has(p)));
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
export const DEPENDENCY_BATCH_TITLE_PREFIX = DEFAULT_GITHUB_CONVENTIONS.dependencyBatchTitlePrefix;

/**
 * Read a Dependabot PR title into packages and versions.
 *
 * Dependabot writes four shapes, all of them seen live on 2026-09-07:
 *   `chore(deps): bump vite from 5.4.21 to 8.2.2`
 *   `chore(deps-dev): bump react-dom and @types/react-dom in /desktop`
 *   `chore(deps): bump qs and express`
 *   `Bump form-data from 4.0.5 to 4.0.6`
 *
 * A grouped bump carries no versions in its title, so they are read from the PR body when one is
 * given (see `versionMovesFromBody`). A package whose move cannot be read keeps no version and
 * `major` is null (unknown), never false: printing "no" for a move nobody read would tell the
 * person deciding whether to approve that a breaking upgrade is routine.
 */
export function describeDependencyPR(number: number, title: string, body?: string | null): DependencyChange {
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
  let packages = grouped
    ? grouped[1].split(/\s*,\s*|\s+and\s+/).map((p) => p.trim()).filter(Boolean)
    : [];
  const moves = versionMovesFromBody(body ?? "");
  // A group title ("bump the npm_and_yarn group ...") names no package; the body does.
  if (packages.length === 0 || /\bgroup\b/i.test(grouped?.[1] ?? "")) {
    const seen = new Map<string, string>();
    for (const name of [...packagesMentionedInBody(body ?? ""), ...moves.map((m) => m.package)]) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    if (seen.size > 0) packages = [...seen.values()];
  }
  const readable = packages.length > 0 && packages.every((p) => moves.some((m) => m.package.toLowerCase() === p.toLowerCase()));
  const relevant = moves.filter((m) => packages.some((p) => p.toLowerCase() === m.package.toLowerCase()));
  const anyMajor = relevant.some((m) => isMajorBump(m.from, m.to));
  const change: DependencyChange = { number, packages, major: anyMajor ? true : readable ? false : null };
  if (relevant.length > 0) change.moves = relevant;
  if (relevant.length === 1 && packages.length === 1) {
    change.from = relevant[0].from;
    change.to = relevant[0].to;
  }
  return change;
}

/** Every package a Dependabot PR body names, whether or not it states the versions (so an unread one stays in the inventory). */
export function packagesMentionedInBody(body: string): string[] {
  const names: string[] = [];
  for (const m of body.matchAll(/Updates\s+`?\[?([^\s`\]\[]+)\]?`?(?:\([^)]*\))?(?=\s+from\b|[ \t]*$)/gm)) names.push(m[1]);
  // "Bumps [a](u) from 1 to 2" and the group summary "Bumps the x group with 2 updates in the / directory: [a](u) and [b](u)."
  for (const line of body.split("\n")) {
    if (!/^\s*Bumps\b/.test(line)) continue;
    for (const m of line.matchAll(/\[([^\]]+)\]\([^)]*\)/g)) names.push(m[1]);
  }
  for (const line of body.split("\n")) {
    const row = /^\|\s*\[([^\]]+)\]\([^)]*\)\s*\|/.exec(line.trim());
    if (row) names.push(row[1]);
  }
  return names;
}

/**
 * The version moves a Dependabot PR body states, in the three forms it writes them:
 *   `Updates \`pkg\` from 1.2.3 to 1.2.4`            (per-package section of a grouped PR)
 *   `Bumps [pkg](url) from 1.2.3 to 1.2.4`            (single-package PR)
 *   `| [pkg](url) | \`1.2.3\` | \`1.2.4\` |`            (the update table of a grouped PR)
 * The first stated move of a package wins. Nothing is inferred: a package the body does not
 * give both versions for has no entry.
 */
export function versionMovesFromBody(body: string): { package: string; from: string; to: string }[] {
  const moves = new Map<string, { package: string; from: string; to: string }>();
  const add = (pkg: string, from: string, to: string): void => {
    const key = pkg.toLowerCase();
    if (!pkg || !from || !to || moves.has(key)) return;
    moves.set(key, { package: pkg, from, to });
  };
  const ver = "v?[0-9][^\\s`|,;)]*";
  for (const m of body.matchAll(new RegExp(`Updates \`?([^\`\\s]+)\`? from \`?(${ver})\`? to \`?(${ver})\`?`, "g"))) add(m[1], m[2], m[3].replace(/[.]$/, ""));
  for (const m of body.matchAll(new RegExp(`Bumps \\[([^\\]]+)\\]\\([^)]*\\) from \`?(${ver})\`? to \`?(${ver})\`?`, "g"))) add(m[1], m[2], m[3].replace(/[.]$/, ""));
  for (const line of body.split("\n")) {
    const row = new RegExp(`^\\|\\s*\\[([^\\]]+)\\]\\([^)]*\\)\\s*\\|\\s*\`?(${ver})\`?\\s*\\|\\s*\`?(${ver})\`?\\s*\\|`).exec(line.trim());
    if (row) add(row[1], row[2], row[3]);
  }
  return [...moves.values()];
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
  landingBranch: string,
  changes: readonly DependencyChange[],
  conventions: GithubConventions = DEFAULT_GITHUB_CONVENTIONS,
  baseBranch = "develop",
): { title: string; body: string } {
  const majors = changes.filter((c) => c.major === true);
  const unknownMajors = changes.filter((c) => c.major === null);
  const n = changes.length;
  const title =
    `${conventions.dependencyBatchTitlePrefix}${n} dependency update${n === 1 ? "" : "s"} on \`${landingBranch}\`` +
    (majors.length > 0 ? ` (${majors.length} major)` : "") +
    (unknownMajors.length > 0 ? ` (${unknownMajors.length} unknown)` : "");

  const row = (c: DependencyChange) => {
    const pkg = c.packages.length ? c.packages.join(", ") : "(see PR)";
    const known = new Set((c.moves ?? []).map((m) => m.package.toLowerCase()));
    const unread = c.packages.filter((p) => !known.has(p.toLowerCase()));
    const move = c.from && c.to
      ? `\`${c.from}\` → \`${c.to}\``
      : (c.moves ?? []).length > 0
        ? [...(c.moves ?? []).map((m) => `${m.package} \`${m.from}\` → \`${m.to}\``), ...unread.map((p) => `${p} (version not stated)`)].join("; ")
        : "grouped — read the PR";
    return `| #${c.number} | ${pkg} | ${move} | ${c.major === null ? "unknown" : c.major ? "**yes**" : "no"} |`;
  };

  const body = [
    `## Problem`,
    ``,
    `${n} Dependabot pull request${n === 1 ? "" : "s"} target \`${landingBranch}\` (or the legacy shared branch) and ${n === 1 ? "is" : "are"} not merged.`,
    `They do not reach \`${baseBranch}\` on their own: a bump aimed at the feature branch has no`,
    `mechanical merge path, because a CI check rollup proves the code compiles and never`,
    `proves the application still runs.`,
    ``,
    majors.length > 0
      ? `**${majors.length} of these ${majors.length === 1 ? "is a" : "are"} major version change${majors.length === 1 ? "" : "s"}.** A major bump is the class most likely to break a runtime while passing every check.` +
        (unknownMajors.length > 0 ? ` A further ${unknownMajors.length} ${unknownMajors.length === 1 ? "is" : "are"} grouped with versions the PR does not state (marked unknown below): read ${unknownMajors.length === 1 ? "it" : "them"} too.` : "")
      : unknownMajors.length > 0
        ? `No PR here is known to cross a major version, but ${unknownMajors.length} ${unknownMajors.length === 1 ? "is" : "are"} grouped with versions the PR does not state (marked unknown below) — read ${unknownMajors.length === 1 ? "it" : "them"} before deciding.`
        : `None of these crosses a major version.`,
    ``,
    `| PR | Package(s) | Version | Major |`,
    `|---|---|---|---|`,
    ...changes.map(row),
    ``,
    `## Required Changes`,
    ``,
    `Land every PR above through this issue's own PR into \`${landingBranch}\`, or leave behind the ones that cannot be landed`,
    `and say which and why. Merging them is not the work — **exercising them is**:`,
    ``,
    `1. Merge the Dependabot branches into **this issue's own assigned branch** (\`foreman/<N>-<slug>\`, cut from \`origin/${landingBranch}\`). Never merge into \`${landingBranch}\` locally and never commit to it.`,
    `2. Install from the lockfile as the deploy does, not with a resolver flag that papers over a peer conflict.`,
    `3. Build.`,
    `4. Run the repo's test suite.`,
    `5. Import or load the built bundle (for example \`node -e "require('./dist/...')"\`, or the equivalent entry import) and confirm it loads without error. Load it only: nothing may listen on a port or connect to another service.`,
    ``,
    `**This session has no Postgres, Redis or Docker, so it cannot boot the application. That is an environment gap, not an update failure.**`,
    `Never drop an update because the app would not start here, or because a datastore was unreachable. Drop a PR only when a step that can run`,
    `here (install, build, tests, bundle load) fails with that update applied. Do not force it: drop it from the batch, keep the rest, and record`,
    `the failure and the step it failed at. Booting the app and a real request to its health route belong to dev verification below, where a datastore exists.`,
    ``,
    `## Acceptance`,
    ``,
    `- **No-Script:** dependency-bump — a version bump with no code change; the implement session's install, build, tests and bundle load, and the SRE's boot and health check on the develop deploy, are the evidence, and a committed script would only assert the lockfile, which already passes today.`,
    ``,
    `### Automated checks`,
    ``,
    `- The repo's build succeeds.`,
    `- The repo's test suite passes.`,
    `- The built bundle loads.`,
    ``,
    `### Dev verification`,
    ``,
    `- For the SRE on the develop deploy: the application boots and a real request to its health route answers. A dependency upgrade that compiles and does not boot is the failure this issue exists to catch, and it is caught here, not in the implement session.`,
    ``,
    `### Human validation`,
    ``,
    `- Confirm the PR names each landed package and its version, and names any PR dropped from the batch with the step it failed at.`,
    ``,
    `## Pre-Flight`,
    ``,
    `- **Design locked.** Land and exercise the listed PRs; drop and report the ones that fail. No open decision.`,
    `- **Preconditions:** none. The PRs already exist and target \`${landingBranch}\` (or the legacy shared branch).`,
    `- **Dev-safety: read-only, no customer writes.** A dependency upgrade changes no request handler, no worker and no outbound integration by itself. The dev verification exercises the app's own routes; it writes to no external system.`,
    ``,
    `## References`,
    ``,
    ...changes.map((c) => `- #${c.number}`),
    ``,
    `_Filed automatically by the Foreman: Dependabot PRs targeting \`${landingBranch}\` accumulate with no merge path until one of these exists._`,
  ].join("\n");

  return { title, body };
}

/**
 * The open dependency-batch issue for a repo, if one exists.
 *
 * Reads the per-cycle open-issue snapshot rather than issuing its own query, so
 * this costs nothing on the twenty-repo sweep.
 */
export async function findOpenDependencyBatchIssue(
  repo: string,
  cwd: string,
  logger: Logger,
  conventions: GithubConventions = DEFAULT_GITHUB_CONVENTIONS,
): Promise<IssueSnapshot | undefined> {
  return (await getOpenIssues(repo, cwd, logger))
    .find((i) => i.title.startsWith(conventions.dependencyBatchTitlePrefix));
}

/**
 * The `gh` argv that files a batch issue. Pure and exported because the label
 * on it is the whole behaviour, in both directions: drop it on a pre-approved
 * repo and that repo's batches stall unapproved again (as every repo's did from
 * 2026-09-07 to 2026-09-29); add it on a repo the owner never pre-approved and
 * the Foreman flies work nobody authorized. `labels` is empty for the latter.
 */
export function dependencyBatchIssueCreateArgs(
  repo: string,
  title: string,
  body: string,
  labels: string[],
): string[] {
  const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
  return [...args, ...labels.flatMap((l) => ["--label", l])];
}

/**
 * File one dependency-batch issue — carrying `labels` (the trigger and the
 * production grant) when the repo is pre-approved, bare otherwise. Returns its number, or null if `gh` refused.
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
 *
 * **Production grant (owner decision, 2026-11-06).** Ray, in session: "Dependency
 * upgrades and security patches probably should just get created with approved and
 * delivered to prod labels." A pre-approved repo's batch is therefore filed with
 * BOTH the trigger label and `deliver-to-prod` (`PROD_GRANT_LABEL`); before this the
 * EM's release gate held every batch, because a standalone issue needs the grant on
 * itself. Safe because nothing is skipped: the SRE checks logs and health on dev and
 * again on prod, the EM still signs `ready for prod release` per issue, and production
 * verification plus soak follow the deploy. The Foreman still never decides a release;
 * it only files with the label, and the EM's gate is what reads it.
 */
export async function createDependencyBatchIssue(
  repo: string,
  cwd: string,
  title: string,
  body: string,
  labels: string[],
  logger?: Logger,
): Promise<number | null> {
  try {
    const out = await ghAsync(dependencyBatchIssueCreateArgs(repo, title, body, labels), cwd);
    const m = /\/issues\/(\d+)/.exec(out);
    return m ? parseInt(m[1], 10) : null;
  } catch (err) {
    logger?.warn("createDependencyBatchIssue: gh issue create failed", { ...formatGhError(err), repo });
    return null;
  }
}

/**
 * Close a superseded Dependabot PR, commenting `reason` first (one `gh` call).
 * Idempotent: a PR that is not open is left as it is. Throws when the state
 * cannot be read or the close is refused, so the caller knows the batch is not
 * resolved. Closing a superseded Dependabot PR is what Dependabot itself
 * expects; it reopens or rebases on its own if the update is still needed.
 */
export async function retireDependencyPR(config: RepoConfig, number: number, reason: string): Promise<void> {
  const state = (await ghAsync(["pr", "view", String(number), "--repo", config.githubRepo, "--json", "state", "--jq", ".state"], config.repoPath)).trim();
  if (state !== "OPEN") return;
  await ghAsync(["pr", "close", String(number), "--repo", config.githubRepo, "--comment", reason], config.repoPath);
  forgetOpenPrs(config.githubRepo);
}

/*
 * `tryMergeDependencyPR` lived here and merged a Dependabot PR whenever its
 * check rollup was green. It was deleted on 2026-09-07: a rollup proves the code
 * compiles and the unit tests pass, and never that the application still starts.
 * Dependency updates now go through `buildDependencyBatchIssue` and the implement
 * session, which builds and boots. Nothing merges a dependency PR without one.
 */
