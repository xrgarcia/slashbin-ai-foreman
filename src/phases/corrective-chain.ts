// The corrective-chain breaker (slashbin-ai-foreman#353).
//
// Origin (#353, 2026-11-18/19): a service repo's issue. Merged before it ran against the real corpus, it failed dev
// acceptance one defect at a time: each fix unmasked the next, and each took a full build, review, merge, deploy
// and verify loop. Nine correctives in 24 hours, and the release behind it held the whole time. A third corrective
// on one verification is no longer a fix, it is a design that does not hold: the Foreman stops building correctives
// for it and asks the EM to redesign it or switch it off (`Dark flag`, src/github/dark-flag.ts).

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { VerifyHold } from "../issue-records.js";
import type { ForemanRuntime } from "../runtime.js";
import { codeHost } from "../plugins/registry.js";
import { HandoffNotSaved } from "../unstick.js";
import { report as reportStall, resolve as resolveStall } from "../stall-clock.js";

/** The corrective count at which the Foreman stops building correctives for one held dev verification. */
export const CORRECTIVE_CHAIN_LIMIT = 3;

/** True when `correctives` has reached the limit. Pure, exported for tests. */
export function chainBroken(correctives: readonly number[], limit = CORRECTIVE_CHAIN_LIMIT): boolean {
  return correctives.length >= limit;
}

/** The EM-queue reason for a broken chain. Pure, exported for tests. */
export function chainReason(holder: number, correctives: readonly number[]): string {
  return `#${holder}'s dev verification has ${correctives.length} correctives (${correctives.map((n) => `#${n}`).join(", ")}) since its PR merged: ` +
    `redesign or switch off. The Foreman builds no further corrective for #${holder}. Switch it off (a \`Dark flag\` that is off unless set) ` +
    `by naming it in #${holder}'s Pre-Flight, then rewrite the remaining work as one designed issue.`;
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;

/** What a held verification's corrective chain does to the build: nothing, stopped, or the holder released. */
export type ChainHold = "build" | "stopped" | "released";
/** A chain's state and, when it stopped, the correctives that must not build. */
export interface ChainVerdict { state: ChainHold; correctives: number[] }

/**
 * What `holder`'s corrective chain does to the build. The caller asks it of every held merged issue, whatever its retry
 * state: a verification whose attempts are spent no longer holds the repo, and its correctives must still not build. Under the limit: `build`, as before. At it: the EM is asked once
 * ("redesign or switch off") and the caller builds no corrective for it (`stopped`), until the EM switches it off by
 * naming a `Dark flag` in its Pre-Flight; then it no longer holds the repo at all (`released`), so the switch-off issue
 * and everything queued behind it build. Its release stays held until the code names that flag (darkIssues, shipped).
 * No hold record, or a read that fails, is `build`: a count that is a guess must not stop work.
 */
export async function correctiveChainHold(
  rt: ForemanRuntime, repoConfig: RepoConfig, holder: number, hold: VerifyHold | undefined, logger: Logger,
): Promise<ChainVerdict> {
  const build: ChainVerdict = { state: "build", correctives: [] };
  if (!hold) return build;
  let correctives: number[];
  try {
    correctives = await codeHost().correctivesOf(repoConfig, holder, hold.prNumber);
  } catch (err) {
    logger.warn(`#${holder}: its correctives could not be counted (${firstLine(err)})`);
    return build;
  }
  if (!chainBroken(correctives)) return build;
  const flag = (await codeHost().darkIssues(repoConfig, [holder], logger)).get(holder);
  if (flag) {
    await resolveStall(rt, repoConfig, holder, "corrective-chain-stopped", new Date().toISOString())
      .catch((err) => logger.warn(`#${holder}: its corrective-chain stall was not resolved (${firstLine(err)})`));
    logger.info(`#${holder}: switched off (\`${flag}\`) after ${correctives.length} correctives; its dev verification no longer holds the repo`);
    return { state: "released", correctives };
  }
  // The stop is a stall with its own start, reported before the unchanged raise; a failure here never stops the raise.
  try {
    await reportStall(rt, repoConfig, {
      issue: holder, cause: "corrective-chain-stopped", eventAt: Number.isNaN(Date.parse(hold.heldAt)) ? new Date().toISOString() : hold.heldAt,
      affected: [`${repoConfig.githubRepo}#${holder}`], resolver: "EM",
      nextAction: "redesign the work as one designed issue, or switch it off with a `Dark flag` named in its Pre-Flight",
      resumptionCondition: "a `Dark flag` is named in the holder's Pre-Flight, which releases it", evidence: `correctives ${correctives.map((n) => `#${n}`).join(", ")}`,
    });
  } catch (err) {
    logger.warn(`#${holder}: the corrective-chain stall was not recorded (${firstLine(err)})`);
  }
  try {
    if (await rt.handoffs.raise(repoConfig, { kind: "corrective-chain", subject: holder, dedupeKey: "chain", reason: chainReason(holder, correctives) })) {
      logger.warn(`#${holder}: ${correctives.length} correctives since its merge; building no further corrective for it — the EM is asked to redesign or switch it off`);
    }
  } catch (err) {
    if (!(err instanceof HandoffNotSaved)) throw err;
    logger.warn(`#${holder}: could not record the corrective-chain question — asked again next pass`);
  }
  return { state: "stopped", correctives };
}
