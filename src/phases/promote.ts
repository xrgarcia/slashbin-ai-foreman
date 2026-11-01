// Promotion: branch-drift sync PRs, dependency batches, and the release PR.
//
// Nothing here sends a Discord message (owner direction, 2026-10-10: a notice
// that needs a person goes on the issue, where it cannot get lost). A stall
// that needs the EM is a comment on the issues waiting on it; the rest is the
// log. `notifyOnce` and `emit` reach observers only (the daemon's activity
// file, the Paperclip mirror), never Discord.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { trackRelease } from "../release-tracker.js";
import { emit, advance } from "../work-source.js";
import { loadRepoState, saveRepoState } from "../state.js";
import { releaseIssues } from "../release-tracker.js";
import { STALL_CHECK_CYCLE_INTERVAL, itemOf, lastStallCheckCycle, notifyOnce } from "./common.js";
import { codeHost } from "../plugins/registry.js";
import type { PromotionIssue, ReleaseCarry } from "../code-host.js";

export function trySyncDrift(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): boolean {
  const syncLogger = logger.child({ cycle: cycleNumber, repo: repoConfig.name, phase: "sync" });

  const drift = codeHost().checkBranchDrift(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, syncLogger);
  if (!drift || drift.developBehindMain === 0) return false;

  // An already-open sync PR is a RETRY, not a no-op. The merge attempted at
  // creation runs while required checks are still IN_PROGRESS and is refused, so
  // "already open" is the normal state a few seconds later — and returning early
  // here meant it was never merged at all. `develop` then stays behind `main`,
  // the next promotion PR goes BEHIND, and branch protection refuses it.
  // (Slashbin-console#779: open 2h48m over ~140 no-op cycles, blocking #782.)
  const existing = codeHost().findOpenSyncPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, syncLogger);
  if (existing) {
    if (codeHost().tryMergeSyncPR(repoConfig.githubRepo, existing.number, repoConfig.repoPath, syncLogger, repoConfig.productionBranch)) {
      syncLogger.info(`Sync PR merged on retry — #${existing.number}: ${existing.url}`);
      return true;
    }
    syncLogger.info(`Sync PR open, not yet mergeable — #${existing.number}: ${existing.url}`);
    return false;
  }

  syncLogger.info(`${repoConfig.baseBranch} is ${drift.developBehindMain} commit(s) behind ${repoConfig.productionBranch} — creating sync PR`);
  const syncUrl = codeHost().createSyncPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, drift.developBehindMain, repoConfig.repoPath, syncLogger, repoConfig.github);
  if (syncUrl) {
    // Say what actually happened. This line used to assert "created and
    // auto-merged" unconditionally, which was false whenever branch protection
    // refused the create-time merge — i.e. on every protected repo.
    syncLogger.info(`Sync PR created — ${syncUrl} (merge retried each cycle until checks pass)`);
    return true;
  }
  syncLogger.warn("Failed to create sync PR");
  return false;
}

/**
 * File ONE issue covering every open Dependabot PR on either working branch.
 *
 * **Idempotent by construction: at most one open batch issue per repo.** Not by
 * remembering what was filed — this runs every cycle across twenty repos and any
 * state it kept in memory would be lost on the next restart, which is how a
 * filing loop becomes twenty issues an hour. The check is a title-prefix match
 * against the open-issue snapshot the cycle already fetched, so it is correct
 * after a restart, correct if someone closes the issue by hand, and free.
 *
 * A PR that appears while a batch issue is open is not filed separately; it is
 * picked up by the next batch once the current one closes. Bounded noise beats
 * complete coverage here — the alternative is editing an issue body an agent may
 * already be working from, which the issue-authoring rules forbid outright.
 *
 * Returns the new issue number, or null when there was nothing to file.
 */
export function tryFileDependencyBatchIssue(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number,
): number | null {
  const depLogger = logger.child({ cycle: cycleNumber, repo: repoConfig.name, phase: "dependencies" });
  const bases = codeHost().dependencyBatchBases(repoConfig.featureBranch, repoConfig.baseBranch, repoConfig.productionBranch);
  if (bases.length === 0) return null;
  const featureBranch = repoConfig.featureBranch || bases[0];

  let prs = codeHost().findDependencyPRs(repoConfig.githubRepo, repoConfig.repoPath, bases, depLogger, repoConfig.github);
  if (prs.length === 0) return null;

  // Security updates only (dependabot.securityOnly, default on; Ray, 2026-10-26).
  // A version-update PR is left alone: not batched, merged or closed. If the alert
  // list cannot be read the cycle batches NOTHING — never everything.
  if (repoConfig.dependabot.securityOnly) {
    let alerts: Set<string>;
    try {
      alerts = codeHost().fetchOpenAlertPackages(repoConfig.githubRepo, repoConfig.repoPath);
    } catch (err) {
      depLogger.warn("dependabot: could not read open Dependabot alerts — batching nothing this cycle", {
        ...codeHost().formatGhError(err), repo: repoConfig.githubRepo, dependencyPRs: prs.length,
      });
      return null;
    }
    const before = prs.length;
    prs = codeHost().selectSecurityPRs(prs, alerts);
    if (prs.length === 0) {
      depLogger.debug(`${before} dependency PR(s) open, none a security update (${alerts.size} open alert package(s)); left alone`);
      return null;
    }
    if (prs.length < before) depLogger.info(`${before - prs.length} of ${before} dependency PR(s) are not security updates; left alone`);
  }

  const existing = codeHost().findOpenDependencyBatchIssue(repoConfig.githubRepo, repoConfig.repoPath, depLogger, repoConfig.github);
  if (existing) {
    depLogger.debug(
      `${prs.length} dependency PR(s) on ${bases.join("/")}; batch issue #${existing.number} is already open`,
    );
    return null;
  }

  const changes = prs.map((p) => codeHost().describeDependencyPR(p.number, p.title));
  const { title, body } = codeHost().buildDependencyBatchIssue(featureBranch, changes, repoConfig.github, repoConfig.baseBranch);
  const number = codeHost().createDependencyBatchIssue(
    repoConfig.githubRepo, repoConfig.repoPath, title, body,
    repoConfig.dependencyPreApproved ? repoConfig.triggerLabel : null, depLogger,
  );
  if (number === null) return null;

  const majors = changes.filter((c) => c.major).length;
  depLogger.info(
    `Filed dependency batch issue #${number} for ${prs.length} PR(s) on ${bases.join("/")}` +
    (majors > 0 ? ` — ${majors} major` : "") +
    (repoConfig.dependencyPreApproved
      ? ` — filed with "${repoConfig.triggerLabel}", queued to build`
      : ` — awaiting "${repoConfig.triggerLabel}"`),
  );
  return number;
}

/**
 * Follow the release PR from open to merged, so the items it carries show as
 * waiting on it and then as done (Slashbin-console#1185 sat "in progress"
 * behind release PR #1206). Exported for the release stage, which calls it the
 * moment the SRE merges, so the board does not wait a pass.
 */
export async function followRelease(repoConfig: RepoConfig, logger: Logger, owned = false): Promise<void> {
  const repoName = repoConfig.name;
  await trackRelease({
    repo: repoConfig.githubRepo,
    productionBranch: repoConfig.productionBranch,
    saved: loadRepoState(repoName).release,
    findOpenRelease: () =>
      codeHost().findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger),
    releaseState: (pr) => codeHost().getPrState(repoConfig.githubRepo, pr, repoConfig.repoPath, logger),
    save: (v) => {
      const st = loadRepoState(repoName);
      if (v) st.release = v;
      else delete st.release;
      saveRepoState(repoName, st);
    },
    emit: async (release) => { await emit({ kind: "release", release }, null, logger); },
    owned,
  });
}

/** Marks the promote stage's one stall comment on an issue. */
const STALL_MARK = "<!-- foreman:promotion-stall -->";

/**
 * `develop` carries work no issue is authorized to release. Every issue
 * waiting at `pr approved` (dev-verified, awaiting EM verification) gets one
 * comment saying so, once per stall: the EM's action is on the issue, not in
 * a channel. Issues that have left `pr approved` drop out of the dedupe list,
 * so a later stall comments again. With nobody to comment on, the log line is
 * the record.
 */
function noteStall(repoConfig: RepoConfig, files: number, logger: Logger, held: number[] = []): void {
  const { prApproved, readyForProd } = repoConfig.lifecycleLabels;
  const waiting = codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)
    .filter((i) => codeHost().hasLabel(i, prApproved) && !codeHost().hasLabel(i, repoConfig.github.blockedLabel))
    .map((i) => i.number);
  const st = loadRepoState(repoConfig.name);
  const noted = new Set((st.promotionStallNoted ?? []).filter((n) => waiting.includes(n)));
  const fresh = waiting.filter((n) => !noted.has(n));
  // A held release names the work: `noteHeldRelease` already said whose it is.
  if (waiting.length === 0 && held.length === 0) {
    logger.warn(
      `${repoConfig.baseBranch} carries ${files} changed file(s) not on ${repoConfig.productionBranch} and no issue carries ` +
      `"${readyForProd}" or "${prApproved}": promotion is STALLED and no issue names the work. Nothing was commented.`,
    );
  }
  for (const n of fresh) {
    try {
      codeHost().commentOnIssue(repoConfig, n, [
        STALL_MARK,
        `**Waiting on EM verification.** This issue passed dev verification (\`${prApproved}\`), and \`${repoConfig.baseBranch}\` ` +
        `carries ${files} changed file(s) that are not on \`${repoConfig.productionBranch}\`, but no issue carries \`${readyForProd}\`, ` +
        "so nothing is being released.",
        "",
        `To release it: verify the outcome, then apply \`${readyForProd}\`. The Foreman opens the release PR, the Tech Lead ` +
        "approves it, the SRE deploys and verifies it in production, and the Foreman closes this issue on a pass.",
      ].join("\n"));
      noted.add(n);
      logger.info(`Promotion stall: commented on #${n} (waiting on EM verification)`);
    } catch (err) {
      logger.warn(`Promotion stall: could not comment on #${n}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const next = [...noted].sort((a, b) => a - b);
  if (next.join() !== (st.promotionStallNoted ?? []).join()) {
    if (next.length > 0) st.promotionStallNoted = next;
    else delete st.promotionStallNoted;
    saveRepoState(repoConfig.name, st);
  }
}

/**
 * Open issues in the release that a stop holds: `release pending` and
 * `blocked` (a predeploy-stop, a Tech Lead refusal, an SRE sweep hold). Their
 * work is what `develop` carries, so the drift is theirs, not unnamed.
 */
function heldReleaseIssues(repoConfig: RepoConfig, logger: Logger): number[] {
  const { releasePending } = repoConfig.lifecycleLabels;
  return codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)
    .filter((i) => codeHost().hasLabel(i, releasePending) && codeHost().hasLabel(i, repoConfig.github.blockedLabel))
    .map((i) => i.number)
    .sort((a, b) => a - b);
}

/** One held issue, worded for the log: whose release, which hold, on which PR. */
function describeHeld(repoConfig: RepoConfig, n: number, fallbackPr: number | null, logger: Logger): string {
  let stop: { pr: number | null; hold: string } | null = null;
  try {
    stop = codeHost().findReleaseStop(repoConfig, n);
  } catch (err) {
    logger.debug(`Could not read the release stop on #${n}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pr = stop?.pr ?? fallbackPr;
  return `release of #${n} held: ${repoConfig.github.blockedLabel}${stop ? ` after ${stop.hold}` : ""}` +
    `${pr ? ` on PR #${pr}` : ""} — waiting on a person`;
}

/**
 * `develop` carries work whose release a stop is holding. Named in the log
 * once per change of the held set (persisted, so a restart does not repeat
 * it); while it is unchanged, each check is a debug line. The issue already
 * carries the stop's own comment, so nothing is commented here. Returns the
 * line for observers.
 */
function noteHeldRelease(repoConfig: RepoConfig, held: number[], files: number, logger: Logger): string {
  const key = held.join(",");
  const st = loadRepoState(repoConfig.name);
  const prefix = `${repoConfig.baseBranch} carries ${files} changed file(s) not on ${repoConfig.productionBranch}: `;
  if (st.promotionHeldNoted === key) {
    const line = held.map((n) => `release of #${n} held (${repoConfig.github.blockedLabel})`).join("; ");
    logger.debug(`${prefix}${line} — unchanged since last noted`);
    return line;
  }
  const open = codeHost().findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger);
  const listed = open ? new Set(releaseIssues(open.body)) : new Set<number>();
  const line = held.map((n) => describeHeld(repoConfig, n, open && listed.has(n) ? open.number : null, logger)).join("; ");
  logger.warn(`${prefix}${line}.`);
  st.promotionHeldNoted = key;
  saveRepoState(repoConfig.name, st);
  return line;
}

/** Forget the noted held release once it no longer holds `develop`, so a later stop is named again. */
function clearHeldNote(repoConfig: RepoConfig): void {
  const st = loadRepoState(repoConfig.name);
  if (st.promotionHeldNoted === undefined) return;
  delete st.promotionHeldNoted;
  saveRepoState(repoConfig.name, st);
}

/**
 * Issues already in the release the Foreman owns (`release pending`), open,
 * not blocked, and not yet merged by the release stage: they must stay listed
 * on the release PR when promote rewrites it, and are re-queued onto a new
 * one if the old one was closed unmerged.
 */
function carriedIssues(repoConfig: RepoConfig, logger: Logger): PromotionIssue[] {
  const { releasePending } = repoConfig.lifecycleLabels;
  const merged = new Set<number>();
  for (const r of Object.values(loadRepoState(repoConfig.name).prodReleases ?? {})) {
    if (r.phase !== "deploying") for (const n of r.issues) merged.add(n);
  }
  return codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)
    .filter((i) => codeHost().hasLabel(i, releasePending) && !codeHost().hasLabel(i, repoConfig.github.blockedLabel) && !merged.has(i.number))
    .map((i) => ({ number: i.number, title: i.title }));
}

/** `a` then whatever of `b` is not in it, by issue number. */
function union(a: PromotionIssue[], b: PromotionIssue[]): PromotionIssue[] {
  const seen = new Set(a.map((i) => i.number));
  return [...a, ...b.filter((i) => !seen.has(i.number))];
}

/**
 * Open the release PR (base → production) for the issues the EM authorized,
 * and keep it listing every issue in it.
 *
 * With the release stage active (`releaseActive`, EM#578) the Foreman owns
 * the release from here: each authorized issue moves `ready for prod release`
 * → `release pending` once a release PR lists it, and the release stage has
 * the Tech Lead approve it, the SRE deploy it, and closes the issues on a
 * passed prod verification. Without it the legacy path runs: the label is
 * stripped and a person merges and closes.
 */
export async function tryPromotion(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number,
  releaseActive = false,
): Promise<"promoted" | "synced" | null> {
  const repoName = repoConfig.name;
  const promoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "promote" });

  // Main-only repos (like docs) don't have develop → main promotion
  if (repoConfig.baseBranch === repoConfig.productionBranch && repoConfig.featureBranch === repoConfig.productionBranch) {
    return null;
  }

  // Before the ready-for-prod read: a release PR stays open, and merges, after
  // its issues have lost that label.
  await followRelease(repoConfig, promoLogger, releaseActive);

  let issues = codeHost().findReadyForProdIssues(
    repoConfig.githubRepo, repoConfig.repoPath, repoConfig.lifecycleLabels, promoLogger,
  );
  const carried = releaseActive ? carriedIssues(repoConfig, promoLogger) : [];
  const queue = async (nums: number[]): Promise<void> => {
    for (const n of nums) await advance(itemOf(repoConfig, n), "releaseQueued", repoConfig, promoLogger);
  };

  if (issues.length === 0 && carried.length === 0) {
    // "Nothing ready to promote" and "the gate was revoked and promotion is
    // stalled" produce the identical empty set and the identical silence. They
    // are distinguishable by one fact: whether `develop` is carrying merged work
    // that never reached `main`. Say so when it is, on the issues waiting.
    //
    // Rate-limited because it costs a compare API call and the discovery budget
    // is repos x cycles/hour (see docs on the GitHub API budget) — a stall lasts
    // cycles, so hourly is early enough to catch it and cheap enough to keep.
    const last = lastStallCheckCycle.get(repoName) ?? -Infinity;
    if (cycleNumber - last >= STALL_CHECK_CYCLE_INTERVAL) {
      lastStallCheckCycle.set(repoName, cycleNumber);
      const drift = codeHost().checkBranchDrift(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, promoLogger);
      // Gate on CHANGED FILES, never on commit count. Every repo sits 1 commit
      // ahead in the steady state — the main -> develop sync PR's merge commit,
      // which carries no file change. Warning on `ahead > 0` fires on every repo
      // on every check, forever, and a warning that is always on is not a signal.
      //
      // And only on files that can change production: a drift confined to
      // `.claude/` (skill syncs) rides the next real release and is not a stall.
      const files = drift ? codeHost().productionDriftFiles(drift) : 0;
      if (drift && files > 0) {
        const held = heldReleaseIssues(repoConfig, promoLogger);
        let detail: string;
        if (held.length > 0) {
          detail = noteHeldRelease(repoConfig, held, files, promoLogger);
        } else {
          clearHeldNote(repoConfig);
          promoLogger.info(
            `${repoName}: ${repoConfig.baseBranch} carries ${files} changed file(s) not on ${repoConfig.productionBranch} ` +
            `(${drift.developAheadOfMain} commit(s) ahead) but no issue carries "${repoConfig.lifecycleLabels.readyForProd}" — ` +
            "promotion is waiting on EM verification.",
            { developAheadOfMain: drift.developAheadOfMain, developAheadFiles: drift.developAheadFiles, productionFiles: files },
          );
          detail = `${repoConfig.baseBranch} carries ${files} changed file(s) not on ${repoConfig.productionBranch}; ` +
            `no issue carries "${repoConfig.lifecycleLabels.readyForProd}"`;
        }
        noteStall(repoConfig, files, promoLogger, held);
        await emit({ kind: "promotionStall", repo: repoConfig.githubRepo, detail }, null, promoLogger);
      } else if (drift) {
        if (drift.developAheadFiles > 0) {
          promoLogger.debug(
            `${repoConfig.baseBranch} differs from ${repoConfig.productionBranch} only under .claude/ ` +
            `(${drift.developAheadFiles} file(s)): no production effect, rides the next release`,
          );
        }
        clearHeldNote(repoConfig);
        await emit({ kind: "promotionStall", repo: repoConfig.githubRepo, detail: null }, null, promoLogger);
      }
    }
    return null;
  }

  // Issues are ready, so promotion is moving, not stalled.
  clearHeldNote(repoConfig);
  await emit({ kind: "promotionStall", repo: repoConfig.githubRepo, detail: null }, null, promoLogger);
  if (issues.length > 0) promoLogger.info(`Found ${issues.length} issue(s) ready for prod release`);

  // Check if a promotion PR already exists
  const existingPR = codeHost().findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, promoLogger);
  if (existingPR) {
    const listed = releaseIssues(existingPR.body);
    const listedSet = new Set(listed);
    // Everything the PR must list: the newly authorized, the carried, and,
    // with the release stage on, whatever it already lists that is still
    // open, so a rewrite never drops an issue out of its own release.
    const open = codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, promoLogger);
    const stillListed = releaseActive
      ? open.filter((i) => listedSet.has(i.number)).map((i) => ({ number: i.number, title: i.title }))
      : [];
    // The PR promotes all of `develop`: adopt every issue whose merge it
    // carries that is not already authorized or listed (foreman#90).
    const authorized = new Set([...listedSet, ...issues.map((i) => i.number), ...carried.map((i) => i.number), ...stillListed.map((i) => i.number)]);
    const carry = codeHost().adoptCarried(repoConfig, authorized, promoLogger);
    // Adopted issues are listed, not signed: only `issues` (the EM's) move to release pending.
    const wanted = releaseActive ? union(union(stillListed, carried), union(issues, carry.adopted)) : union(issues, carry.adopted);
    const missing = wanted.filter((i) => !listedSet.has(i.number));
    const unlistedPrs = carry.unlinked.filter((u) => !existingPR.body.includes(`PR ${u.pr}:`));

    if (missing.length > 0 || unlistedPrs.length > 0) {
      const updated = codeHost().updatePromotionPR(
        repoConfig.githubRepo, existingPR.number, wanted, repoConfig.repoPath, repoConfig.github, carry.unlinked,
      );
      if (updated) {
        promoLogger.info(
          `Updated promotion PR #${existingPR.number} — added ${missing.length} issue(s): ${missing.map((i) => `#${i.number}`).join(", ")}`
        );
        if (releaseActive) await queue(issues.map((i) => i.number));
        await codeHost().noteCarried(repoConfig, carry, existingPR.number, wanted.map((i) => i.number).filter((n) => !carry.adopted.some((a) => a.number === n)), promoLogger);
      } else {
        promoLogger.error(
          `Failed to update promotion PR #${existingPR.number} — ${missing.length} dev-verified issue(s) are BLOCKED from production and no promotion PR reflects them. This is not cosmetic: the promote phase found the work and could not act on it.`
        );
      }
    } else {
      promoLogger.info(`Promotion PR #${existingPR.number} already includes all ${wanted.length} issue(s)`);
      if (releaseActive) await queue(issues.map((i) => i.number));
    }
    return null;
  }

  // No open release PR. With the release stage on and nothing newly
  // authorized, only carried issues remain: their release PR was closed
  // unmerged, or merged (the release stage's adoption owns that).
  let toList = releaseActive ? union(carried, issues) : issues;

  // Guard: confirm develop actually has file changes main is missing before
  // creating the promotion PR. develop can be "ahead" of main by 1+ commits
  // purely from sync merge commits (main → develop) that carry no file diff.
  // In that case an issue still labeled `ready for prod release` (because the
  // EM verification script hasn't stripped it yet) would trigger a phantom
  // no-op promotion PR — the ping-pong bug.
  const diffFiles = codeHost().countBranchDiffFiles(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, promoLogger);
  if (diffFiles === 0) {
    // TERMINAL EXIT for the promote lifecycle (slashbin-ai-foreman#32, promote variant).
    //
    // develop has ZERO file changes vs main, so every ready-for-prod issue's work
    // is ALREADY in main — it was promoted, and there is nothing left to promote.
    // Retrying is futile by construction; no future cycle can produce a diff.
    // (jerky_security_testing #110/#115/#117/#118/#122 kept the label for two
    // weeks, re-checked every poll, while their fixes had shipped on day one.)
    //
    // Safe: `ready for prod release` is only applied after the feature PR merges to
    // develop, so develop-content == main-content ⇒ that work IS in main.
    if (issues.length === 0) return null;  // carried only: the release stage owns them
    const nums = issues.map((i) => i.number);
    if (releaseActive) {
      // In main, but "in main" is not "verified in production" (EM#578). An
      // issue closes here only on evidence: a prod verification the release
      // stage recorded for it against the commit production is at now.
      // Everything else goes to `release pending`, where the release stage
      // adopts the merged release that carried it and verifies it.
      let head: string | null = null;
      try { head = codeHost().productionHead(repoConfig); } catch (err) {
        promoLogger.warn(`Could not read ${repoConfig.productionBranch}'s head: ${err instanceof Error ? err.message : String(err)}`);
      }
      const verified = loadRepoState(repoName).prodVerified ?? {};
      const close = nums.filter((n) => head !== null && verified[n]?.mergeSha === head);
      const pending = nums.filter((n) => !close.includes(n));
      promoLogger.info(
        `Already promoted — ${nums.length} issue(s) labeled '${repoConfig.lifecycleLabels.readyForProd}' with ${repoConfig.baseBranch} at 0 file changes vs ${repoConfig.productionBranch}` +
        (close.length > 0 ? `; closing ${close.map((n) => `#${n}`).join(", ")} (prod-verified at ${head?.slice(0, 10)})` : "") +
        (pending.length > 0 ? `; ${pending.map((n) => `#${n}`).join(", ")} → release pending for prod verification` : ""),
      );
      await emit({ kind: "release", release: {
        repo: repoConfig.githubRepo, state: "merged",
        issues: nums.map((n) => itemOf(repoConfig, n)), productionBranch: repoConfig.productionBranch,
      } }, null, promoLogger);
      for (const n of close) await advance(itemOf(repoConfig, n), "alreadyReleased", repoConfig, promoLogger);
      await queue(pending);
      await notifyOnce("promoted", repoConfig, nums, promoLogger);
      return null;
    }
    // Legacy (no release stage): strip the label to remove them from the promote
    // set. We do NOT close them — the EM still owns outcome verification; an open
    // issue with no lifecycle label is inert and stays visible for that close.
    promoLogger.warn(
      `Already promoted — ${issues.length} issue(s) still labeled '${repoConfig.lifecycleLabels.readyForProd}' but ${repoConfig.baseBranch} has 0 file changes vs ${repoConfig.productionBranch}, ` +
      `so their work is already in ${repoConfig.productionBranch}: ${nums.map((n) => `#${n}`).join(", ")}. ` +
      `Stripping the label (nothing left to promote). They remain open for EM outcome-verification + close.`,
    );
    codeHost().stripReadyForProdLabel(repoConfig.githubRepo, nums, repoConfig.repoPath, repoConfig.lifecycleLabels, promoLogger);
    // Confirmed in main: the promotion these issues were waiting for happened.
    await notifyOnce("promoted", repoConfig, nums, promoLogger);
    await emit({ kind: "release", release: {
      repo: repoConfig.githubRepo,
      state: "merged",
      issues: nums.map((n) => itemOf(repoConfig, n)),
      productionBranch: repoConfig.productionBranch,
    } }, null, promoLogger);
    return null;
  }
  if (diffFiles < 0) {
    promoLogger.warn("Could not compute branch diff — proceeding with promotion PR creation (best effort)");
  }

  // The PR promotes all of `develop`: adopt every issue whose merge it carries
  // that is not already authorized (foreman#90), so the PR lists them all.
  const authorizedNums = toList.map((i) => i.number);
  const carry: ReleaseCarry = codeHost().adoptCarried(repoConfig, new Set(authorizedNums), promoLogger);
  toList = union(toList, carry.adopted);

  const prUrl = codeHost().createPromotionPR(
    repoConfig.githubRepo,
    repoConfig.productionBranch,
    repoConfig.baseBranch,
    toList,
    repoConfig.repoPath,
    promoLogger,
    repoConfig.github,
    carry.unlinked,
  );

  if (prUrl) {
    promoLogger.info(`Promotion PR created: ${prUrl}`, {
      issues: toList.map((i) => i.number),
    });
    const nums = issues.map((i) => i.number);
    const prNumber = Number(/\/pull\/(\d+)/.exec(prUrl)?.[1]);
    if (Number.isFinite(prNumber)) await codeHost().noteCarried(repoConfig, carry, prNumber, authorizedNums, promoLogger);
    if (releaseActive) {
      // The release PR owns them now: `ready for prod release` → `release pending`.
      await queue(nums);
    } else {
      // Strip the `ready for prod release` label now that the promotion PR
      // owns these issues, so the next cycle does not promote them again.
      codeHost().stripReadyForProdLabel(repoConfig.githubRepo, nums, repoConfig.repoPath, repoConfig.lifecycleLabels, promoLogger);
    }
    await notifyOnce("promoted", repoConfig, nums, promoLogger);
    return "promoted";
  } else {
    promoLogger.warn("Failed to create promotion PR");
    return null;
  }
}
