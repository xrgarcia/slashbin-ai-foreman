// The release stage (EM#578): the release PR promote opened goes to
// production with no person in the loop, and its issues close only on a
// passed prod verification.
//
//   1. The Tech Lead approves the release PR at its head (`tech-lead.mjs
//      approve-promotion`).
//   2. The SRE merges and deploys it, and verifies production (`sre.mjs
//      deploy`). The Foreman never merges a release PR itself.
//   3. On a merge, the Foreman tags the merge commit: a plain annotated tag,
//      never a GitHub Release (see `github.releaseTagFormat`).
//   4. A pass closes each issue as completed with one comment (tag, merge SHA,
//      evidence). A hold or fail reopens it at `prod verification held` and the
//      SRE re-verifies on the prodVerifyRetry back-off.
//   5. 30 minutes after the merge the SRE soaks the release once (`sre.mjs
//      verify --mode soak`); a soak hold reopens the issues the same way.
//
// It also adopts what it did not deploy: a base → production PR merged in the
// last 48 hours (by a person, or before this stage ran) whose issues it has not
// closed on a prod verification, and an issue the SRE's interim
// promotion-verify sweep blocked ("**Production release check needs a
// person.**"). Those skip steps 1 and 2.
//
// No Discord message on any outcome (owner direction, 2026-10-10): a pass is
// the closing comment on the issue, a hold or STOP is a comment and a label on
// each issue, which moves its Paperclip card. Everything else is the log.
//
// No Claude session: the Tech Lead and the SRE are subprocesses. One of them
// runs per pass at most, so a slow deploy holds up one repo's pass, not the
// fleet's.

import { resolve } from "node:path";
import { releaseStageReady, type AgentConfig, type RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { emit, advance } from "../work-source.js";
import type { Move } from "../lifecycle.js";
import { approvePromotionViaTechLead, deployViaSre, verifyProdViaSre, type VerifyResult } from "../agent.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import {
  findOpenPromotionPR,
  getOpenIssues,
  hasLabel,
  commentOnIssue,
  countBranchDiffFiles,
  viewIssue,
  viewReleasePr,
  recentMergedReleasePrs,
  findPvComment,
  readPvResult,
  findSreSweepHold,
  ensureReleaseTag,
  addBlockedLabel,
  removeBlockedLabel,
  addReleasePrIssues,
  productionHead,
  type ReleasePrView,
} from "../github.js";
import { releaseTagName } from "../github/conventions.js";
import { releaseIssues } from "../release-tracker.js";
import { loadRepoState, saveRepoState, type ProdRelease, type RepoState } from "../state.js";
import { BackoffTracker, backoffDelay, formatWait } from "../backoff.js";
import { activeRuns, itemOf } from "./common.js";
import { verifyHoldPlan } from "./verify.js";
import { followRelease } from "./promote.js";

/** The SRE's soak window: it runs once this long after the merge. */
export const SOAK_DELAY_MS = 30 * 60_000;
/** How far back the release stage adopts merged releases it did not deploy. */
export const ADOPT_WINDOW_MS = 48 * 3_600_000;
/** How often a repo is scanned for releases to adopt: one `gh pr list` each time. */
export const ADOPT_SCAN_MS = 10 * 60_000;

/** Per `repo#pr`: a release waiting after a passing failure (backoff.releaseRetry). */
export let releaseBackoff = new BackoffTracker();
/** Per repo: when it was last scanned for releases to adopt. */
const lastAdoptScan = new Map<string, number>();
/** `repo#pr` already found to name no issue to adopt; `repo#issue` already checked for an SRE sweep hold. */
const adoptChecked = new Set<string>();

/** Forget the stage's in-memory state. For tests. */
export function resetReleaseStage(): void {
  releaseBackoff = new BackoffTracker();
  lastAdoptScan.clear();
  adoptChecked.clear();
}

type Verdict =
  | { kind: "pass"; evidence?: string }
  | { kind: "hold"; hold: string; evidence?: string }
  /** Not a failure: the SRE named the time the rest becomes observable. */
  | { kind: "wait"; retryAt: string; hold: string }
  /** Nothing was verified (the SRE could not run): back off, write nothing. */
  | { kind: "defer"; reason: string };

/** A hold slug's verdict: `defer` and `wait` are not failures (verifyHoldPlan). */
function holdVerdict(hold: string, evidence?: string): Verdict {
  const plan = verifyHoldPlan(hold);
  if (plan.kind === "defer") return { kind: "defer", reason: hold };
  if (plan.kind === "wait") return { kind: "wait", retryAt: plan.retryAt, hold };
  return { kind: "hold", hold, ...(evidence ? { evidence } : {}) };
}

/** The evidence link for a verification the SRE just posted: its latest Production Verification comment. */
function evidenceFor(repoConfig: RepoConfig, pr: number, logger: Logger): string | undefined {
  try {
    return findPvComment(repoConfig, pr)?.url;
  } catch (err) {
    logger.debug(`Could not read release PR #${pr}'s verification comment: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function fromVerifyResult(r: VerifyResult, repoConfig: RepoConfig, pr: number, logger: Logger): Verdict {
  if (r.kind === "error") return { kind: "defer", reason: r.error };
  const evidence = evidenceFor(repoConfig, pr, logger);
  if (r.pass) return { kind: "pass", ...(evidence ? { evidence } : {}) };
  return holdVerdict(r.reason ?? "prod-verify-held", evidence);
}

const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (sha: string | undefined) => (sha ? sha.slice(0, 10) : "unknown");

function save(repoConfig: RepoConfig, edit: (st: RepoState) => void): void {
  const st = loadRepoState(repoConfig.name);
  edit(st);
  saveRepoState(repoConfig.name, st);
}

function putRelease(repoConfig: RepoConfig, rel: ProdRelease): void {
  save(repoConfig, (st) => { st.prodReleases = { ...(st.prodReleases ?? {}), [rel.pr]: rel }; });
}

function dropRelease(repoConfig: RepoConfig, pr: number): void {
  save(repoConfig, (st) => { if (st.prodReleases) delete st.prodReleases[pr]; });
}

function comment(repoConfig: RepoConfig, n: number, body: string, logger: Logger): void {
  try {
    commentOnIssue(repoConfig, n, body);
  } catch (err) {
    logger.warn(`Could not comment on #${n}: ${errText(err)}`);
  }
}

/** The transcript path for one Tech Lead / SRE run. */
function transcript(repoConfig: RepoConfig, what: string, cycleNumber: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(process.cwd(), "logs", "release", `${repoConfig.name}-${what}-cycle${cycleNumber}-${ts}.log`);
}

/** Run one Tech Lead / SRE subprocess as this repo's in-flight run, so a shutdown aborts it. */
async function asRun<T>(repoConfig: RepoConfig, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  activeRuns.set(repoConfig.name, ac);
  try {
    return await fn(ac.signal);
  } finally {
    activeRuns.delete(repoConfig.name);
  }
}

/** Tag the release's merge commit once; a failure is logged and retried with the release's next step. */
function tagRelease(repoConfig: RepoConfig, rel: ProdRelease, logger: Logger): void {
  if (rel.tag || !rel.mergeSha) return;
  try {
    const name = releaseTagName(repoConfig.github.releaseTagFormat, rel.pr, new Date(rel.mergedAt ?? now()));
    const message = [
      `Release PR #${rel.pr}${rel.url ? ` (${rel.url})` : ""} to ${repoConfig.productionBranch}`,
      "",
      "Issues:",
      ...rel.issues.map((n) => `- #${n}`),
    ].join("\n");
    const t = ensureReleaseTag(repoConfig, rel.mergeSha, name, message);
    rel.tag = t.tag;
    logger.info(`${t.created ? "Tagged" : "Found tag"} ${t.tag} on ${short(rel.mergeSha)} (release PR #${rel.pr})`);
  } catch (err) {
    logger.warn(`Could not tag release PR #${rel.pr} at ${short(rel.mergeSha)}: ${errText(err)}`);
  }
}

/** The release's issues a write may touch: not blocked by a person (an SRE sweep hold was already taken over). */
function writable(repoConfig: RepoConfig, rel: ProdRelease, logger: Logger): number[] {
  const blocked = new Set(
    getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)
      .filter((i) => hasLabel(i, repoConfig.github.blockedLabel)).map((i) => i.number),
  );
  const skip = rel.issues.filter((n) => blocked.has(n));
  if (skip.length > 0) logger.info(`Release PR #${rel.pr}: leaving ${skip.map((n) => `#${n}`).join(", ")} alone (blocked by a person)`);
  return rel.issues.filter((n) => !blocked.has(n));
}

/** A pass: close every issue with one line of evidence, record it, and queue the soak. */
async function passRelease(repoConfig: RepoConfig, rel: ProdRelease, move: Move, evidence: string | undefined, logger: Logger): Promise<void> {
  tagRelease(repoConfig, rel, logger);
  const line =
    `**Verified in production.** Release PR #${rel.pr} merged to \`${repoConfig.productionBranch}\` as \`${short(rel.mergeSha)}\`` +
    `${rel.tag ? `, tagged \`${rel.tag}\`` : ""}. Evidence: ${evidence ?? rel.evidence ?? "the SRE's verification on the release PR"}.`;
  // A closed issue was verified by an earlier pass of this release (a re-verify after a join).
  const open = new Set(getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger).map((i) => i.number));
  for (const n of writable(repoConfig, rel, logger).filter((i) => open.has(i))) {
    comment(repoConfig, n, line, logger);
    await advance(itemOf(repoConfig, n), move, repoConfig, logger);
  }
  const at = iso(now());
  save(repoConfig, (st) => {
    st.prodVerified = { ...(st.prodVerified ?? {}) };
    for (const n of rel.issues) {
      st.prodVerified[n] = {
        pr: rel.pr, mergeSha: rel.mergeSha ?? "", at,
        ...(rel.tag ? { tag: rel.tag } : {}), ...(evidence ? { evidence } : {}),
      };
    }
  });
  logger.info(`Release PR #${rel.pr} verified in production; closed ${rel.issues.map((n) => `#${n}`).join(", ")}`);
  if (rel.soaked) {
    dropRelease(repoConfig, rel.pr);
    return;
  }
  const mergedAt = Date.parse(rel.mergedAt ?? "") || now();
  putRelease(repoConfig, {
    ...rel, phase: "soaking", soakAt: iso(mergedAt + SOAK_DELAY_MS),
    ...(evidence ? { evidence } : {}), retryAt: undefined, hold: undefined,
  });
}

/**
 * A hold or fail: reopen each issue at `prod verification held` with the slug
 * and evidence (once per slug), and schedule the re-verify.
 */
async function holdRelease(
  repoConfig: RepoConfig,
  config: AgentConfig,
  rel: ProdRelease,
  v: { hold: string; evidence?: string },
  move: Move,
  logger: Logger,
): Promise<void> {
  tagRelease(repoConfig, rel, logger);
  const attempts = rel.attempts + 1;
  const retryAt = iso(now() + backoffDelay(attempts, config.backoff.prodVerifyRetry));
  if (rel.hold !== v.hold || rel.phase !== "held") {
    const body = [
      `**Production verification held: \`${v.hold}\`.** Release PR #${rel.pr} merged to \`${repoConfig.productionBranch}\` as ` +
      `\`${short(rel.mergeSha)}\`${rel.tag ? ` (tag \`${rel.tag}\`)` : ""}, but the SRE did not pass it` +
      `${v.evidence ? `: ${v.evidence}` : ""}.`,
      "",
      `This issue stays open at \`${repoConfig.lifecycleLabels.prodVerifyHeld}\`. The SRE re-verifies production after ` +
      `${formatWait(Date.parse(retryAt) - now())}, longer each time, and the Foreman closes it on a pass.`,
    ].join("\n");
    for (const n of writable(repoConfig, rel, logger)) {
      comment(repoConfig, n, body, logger);
      await advance(itemOf(repoConfig, n), move, repoConfig, logger);
    }
  }
  logger.warn(`Release PR #${rel.pr}: prod verification held (${v.hold}), attempt ${attempts}; re-verify at ${retryAt}`);
  putRelease(repoConfig, {
    ...rel, phase: "held", attempts, retryAt, hold: v.hold,
    ...(v.evidence ? { evidence: v.evidence } : {}),
  });
}

/** A STOP: the issues need a person. Blocked, with the reason on each; `release pending` stays. */
async function stopRelease(repoConfig: RepoConfig, pr: number | null, issues: number[], reason: string, evidence: string | undefined, logger: Logger): Promise<void> {
  const body =
    `**Release stopped: needs a person.** ${pr ? `Release PR #${pr}: ` : ""}${reason}${evidence ? ` (${evidence})` : ""}. ` +
    `The Foreman will not retry it while this issue carries \`${repoConfig.github.blockedLabel}\`; remove the label to release it again.`;
  for (const n of issues) {
    try {
      addBlockedLabel(repoConfig, n);
    } catch (err) {
      logger.warn(`Could not block #${n}: ${errText(err)}`);
    }
    comment(repoConfig, n, body, logger);
    await emit({ kind: "blocked", item: itemOf(repoConfig, n), reason: `release stopped: ${reason}` }, repoConfig, logger);
  }
  logger.warn(`${pr ? `Release PR #${pr}` : "Release"} stopped (${reason}); blocked ${issues.map((n) => `#${n}`).join(", ")}`);
}

/**
 * Take over the SRE sweep's interim holds: an open issue labelled `blocked`
 * whose latest sweep comment names a merged release. The `blocked` goes, the
 * issue moves to `prod verification held`, and the release is re-verified
 * here. Each issue is checked once per process (one comments read).
 */
async function adoptSweepHolds(repoConfig: RepoConfig, logger: Logger): Promise<void> {
  const blocked = getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)
    .filter((i) => hasLabel(i, repoConfig.github.blockedLabel));
  for (const issue of blocked) {
    const key = `${repoConfig.githubRepo}#issue${issue.number}`;
    if (adoptChecked.has(key)) continue;
    adoptChecked.add(key);
    let hold: { pr: number; url: string } | null;
    let pr: ReleasePrView;
    try {
      hold = findSreSweepHold(repoConfig, issue.number);
      if (!hold) continue;
      pr = viewReleasePr(repoConfig, hold.pr);
    } catch (err) {
      adoptChecked.delete(key);
      logger.debug(`Could not check #${issue.number} for an SRE sweep hold: ${errText(err)}`);
      continue;
    }
    if (pr.state !== "MERGED") {
      logger.info(`#${issue.number}: SRE sweep hold names release PR #${hold.pr}, which is not merged; left for a person`);
      continue;
    }
    try {
      removeBlockedLabel(repoConfig, issue.number);
    } catch (err) {
      adoptChecked.delete(key);
      logger.warn(`Could not take over the SRE sweep hold on #${issue.number}: ${errText(err)}`);
      continue;
    }
    const st = loadRepoState(repoConfig.name);
    const t = iso(now());
    const prior = st.prodReleases?.[hold.pr];
    const rel: ProdRelease = prior
      ? { ...prior, issues: prior.issues.includes(issue.number) ? prior.issues : [...prior.issues, issue.number] }
      : {
        pr: pr.number, url: pr.url, headSha: pr.headSha, issues: [issue.number], phase: "held",
        ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}), mergedAt: pr.mergedAt ?? t,
        attempts: 1, retryAt: t, hold: "sre-sweep-hold", since: t, adopted: true,
      };
    if (rel.phase === "soaking") { rel.phase = "held"; rel.retryAt = t; rel.hold = "sre-sweep-hold"; }
    putRelease(repoConfig, rel);
    await advance(itemOf(repoConfig, issue.number), "prodHeld", repoConfig, logger);
    comment(repoConfig, issue.number,
      `**The Foreman took over this production release check** from the SRE's interim hold (${hold.url}). ` +
      `It re-verifies release PR #${hold.pr} in production on a back-off and closes this issue on a pass; ` +
      `until then it stays open at \`${repoConfig.lifecycleLabels.prodVerifyHeld}\`.`, logger);
    logger.info(`Took over the SRE sweep hold on #${issue.number} (release PR #${hold.pr})`);
  }
}

/**
 * Adopt base → production PRs merged in the last 48 hours that the release
 * stage did not deploy and whose issues it has not closed on a prod
 * verification. A PR naming no issue is not adopted (nothing to close).
 */
function adoptMergedReleases(repoConfig: RepoConfig, st: RepoState, logger: Logger): void {
  const verified = st.prodVerified ?? {};
  const tracked = new Set(Object.values(st.prodReleases ?? {}).flatMap((r) => r.issues));
  let prs: ReleasePrView[];
  try {
    prs = recentMergedReleasePrs(repoConfig, iso(now() - ADOPT_WINDOW_MS));
  } catch (err) {
    logger.debug(`Could not list merged release PRs: ${errText(err)}`);
    return;
  }
  for (const pr of [...prs].reverse()) {
    const key = `${repoConfig.githubRepo}#pr${pr.number}`;
    if (st.prodReleases?.[pr.number] || adoptChecked.has(key)) continue;
    const named = releaseIssues(pr.body).filter((n) => n !== pr.number && !tracked.has(n) && !((verified[n]?.pr ?? 0) >= pr.number));
    if (named.length === 0) continue;
    // Only issues the Foreman's lifecycle owns (they carry the trigger label):
    // a `#N` in the body can be a PR or a passing mention.
    const issues: number[] = [];
    try {
      for (const n of named) {
        const v = viewIssue(repoConfig, n);
        if (v?.labels.includes(repoConfig.triggerLabel)) issues.push(n);
      }
    } catch (err) {
      logger.debug(`Could not read release PR #${pr.number}'s issues: ${errText(err)}`);
      continue;
    }
    if (issues.length === 0) {
      adoptChecked.add(key);
      logger.debug(`Release PR #${pr.number} names no issue in the lifecycle; not adopted`);
      continue;
    }
    const t = iso(now());
    putRelease(repoConfig, {
      pr: pr.number, url: pr.url, headSha: pr.headSha, issues, phase: "merged",
      ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}), mergedAt: pr.mergedAt ?? t,
      attempts: 0, since: t, adopted: true,
    });
    for (const n of issues) tracked.add(n);
    logger.info(`Adopted release PR #${pr.number} (merged ${pr.mergedAt ?? "recently"}) for prod verification: ${issues.map((n) => `#${n}`).join(", ")}`);
  }
}

/**
 * `release pending` issues nothing carries: no open release PR, no tracked
 * release, and `develop` has nothing left for a new one. Their work reached
 * production without a release the Foreman can verify them by, so they need a
 * person; closing them would be closing unverified.
 */
async function blockOrphans(repoConfig: RepoConfig, st: RepoState, logger: Logger): Promise<void> {
  const { releasePending } = repoConfig.lifecycleLabels;
  const tracked = new Set(Object.values(st.prodReleases ?? {}).flatMap((r) => r.issues));
  const orphans = getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)
    .filter((i) => hasLabel(i, releasePending) && !hasLabel(i, repoConfig.github.blockedLabel) && !tracked.has(i.number))
    .map((i) => i.number);
  if (orphans.length === 0) return;
  if (findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger)) return;
  const diff = countBranchDiffFiles(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger);
  if (diff !== 0) return;  // promote opens a release PR for them next pass
  if (await joinCarryingRelease(repoConfig, st, orphans, logger)) return;
  await stopRelease(repoConfig, null, orphans,
    `no release carries this issue: its work is already on \`${repoConfig.productionBranch}\`, but no release PR merged in the last ` +
    "48 hours lists it, so there is no release to verify it by. Check production by hand and close it, or move it back to " +
    `\`${repoConfig.lifecycleLabels.readyForProd}\` once a release can carry it`, undefined, logger);
}

/**
 * An orphan's work is on production with nothing left on base, so the release
 * whose merge IS production's head shipped it. That happens when an issue
 * reaches `ready for prod release` after promote read the list for the open
 * release PR (jerky_skuvault_service #417 and #419, 2026-10-11: labelled 1-4 s
 * after PR #426 was opened naming only #397, then blocked here as carried by
 * nothing). Join it to that release: its PR body names it, so the SRE's next
 * prod verification grades its acceptance, and the release closes it on a pass.
 * A `soaking` release already passed without it, so it goes back to `merged` to
 * be verified again (jerky_skuvault_service #433, 2026-10-12: labelled 2 s
 * before PR #439 was cut, orphaned only after #439 passed). True when joined.
 */
async function joinCarryingRelease(repoConfig: RepoConfig, st: RepoState, orphans: number[], logger: Logger): Promise<boolean> {
  let head: string;
  try {
    head = productionHead(repoConfig);
  } catch (err) {
    logger.debug(`Could not read ${repoConfig.productionBranch}'s head: ${errText(err)}`);
    return false;
  }
  const rel = Object.values(st.prodReleases ?? {})
    .find((r) => r.mergeSha === head && r.phase !== "deploying");
  if (!rel) return false;
  const titles = new Map(getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger).map((i) => [i.number, i.title]));
  try {
    const pr = viewReleasePr(repoConfig, rel.pr);
    const named = new Set(releaseIssues(pr.body));
    const missing = orphans.filter((n) => !named.has(n));
    if (missing.length) addReleasePrIssues(repoConfig, pr, missing.map((n) => ({ number: n, title: titles.get(n) ?? `#${n}` })));
  } catch (err) {
    logger.warn(`Could not add ${orphans.map((n) => `#${n}`).join(", ")} to release PR #${rel.pr}: ${errText(err)}`);
    return false;
  }
  const issues = [...rel.issues, ...orphans.filter((n) => !rel.issues.includes(n))];
  const reverify = rel.phase === "soaking";
  putRelease(repoConfig, reverify
    ? { ...rel, issues, phase: "merged", attempts: 0, adopted: false, retryAt: undefined, soakAt: undefined, hold: undefined }
    : { ...rel, issues });
  for (const n of orphans) {
    if (rel.phase === "held") await advance(itemOf(repoConfig, n), "prodHeld", repoConfig, logger);
    comment(repoConfig, n,
      `**Joined release PR #${rel.pr}.** This issue's work shipped in that release (\`${repoConfig.productionBranch}\` is at its merge, \`${short(head)}\`), ` +
      "which was opened before this issue was ready for production. The release now names it, so its " +
      `${reverify ? "re-run " : ""}production verification grades this issue and closes it on a pass.`, logger);
  }
  logger.info(`Joined ${orphans.map((n) => `#${n}`).join(", ")} to release PR #${rel.pr} (production head ${short(head)})`);
  return true;
}

/** The verdict for a merged release: the SRE's posted Production Verification if there is one, else a fresh run. */
async function mergedVerdict(repoConfig: RepoConfig, config: AgentConfig, rel: ProdRelease, logger: Logger, cycleNumber: number): Promise<Verdict> {
  if (rel.adopted && rel.attempts === 0) {
    try {
      const pv = findPvComment(repoConfig, rel.pr);
      const read = pv ? readPvResult(pv.body) : null;
      if (pv && read) {
        logger.info(`Release PR #${rel.pr}: reading its existing Production Verification (${pv.url})`);
        return read.pass ? { kind: "pass", evidence: pv.url } : holdVerdict(read.hold, pv.url);
      }
    } catch (err) {
      logger.debug(`Could not read release PR #${rel.pr}'s Production Verification: ${errText(err)}`);
    }
  }
  const path = transcript(repoConfig, `verify-pr${rel.pr}`, cycleNumber);
  logger.info(`Release PR #${rel.pr}: SRE prod verification, transcript: ${path}`);
  const r = await asRun(repoConfig, (signal) => verifyProdViaSre(repoConfig, config, rel.pr, logger, signal, path, "prod"));
  if (r.kind === "nothing") return { kind: "defer", reason: r.reason };
  return fromVerifyResult(r, repoConfig, rel.pr, logger);
}

/** Act on a verdict for a release that has merged (first verification, or a held re-verify). */
async function settle(repoConfig: RepoConfig, config: AgentConfig, rel: ProdRelease, v: Verdict, logger: Logger): Promise<void> {
  const key = `${repoConfig.githubRepo}#${rel.pr}`;
  switch (v.kind) {
    case "pass":
      releaseBackoff.clear(key);
      await passRelease(repoConfig, rel, rel.phase === "held" ? "prodReverified" : "prodVerified", v.evidence, logger);
      return;
    case "hold":
      releaseBackoff.clear(key);
      await holdRelease(repoConfig, config, rel, v, "prodHeld", logger);
      return;
    case "wait":
      logger.info(`Release PR #${rel.pr}: the SRE can verify the rest after ${v.retryAt} (${v.hold})`);
      putRelease(repoConfig, { ...rel, retryAt: v.retryAt });
      return;
    case "defer": {
      const ms = releaseBackoff.start(key, config.backoff.releaseRetry);
      logger.warn(`Release PR #${rel.pr}: prod verification did not run (${v.reason}); retry in ${formatWait(ms)}`);
      return;
    }
  }
}

/** The 30-minute soak, once per release. */
async function soak(repoConfig: RepoConfig, config: AgentConfig, rel: ProdRelease, logger: Logger, cycleNumber: number): Promise<void> {
  const key = `${repoConfig.githubRepo}#${rel.pr}`;
  const path = transcript(repoConfig, `soak-pr${rel.pr}`, cycleNumber);
  logger.info(`Release PR #${rel.pr}: SRE 30-minute soak, transcript: ${path}`);
  const r = await asRun(repoConfig, (signal) => verifyProdViaSre(repoConfig, config, rel.pr, logger, signal, path, "soak"));
  if (r.kind === "nothing") {
    logger.info(`Release PR #${rel.pr}: no soak to run (${r.reason}); done`);
    dropRelease(repoConfig, rel.pr);
    return;
  }
  const v = fromVerifyResult(r, repoConfig, rel.pr, logger);
  switch (v.kind) {
    case "pass":
      logger.info(`Release PR #${rel.pr}: soak passed; done`);
      releaseBackoff.clear(key);
      dropRelease(repoConfig, rel.pr);
      return;
    case "wait":
      putRelease(repoConfig, { ...rel, soakAt: v.retryAt });
      return;
    case "defer": {
      const ms = releaseBackoff.start(key, config.backoff.releaseRetry);
      logger.warn(`Release PR #${rel.pr}: soak did not run (${v.reason}); retry in ${formatWait(ms)}`);
      return;
    }
    case "hold": {
      releaseBackoff.clear(key);
      save(repoConfig, (st) => { for (const n of rel.issues) delete st.prodVerified?.[n]; });
      await holdRelease(repoConfig, config, { ...rel, soaked: true, attempts: 0, phase: "soaking", hold: undefined },
        { hold: `soak:${v.hold}`, ...(v.evidence ? { evidence: v.evidence } : {}) }, "soakHeld", logger);
      return;
    }
  }
}

/**
 * Deploy the open release PR: Tech Lead approval at its head, then the SRE's
 * deploy. Returns false when there is nothing to deploy this pass.
 */
async function deploy(repoConfig: RepoConfig, config: AgentConfig, logger: Logger, cycleNumber: number): Promise<boolean> {
  const open = findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger);
  if (!open) return false;
  const key = `${repoConfig.githubRepo}#${open.number}`;
  if (releaseBackoff.waiting(key)) return false;
  const listed = new Set(releaseIssues(open.body));
  const issues = getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger).filter((i) => listed.has(i.number));
  const pending = issues.filter((i) => hasLabel(i, repoConfig.lifecycleLabels.releasePending)).map((i) => i.number);
  if (pending.length === 0) return false;
  const stopped = issues.filter((i) => hasLabel(i, repoConfig.github.blockedLabel)).map((i) => i.number);
  if (stopped.length > 0) {
    logger.debug(`Release PR #${open.number}: ${stopped.map((n) => `#${n}`).join(", ")} blocked; not deploying`);
    return false;
  }

  let pr: ReleasePrView;
  try {
    pr = viewReleasePr(repoConfig, open.number);
  } catch (err) {
    logger.warn(`Could not read release PR #${open.number}: ${errText(err)}`);
    return false;
  }
  if (pr.state !== "OPEN" || !/^[0-9a-f]{40}$/.test(pr.headSha)) return false;

  const approvePath = transcript(repoConfig, `approve-pr${pr.number}`, cycleNumber);
  const approval = await asRun(repoConfig, (signal) =>
    approvePromotionViaTechLead(repoConfig, config, pr.number, pr.headSha, logger, signal, approvePath));
  if (approval.kind === "refused") {
    await stopRelease(repoConfig, pr.number, pending, `the Tech Lead refused to approve it at \`${short(pr.headSha)}\`: ${approval.reason}`, undefined, logger);
    return true;
  }
  if (approval.kind === "retry") {
    const ms = releaseBackoff.start(key, config.backoff.releaseRetry);
    logger.warn(`Release PR #${pr.number}: Tech Lead approval did not complete (${approval.reason}); retry in ${formatWait(ms)}`);
    return true;
  }

  const t = iso(now());
  const rel: ProdRelease = { pr: pr.number, url: pr.url, headSha: pr.headSha, issues: pending, phase: "deploying", attempts: 0, since: t };
  putRelease(repoConfig, rel);
  const deployPath = transcript(repoConfig, `deploy-pr${pr.number}`, cycleNumber);
  logger.info(`Release PR #${pr.number}: Tech Lead approved at ${short(pr.headSha)}; SRE deploying, transcript: ${deployPath}`);
  const r = await asRun(repoConfig, (signal) => deployViaSre(repoConfig, config, pr.number, pr.headSha, logger, signal, deployPath));

  if (r.kind !== "trailer" || !r.trailer.merged) {
    dropRelease(repoConfig, pr.number);
    if (r.kind === "trailer" && r.trailer.hold === "predeploy-stop") {
      await stopRelease(repoConfig, pr.number, pending, "the SRE's pre-deploy check said STOP (`predeploy-stop`)", r.trailer.evidence, logger);
      return true;
    }
    const why = r.kind === "trailer" ? `not merged (${r.trailer.hold ?? "no reason given"})` : r.reason;
    const ms = releaseBackoff.start(key, config.backoff.releaseRetry);
    logger.warn(`Release PR #${pr.number}: SRE deploy ${why}; retry in ${formatWait(ms)}`);
    return true;
  }

  releaseBackoff.clear(key);
  const tr = r.trailer;
  let mergeSha = tr.mergeSha;
  if (!mergeSha) {
    try { mergeSha = viewReleasePr(repoConfig, pr.number).mergeSha; } catch { /* read again next pass */ }
  }
  const merged: ProdRelease = { ...rel, phase: "merged", mergedAt: iso(now()), ...(mergeSha ? { mergeSha } : {}) };
  putRelease(repoConfig, merged);
  logger.info(`Release PR #${pr.number} merged by the SRE as ${short(mergeSha ?? undefined)} (verify=${tr.verify}${tr.hold ? `, hold=${tr.hold}` : ""})`);
  await followRelease(repoConfig, logger, true);
  tagRelease(repoConfig, merged, logger);
  putRelease(repoConfig, merged);
  if (tr.verify === "pass") {
    await settle(repoConfig, config, merged, { kind: "pass", ...(tr.evidence ? { evidence: tr.evidence } : {}) }, logger);
  } else if (tr.verify === "hold" || tr.verify === "fail") {
    const v = holdVerdict(tr.hold ?? (tr.verify === "fail" ? "prod-verify-failed" : "prod-verify-held"), tr.evidence);
    // A deferred verdict leaves it `merged`: the next pass verifies it.
    if (v.kind !== "defer") await settle(repoConfig, config, merged, v, logger);
  }
  // verify=none: left `merged`; the next pass runs the prod verification.
  return true;
}

/**
 * One pass of the release stage for one repo. Bookkeeping first (adopting
 * what the SRE sweep held and what others merged), then at most one Tech Lead
 * or SRE action: finish a merged release, re-verify a held one, soak one, or
 * deploy the open release PR, in that order. Returns true when one ran.
 */
export async function tryRelease(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
): Promise<boolean> {
  if (!releaseStageReady(config)) return false;
  if (repoConfig.baseBranch === repoConfig.productionBranch && repoConfig.featureBranch === repoConfig.productionBranch) return false;
  if (isUpstreamBlocked("github")) return false;
  const rlog = logger.child({ cycle: cycleNumber, repo: repoConfig.name, phase: "release" });

  if (now() - (lastAdoptScan.get(repoConfig.name) ?? 0) >= ADOPT_SCAN_MS) {
    lastAdoptScan.set(repoConfig.name, now());
    await adoptSweepHolds(repoConfig, rlog);
    adoptMergedReleases(repoConfig, loadRepoState(repoConfig.name), rlog);
    await blockOrphans(repoConfig, loadRepoState(repoConfig.name), rlog);
  }

  const releases = Object.values(loadRepoState(repoConfig.name).prodReleases ?? {}).sort((a, b) => a.pr - b.pr);
  const t = now();
  const due = (at: string | undefined) => !at || t >= Date.parse(at);

  for (const rel of releases) {
    if (rel.phase !== "deploying") continue;
    // The Foreman stopped mid-deploy: read where the PR ended up.
    try {
      const pr = viewReleasePr(repoConfig, rel.pr);
      if (pr.state === "MERGED") {
        putRelease(repoConfig, { ...rel, phase: "merged", mergedAt: pr.mergedAt ?? iso(t), ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}) });
        rlog.info(`Release PR #${rel.pr} merged while its deploy was in flight; verifying it`);
      } else {
        dropRelease(repoConfig, rel.pr);
        rlog.info(`Release PR #${rel.pr} did not merge during its interrupted deploy; it will be deployed again`);
      }
    } catch (err) {
      rlog.debug(`Could not read release PR #${rel.pr}: ${errText(err)}`);
    }
  }

  const current = Object.values(loadRepoState(repoConfig.name).prodReleases ?? {}).sort((a, b) => a.pr - b.pr);
  const ready = (rel: ProdRelease) => !releaseBackoff.waiting(`${repoConfig.githubRepo}#${rel.pr}`);

  const merged = current.find((r) => r.phase === "merged" && ready(r) && due(r.retryAt));
  if (merged) {
    if (!merged.mergeSha) {
      try {
        const pr = viewReleasePr(repoConfig, merged.pr);
        if (pr.mergeSha) merged.mergeSha = pr.mergeSha;
      } catch { /* tagged on a later pass */ }
    }
    tagRelease(repoConfig, merged, rlog);
    putRelease(repoConfig, merged);
    await settle(repoConfig, config, merged, await mergedVerdict(repoConfig, config, merged, rlog, cycleNumber), rlog);
    return true;
  }

  const held = current.find((r) => r.phase === "held" && ready(r) && due(r.retryAt));
  if (held) {
    const path = transcript(repoConfig, `verify-pr${held.pr}`, cycleNumber);
    rlog.info(`Release PR #${held.pr}: re-verifying production after ${held.hold ?? "a hold"}, transcript: ${path}`);
    const r = await asRun(repoConfig, (signal) => verifyProdViaSre(repoConfig, config, held.pr, rlog, signal, path, "prod"));
    const v: Verdict = r.kind === "nothing" ? { kind: "defer", reason: r.reason } : fromVerifyResult(r, repoConfig, held.pr, rlog);
    await settle(repoConfig, config, held, v, rlog);
    return true;
  }

  const soaking = current.find((r) => r.phase === "soaking" && ready(r) && due(r.soakAt));
  if (soaking) {
    await soak(repoConfig, config, soaking, rlog, cycleNumber);
    return true;
  }

  return deploy(repoConfig, config, rlog, cycleNumber);
}
