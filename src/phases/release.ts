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
// And it recovers what the lifecycle lost (#220): an open issue with no lifecycle label that nothing carries is
// closed on its recorded production verification, or, when only its merge is known, one request asks the EM for the
// sign-off (`sweepStranded`). Never closed without a recorded verification.
//
// No Discord message on any outcome (owner direction, 2026-10-10): a pass is
// the closing comment on the issue, a hold or STOP is a comment and a label on
// each issue, which moves its Paperclip card. Everything else is the log.
//
// No Claude session: the Tech Lead and the SRE are subprocesses. One of them
// runs per pass at most, so a slow deploy holds up one repo's pass, not the
// fleet's.

import { resolve } from "node:path";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { emit, advance } from "../work-source.js";
import type { Move } from "../lifecycle.js";
import { roleFor } from "../plugins/registry.js";
import type { DeployTrailer, IssueAcceptance, VerifyResult } from "../plugins/contract.js";
import { parseWaitUntil } from "../contract/result-v1.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import { releaseIssues } from "../release-tracker.js";
import type { ProdRelease } from "../issue-records.js";
import { fieldTable } from "../issue-records.js";
import { BackoffTracker, backoffDelay, formatWait } from "../backoff.js";
import { activeRuns, itemOf } from "./common.js";
import { epicChildClosedAlert } from "../unstick.js";
import { verifyHoldPlan } from "./verify.js";
import { followRelease } from "./promote.js";
import { epicRefs, handoffSubject } from "../unstick.js";
import { codeHost } from "../plugins/registry.js";
import { releaseTagName } from "../config-schema/github.js";
import type { ReleasePrView } from "../code-host.js";
import type { ForemanRuntime } from "../runtime.js";

/** The SRE's soak window: it runs once this long after the merge. */
export const SOAK_DELAY_MS = 30 * 60_000;
/** How long after a follow-up passes its soak a held release it corrects is re-verified (foreman#186). */
export const REARM_SETTLE_MS = 10 * 60_000;
/** How far back the release stage adopts merged releases it did not deploy. */
export const ADOPT_WINDOW_MS = 48 * 3_600_000;
/** How often a repo is scanned for releases to adopt: one `gh pr list` each time. */
export const ADOPT_SCAN_MS = 10 * 60_000;

/** How many unlabeled open issues one scan looks at for the stranded sweep (their records are read, one call each). */
export const STRANDED_SCAN_CAP = 25;
const STRANDED_RECHECK_MS = 60 * 60_000;
/** Marks the one request the stranded sweep leaves on an issue whose work merged but that nothing carries. */
export const STRANDED_MARK = "<!-- foreman:stranded-issue";

/** Spacing of those head reads: one `commits/<branch>` call per repo per minute while a release is held. */
export const HEAD_PROBE_MS = 60_000;

type Verdict =
  | { kind: "pass"; evidence?: string; /** What the verifier could not check, passed anyway: named in the close comment. */ note?: string }
  | { kind: "hold"; hold: string; evidence?: string; /** The verifier's grade of each issue on its own rows (foreman#117). */ rows?: IssueAcceptance[] }
  /** Not a failure: the SRE named the time the rest becomes observable. */
  | { kind: "wait"; retryAt: string; hold: string; evidence?: string; /** The SRE's stated reason, when it gave one. */ reason?: string }
  /** Nothing was verified (the SRE could not run): back off, write nothing. */
  | { kind: "defer"; reason: string };

/** A hold slug's verdict: `defer` and `wait` are not failures (verifyHoldPlan). */
function holdVerdict(hold: string, evidence?: string, rows?: IssueAcceptance[], reason?: string): Verdict {
  const plan = verifyHoldPlan(hold);
  if (plan.kind === "defer") return { kind: "defer", reason: hold };
  if (plan.kind === "wait") return { kind: "wait", retryAt: plan.retryAt, hold, ...(evidence ? { evidence } : {}), ...(reason ? { reason } : {}) };
  return { kind: "hold", hold, ...(evidence ? { evidence } : {}), ...(rows?.length ? { rows } : {}) };
}

/** Hold slugs that are a verdict on acceptance rows: only these are split per issue. */
const ACCEPTANCE_HOLD = /acceptance/;

/**
 * Which of a release's issues a failing verdict holds, and which it passes (foreman#117). The verifier grades each
 * issue on its own acceptance rows; one issue's failing row must not hold the issues whose rows passed. Split only
 * on an acceptance hold where EVERY tracked issue has a row, some row is a FAIL (any issue's) and a tracked issue
 * PASSed: anything less (no rows, a missing row, all failing, a deploy or release-level hold) is the release's
 * verdict as a whole. An issue
 * graded NOT-VERIFIED is not passed: it stays held with the failing ones. Pure, exported for tests.
 */
export function splitByIssueRows(issues: readonly number[], hold: string, rows: readonly IssueAcceptance[] | undefined): { passing: number[]; held: number[] } | undefined {
  if (!rows?.length || !ACCEPTANCE_HOLD.test(hold)) return undefined;
  const state = new Map<number, IssueAcceptance["state"]>();
  for (const r of rows) if (!state.has(r.issue)) state.set(r.issue, r.state);
  if (!issues.every((n) => state.has(n))) return undefined;
  const passing = issues.filter((n) => state.get(n) === "PASS");
  const held = issues.filter((n) => state.get(n) !== "PASS");
  // The failing row may belong to an issue this record no longer tracks (a re-tracked joined issue): the evidence
  // still names a failure, and the tracked issue's own row passed. Without any FAIL row the hold is the release's.
  if (passing.length === 0 || !rows.some((r) => r.state === "FAIL")) return undefined;
  return { passing, held };
}

/** Production verification (or the soak) by the enabled verifier; an error result when none is enabled. */
function verifyProd(repoConfig: RepoConfig, config: AgentConfig, pr: number, logger: Logger, signal: AbortSignal, path: string, mode: "prod" | "soak", recheck = false): Promise<VerifyResult | { kind: "nothing"; reason: string }> {
  const v = roleFor("verifier", config);
  return v ? v.verifyProd(repoConfig, config, pr, logger, signal, path, mode, recheck) : Promise.resolve({ kind: "error", error: "no verifier is enabled" });
}

/** The evidence link for a verification the SRE just posted: its latest Production Verification comment. */
async function evidenceFor(repoConfig: RepoConfig, pr: number, logger: Logger): Promise<string | undefined> {
  try {
    return (await codeHost().findPvComment(repoConfig, pr))?.url;
  } catch (err) {
    logger.debug(`Could not read release PR #${pr}'s verification comment: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Hold slugs that name an observed regression: a gap never overrides them. */
const REGRESSION_HOLD = /acceptance|regress/;

async function fromVerifyResult(rt: ForemanRuntime, r: VerifyResult, repoConfig: RepoConfig, pr: number, logger: Logger, soak = false): Promise<Verdict> {
  if (r.kind === "error") return { kind: "defer", reason: r.error };
  // Errors the SRE excluded as not this release's go to the EM to route (unrelated-error); they never hold it.
  if (r.unrelated) await rt.handoffs.settleHandoffs(repoConfig, handoffSubject(repoConfig.githubRepo, pr), { seen: r.unrelated, seenOn: `${repoConfig.githubRepo} PR #${pr} (prod)` });
  const evidence = await evidenceFor(repoConfig, pr, logger);
  const gapNote = r.gap && r.gap.class !== "none" ? `the SRE could not check part of it (gap: \`${r.gap.class}\`${r.gap.reason ? `, ${r.gap.reason}` : ""})` : undefined;
  if (r.pass) return { kind: "pass", ...(evidence ? { evidence } : {}), ...(gapNote ? { note: gapNote } : {}) };
  // A soak that could not be verified for want of an instrument, with no regression observed, is a pass
  // with the gap named, never a hold: a hold here waits on something no re-run can change (foreman#80).
  if (soak && r.soak === "NOT-VERIFIED" && r.gap?.class === "tooling-gap" && !REGRESSION_HOLD.test(r.reason ?? "")) {
    return { kind: "pass", ...(evidence ? { evidence } : {}), note: gapNote ?? "the SRE could not check part of it (gap: `tooling-gap`)" };
  }
  return holdVerdict(r.reason ?? "prod-verify-held", evidence, r.issues);
}

const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (sha: string | undefined) => (sha ? sha.slice(0, 10) : "unknown");

/**
 * A release's record is its release PR's record in the work source. A save resolves false when it could not be
 * made, and the caller then does not do what the save was to precede (deploy, comment, close): the next pass
 * tries again from what the record still says.
 */
async function putRelease(rt: ForemanRuntime, repoConfig: RepoConfig, rel: ProdRelease, logger: Logger): Promise<boolean> {
  const ok = await rt.releases.putRelease(repoConfig, rel);
  if (!ok) logger.warn(`Release PR #${rel.pr}: its record could not be saved (${rel.phase}); nothing further is done for it this pass`);
  return ok;
}

async function dropRelease(rt: ForemanRuntime, repoConfig: RepoConfig, pr: number, logger: Logger): Promise<boolean> {
  const ok = await rt.releases.dropRelease(repoConfig, pr);
  if (!ok) logger.warn(`Release PR #${pr}: its record could not be cleared; it is looked at again next pass`);
  return ok;
}

/**
 * A release ended healthy (its soak passed, or there was none left to run): the corrective change is live and proven.
 * Every held release that carries an issue this one corrects is due `REARM_SETTLE_MS` from now with its attempts
 * cleared, so a failed re-verify retries in minutes instead of on the back-off it had grown to (foreman#186,
 * slashbin_data_receiver#189 held 6 h past the fix of #192). Never called at a production-verification pass.
 */
async function rearmHeld(rt: ForemanRuntime, repoConfig: RepoConfig, from: ProdRelease, followUpOf: readonly number[] | undefined, logger: Logger): Promise<void> {
  if (!followUpOf?.length) return;
  const loaded = await rt.releases.loadReleases(repoConfig, logger);
  if (!loaded) return;
  for (const held of loaded.releases) {
    if (held.pr === from.pr || held.phase !== "held" || !held.issues.some((n) => followUpOf.includes(n))) continue;
    const retryAt = iso(now() + REARM_SETTLE_MS);
    // The head is recorded too, so the head-moved probe does not push the re-arm out to a soak window.
    const head = rt.memory.passHead.get(repoConfig.name);
    if (await putRelease(rt, repoConfig, { ...held, retryAt, attempts: 0, ...(head ? { verifiedHead: head } : {}) }, logger)) {
      logger.info(`Release PR #${held.pr}: its follow-up (release PR #${from.pr}) passed its soak; re-verifying at ${retryAt}`);
    }
  }
}

async function comment(repoConfig: RepoConfig, n: number, body: string, logger: Logger): Promise<void> {
  try {
    await codeHost().commentOnIssue(repoConfig, n, body);
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
  activeRuns.set(ac, repoConfig.name);
  try {
    return await fn(ac.signal);
  } finally {
    activeRuns.delete(ac);
  }
}

/** Tag the release's merge commit once; a failure is logged and retried with the release's next step. */
async function tagRelease(repoConfig: RepoConfig, rel: ProdRelease, logger: Logger): Promise<void> {
  if (rel.tag || !rel.mergeSha) return;
  try {
    const name = releaseTagName(repoConfig.github.releaseTagFormat, rel.pr, new Date(rel.mergedAt ?? now()));
    const message = [
      `Release PR #${rel.pr}${rel.url ? ` (${rel.url})` : ""} to ${repoConfig.productionBranch}`,
      "",
      "Issues:",
      ...rel.issues.map((n) => `- #${n}`),
    ].join("\n");
    const t = await codeHost().ensureReleaseTag(repoConfig, rel.mergeSha, name, message);
    rel.tag = t.tag;
    logger.info(`${t.created ? "Tagged" : "Found tag"} ${t.tag} on ${short(rel.mergeSha)} (release PR #${rel.pr})`);
  } catch (err) {
    logger.warn(`Could not tag release PR #${rel.pr} at ${short(rel.mergeSha)}: ${errText(err)}`);
  }
}

/** The release's issues a write may touch: not blocked by a person (an SRE sweep hold was already taken over). */
async function writable(repoConfig: RepoConfig, rel: ProdRelease, logger: Logger): Promise<number[]> {
  const blocked = new Set(
    (await codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger))
      .filter((i) => codeHost().hasLabel(i, repoConfig.github.blockedLabel)).map((i) => i.number),
  );
  const skip = rel.issues.filter((n) => blocked.has(n));
  if (skip.length > 0) logger.info(`Release PR #${rel.pr}: leaving ${skip.map((n) => `#${n}`).join(", ")} alone (blocked by a person)`);
  return rel.issues.filter((n) => !blocked.has(n));
}

/**
 * Hand the EM the epics a child about to close in production belongs to: those its body names, or for a
 * fix those of the issue it corrects (`relationsOf`). Recorded BEFORE the child is closed, so the hand-off is durable when the
 * close is acknowledged. A failed read of the body or a failed save throws: nothing is closed, the pass fails
 * closed, and the next healthy pass finds the child still open and raises it again.
 */
async function noteEpicClose(rt: ForemanRuntime, repoConfig: RepoConfig, n: number, logger: Logger): Promise<void> {
  // No epic label configured (`epicRefLabel`): epics are not tracked, so nothing is read or raised.
  const label = repoConfig.epicRefLabel;
  if (!label) return;
  let epics = epicRefs(await codeHost().readIssueBody(repoConfig, n), label);
  if (!epics.length) {
    // A fix belongs to the epics of the issue it corrects (its strongest link: `Relation`, src/adapters.ts).
    const origin = (await codeHost().relationsOf(repoConfig, [n], logger)).get(n)?.corrects[0];
    if (origin !== undefined) epics = epicRefs(await codeHost().readIssueBody(repoConfig, origin), label);
  }
  // An epic already closed has nothing left to be ready for. Unreadable counts as open: asking twice is cheaper than never.
  if (repoConfig.epicRepo) {
    const open: number[] = [];
    for (const e of epics) {
      if (e !== n && (await codeHost().readIssueState(repoConfig, repoConfig.epicRepo, e)) !== "closed") open.push(e);
    }
    epics = open;
  }
  if ((await rt.handoffs.raiseAll(repoConfig, epics.map((epic) => epicChildClosedAlert(repoConfig.githubRepo, n, epic, label)))) > 0) {
    logger.info(`#${n} is closing in production; asking the EM whether ${label} ${epics.map((e) => `#${e}`).join(", ")} is ready to close`);
  }
}

/**
 * Close `issues` of a release with one line of evidence, each only once its verification is recorded. False when a
 * save or a close did not land: the issue is left open and the release is verified again next pass.
 */
async function closeIssues(
  rt: ForemanRuntime, repoConfig: RepoConfig, rel: ProdRelease, issues: readonly number[], move: Move,
  evidence: string | undefined, logger: Logger, note?: string,
): Promise<boolean> {
  const line =
    `**Verified in production.** Release PR #${rel.pr} merged to \`${repoConfig.productionBranch}\` as \`${short(rel.mergeSha)}\`` +
    `${rel.tag ? `, tagged \`${rel.tag}\`` : ""}. Evidence: ${evidence ?? rel.evidence ?? "the SRE's verification on the release PR"}.` +
    `${note ? ` Passed with a noted gap: ${note}.` : ""}`;
  // Record first, then act: an issue is commented on and closed only once its verification is saved, so a failed
  // save can never leave it closed with no record. An unrecorded issue is left for the next pass of this release.
  const at = iso(now());
  const unsaved: number[] = [];
  const saved = new Set<number>();
  const notClosed: number[] = [];
  for (const n of issues) {
    const ok = await rt.records.updateIssueRecord(repoConfig, n, (d) => {
      d.prodVerified = {
        pr: rel.pr, mergeSha: rel.mergeSha ?? "", at,
        ...(rel.tag ? { tag: rel.tag } : {}), ...(evidence ? { evidence } : {}),
      };
    });
    if (ok) saved.add(n);
    else unsaved.push(n);
  }
  if (unsaved.length > 0) logger.warn(`Release PR #${rel.pr}: the production verification of ${unsaved.map((n) => `#${n}`).join(", ")} could not be recorded; nothing is closed for them, the release is verified again next pass`);
  // A closed issue was verified by an earlier pass of this release (a re-verify after a join).
  const openIssues = await codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger);
  const open = new Set(openIssues.map((i) => i.number));
  const writableNow = await writable(repoConfig, { ...rel, issues: [...issues] }, logger);
  for (const n of writableNow.filter((i) => open.has(i) && saved.has(i))) {
    await noteEpicClose(rt, repoConfig, n, logger);
    // Close first, comment once it is closed: a close that fails is retried next pass and must not repeat the comment.
    if (!(await advance(rt, itemOf(repoConfig, n), move, repoConfig, logger))) {
      notClosed.push(n);
      continue;
    }
    await comment(repoConfig, n, line, logger);
  }
  if (unsaved.length > 0) return false;
  // A close that did not land leaves the issue open and labelled `release pending`: the release stays at
  // this phase and the next pass closes it, instead of soaking with an open issue nobody owns (#220).
  if (notClosed.length > 0) {
    logger.warn(`Release PR #${rel.pr}: could not close ${notClosed.map((n) => `#${n}`).join(", ")}; the release is verified again next pass`);
    return false;
  }
  return true;
}

/** A pass: close every issue with one line of evidence, record it, and queue the soak. */
async function passRelease(rt: ForemanRuntime, repoConfig: RepoConfig, rel: ProdRelease, move: Move, evidence: string | undefined, logger: Logger, note?: string): Promise<void> {
  await tagRelease(repoConfig, rel, logger);
  // What these issues correct, read while they are open (a closed issue's title is gone): the release's healthy end
  // re-arms the held releases carrying them. An unreadable link throws: nothing is closed and the next pass retries.
  const relations = await codeHost().relationsOf(repoConfig, rel.issues, logger);
  const followUpOf = [...new Set(rel.issues.flatMap((n) => relations.get(n)?.corrects ?? []))].filter((n) => !rel.issues.includes(n));
  rel = { ...rel, ...(followUpOf.length > 0 ? { followUpOf } : {}) };
  if (!(await closeIssues(rt, repoConfig, rel, rel.issues, move, evidence, logger, note))) return;
  logger.info(`Release PR #${rel.pr} verified in production; closed ${rel.issues.map((n) => `#${n}`).join(", ")}`);
  // The issues are closed and recorded; a failed save here only repeats the (idempotent) verification next pass.
  if (rel.soaked) {
    if (await dropRelease(rt, repoConfig, rel.pr, logger)) await rearmHeld(rt, repoConfig, rel, rel.followUpOf, logger);
    return;
  }
  const mergedAt = Date.parse(rel.mergedAt ?? "") || now();
  await putRelease(rt, repoConfig, {
    ...rel, phase: "soaking", soakAt: iso(mergedAt + SOAK_DELAY_MS),
    ...(evidence ? { evidence } : {}), retryAt: undefined, hold: undefined,
  }, logger);
}

/**
 * A failing verdict, split per issue when the verifier graded each on its own rows (foreman#117): the release keeps
 * only the issues that failed (or could not be graded) and is held for them, and the issues whose rows passed are
 * closed on their own evidence (those already closed by a first prod pass stay closed). Without a usable split it is
 * `holdRelease` on the whole release. `closeMove` is null when the passing issues are already closed.
 */
async function holdFailing(
  rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, rel: ProdRelease,
  v: { hold: string; evidence?: string }, rows: IssueAcceptance[] | undefined,
  move: Move, closeMove: Move | null, logger: Logger,
): Promise<void> {
  const split = splitByIssueRows(rel.issues, v.hold, rows);
  if (!split) {
    await holdRelease(rt, repoConfig, config, rel, v, move, logger);
    return;
  }
  logger.info(`Release PR #${rel.pr}: ${split.held.length > 0 ? `held for ${split.held.map((n) => `#${n}`).join(", ")} on its own acceptance rows; ` : ""}${split.passing.map((n) => `#${n}`).join(", ")} passed`);
  if (split.held.length === 0) {
    // Every tracked issue passed its own row; the failure is another issue's, which this record does not hold.
    const note = `its own acceptance row passed; another issue's row failed (\`${v.hold}\`)`;
    if (closeMove) await passRelease(rt, repoConfig, { ...rel, issues: split.passing }, closeMove, v.evidence, logger, note);
    else await dropRelease(rt, repoConfig, rel.pr, logger);
    return;
  }
  if (!(await holdRelease(rt, repoConfig, config, { ...rel, issues: split.held }, v, move, logger))) return;
  if (!closeMove) return;
  // Every passing issue is recorded verified, an issue GitHub already closed too; closeIssues closes only the open ones.
  await closeIssues(rt, repoConfig, rel, split.passing, closeMove, v.evidence, logger, `its own acceptance rows passed; another issue's row failed (\`${v.hold}\`)`);
}

/**
 * A hold or fail: reopen each issue at `prod verification held` with the slug
 * and evidence (once per slug), and schedule the re-verify.
 */
async function holdRelease(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  rel: ProdRelease,
  v: { hold: string; evidence?: string },
  move: Move,
  logger: Logger,
): Promise<boolean> {
  await tagRelease(repoConfig, rel, logger);
  const attempts = rel.attempts + 1;
  const retryAt = iso(now() + backoffDelay(attempts, config.backoff.prodVerifyRetry));
  let verifiedHead = rt.memory.passHead.get(repoConfig.name) ?? rel.verifiedHead;
  if (!rt.memory.passHead.has(repoConfig.name)) {
    try {
      verifiedHead = await codeHost().productionHead(repoConfig);
      rt.memory.passHead.set(repoConfig.name, verifiedHead);
      rt.memory.lastHeadProbe.set(repoConfig.name, now());
    } catch (err) {
      logger.debug(`Could not read ${repoConfig.productionBranch}'s head: ${errText(err)}`);
    }
  }
  // Record the hold first, then tell the issues: the comment goes out once per slug, and "once" is read from the
  // record, so a hold whose record could not be saved says nothing and is verified and held again next pass.
  const first = rel.hold !== v.hold || rel.phase !== "held";
  const held: ProdRelease = {
    ...rel, phase: "held", attempts, retryAt, hold: v.hold,
    ...(verifiedHead ? { verifiedHead } : {}),
    ...(v.evidence ? { evidence: v.evidence } : {}),
  };
  if (!(await putRelease(rt, repoConfig, held, logger))) return false;
  if (first) {
    const body = [
      `**Production verification held: \`${v.hold}\`.** Release PR #${rel.pr} merged to \`${repoConfig.productionBranch}\` as ` +
      `\`${short(rel.mergeSha)}\`${rel.tag ? ` (tag \`${rel.tag}\`)` : ""}, but the SRE did not pass it` +
      `${v.evidence ? `: ${v.evidence}` : ""}.`,
      "",
      `This issue stays open at \`${repoConfig.lifecycleLabels.prodVerifyHeld}\`. The SRE re-verifies production after ` +
      `${formatWait(Date.parse(retryAt) - now())}, longer each time, and the Foreman closes it on a pass.`,
    ].join("\n");
    for (const n of await writable(repoConfig, rel, logger)) {
      await comment(repoConfig, n, body, logger);
      await advance(rt, itemOf(repoConfig, n), move, repoConfig, logger);
    }
  } else {
    // Same slug again: the reason lives only in the SRE's edited comment, so say it on the issues (foreman#186).
    const evidence = v.evidence?.trim().replace(/\.+$/, "");
    const body = `**Re-verified, still held: \`${v.hold}\`.** Release PR #${rel.pr}, attempt ${attempts}.` +
      `${evidence ? ` ${evidence}.` : ""} Next re-verify: ${formatWait(Date.parse(retryAt) - now())}.`;
    for (const n of await writable(repoConfig, rel, logger)) await comment(repoConfig, n, body, logger);
  }
  logger.warn(`Release PR #${rel.pr}: prod verification held (${v.hold}), attempt ${attempts}; re-verify at ${retryAt}`);
  return true;
}

/** A STOP: the issues need a person. Blocked, with the reason on each; `release pending` stays. */
/**
 * SRE deploy holds that only a person or a new commit clears. Every other unmerged hold retries
 * on the back-off; these did too, and each retry bought a Tech Lead approval and an SRE run
 * (slashbin-cli#161: 46 refused merges at one sha; slashbin-io-worker#724: 13 approvals behind
 * a red required check).
 */
export const DEPLOY_STOPS: Readonly<Record<string, string>> = {
  "predeploy-stop": "the SRE's pre-deploy check said STOP (`predeploy-stop`)",
  "merge-refused-repeatedly": "GitHub refused the SRE's merge repeatedly at this head (`merge-refused-repeatedly`)",
  "merge-blocked-check": "a required check is red at this head, after one re-run (`merge-blocked-check`)",
};

/** The longest a time hold is waited for before the release is asked about again: a far `eligible_at` is re-checked daily. */
export const MAX_TIME_HOLD_MS = 24 * 3_600_000;

/**
 * What an unmerged deploy's hold means (agent contract v1). The deployer's own
 * `holdClass` decides when it sent one: `person` stops the release, `time`
 * waits until `eligibleAt` (capped at a day), `transient` takes the back-off.
 * A legacy trailer carries no class, so the Foreman's `DEPLOY_STOPS` list
 * decides as before. Pure, exported for tests.
 */
export function deployHoldPlan(
  t: Pick<DeployTrailer, "hold" | "holdClass" | "holdReason">,
  nowMs: number,
): { kind: "stop"; reason: string } | { kind: "wait"; untilMs: number } | { kind: "backoff" } {
  const hold = t.hold ?? "";
  const cls = t.holdClass ?? (DEPLOY_STOPS[hold] ? "person" : undefined);
  if (cls === "person") {
    return { kind: "stop", reason: DEPLOY_STOPS[hold] ?? `the deployer held it (\`${hold || "no slug"}\`)${t.holdReason ? `: ${t.holdReason}` : ""}` };
  }
  // A named time (`wait-until-…`, legacy or v1) clears by itself: wait for it.
  const at = parseWaitUntil(hold);
  if (at !== null && cls !== "transient") return { kind: "wait", untilMs: Math.min(Math.max(at, nowMs), nowMs + MAX_TIME_HOLD_MS) };
  return { kind: "backoff" };
}

async function stopRelease(rt: ForemanRuntime, repoConfig: RepoConfig, pr: number | null, issues: number[], reason: string, evidence: string | undefined, logger: Logger): Promise<void> {
  const body =
    `${codeHost().RELEASE_STOP_MARK} ${pr ? `Release PR #${pr}: ` : ""}${reason}${evidence ? ` (${evidence})` : ""}. ` +
    `The Foreman will not retry it while this issue carries \`${repoConfig.github.blockedLabel}\`; remove the label to release it again.`;
  for (const n of issues) {
    try {
      await codeHost().addBlockedLabel(repoConfig, n);
    } catch (err) {
      logger.warn(`Could not block #${n}: ${errText(err)}`);
    }
    await comment(repoConfig, n, body, logger);
    await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: `release stopped: ${reason}` }, repoConfig, logger);
  }
  logger.warn(`${pr ? `Release PR #${pr}` : "Release"} stopped (${reason}); blocked ${issues.map((n) => `#${n}`).join(", ")}`);
}

/**
 * Take over the SRE sweep's interim holds: an open issue labelled `blocked`
 * whose latest sweep comment names a merged release. The `blocked` goes, the
 * issue moves to `prod verification held`, and the release is re-verified
 * here. Each issue is checked once per process (one comments read).
 */
async function adoptSweepHolds(rt: ForemanRuntime, repoConfig: RepoConfig, logger: Logger): Promise<void> {
  const blockedAll = (await codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger))
    .filter((i) => codeHost().hasLabel(i, repoConfig.github.blockedLabel));
  // An issue whose record cannot be read is not touched (and not marked checked): looked at again next scan.
  const eligible = new Set((await rt.records.actionableIssues(repoConfig, blockedAll.map((i) => i.number))).ok);
  const blocked = blockedAll.filter((i) => eligible.has(i.number));
  for (const issue of blocked) {
    const key = `${repoConfig.githubRepo}#issue${issue.number}`;
    if (rt.memory.adoptChecked.has(key)) continue;
    rt.memory.adoptChecked.add(key);
    let hold: { pr: number; url: string } | null;
    let pr: ReleasePrView;
    try {
      hold = await codeHost().findSreSweepHold(repoConfig, issue.number);
      if (!hold) continue;
      pr = await codeHost().viewReleasePr(repoConfig, hold.pr);
    } catch (err) {
      rt.memory.adoptChecked.delete(key);
      logger.debug(`Could not check #${issue.number} for an SRE sweep hold: ${errText(err)}`);
      continue;
    }
    if (pr.state !== "MERGED") {
      logger.info(`#${issue.number}: SRE sweep hold names release PR #${hold.pr}, which is not merged; left for a person`);
      continue;
    }
    // The release's record is read before anything changes: one that cannot be read may already be carrying
    // this issue, so the hold is left alone and looked at again next scan.
    const record = await rt.records.loadPrRecord(repoConfig, hold.pr);
    if (!record) {
      rt.memory.adoptChecked.delete(key);
      logger.debug(`#${issue.number}: release PR #${hold.pr}'s record cannot be read; the SRE sweep hold is left alone this scan`);
      continue;
    }
    const t = iso(now());
    const prior = record.release;
    const rel: ProdRelease = prior
      ? { ...prior, issues: prior.issues.includes(issue.number) ? prior.issues : [...prior.issues, issue.number] }
      : {
        pr: pr.number, url: pr.url, headSha: pr.headSha, issues: [issue.number], phase: "held",
        ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}), mergedAt: pr.mergedAt ?? t,
        attempts: 1, retryAt: t, hold: "sre-sweep-hold", since: t, adopted: true,
      };
    if (rel.phase === "soaking") { rel.phase = "held"; rel.retryAt = t; rel.hold = "sre-sweep-hold"; }
    // Recorded before the hold is taken over: the SRE's label goes only once the Foreman holds the release.
    if (!(await putRelease(rt, repoConfig, rel, logger))) { rt.memory.adoptChecked.delete(key); continue; }
    try {
      await codeHost().removeBlockedLabel(repoConfig, issue.number);
    } catch (err) {
      rt.memory.adoptChecked.delete(key);
      logger.warn(`Could not take over the SRE sweep hold on #${issue.number}: ${errText(err)}`);
      continue;
    }
    await advance(rt, itemOf(repoConfig, issue.number), "prodHeld", repoConfig, logger);
    await comment(repoConfig, issue.number,
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
async function adoptMergedReleases(rt: ForemanRuntime, repoConfig: RepoConfig, releases: readonly ProdRelease[], logger: Logger): Promise<void> {
  const tracked = new Set(releases.flatMap((r) => r.issues));
  const carrying = new Set(releases.map((r) => r.pr));
  let prs: ReleasePrView[];
  try {
    prs = await codeHost().recentMergedReleasePrs(repoConfig, iso(now() - ADOPT_WINDOW_MS));
  } catch (err) {
    logger.debug(`Could not list merged release PRs: ${errText(err)}`);
    return;
  }
  for (const pr of [...prs].reverse()) {
    const key = `${repoConfig.githubRepo}#pr${pr.number}`;
    if (carrying.has(pr.number) || rt.memory.adoptChecked.has(key)) continue;
    // A release the Foreman is already carrying is not adopted over; one whose record cannot be read may be.
    const record = await rt.records.loadPrRecord(repoConfig, pr.number);
    if (!record) { logger.debug(`Release PR #${pr.number}: its record cannot be read; not adopted this scan`); continue; }
    if (record.release) { rt.releases.noteLiveRelease(repoConfig.githubRepo, pr.number); continue; }
    const candidates = releaseIssues(pr.body).filter((n) => n !== pr.number && !tracked.has(n));
    // An issue whose record cannot be read may already be verified: not adopted this pass, looked at again the next.
    const recorded = await rt.records.loadIssueRecords(repoConfig, candidates);
    const verified = fieldTable(recorded, "prodVerified");
    const noop = fieldTable(recorded, "noopClosed");
    const named = candidates.filter((n) => !recorded.unavailable.has(n) && !((verified[n]?.pr ?? 0) >= pr.number));
    if (named.length === 0) continue;
    // Only issues the Foreman's lifecycle owns (they carry the trigger label):
    // a `#N` in the body can be a PR or a passing mention.
    const issues: number[] = [];
    try {
      for (const n of named) {
        const v = await codeHost().viewIssue(repoConfig, n);
        // A closed issue already verified in production was delivered, whichever release verified it (foreman#86).
        if (v?.state === "CLOSED" && (verified[n] || noop[n])) continue;
        // A net-zero issue whose merge is not on production was closed with its own outcome: no release carries it.
        if (noop[n]) continue;
        if (v?.labels.includes(repoConfig.triggerLabel)) issues.push(n);
      }
    } catch (err) {
      logger.debug(`Could not read release PR #${pr.number}'s issues: ${errText(err)}`);
      continue;
    }
    if (issues.length === 0) {
      rt.memory.adoptChecked.add(key);
      logger.debug(`Release PR #${pr.number} names no issue in the lifecycle; not adopted`);
      continue;
    }
    const t = iso(now());
    if (!(await putRelease(rt, repoConfig, {
      pr: pr.number, url: pr.url, headSha: pr.headSha, issues, phase: "merged",
      ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}), mergedAt: pr.mergedAt ?? t,
      attempts: 0, since: t, adopted: true,
    }, logger))) continue;
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
/** The terminal outcome of a net-zero issue whose merge is not on production: closed with a note, never graded by a release. */
async function closeNetZero(rt: ForemanRuntime, repoConfig: RepoConfig, n: number, w: { pr: number; url: string }, move: Move, logger: Logger): Promise<boolean> {
  // Recorded first: a release that names the issue is never again allowed to adopt it, grade it or record it verified.
  if (!(await rt.records.updateIssueRecord(repoConfig, n, (d) => { d.noopClosed = { pr: w.pr, at: iso(now()) }; }))) return false;
  if (!(await advance(rt, itemOf(repoConfig, n), move, repoConfig, logger))) return false;  // retried next scan
  await comment(repoConfig, n,
    `**Closed: nothing to verify in production.** This issue's PR #${w.pr} (${w.url}) merged to \`${repoConfig.baseBranch}\` with an empty net diff, ` +
    `so no change shipped and no release carries it. It was not joined to a release: a release's verdict is about the changes it shipped, ` +
    "and none of them are this issue's. Reopen it if there is work left.", logger);
  logger.info(`Closed #${n}: its PR #${w.pr} is net-zero and not on ${repoConfig.productionBranch}; nothing to verify`);
  return true;
}

/**
 * An issue joined to a held release before it was known to be net-zero (foreman#117): it stops being carried. It is
 * closed with the no-op note and leaves the release's record; the release stays held for the issues that remain.
 */
async function closeHeldNetZero(rt: ForemanRuntime, repoConfig: RepoConfig, releases: readonly ProdRelease[], logger: Logger): Promise<void> {
  const held = releases.filter((r) => r.phase === "held" && r.issues.length > 0);
  if (held.length === 0) return;
  const open = new Set((await codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)).map((i) => i.number));
  for (const rel of held) {
    const candidates = rel.issues.filter((n) => open.has(n));
    if (candidates.length === 0) continue;
    let noop: Map<number, { pr: number; url: string }>;
    try {
      noop = await codeHost().netZeroOffProduction(repoConfig, candidates, logger);
    } catch (err) {
      logger.warn(`Release PR #${rel.pr}: could not tell whether ${candidates.map((n) => `#${n}`).join(", ")} changed anything; left alone this scan: ${errText(err)}`);
      continue;
    }
    const closed: number[] = [];
    for (const [n, w] of noop) if (await closeNetZero(rt, repoConfig, n, w, "prodReverified", logger)) closed.push(n);
    if (closed.length === 0) continue;
    const rest = rel.issues.filter((n) => !closed.includes(n));
    if (rest.length === 0) await dropRelease(rt, repoConfig, rel.pr, logger);
    else await putRelease(rt, repoConfig, { ...rel, issues: rest }, logger);
  }
}

async function blockOrphans(rt: ForemanRuntime, repoConfig: RepoConfig, releases: readonly ProdRelease[], logger: Logger): Promise<void> {
  await closeHeldNetZero(rt, repoConfig, releases, logger);
  const { releasePending } = repoConfig.lifecycleLabels;
  const tracked = new Set(releases.flatMap((r) => r.issues));
  const orphans = (await codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger))
    .filter((i) => codeHost().hasLabel(i, releasePending) && !codeHost().hasLabel(i, repoConfig.github.blockedLabel) && !tracked.has(i.number))
    .map((i) => i.number);
  if (orphans.length === 0) return;
  if (await codeHost().findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger)) return;
  const diff = await codeHost().countBranchDiffFiles(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger);
  if (diff !== 0) return;  // promote opens a release PR for them next pass
  // Joined, commented on or blocked only if the record can be read; the rest wait for a later scan.
  const { ok } = await rt.records.actionableIssues(repoConfig, orphans);
  if (ok.length < orphans.length) logger.info(`Release orphans: ${orphans.length - ok.length} issue(s) with an unreadable record left alone this scan`);
  if (ok.length === 0) return;
  // A net-zero issue whose merge is not on production shipped nothing: no release carries it, and joining it to one
  // would hand it a verdict that is not its own (foreman#117). It ends here, closed with a note saying so.
  let noop: Map<number, { pr: number; url: string }>;
  try {
    noop = await codeHost().netZeroOffProduction(repoConfig, ok, logger);
  } catch (err) {
    logger.warn(`Release orphans: could not tell whether ${ok.map((n) => `#${n}`).join(", ")} changed anything; left alone this scan: ${errText(err)}`);
    return;
  }
  for (const [n, w] of noop) await closeNetZero(rt, repoConfig, n, w, "prodVerified", logger);
  const carried = ok.filter((n) => !noop.has(n));
  if (carried.length === 0) return;
  const joined = await joinCarryingRelease(rt, repoConfig, releases, carried, logger);
  // Unreadable is not "no release carries them": they are not blocked on a record that could not be read.
  if (joined !== false) return;
  await stopRelease(rt, repoConfig, null, carried,
    `no release carries this issue: its work is already on \`${repoConfig.productionBranch}\`, but no release PR merged in the last ` +
    "48 hours lists it, so there is no release to verify it by. Check production by hand and close it, or move it back to " +
    `\`${repoConfig.lifecycleLabels.readyForProd}\` once a release can carry it`, undefined, logger);
}

/**
 * Open issues the lifecycle lost, found from GitHub every scan and not from the labels (#220).
 *
 * `passRelease` used to strip an issue's lifecycle labels before closing it; a close that failed left it open,
 * unlabelled and carried by nothing (jerky_shipping #618 and #620, 2026-10-10), and no later pass looked at an
 * issue with no label. Closing first (`closeReleased`) stops new ones; this recovers the ones already there, and
 * any that never carried a label (#396, #680). An open issue with no lifecycle or blocked label that no release
 * carries (it may still carry the trigger label: closing strips only lifecycle labels) is one of two things:
 *   - its record holds a passed production verification: it was verified, the close did not land. It is closed
 *     now with that evidence;
 *   - its work merged to the base branch (a PR that says it closes it) and nothing records it verified: it is not
 *     closed, one comment asks the EM for the sign-off that lets the release stage carry and verify it.
 * Anything else is an ordinary unapproved issue and is left alone. An issue is never closed without a recorded
 * production verification, and never one reopened after it (a person reopening it is the signal it is being worked
 * again). Delivery evidence is a merged PR that closes it or a Foreman skip record (a no-code delivery); with neither
 * the issue is looked at again in an hour, never settled on a miss. A request is made once (marked, so across
 * restarts too), at most STRANDED_SCAN_CAP are read per scan, and one whose record or events cannot be read waits.
 */
async function sweepStranded(rt: ForemanRuntime, repoConfig: RepoConfig, releases: readonly ProdRelease[], logger: Logger): Promise<void> {
  const tracked = new Set(releases.flatMap((r) => r.issues));
  const skip = [...Object.values(repoConfig.lifecycleLabels), repoConfig.github.blockedLabel];
  const key = (n: number) => `${repoConfig.githubRepo}#${n}`;
  const settle = (n: number) => rt.memory.strandedChecked.set(key(n), Infinity);
  const later = (n: number) => rt.memory.strandedChecked.set(key(n), now() + STRANDED_RECHECK_MS);
  const open = await codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger);
  const candidates = open
    .filter((i) => !skip.some((l) => codeHost().hasLabel(i, l)) && !tracked.has(i.number) && (rt.memory.strandedChecked.get(key(i.number)) ?? 0) <= now())
    .slice(0, STRANDED_SCAN_CAP);
  if (candidates.length === 0) return;
  const { records, unavailable } = await rt.records.loadIssueRecords(repoConfig, candidates.map((i) => i.number));
  const unrecorded: number[] = [];
  for (const i of candidates) {
    if (unavailable.has(i.number)) continue;
    const verified = records.get(i.number)?.prodVerified;
    if (!verified) { unrecorded.push(i.number); continue; }
    // Closing keeps the trigger label, so a person reopening the issue after its verification is the signal that it is being worked again.
    let reopened: boolean;
    try {
      reopened = await codeHost().reopenedSince(repoConfig, i.number, verified.at ?? "");
    } catch (err) {
      logger.debug(`Could not read #${i.number}'s events: ${errText(err)}`);
      continue;
    }
    if (reopened) { settle(i.number); continue; }
    if (!(await advance(rt, itemOf(repoConfig, i.number), "prodVerified", repoConfig, logger))) continue;  // retried next scan
    settle(i.number);
    await comment(repoConfig, i.number,
      `**Verified in production.** Release PR #${verified.pr}${verified.mergeSha ? ` (\`${short(verified.mergeSha)}\`)` : ""} passed its production verification` +
      `${verified.at ? ` at ${verified.at}` : ""}${verified.tag ? `, tagged \`${verified.tag}\`` : ""}, but this issue stayed open with no lifecycle label: ` +
      `the close did not land. Closed now on that record. Evidence: ${verified.evidence ?? "the SRE's verification on the release PR"}.`, logger);
    logger.info(`Closed #${i.number} on its recorded production verification (release PR #${verified.pr}); the release's close had not landed`);
  }
  if (unrecorded.length === 0) return;
  const merged = await codeHost().findIssuesMergedToBase(repoConfig, unrecorded, logger);
  const shipped = new Map(merged.map((m) => [m.issueNumber, m]));
  const ask = async (n: number, because: string, pr?: number): Promise<void> => {
    try {
      if (await codeHost().hasCommentContaining(repoConfig, n, STRANDED_MARK)) { settle(n); return; }
    } catch (err) {
      logger.debug(`Could not read #${n}'s comments: ${errText(err)}`);
      return;
    }
    settle(n);
    await comment(repoConfig, n,
      `${STRANDED_MARK}${pr ? ` pr=${pr}` : ""} -->\n**Open and carried by no release.** ${because} This issue has no lifecycle label and no production verification is ` +
      `recorded for it, so no release will carry it and it is not closed. **EM: needs the production sign-off record.** Apply ` +
      `\`${repoConfig.lifecycleLabels.readyForProd}\` if the work should ship: the release stage then carries it, the SRE verifies it in production, and the ` +
      "release closes it on a pass. Otherwise close it by hand.", logger);
    logger.info(`#${n} is open, unlabelled and carried by no release; asked the EM for the production sign-off`);
  };
  for (const n of unrecorded) {
    const ref = shipped.get(n);
    if (ref) { await ask(n, `Its work merged to \`${repoConfig.baseBranch}\` in PR #${ref.prNumber} (${ref.prUrl}).`, ref.prNumber); continue; }
    // No merged PR in the lookup's window is not a verdict. A Foreman skip record is a no-code delivery.
    const skipped = records.get(n)?.skipped;
    if (skipped && !skipped.waitingOn) { await ask(n, `The Foreman skipped it (${skipped.reason}) and no recent merged PR closes it, so it may have been delivered without code.`); continue; }
    later(n);
  }
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
async function joinCarryingRelease(rt: ForemanRuntime, repoConfig: RepoConfig, releases: readonly ProdRelease[], orphans: number[], logger: Logger): Promise<boolean | "unreadable"> {
  let head: string;
  try {
    head = await codeHost().productionHead(repoConfig);
  } catch (err) {
    logger.debug(`Could not read ${repoConfig.productionBranch}'s head: ${errText(err)}`);
    return false;
  }
  let rel: ProdRelease | undefined = releases.find((r) => r.mergeSha === head && r.phase !== "deploying");
  // The head release already settled and left the state, and the orphan shipped
  // unlisted inside an earlier one (Slashbin-console #1297, 2026-10-16: on `main`
  // via #1302, which named only #1285, and #1312 settled at the head before it
  // was ready). Production's head carries everything on it, so track the head
  // release again for these issues alone; its issues already closed stay closed.
  const shippedUnlisted = !rel;
  if (!rel) {
    try {
      const pr = (await codeHost().recentMergedReleasePrs(repoConfig, iso(now() - ADOPT_WINDOW_MS))).find((p) => p.mergeSha === head);
      if (pr) {
        // A record that cannot be read may already be carrying this release: neither joined nor blocked this scan.
        const record = await rt.records.loadPrRecord(repoConfig, pr.number);
        if (!record) return "unreadable";
        if (record.release) { rt.releases.noteLiveRelease(repoConfig.githubRepo, pr.number); return false; }
        const t = iso(now());
        rel = { pr: pr.number, url: pr.url, headSha: pr.headSha, issues: [], phase: "merged", mergeSha: head,
          mergedAt: pr.mergedAt ?? t, attempts: 0, since: t };
      }
    } catch (err) {
      logger.debug(`Could not list merged release PRs: ${errText(err)}`);
    }
  }
  if (!rel) return false;
  const titles = new Map((await codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)).map((i) => [i.number, i.title]));
  try {
    const pr = await codeHost().viewReleasePr(repoConfig, rel.pr);
    const named = new Set(releaseIssues(pr.body));
    const missing = orphans.filter((n) => !named.has(n));
    if (missing.length) await codeHost().addReleasePrIssues(repoConfig, pr, missing.map((n) => ({ number: n, title: titles.get(n) ?? `#${n}` })));
  } catch (err) {
    logger.warn(`Could not add ${orphans.map((n) => `#${n}`).join(", ")} to release PR #${rel.pr}: ${errText(err)}`);
    return false;
  }
  const issues = [...rel.issues, ...orphans.filter((n) => !rel.issues.includes(n))];
  const reverify = rel.phase === "soaking";
  if (!(await putRelease(rt, repoConfig, reverify
    ? { ...rel, issues, phase: "merged", attempts: 0, adopted: false, retryAt: undefined, soakAt: undefined, hold: undefined }
    : { ...rel, issues }, logger))) return "unreadable";
  for (const n of orphans) {
    if (rel.phase === "held") await advance(rt, itemOf(repoConfig, n), "prodHeld", repoConfig, logger);
    await comment(repoConfig, n,
      `**Joined release PR #${rel.pr}.** This issue's work ${shippedUnlisted
        ? `reached production in a release that did not name it; release PR #${rel.pr} is at production's head (\`${short(head)}\`), so it carries this work`
        : `shipped in that release (\`${repoConfig.productionBranch}\` is at its merge, \`${short(head)}\`), which was opened before this issue was ready for production`}. ` +
      "The release now names it, so its " +
      `${reverify ? "re-run " : ""}production verification grades this issue and closes it on a pass.`, logger);
  }
  logger.info(`Joined ${orphans.map((n) => `#${n}`).join(", ")} to release PR #${rel.pr} (production head ${short(head)})`);
  return true;
}

/** The verdict for a merged release: the SRE's posted Production Verification if there is one, else a fresh run. */
async function mergedVerdict(rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, rel: ProdRelease, logger: Logger, cycleNumber: number): Promise<Verdict> {
  if (rel.adopted && rel.attempts === 0) {
    try {
      const pv = await codeHost().findPvComment(repoConfig, rel.pr);
      const read = pv ? codeHost().readPvResult(pv.body) : null;
      if (pv && read) {
        logger.info(`Release PR #${rel.pr}: reading its existing Production Verification (${pv.url})`);
        return read.pass ? { kind: "pass", evidence: pv.url } : holdVerdict(read.hold, pv.url, read.rows);
      }
    } catch (err) {
      logger.debug(`Could not read release PR #${rel.pr}'s Production Verification: ${errText(err)}`);
    }
  }
  const path = transcript(repoConfig, `verify-pr${rel.pr}`, cycleNumber);
  logger.info(`Release PR #${rel.pr}: SRE prod verification, transcript: ${path}`);
  const r = await asRun(repoConfig, (signal) => verifyProd(repoConfig, config, rel.pr, logger, signal, path, "prod"));
  if (r.kind === "nothing") return { kind: "defer", reason: r.reason };
  return await fromVerifyResult(rt, r, repoConfig, rel.pr, logger);
}

/** `2026-12-01T06:00:00.000Z` as `2026-12-01 06:00 UTC`. */
const utcMinute = (isoTime: string): string => `${isoTime.slice(0, 10)} ${isoTime.slice(11, 16)} UTC`;

/** A hold slug or the class word is not a reason: only prose the SRE wrote is. */
const SLUG_PREFIX = /^wait-until(-\d{8}T\d{4}Z)?(: |$)/;
const statedReason = (reason: string | undefined, hold: string): string | undefined => {
  const r = reason?.trim().replace(/\.+$/, "").replace(SLUG_PREFIX, "").trim();
  return r && r !== hold ? r : undefined;
};

/**
 * The SRE named the time the rest of the production check becomes observable: record it, then announce it.
 * It never changes when or whether the release closes.
 */
async function settleWait(
  rt: ForemanRuntime, repoConfig: RepoConfig, rel: ProdRelease, v: Extract<Verdict, { kind: "wait" }>, logger: Logger,
): Promise<void> {
  const next: ProdRelease = { ...rel, retryAt: v.retryAt };
  if (await putRelease(rt, repoConfig, next, logger)) await announceWait(rt, repoConfig, next, v, logger);
}

/**
 * Say once per `retryAt`, on each of the release's issues (comment and card note), that it is live, verified and
 * needs nobody: without it the card sits unchanged for the whole wait. The issues are read before the marker is
 * saved, so a failed read says nothing and is tried again; a save that fails likewise.
 */
async function announceWait(
  rt: ForemanRuntime, repoConfig: RepoConfig, rel: ProdRelease, v: Extract<Verdict, { kind: "wait" }>, logger: Logger,
): Promise<void> {
  if (rel.waitNoted === v.retryAt) return;
  const issues = await writable(repoConfig, rel, logger);
  if (!(await putRelease(rt, repoConfig, { ...rel, waitNoted: v.retryAt }, logger))) return;
  const at = utcMinute(v.retryAt);
  const stated = statedReason(v.reason, v.hold);
  const why = stated ?? `the part of the SRE's production check that cannot be observed before then${v.evidence ? ` (${v.evidence})` : ""}`;
  const body = [
    `**Live in production; waiting until ${at}.** Release PR #${rel.pr} merged to \`${repoConfig.productionBranch}\` as ` +
    `\`${short(rel.mergeSha)}\`${rel.tag ? ` (tag \`${rel.tag}\`)` : ""} and the SRE verified the deploy.`,
    "",
    `The Foreman is waiting until ${at} for ${why}. Nothing is needed from anyone: it re-verifies then and closes this ` +
    `issue on a pass.${stated && v.evidence ? ` Evidence: ${v.evidence}` : ""}`,
  ].join("\n");
  for (const n of issues) {
    await comment(repoConfig, n, body, logger);
    await emit(rt, {
      kind: "release",
      release: { repo: repoConfig.githubRepo, state: "waiting", pr: rel.pr, ...(rel.url ? { url: rel.url } : {}), issues: [itemOf(repoConfig, n)], productionBranch: repoConfig.productionBranch, owned: true, waitUntil: at, waitReason: why },
    }, repoConfig, logger);
  }
}

/** Act on a verdict for a release that has merged (first verification, or a held re-verify). */
async function settle(rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, rel: ProdRelease, v: Verdict, logger: Logger): Promise<void> {
  const key = `${repoConfig.githubRepo}#${rel.pr}`;
  // The gate: nothing settles (pass, hold, wait, defer, prodReverified) while an unrelated-error report for this PR is unsaved.
  await rt.handoffs.settleHandoffs(repoConfig, handoffSubject(repoConfig.githubRepo, rel.pr));
  switch (v.kind) {
    case "pass":
      rt.memory.releaseBackoff.clear(key);
      await passRelease(rt, repoConfig, rel, rel.phase === "held" ? "prodReverified" : "prodVerified", v.evidence, logger, v.note);
      return;
    case "hold":
      rt.memory.releaseBackoff.clear(key);
      await holdFailing(rt, repoConfig, config, rel, v, v.rows, "prodHeld", rel.phase === "held" ? "prodReverified" : "prodVerified", logger);
      return;
    case "wait":
      logger.info(`Release PR #${rel.pr}: the SRE can verify the rest after ${v.retryAt} (${v.hold})`);
      await settleWait(rt, repoConfig, rel, v, logger);
      return;
    case "defer": {
      const ms = rt.memory.releaseBackoff.start(key, config.backoff.releaseRetry);
      logger.warn(`Release PR #${rel.pr}: prod verification did not run (${v.reason}); retry in ${formatWait(ms)}`);
      return;
    }
  }
}

/** Whether a release is held by its soak, not by its production verification: its re-verify is a soak. */
const soakHeld = (rel: ProdRelease): boolean => rel.phase === "held" && (rel.soaked === true || (rel.hold ?? "").startsWith("soak:"));

/**
 * Act on a soak's result. `held` is a release already held by its soak, re-soaked: the issues were reopened,
 * so a pass (or "nothing left to soak") closes them through passRelease, which drops the release because it
 * is soaked. A first soak's pass just drops it: its issues closed at the production verification.
 */
async function settleSoak(
  rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, rel: ProdRelease,
  r: VerifyResult | { kind: "nothing"; reason: string }, logger: Logger, held: boolean,
): Promise<void> {
  const key = `${repoConfig.githubRepo}#${rel.pr}`;
  // The gate: neither a clean soak nor "no soak to run" drops the release while a report for this PR is unsaved. This
  // result's own reports are buffered BEFORE the drain, so a new error B survives a drain still failing on an earlier A.
  await rt.handoffs.settleHandoffs(repoConfig, handoffSubject(repoConfig.githubRepo, rel.pr),
    r.kind !== "error" && r.kind !== "nothing" && r.unrelated ? { seen: r.unrelated, seenOn: `${repoConfig.githubRepo} PR #${rel.pr} (prod)` } : undefined);
  if (r.kind === "nothing") {
    logger.info(`Release PR #${rel.pr}: no soak to run (${r.reason}); done`);
    if (held) {
      rt.memory.releaseBackoff.clear(key);
      await passRelease(rt, repoConfig, { ...rel, soaked: true }, "prodReverified", undefined, logger, `no soak was left to run (${r.reason})`);
      return;
    }
    if (await dropRelease(rt, repoConfig, rel.pr, logger)) await rearmHeld(rt, repoConfig, rel, rel.followUpOf, logger);
    return;
  }
  const v = await fromVerifyResult(rt, r, repoConfig, rel.pr, logger, true);
  switch (v.kind) {
    case "pass":
      logger.info(`Release PR #${rel.pr}: soak passed; done`);
      rt.memory.releaseBackoff.clear(key);
      if (held) await passRelease(rt, repoConfig, { ...rel, soaked: true }, "prodReverified", v.evidence, logger, v.note);
      else {
        // The issues closed at the production verification, so the gap goes in a comment of its own before the drop.
        if (v.note) {
          const body = `**Soak passed with a noted gap.** Release PR #${rel.pr}: ${v.note}. No regression was observed.`;
          for (const n of await writable(repoConfig, rel, logger)) await comment(repoConfig, n, body, logger);
        }
        if (await dropRelease(rt, repoConfig, rel.pr, logger)) await rearmHeld(rt, repoConfig, rel, rel.followUpOf, logger);
      }
      return;
    case "wait":
      await putRelease(rt, repoConfig, held ? { ...rel, retryAt: v.retryAt } : { ...rel, soakAt: v.retryAt }, logger);
      return;
    case "defer": {
      const ms = rt.memory.releaseBackoff.start(key, config.backoff.releaseRetry);
      logger.warn(`Release PR #${rel.pr}: soak did not run (${v.reason}); retry in ${formatWait(ms)}`);
      return;
    }
    case "hold": {
      rt.memory.releaseBackoff.clear(key);
      const hold = { hold: `soak:${v.hold}`, ...(v.evidence ? { evidence: v.evidence } : {}) };
      if (held) {
        // Still held by its soak: keep the attempt count, so the re-verify backs off. An issue whose own rows
        // passed was reopened with the rest: it closes now.
        await holdFailing(rt, repoConfig, config, { ...rel, soaked: true }, hold, v.rows, "soakHeld", "prodReverified", logger);
        return;
      }
      // The issues whose own rows passed stay closed with their verification; the rest are reopened and held.
      const split = splitByIssueRows(rel.issues, v.hold, v.rows);
      for (const n of split?.held ?? rel.issues) await rt.records.updateIssueRecord(repoConfig, n, (d) => { delete d.prodVerified; });
      await holdFailing(rt, repoConfig, config, { ...rel, soaked: true, attempts: 0, phase: "soaking", hold: undefined }, hold, v.rows, "soakHeld", null, logger);
      return;
    }
  }
}

/** The 30-minute soak, once per release. */
async function soak(rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, rel: ProdRelease, logger: Logger, cycleNumber: number): Promise<void> {
  const path = transcript(repoConfig, `soak-pr${rel.pr}`, cycleNumber);
  logger.info(`Release PR #${rel.pr}: SRE 30-minute soak, transcript: ${path}`);
  const r = await asRun(repoConfig, (signal) => verifyProd(repoConfig, config, rel.pr, logger, signal, path, "soak"));
  await settleSoak(rt, repoConfig, config, rel, r, logger, false);
}

/**
 * Deploy the open release PR: Tech Lead approval at its head, then the SRE's
 * deploy. Returns false when there is nothing to deploy this pass.
 */
async function deploy(rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, logger: Logger, cycleNumber: number): Promise<boolean> {
  const open = await codeHost().findOpenPromotionPR(repoConfig.githubRepo, repoConfig.productionBranch, repoConfig.baseBranch, repoConfig.repoPath, logger);
  if (!open) return false;
  const key = `${repoConfig.githubRepo}#${open.number}`;
  // The PR's own record decides whether it may be deployed at all: one that cannot be read is not "nothing recorded",
  // and one that already holds a release is an interrupted deploy the next pass settles from the PR's state.
  const own = await rt.records.loadPrRecord(repoConfig, open.number);
  if (!own) {
    logger.info(`Release PR #${open.number}: its record cannot be read from the work source; not deploying this cycle`);
    return false;
  }
  if (own.release) {
    rt.releases.noteLiveRelease(repoConfig.githubRepo, open.number);
    logger.info(`Release PR #${open.number}: already recorded as ${own.release.phase}; not deploying again`);
    return false;
  }
  const listed = new Set(releaseIssues(open.body));
  // Before any sign-off sync, approval or deploy: the release waits while a carried issue's record cannot be read.
  const gate = await rt.records.actionableIssues(repoConfig, listed);
  if (gate.withheld.length > 0) {
    logger.info(`Release PR #${open.number}: ${gate.withheld.map((n) => `#${n}`).join(", ")} cannot be read from the record store; not deploying this cycle`);
    return false;
  }
  const issues = (await codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, logger)).filter((i) => listed.has(i.number));
  // The EM's sign-off gate (foreman#128): no Tech Lead approval and no SRE merge
  // while the release lists an issue without `ready for prod release` (or a label
  // it moves on to). Before the back-off wait, so the hold shows at once; it
  // clears itself on the pass after the last issue is signed.
  const unsigned = await codeHost().unsignedIssues(issues, listed, repoConfig.lifecycleLabels, codeHost().foremanAppliedOrHold(repoConfig, logger));
  if (unsigned.length > 0) {
    try {
      await codeHost().syncSignoff(repoConfig, open.number, (await codeHost().viewReleasePr(repoConfig, open.number)).headSha, unsigned, logger);
    } catch (err) {
      logger.warn(`Could not read release PR #${open.number}: ${errText(err)}`);
    }
    logger.info(`Release PR #${open.number}: ${unsigned.map((n) => `#${n}`).join(", ")} not signed off by the EM; not deploying`);
    return false;
  }
  if (rt.memory.releaseBackoff.waiting(key)) return false;
  const pending = issues.filter((i) => codeHost().hasLabel(i, repoConfig.lifecycleLabels.releasePending)).map((i) => i.number);
  if (pending.length === 0) return false;
  const stopped = issues.filter((i) => codeHost().hasLabel(i, repoConfig.github.blockedLabel)).map((i) => i.number);
  if (stopped.length > 0) {
    logger.debug(`Release PR #${open.number}: ${stopped.map((n) => `#${n}`).join(", ")} blocked; not deploying`);
    return false;
  }

  let pr: ReleasePrView;
  try {
    pr = await codeHost().viewReleasePr(repoConfig, open.number);
  } catch (err) {
    logger.warn(`Could not read release PR #${open.number}: ${errText(err)}`);
    return false;
  }
  if (pr.state !== "OPEN" || !/^[0-9a-f]{40}$/.test(pr.headSha)) return false;
  // The body is a snapshot: an issue that merged to the base branch after it was written is in
  // this head all the same. Read what the head carries now, then the head again: if it moved,
  // the decision was about another commit, so decide again next pass.
  const late = await codeHost().unsignedInHead(repoConfig, logger);
  if (late === null) {
    logger.warn(`Release PR #${pr.number}: could not read what ${repoConfig.baseBranch} carries; not deploying`);
    return false;
  }
  if (late.unsigned.length > 0 || late.unresolved.length > 0) {
    await codeHost().syncSignoff(repoConfig, pr.number, pr.headSha, late.unsigned, logger, late.unresolved);
    logger.info(`Release PR #${pr.number}: ${late.unsigned.map((n) => `#${n}`).join(", ")} merged but not signed off by the EM, ${late.unresolved.length} merged PR(s) unread; not deploying`);
    return false;
  }
  try {
    if ((await codeHost().viewReleasePr(repoConfig, pr.number)).headSha !== pr.headSha) return false;
  } catch (err) {
    logger.warn(`Could not re-read release PR #${pr.number}: ${errText(err)}`);
    return false;
  }
  await codeHost().syncSignoff(repoConfig, pr.number, pr.headSha, [], logger);

  const approvePath = transcript(repoConfig, `approve-pr${pr.number}`, cycleNumber);
  const approval = await asRun(repoConfig, (signal) =>
    roleFor("reviewer", config)?.approvePromotion(repoConfig, config, pr.number, pr.headSha, logger, signal, approvePath) ?? Promise.resolve({ kind: "retry" as const, reason: "no reviewer is enabled" }));
  if (approval.kind === "refused") {
    await stopRelease(rt, repoConfig, pr.number, pending, `the Tech Lead refused to approve it at \`${short(pr.headSha)}\`: ${approval.reason}`, undefined, logger);
    return true;
  }
  if (approval.kind === "retry") {
    const ms = rt.memory.releaseBackoff.start(key, config.backoff.releaseRetry);
    logger.warn(`Release PR #${pr.number}: Tech Lead approval did not complete (${approval.reason}); retry in ${formatWait(ms)}`);
    return true;
  }

  const t = iso(now());
  const rel: ProdRelease = { pr: pr.number, url: pr.url, headSha: pr.headSha, issues: pending, phase: "deploying", attempts: 0, since: t };
  // Recorded before the SRE merges anything: a deploy whose "deploying" record could not be saved does not happen,
  // so a restart can never find a merge it has no record of (and deploy it again).
  if (!(await putRelease(rt, repoConfig, rel, logger))) {
    const ms = rt.memory.releaseBackoff.start(key, config.backoff.releaseRetry);
    logger.warn(`Release PR #${pr.number}: not deploying; retry in ${formatWait(ms)}`);
    return true;
  }
  const deployPath = transcript(repoConfig, `deploy-pr${pr.number}`, cycleNumber);
  logger.info(`Release PR #${pr.number}: Tech Lead approved at ${short(pr.headSha)}; SRE deploying, transcript: ${deployPath}`);
  const r = await asRun(repoConfig, (signal) => roleFor("deployer", config)?.deploy(repoConfig, config, pr.number, pr.headSha, logger, signal, deployPath) ?? Promise.resolve({ kind: "retry" as const, reason: "no deployer is enabled" }));

  if (r.kind !== "trailer" || !r.trailer.merged) {
    // If this cannot be cleared the next pass reads the PR: still open, the "deploying" record is dropped then.
    await dropRelease(rt, repoConfig, pr.number, logger);
    const plan = r.kind === "trailer" ? deployHoldPlan(r.trailer, now()) : undefined;
    if (plan?.kind === "stop" && r.kind === "trailer") {
      await stopRelease(rt, repoConfig, pr.number, pending, plan.reason, r.trailer.evidence, logger);
      return true;
    }
    if (plan?.kind === "wait") {
      // A hold that clears by itself at a named time (#193): wait for it, no person, no count bump.
      const ms = rt.memory.releaseBackoff.waitUntil(key, plan.untilMs);
      logger.info(`Release PR #${pr.number}: SRE held it until ${new Date(plan.untilMs).toISOString()} (${r.kind === "trailer" ? r.trailer.hold : ""}); retry in ${formatWait(ms)}`);
      return true;
    }
    const why = r.kind === "trailer" ? `not merged (${r.trailer.hold ?? "no reason given"})` : r.reason;
    const ms = rt.memory.releaseBackoff.start(key, config.backoff.releaseRetry);
    logger.warn(`Release PR #${pr.number}: SRE deploy ${why}; retry in ${formatWait(ms)}`);
    return true;
  }

  rt.memory.releaseBackoff.clear(key);
  const tr = r.trailer;
  let mergeSha = tr.mergeSha;
  if (!mergeSha) {
    try { mergeSha = (await codeHost().viewReleasePr(repoConfig, pr.number)).mergeSha; } catch { /* read again next pass */ }
  }
  const merged: ProdRelease = { ...rel, phase: "merged", mergedAt: iso(now()), ...(mergeSha ? { mergeSha } : {}) };
  if (r.unrelated) await rt.handoffs.settleHandoffs(repoConfig, handoffSubject(repoConfig.githubRepo, pr.number), { seen: r.unrelated, seenOn: `${repoConfig.githubRepo} PR #${pr.number} (prod deploy)` });
  logger.info(`Release PR #${pr.number} merged by the SRE as ${short(mergeSha ?? undefined)} (verify=${tr.verify}${tr.hold ? `, hold=${tr.hold}` : ""})`);
  // The PR is merged. If "merged" cannot be recorded the "deploying" record stands: the next pass reads the PR as
  // MERGED, moves it to merged and verifies it, so the release is neither deployed again nor skipped.
  if (!(await putRelease(rt, repoConfig, merged, logger))) return true;
  await followRelease(rt, repoConfig, logger, true);
  await tagRelease(repoConfig, merged, logger);
  await putRelease(rt, repoConfig, merged, logger);
  if (tr.verify === "pass") {
    await settle(rt, repoConfig, config, merged, { kind: "pass", ...(tr.evidence ? { evidence: tr.evidence } : {}) }, logger);
  } else if (tr.verify === "hold" || tr.verify === "fail") {
    const v = holdVerdict(tr.hold ?? (tr.verify === "fail" ? "prod-verify-failed" : "prod-verify-held"), tr.evidence, tr.issues, tr.holdReason);
    // A deferred verdict leaves it `merged`: the next pass verifies it.
    if (v.kind !== "defer") await settle(rt, repoConfig, config, merged, v, logger);
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
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
): Promise<boolean> {
  // One reviewer approval and one deployer deploy (EM#578): without both the stage does not run.
  if (!roleFor("deployer", config) || !roleFor("reviewer", config)) return false;
  if (repoConfig.baseBranch === repoConfig.productionBranch) return false;
  if (isUpstreamBlocked("github")) return false;
  const rlog = logger.child({ cycle: cycleNumber, repo: repoConfig.name, phase: "release" });
  rt.memory.passHead.delete(repoConfig.name);

  // The releases the stage carries, each record read once, up front. What cannot be read (the repo's release PRs
  // unknown, or a PR whose record is unreadable) is never treated as absent: nothing below acts on it.
  const loaded = await rt.releases.loadReleases(repoConfig, rlog);
  if (!loaded) {
    rlog.info("Release PRs cannot be listed from GitHub; the release stage waits for a later cycle");
    return false;
  }

  let releases = loaded.releases;
  if (now() - (rt.memory.lastAdoptScan.get(repoConfig.name) ?? 0) >= ADOPT_SCAN_MS) {
    rt.memory.lastAdoptScan.set(repoConfig.name, now());
    await adoptSweepHolds(rt, repoConfig, rlog);
    // Adopting changes the set of releases: the one reload this pass makes, on a scan pass only.
    await adoptMergedReleases(rt, repoConfig, releases, rlog);
    const reloaded = await rt.releases.loadReleases(repoConfig, rlog);
    releases = reloaded?.releases ?? releases;
    // Who carries an issue is unknown while a release PR's record cannot be read (it may be the one): no issue is
    // joined to another release or blocked as an orphan until every record reads, and nothing needs unblocking after.
    if (!reloaded) rlog.info("Release orphans: the release PRs cannot be listed; no issue is joined or blocked this scan");
    else if (reloaded.unreadable.size > 0) rlog.info(`Release orphans: release PR(s) ${[...reloaded.unreadable].map((n) => `#${n}`).join(", ")} cannot be read from the work source; no issue is joined or blocked this scan`);
    else {
      await blockOrphans(rt, repoConfig, releases, rlog);
      await sweepStranded(rt, repoConfig, releases, rlog);
    }
    releases = (await rt.releases.loadReleases(repoConfig, rlog))?.releases ?? releases;
  }

  const t = now();
  const due = (at: string | undefined) => !at || t >= Date.parse(at);
  /** The pass's view of the releases follows each record it saves, so nothing is read twice. */
  // Keyed by PR so each update is constant time (R updates cost O(R), not O(R^2)); `view()` orders it once per read.
  const byPr = new Map<number, ProdRelease>(releases.map((r) => [r.pr, r]));
  const follow = (next: ProdRelease | number): void => {
    if (typeof next === "number") byPr.delete(next);
    else byPr.set(next.pr, next);
  };
  const view = (): ProdRelease[] => [...byPr.values()].sort((a, b) => a.pr - b.pr);

  for (const rel of [...releases]) {
    if (rel.phase !== "deploying") continue;
    // The Foreman stopped mid-deploy: read where the PR ended up.
    try {
      const pr = await codeHost().viewReleasePr(repoConfig, rel.pr);
      if (pr.state === "MERGED") {
        const next: ProdRelease = { ...rel, phase: "merged", mergedAt: pr.mergedAt ?? iso(t), ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}) };
        if (await putRelease(rt, repoConfig, next, rlog)) {
          follow(next);
          rlog.info(`Release PR #${rel.pr} merged while its deploy was in flight; verifying it`);
        }
      } else if (await dropRelease(rt, repoConfig, rel.pr, rlog)) {
        follow(rel.pr);
        rlog.info(`Release PR #${rel.pr} did not merge during its interrupted deploy; it will be deployed again`);
      }
    } catch (err) {
      rlog.debug(`Could not read release PR #${rel.pr}: ${errText(err)}`);
    }
  }

  // A held release waits out its back-off, but a new production head (the blocker's fix
  // shipping in another release) makes it due one soak window later (the deploy may not have settled yet, and an early
  // re-verify burns the back-off: foreman#186), once per head (#1477, 2026-10-29: held
  // 5 h 20 m past a fix that landed). Reuses `productionHead`, read at most once a minute.
  const waiting = view().filter((r) => r.phase === "held" && !due(r.retryAt));
  if (waiting.length > 0 && t - (rt.memory.lastHeadProbe.get(repoConfig.name) ?? 0) >= HEAD_PROBE_MS) {
    rt.memory.lastHeadProbe.set(repoConfig.name, t);
    try {
      const head = await codeHost().productionHead(repoConfig);
      rt.memory.passHead.set(repoConfig.name, head);
      const moved = waiting.filter((r) => r.verifiedHead !== head);
      for (const rel of moved) {
        // A hold recorded before heads were stored has no head to compare: verify it once now.
        const ok = await rt.records.updatePrRecord(repoConfig, rel.pr, (d) => {
          if (!d.release) return;
          d.release = { ...d.release, verifiedHead: head, retryAt: iso(t + SOAK_DELAY_MS), attempts: 0 };
        });
        if (ok) {
          follow({ ...rel, verifiedHead: head, retryAt: iso(t + SOAK_DELAY_MS), attempts: 0 });
          rlog.info(`Release PR #${rel.pr}: ${repoConfig.productionBranch} ${rel.verifiedHead ? "moved" : "head unrecorded"} at ${short(head)} since its last prod verification; re-verifying in ${formatWait(SOAK_DELAY_MS)}`);
        }
      }
    } catch (err) {
      rlog.debug(`Could not read ${repoConfig.productionBranch}'s head: ${errText(err)}`);
    }
  }

  const current = view();
  // A tracked release acts on its issues (verifies, comments, closes, records): it waits while any of them is unreadable.
  const gate = await rt.records.actionableIssues(repoConfig, current.flatMap((r) => r.issues));
  const said = new Set<number>();
  const ready = (rel: ProdRelease) => {
    if (rt.memory.releaseBackoff.waiting(`${repoConfig.githubRepo}#${rel.pr}`)) return false;
    const blocked = rel.issues.filter((n) => gate.loaded.unavailable.has(n));
    if (blocked.length > 0) {
      if (!said.has(rel.pr)) rlog.info(`Release PR #${rel.pr}: ${blocked.map((n) => `#${n}`).join(", ")} cannot be read from the record store; left alone this cycle`);
      said.add(rel.pr);
      return false;
    }
    return true;
  };

  // A merged release waiting on a time the SRE named (a `merged` release has a `retryAt` only from a wait) that was
  // saved before waits were announced: say so now, once. It is not an action: nothing is verified early and the
  // time is unchanged.
  for (const w of current.filter((r) => r.phase === "merged" && ready(r) && r.retryAt && !due(r.retryAt) && r.waitNoted !== r.retryAt)) {
    try {
      const evidence = await evidenceFor(repoConfig, w.pr, rlog);
      await announceWait(rt, repoConfig, w, { kind: "wait", retryAt: w.retryAt!, hold: "", ...(evidence ? { evidence } : {}) }, rlog);
    } catch (err) {
      rlog.warn(`Release PR #${w.pr}: could not announce its wait: ${errText(err)}`);
    }
  }

  const merged = current.find((r) => r.phase === "merged" && ready(r) && due(r.retryAt));
  if (merged) {
    if (!merged.mergeSha) {
      try {
        const pr = await codeHost().viewReleasePr(repoConfig, merged.pr);
        if (pr.mergeSha) merged.mergeSha = pr.mergeSha;
      } catch { /* tagged on a later pass */ }
    }
    await tagRelease(repoConfig, merged, rlog);
    if (!(await putRelease(rt, repoConfig, merged, rlog))) return true;
    await settle(rt, repoConfig, config, merged, await mergedVerdict(rt, repoConfig, config, merged, rlog, cycleNumber), rlog);
    return true;
  }

  const held = current.find((r) => r.phase === "held" && ready(r) && due(r.retryAt));
  if (held) {
    const path = transcript(repoConfig, `verify-pr${held.pr}`, cycleNumber);
    // A release held by its soak is cleared by a fresh soak, never by a production pass: the soak is what
    // held it, and a prod pass would close the reopened issues with the soak's finding unanswered (foreman#80).
    if (soakHeld(held)) {
      rlog.info(`Release PR #${held.pr}: re-soaking after ${held.hold ?? "a soak hold"}, transcript: ${path}`);
      const sr = await asRun(repoConfig, (signal) => verifyProd(repoConfig, config, held.pr, rlog, signal, path, "soak", true));
      await settleSoak(rt, repoConfig, config, held, sr, rlog, true);
      return true;
    }
    rlog.info(`Release PR #${held.pr}: re-verifying production after ${held.hold ?? "a hold"}, transcript: ${path}`);
    const r = await asRun(repoConfig, (signal) => verifyProd(repoConfig, config, held.pr, rlog, signal, path, "prod"));
    const v: Verdict = r.kind === "nothing" ? { kind: "defer", reason: r.reason } : await fromVerifyResult(rt, r, repoConfig, held.pr, rlog);
    await settle(rt, repoConfig, config, held, v, rlog);
    return true;
  }

  const soaking = current.find((r) => r.phase === "soaking" && ready(r) && due(r.soakAt));
  if (soaking) {
    await soak(rt, repoConfig, config, soaking, rlog, cycleNumber);
    return true;
  }

  return deploy(rt, repoConfig, config, rlog, cycleNumber);
}
