// The GitHub conventions the Foreman reads and writes beyond the trigger and
// lifecycle labels: the label that holds an issue back, the priority labels a
// build is picked by, how a dependency-update PR is recognised, and the titles
// and signature of the PRs and issues the Foreman files itself. Each default is
// what the Foreman always used, so a config without a `github` block runs
// exactly as before. docs/configuration.md is generated from the comments in
// githubConventionsSchema.
//
// Not here, on purpose: the markers the Foreman and its own skills and
// reviewers talk through (`FOREMAN_RESULT`, `FOREMAN_REVIEW`, `<!-- foreman-ci-gate -->`,
// "Related to #N"). They are one protocol between two programs; renaming one
// side breaks the other, and no user gains anything from a different spelling.
import { z } from "zod";

const name = z.string().trim().min(1);

export const githubConventionsSchema = z.object({
  // The label that holds an issue back. An issue carrying it is never built,
  // never reported stuck after a merge, and shows as Blocked to an observer.
  // Sessions get it as FOREMAN_BLOCKED_LABEL. Must differ from every trigger
  // and lifecycle label.
  blockedLabel: name.default("blocked"),
  // The order the implement session picks among several approved issues,
  // highest first. Each tier is the labels an issue must all carry; an issue
  // takes the first tier it matches. Sessions get it as FOREMAN_PRIORITY_LABELS
  // (JSON). An issue matching no tier comes after every tier.
  priorityLabels: z.array(z.array(name).min(1)).min(1).default([
    ["S1"], ["security"], ["S2", "bug"], ["S2", "enhancement"], ["S2", "feature"],
    ["bug"], ["enhancement"], ["feature"], ["S3"], ["chore"],
  ]),
  // Head-branch prefixes that mark a dependency-update PR, for the
  // dependency-batch issue. A branch, never a label: any account can apply a
  // label, only the bot writes its own branches. Renovate's is "renovate/".
  dependencyBranchPrefixes: z.array(name).min(1).default(["dependabot/"]),
  // The title every dependency-batch issue starts with. It is also how an open
  // batch is found, so changing it while one is open files a second.
  dependencyBatchTitlePrefix: name.default("chore(deps): validate and land "),
  // Title of a promotion PR (base → production) carrying one issue. {title} is
  // the issue's title, {N} its number.
  promotionTitle: name.default("release: {title}"),
  // Title of a promotion PR carrying several issues. {n} is how many.
  promotionBatchTitle: name.default("release: promote {n} changes to production"),
  // Title of the PR that merges production back into base after a promotion.
  // {base} and {production} are the two branch names.
  syncTitle: name.default("chore: sync {base} with {production} (merge commits backfill)"),
  // Title of a PR the reconcile stage opens for orphaned commits naming one
  // issue. {N} is its number.
  reconcileTitle: name.default("feat: implement #{N}"),
  // The same, for commits naming no issue or several. {n} is the commit count,
  // {branch} the feature branch.
  reconcileBatchTitle: name.default("feat: implement {n} change(s) from {branch}"),
  // Name of the annotated git tag the release stage puts on a release PR's
  // merge commit once the SRE has merged it, in UTC: {yyyy} {mm} {dd} the date,
  // {HH} {MM} (or {HHMM}) the time, {N} the release PR's number, which must
  // appear so two releases never share a name. A plain annotated tag only,
  // never a GitHub Release: jerky_shipping's desktop pipeline
  // (scripts/lib/desktop-release-version.mjs) reads published GitHub Releases
  // and tags at HEAD to decide whether a commit is already released, so a
  // Release on main's merge commit would suppress its desktop build. Never
  // starts with "v": slashbin-cli's semantic-release reads only `v*` tags, so a
  // `release-` name stays out of its version history.
  releaseTagFormat: name
    .refine((f) => f.includes("{N}"), "releaseTagFormat must contain {N}, the release PR number")
    .refine((f) => !/^v/i.test(f), "releaseTagFormat must not start with \"v\" (semantic-release reads v* tags)")
    .refine((f) => isTagName(fillReleaseTag(f, 1, new Date(0))), "releaseTagFormat must fill to a valid git tag name")
    .default("release-{yyyy}{mm}{dd}-{HHMM}-pr{N}"),
  // The commit status the Foreman puts on a release PR's head while it lists an
  // open issue the EM has not signed off (no `ready for prod release` or later
  // release-stage label). Failing while any is unsigned, passing once none is:
  // add it to the production branch's required checks to hold a human merge too.
  signoffStatusContext: name.default("foreman/em-sign-off"),
  // The last line of every PR body the Foreman writes. Empty writes none. No
  // "#<number>": every #N in a promotion PR's body is read as an issue it carries.
  signature: z.string().trim()
    .refine((s) => !/#\d/.test(s), "signature must not contain #<number>")
    .default("Automated by slashbin-ai-agent"),
}).prefault({});

export type GithubConventions = Readonly<z.infer<typeof githubConventionsSchema>>;

/** What a config with no `github` block runs on. */
export const DEFAULT_GITHUB_CONVENTIONS: GithubConventions = deepFreeze(githubConventionsSchema.parse({}));

/** The parsed block, frozen to the leaves. */
export function freezeGithubConventions(c: z.infer<typeof githubConventionsSchema>): GithubConventions {
  return deepFreeze(structuredClone(c));
}

/** `template` with each `{name}` replaced from `vars`; an unknown `{name}` is left as written. */
export function fillTitle(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** `body` with the signature appended under a rule, or `body` alone when the signature is empty. */
export function signed(body: string, c: GithubConventions, suffix = ""): string {
  return c.signature ? `${body}\n\n---\n${c.signature}${suffix}` : body;
}

/** `format` filled for release PR `pr` merged at `at` (UTC): {yyyy} {mm} {dd} {HH} {MM} {HHMM} {N}. */
export function fillReleaseTag(format: string, pr: number, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const HH = p(at.getUTCHours()), MM = p(at.getUTCMinutes());
  return fillTitle(format, {
    yyyy: at.getUTCFullYear(), mm: p(at.getUTCMonth() + 1), dd: p(at.getUTCDate()), HH, MM, HHMM: `${HH}${MM}`, N: pr,
  });
}

/**
 * The release tag for `pr` merged at `at`. Throws on a name starting with "v"
 * or one git refuses: the format is checked at config load, so this is the
 * guard against a format that passed there and fills badly here.
 */
export function releaseTagName(format: string, pr: number, at: Date): string {
  const tag = fillReleaseTag(format, pr, at);
  if (/^v/i.test(tag)) throw new Error(`release tag "${tag}" starts with "v"; semantic-release would read it as a version`);
  if (!isTagName(tag)) throw new Error(`release tag "${tag}" is not a valid git tag name`);
  return tag;
}

/** A conservative git ref-name check: what `git check-ref-format` accepts, and no `{`. */
function isTagName(t: string): boolean {
  return t.length > 0 && t.length <= 200 && /^[A-Za-z0-9._\/-]+$/.test(t) && !/^[./-]|[./]$|\.\.|\/\/|\.lock$|@\{/.test(t);
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}
