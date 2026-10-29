// The EM's sign-off gate on a release PR (slashbin-ai-foreman#128).
//
// A release PR promotes ALL of `develop`, so an issue can ride in that the EM
// never signed: Slashbin-console#1455 merged carrying #1434 and #1453, listed
// and labelled `release pending` by the Foreman, neither ever `ready for prod
// release`. `ready for prod release` is the EM's production sign-off, and a
// release PR must not merge while it lists an open issue without it.
//
// An issue is signed once it carries `ready for prod release`, or a label a
// signed issue moves on to (`release pending`, `prod verification held`,
// `ready to close`). A listed issue carrying none of them is UNSIGNED.
//
// While any is, the release stage does not ask the Tech Lead to approve nor the
// SRE to merge (release.ts `deploy`), and this puts a failing commit status on
// the PR head and one comment naming the unsigned issues. The hold needs no
// release: every pass recomputes it, and the status turns green on its own once
// the EM has signed the last one. Making `github.signoffStatusContext` a
// required check on the production branch extends the hold to a human merge.

import type { LifecycleLabels, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { getOpenIssues, hasLabel, type IssueSnapshot } from "./cache.js";
import { gh } from "./gh.js";
import { hasCommentContaining } from "./pr-comments.js";
import { CARRIED_MARK, listCarriedMerges } from "./release-carry.js";

/** Marks the comment naming the unsigned set, so a restart does not repeat it. */
export const SIGNOFF_MARK = "<!-- foreman:release-unsigned";

export interface SignoffGate {
  /** The unsigned issues the release lists, ascending. */
  unsigned: number[];
}

/**
 * The listed open issues that carry no sign-off label, ascending, plus any that
 * carry one the Foreman wrote itself (`foremanSigned`). Pure, exported for tests.
 */
export function unsignedIssues(
  open: readonly IssueSnapshot[],
  listed: ReadonlySet<number>,
  labels: LifecycleLabels,
  foremanSigned: (issue: number) => boolean = () => false,
): number[] {
  const signedLabels = [labels.readyForProd, labels.releasePending, labels.prodVerifyHeld, labels.readyToClose];
  return open
    .filter((i) => listed.has(i.number) && (!signedLabels.some((l) => hasLabel(i, l)) || foremanSigned(i.number)))
    .map((i) => i.number)
    .sort((a, b) => a - b);
}

const humanSigned = new Set<string>();

/**
 * True when the Foreman, not the EM, put the sign-off on issue `n`: before
 * foreman#128 adoption applied `ready for prod release` itself and left a
 * "foreman:release-carried" comment. Such an issue is signed only if someone
 * other than the comment's author later applied `ready for prod release`
 * (the label events name the actor). An issue with no such comment was never
 * adopted. Reads GitHub only for issues carrying the comment; a human sign-off
 * is remembered. Throws on a failed read (the caller holds the release).
 */
export function foremanApplied(config: RepoConfig, n: number): boolean {
  const key = `${config.githubRepo}#${n}`;
  if (humanSigned.has(key)) return false;
  const rows = gh([
    "api", `repos/${config.githubRepo}/issues/${n}/comments?per_page=100`, "--paginate",
    "--jq", ".[] | {body: .body, by: .user.login} | @json",
  ], config.repoPath).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { body?: string; by?: string });
  const adopted = rows.find((r) => (r.body ?? "").includes(CARRIED_MARK));
  if (!adopted?.by) return false;
  const events = gh([
    "api", `repos/${config.githubRepo}/issues/${n}/events?per_page=100`, "--paginate",
    "--jq", '.[] | select(.event=="labeled") | {label: .label.name, by: .actor.login} | @json',
  ], config.repoPath).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { label?: string; by?: string });
  const byEm = events.some((e) => e.label === config.lifecycleLabels.readyForProd && e.by !== adopted.by);
  if (byEm) humanSigned.add(key);
  return !byEm;
}

/** `foremanApplied` for the gate: a failed read counts as Foreman-applied, so the release holds. */
export function foremanAppliedOrHold(config: RepoConfig, logger: Logger): (n: number) => boolean {
  return (n) => {
    try {
      return foremanApplied(config, n);
    } catch (err) {
      logger.warn(`Could not tell who signed off #${n}: ${errText(err)}`);
      return true;
    }
  };
}

/**
 * The open issues the production branch would gain from the base branch
 * right now (its merges, read live) that are not signed off, ascending; null
 * when the merges cannot be read. The release PR's body is a snapshot: an issue
 * that merged after it was written is in the head all the same.
 */
export function unsignedInHead(config: RepoConfig, logger: Logger): { unsigned: number[]; unresolved: number[] } | null {
  const unresolved: number[] = [];
  const merges = listCarriedMerges(config, logger, unresolved);
  if (merges === null) return null;
  const carried = new Set(merges.filter((m) => !m.exempt).flatMap((m) => m.issues));
  const unsigned = unsignedIssues(getOpenIssues(config.githubRepo, config.repoPath, logger), carried, config.lifecycleLabels, foremanAppliedOrHold(config, logger));
  return { unsigned, unresolved };
}

const posted = new Map<string, string>();

/** Forget what was posted. For tests. */
export function resetSignoff(): void {
  posted.clear();
  humanSigned.clear();
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const list = (ns: number[]) => ns.map((n) => `#${n}`).join(", ");

/**
 * Make the sign-off status on release PR `pr`'s head say what is true: failure
 * naming `unsigned`, or success when it is empty. Posts only when the head or
 * the unsigned set changed since the last post, and comments once per set.
 * A failed write is logged and retried next pass; it never throws.
 */
export async function syncSignoff(config: RepoConfig, pr: number, headSha: string, unsigned: number[], logger: Logger, unresolved: number[] = []): Promise<void> {
  const held = unsigned.length + unresolved.length > 0;
  const key = `${config.githubRepo}#${pr}`;
  const state = `${headSha}|${unsigned.join(",")}|${unresolved.join(",")}`;
  if (posted.get(key) === state) return;
  const ctx = config.github.signoffStatusContext;
  const description = !held
    ? "Every issue in this release is signed off by the EM"
    : (unsigned.length > 0
      ? `Awaiting EM sign-off (ready for prod release): ${list(unsigned)}`
      : `Cannot read merged PR ${list(unresolved)}; sign-off unknown`).slice(0, 140);
  try {
    gh([
      "api", "--method", "POST", `repos/${config.githubRepo}/statuses/${headSha}`,
      "-f", `state=${held ? "failure" : "success"}`, "-f", `context=${ctx}`, "-f", `description=${description}`, "--silent",
    ], config.repoPath);
    if (held) {
      const mark = `${SIGNOFF_MARK} ${unsigned.join(",")}${unresolved.length ? `;unread ${unresolved.join(",")}` : ""} -->`;
      if (!(await hasCommentContaining(config, pr, mark))) {
        gh([
          "api", "--method", "POST", `repos/${config.githubRepo}/issues/${pr}/comments`,
          "-f", `body=${[
            mark,
            (unsigned.length > 0
              ? `**Release held: ${unsigned.length} issue(s) not signed off by the EM.** This release PR lists ${list(unsigned)}, ` +
                `which do not carry \`${config.lifecycleLabels.readyForProd}\`. `
              : "") +
            (unresolved.length > 0
              ? `**Release held: merged PR ${list(unresolved)} could not be read**, so what it carries is unknown. `
              : "") +
            `Do not merge it. The Foreman will not ask for the Tech Lead's ` +
            "approval or the SRE's deploy while any is unsigned, and the `" + ctx + "` status stays failed.",
            "",
            `The hold clears on its own once the EM applies \`${config.lifecycleLabels.readyForProd}\` to each, or they leave the release.`,
          ].join("\n")}`, "--silent",
        ], config.repoPath);
      }
    }
    posted.set(key, state);
    if (held) logger.warn(`Release PR #${pr}: held, ${list(unsigned)} not signed off by the EM${unresolved.length ? `; unread ${list(unresolved)}` : ""}`);
    else logger.info(`Release PR #${pr}: every issue signed off`);
  } catch (err) {
    logger.warn(`Release PR #${pr}: could not post the sign-off status: ${errText(err)}`);
  }
}
