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
    `so it stops holding the release, then rewrite the remaining work as one designed issue.`;
}

/**
 * Whether `holder`'s corrective chain is broken. When it is, the EM is asked once ("redesign or switch off") and the
 * caller builds no corrective for it. No hold record, or a read that fails, is not broken: the build goes on as before,
 * because a count that is a guess must not stop work.
 */
export async function correctiveChainBroken(
  rt: ForemanRuntime, repoConfig: RepoConfig, holder: number, hold: VerifyHold | undefined, logger: Logger,
): Promise<boolean> {
  if (!hold) return false;
  let correctives: number[];
  try {
    correctives = await codeHost().correctivesOf(repoConfig, holder, hold.prNumber);
  } catch (err) {
    logger.warn(`#${holder}: its correctives could not be counted (${(err instanceof Error ? err.message : String(err)).split("\n")[0]})`);
    return false;
  }
  if (!chainBroken(correctives)) return false;
  try {
    if (await rt.handoffs.raise(repoConfig, { kind: "corrective-chain", subject: holder, dedupeKey: "chain", reason: chainReason(holder, correctives) })) {
      logger.warn(`#${holder}: ${correctives.length} correctives since its merge; building no further corrective for it — the EM is asked to redesign or switch it off`);
    }
  } catch (err) {
    if (!(err instanceof HandoffNotSaved)) throw err;
    logger.warn(`#${holder}: could not record the corrective-chain question — asked again next pass`);
  }
  return true;
}
