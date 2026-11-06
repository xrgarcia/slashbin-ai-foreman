// What a `landed` result means for a dependency batch.
//
// An implement session for a batch issue can answer "nothing left to land": the
// versions are already on the base branch. Closing the ISSUE (dead-blocker.ts,
// generic) is not the end of the batch: the batch is a set of Dependabot PRs, and
// it ends only when each is landed, refused or retired. This resolves them:
// retire each PR still open at the head the batch recorded, then record the
// outcome in the ledger.
//
// The outcome is recorded only when every PR is resolved. If a retirement fails
// the batch stays unresolved, so the filing policy's 3-in-24h cap is what stops
// the loop, and the EM is told. A terminal outcome written over an open PR would
// hide the failure.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { DependencyDiscovery } from "./collaborators.js";
import type { DependencyBatchLedger } from "./ledger.js";

/** The one code-host call landing needs. */
export interface PrRetirer {
  retireDependencyPR(config: RepoConfig, number: number, reason: string): void;
}

export type LandingResult =
  | { kind: "not-a-batch" }
  | { kind: "ledger-unavailable" }
  | { kind: "landed"; retired: number[]; alreadyGone: number[]; newerHead: number[] }
  | { kind: "retirement-failed"; failed: { number: number; error: string }[]; retired: number[] };

export class DependencyBatchLanding {
  constructor(
    private readonly ledger: DependencyBatchLedger,
    private readonly discovery: DependencyDiscovery,
    private readonly host: PrRetirer,
  ) {}

  /** `issue` finished as landed for `reason`. Never throws. */
  async resolve(repoConfig: RepoConfig, issue: number, reason: string, logger: Logger, now: Date = new Date()): Promise<LandingResult> {
    const found = await this.ledger.batchOfIssue(repoConfig, issue);
    if (found === null) return { kind: "ledger-unavailable" };
    if (found === undefined) return { kind: "not-a-batch" };
    const { batch } = found;

    const open = new Map(this.discovery.openPrs(repoConfig, logger).map((p) => [p.number, p]));
    const comment = `Superseded by #${issue}: the Foreman's build found this update already on \`${repoConfig.baseBranch}\`.\n\n${reason}\n\n` +
      "Closing as superseded. Dependabot reopens or rebases it on its own if the update is still needed.";
    const retired: number[] = [];
    const alreadyGone: number[] = [];
    const newerHead: number[] = [];
    const failed: { number: number; error: string }[] = [];
    for (const pr of batch.prs) {
      const current = open.get(pr.number);
      // Dependabot pushed since the batch was filed: that is different work, with its own key. Leave it.
      if (current?.headRefOid && pr.headSha !== "unknown" && current.headRefOid !== pr.headSha) { newerHead.push(pr.number); continue; }
      try {
        this.host.retireDependencyPR(repoConfig, pr.number, comment);
        (current ? retired : alreadyGone).push(pr.number);
      } catch (err) {
        failed.push({ number: pr.number, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (failed.length > 0) {
      logger.warn(`dependency batch ${batch.key}: could not retire ${failed.map((f) => `#${f.number}`).join(", ")} — the batch stays open in the ledger`);
      return { kind: "retirement-failed", failed, retired };
    }
    if (!(await this.ledger.recordOutcome(repoConfig, batch, "landed", now))) {
      logger.warn(`dependency batch ${batch.key}: PRs retired, but the ledger could not record the outcome`);
      return { kind: "ledger-unavailable" };
    }
    logger.info(`dependency batch ${batch.key} landed: retired ${retired.map((n) => `#${n}`).join(", ") || "none"}`);
    return { kind: "landed", retired, alreadyGone, newerHead };
  }
}
