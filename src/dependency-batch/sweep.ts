// The dependency sweep as orchestration: discover, select, ask the policy, file.
// Every decision lives in a collaborator; this class only sequences them and
// keeps the ledger honest about what it filed.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { DependencyBatch } from "./batch.js";
import {
  batchOf, type BatchIssueComposer, type BatchIssueFiler, type DependencyDiscovery, type OpenBatchIssueProbe, type SecuritySelection,
} from "./collaborators.js";
import type { DependencyBatchLedger } from "./ledger.js";
import type { DependencyBatchFilingPolicy } from "./policy.js";

/** How the EM is told a batch is looping. Idempotent: called on every held sweep. Throws when the notice could not be recorded. */
export interface BatchLoopNotifier {
  batchLooping(repoConfig: RepoConfig, batch: DependencyBatch, filings: number): Promise<boolean>;
}

export interface SweepParts {
  discovery: DependencyDiscovery;
  security: SecuritySelection;
  openIssue: OpenBatchIssueProbe;
  ledger: DependencyBatchLedger;
  policy: DependencyBatchFilingPolicy;
  composer: BatchIssueComposer;
  filer: BatchIssueFiler;
  notifier: BatchLoopNotifier;
}

export class DependencyBatchSweep {
  constructor(private readonly parts: SweepParts) {}

  /** One sweep of one repo. Returns the number of the issue it filed, or null when it filed nothing. */
  async run(repoConfig: RepoConfig, logger: Logger, now: Date = new Date()): Promise<number | null> {
    const { discovery, security, openIssue, ledger, policy, composer, filer, notifier } = this.parts;

    const found = discovery.discover(repoConfig, logger);
    if (!found) return null;
    const prs = security.select(repoConfig, found.prs, logger);
    if (prs.length === 0) return null;

    const batch = batchOf(prs);
    const decision = policy.decide({
      history: await ledger.historyOf(repoConfig, batch),
      batchIssueOpen: openIssue.isOpen(repoConfig, logger),
      now,
    });

    if (decision.action === "skip") {
      logger.debug(`${prs.length} dependency PR(s) on ${found.bases.join("/")}; not filed (${decision.reason})`);
      return null;
    }
    if (decision.action === "hold") {
      logger.warn(`dependency batch ${batch.key} was filed ${decision.filings} times in 24h — holding it`);
      await this.tellEm(repoConfig, batch, decision.filings, logger);
      return null;
    }

    // Record the filing BEFORE the write: a ledger that cannot take it files nothing, so the cap cannot be bypassed.
    if (!(await ledger.recordFiling(repoConfig, batch, now))) {
      logger.warn(`dependency batch ${batch.key}: the ledger could not record the filing — filing nothing`);
      return null;
    }
    const issue = composer.compose(repoConfig, prs);
    const number = filer.file(repoConfig, issue, logger);
    if (number === null) return null;
    if (!(await ledger.attachIssue(repoConfig, batch, number))) {
      logger.warn(`dependency batch ${batch.key}: could not record issue #${number} in the ledger; a landed result on it will not retire the PRs`);
    }

    const majors = issue.changes.filter((c) => c.major).length;
    logger.info(
      `Filed dependency batch issue #${number} for ${prs.length} PR(s) on ${found.bases.join("/")}` +
      (majors > 0 ? ` — ${majors} major` : "") +
      (repoConfig.dependencyPreApproved
        ? ` — filed with "${repoConfig.triggerLabel}", queued to build`
        : ` — awaiting "${repoConfig.triggerLabel}"`),
    );
    return number;
  }

  /**
   * Every held sweep puts the notice to the EM's question table, which is idempotent: it answers true at once when
   * the EM already holds the question. Delivery, and the re-arm of a spent one, belong to the unstick stage (`nextStep`). The ledger
   * keeps no "told" flag of its own, so there is one record of delivery, not two that can disagree.
   */
  private async tellEm(repoConfig: RepoConfig, batch: DependencyBatch, filings: number, logger: Logger): Promise<void> {
    try {
      await this.parts.notifier.batchLooping(repoConfig, batch, filings);
    } catch (err) {
      logger.warn(`dependency batch ${batch.key}: could not raise the EM notice — retried next sweep: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
