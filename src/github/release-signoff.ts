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
import { hasLabel, type IssueSnapshot } from "./cache.js";
import { gh } from "./gh.js";

/** Marks the comment naming the unsigned set, so a restart does not repeat it. */
export const SIGNOFF_MARK = "<!-- foreman:release-unsigned";

export interface SignoffGate {
  /** The unsigned issues the release lists, ascending. */
  unsigned: number[];
}

/** The listed open issues that carry no sign-off label, ascending. Pure, exported for tests. */
export function unsignedIssues(open: readonly IssueSnapshot[], listed: ReadonlySet<number>, labels: LifecycleLabels): number[] {
  const signedLabels = [labels.readyForProd, labels.releasePending, labels.prodVerifyHeld, labels.readyToClose];
  return open
    .filter((i) => listed.has(i.number) && !signedLabels.some((l) => hasLabel(i, l)))
    .map((i) => i.number)
    .sort((a, b) => a - b);
}

const posted = new Map<string, string>();

/** Forget what was posted. For tests. */
export function resetSignoff(): void {
  posted.clear();
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const list = (ns: number[]) => ns.map((n) => `#${n}`).join(", ");

/**
 * Make the sign-off status on release PR `pr`'s head say what is true: failure
 * naming `unsigned`, or success when it is empty. Posts only when the head or
 * the unsigned set changed since the last post, and comments once per set.
 * A failed write is logged and retried next pass; it never throws.
 */
export function syncSignoff(config: RepoConfig, pr: number, headSha: string, unsigned: number[], logger: Logger): void {
  const key = `${config.githubRepo}#${pr}`;
  const state = `${headSha}|${unsigned.join(",")}`;
  if (posted.get(key) === state) return;
  const ctx = config.github.signoffStatusContext;
  const description = unsigned.length === 0
    ? "Every issue in this release is signed off by the EM"
    : `Awaiting EM sign-off (ready for prod release): ${list(unsigned)}`.slice(0, 140);
  try {
    gh([
      "api", "--method", "POST", `repos/${config.githubRepo}/statuses/${headSha}`,
      "-f", `state=${unsigned.length === 0 ? "success" : "failure"}`, "-f", `context=${ctx}`, "-f", `description=${description}`, "--silent",
    ], config.repoPath);
    if (unsigned.length > 0) {
      const mark = `${SIGNOFF_MARK} ${unsigned.join(",")} -->`;
      const seen = gh([
        "api", `repos/${config.githubRepo}/issues/${pr}/comments?per_page=100`, "--paginate", "--jq", ".[] | {body: .body} | @json",
      ], config.repoPath);
      if (!seen.split("\n").some((l) => l.trim() && ((JSON.parse(l) as { body?: string }).body ?? "").includes(mark))) {
        gh([
          "api", "--method", "POST", `repos/${config.githubRepo}/issues/${pr}/comments`,
          "-f", `body=${[
            mark,
            `**Release held: ${unsigned.length} issue(s) not signed off by the EM.** This release PR lists ${list(unsigned)}, ` +
            `which do not carry \`${config.lifecycleLabels.readyForProd}\`. Do not merge it. The Foreman will not ask for the Tech Lead's ` +
            "approval or the SRE's deploy while any is unsigned, and the `" + ctx + "` status stays failed.",
            "",
            `The hold clears on its own once the EM applies \`${config.lifecycleLabels.readyForProd}\` to each, or they leave the release.`,
          ].join("\n")}`, "--silent",
        ], config.repoPath);
      }
    }
    posted.set(key, state);
    if (unsigned.length > 0) logger.warn(`Release PR #${pr}: held, ${list(unsigned)} not signed off by the EM`);
    else logger.info(`Release PR #${pr}: every issue signed off`);
  } catch (err) {
    logger.warn(`Release PR #${pr}: could not post the sign-off status: ${errText(err)}`);
  }
}
