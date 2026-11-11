// The steps of the dependency sweep, each behind its own small class. The phase
// function (phases/promote.ts) only wires them in order; each is unit-tested on
// its own against a fake `DependencyHostPort`.

import { PROD_GRANT_LABEL, type RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { DependencyChange, PrSnapshot } from "../code-host.js";
import type { GithubConventions } from "../config-schema/github.js";
import { DependencyBatch } from "./batch.js";

/** The slice of the code host the sweep uses. `CodeHost` satisfies it. */
export interface DependencyHostPort {
  dependencyBatchBases(baseBranch: string | undefined, productionBranch: string, legacyFeatureBranch?: string): string[];
  findDependencyPRs(repo: string, cwd: string, bases: readonly string[], logger?: Logger, conventions?: GithubConventions): Promise<PrSnapshot[]>;
  fetchOpenAlertPackages(repo: string, cwd: string): Promise<Set<string>>;
  selectSecurityPRs<T extends Pick<PrSnapshot, "title" | "body">>(prs: readonly T[], alertPackages: ReadonlySet<string>): T[];
  formatGhError(err: unknown): { message: string; stderr: string; status: number | null };
  findOpenDependencyBatchIssue(repo: string, cwd: string, logger: Logger, conventions?: GithubConventions): Promise<{ number: number } | undefined>;
  describeDependencyPR(number: number, title: string, body?: string): DependencyChange;
  buildDependencyBatchIssue(landingBranch: string, changes: readonly DependencyChange[], conventions?: GithubConventions, baseBranch?: string): { title: string; body: string };
  createDependencyBatchIssue(repo: string, cwd: string, title: string, body: string, labels: string[], logger?: Logger): Promise<number | null>;
}

/** What the sweep found open. */
export interface DiscoveredDependencies {
  bases: string[];
  prs: PrSnapshot[];
}

/** Step 1: which branches carry dependency PRs, and which Dependabot PRs are open on them. */
export class DependencyDiscovery {
  constructor(private readonly host: Pick<DependencyHostPort, "dependencyBatchBases" | "findDependencyPRs">) {}

  async discover(repoConfig: RepoConfig, logger: Logger): Promise<DiscoveredDependencies | null> {
    const bases = this.host.dependencyBatchBases(repoConfig.baseBranch, repoConfig.productionBranch, repoConfig.featureBranch);
    if (bases.length === 0) return null;
    const prs = await this.host.findDependencyPRs(repoConfig.githubRepo, repoConfig.repoPath, bases, logger, repoConfig.github);
    return prs.length === 0 ? null : { bases, prs };
  }

  /** The open Dependabot PRs on the repo's dependency bases; empty when there are none or the list cannot be read. */
  async openPrs(repoConfig: RepoConfig, logger: Logger): Promise<PrSnapshot[]> {
    return (await this.discover(repoConfig, logger))?.prs ?? [];
  }
}

/**
 * Step 2: security-only selection (`dependabot.securityOnly`, default on; Ray, 2026-10-26).
 * A version-update PR is left alone: not batched, merged or closed. If the alert
 * list cannot be read the sweep batches NOTHING, never everything.
 */
export class SecuritySelection {
  constructor(private readonly host: Pick<DependencyHostPort, "fetchOpenAlertPackages" | "selectSecurityPRs" | "formatGhError">) {}

  async select(repoConfig: RepoConfig, prs: PrSnapshot[], logger: Logger): Promise<PrSnapshot[]> {
    if (!repoConfig.dependabot.securityOnly) return prs;
    let alerts: Set<string>;
    try {
      alerts = await this.host.fetchOpenAlertPackages(repoConfig.githubRepo, repoConfig.repoPath);
    } catch (err) {
      logger.warn("dependabot: could not read open Dependabot alerts — batching nothing this cycle", {
        ...this.host.formatGhError(err), repo: repoConfig.githubRepo, dependencyPRs: prs.length,
      });
      return [];
    }
    const selected = this.host.selectSecurityPRs(prs, alerts);
    if (selected.length === 0) {
      logger.debug(`${prs.length} dependency PR(s) open, none a security update (${alerts.size} open alert package(s)); left alone`);
    } else if (selected.length < prs.length) {
      logger.info(`${prs.length - selected.length} of ${prs.length} dependency PR(s) are not security updates; left alone`);
    }
    return selected;
  }
}

/** The batch a set of PR snapshots makes. */
export function batchOf(prs: readonly PrSnapshot[]): DependencyBatch {
  return DependencyBatch.of(prs.map((p) => ({ number: p.number, headSha: p.headRefOid })));
}

/** A batch issue ready to file. */
export interface ComposedIssue {
  title: string;
  body: string;
  changes: DependencyChange[];
}

/** Step 3: the issue's title and body. */
export class BatchIssueComposer {
  constructor(private readonly host: Pick<DependencyHostPort, "describeDependencyPR" | "buildDependencyBatchIssue">) {}

  compose(repoConfig: RepoConfig, prs: readonly PrSnapshot[]): ComposedIssue {
    const changes = prs.map((p) => this.host.describeDependencyPR(p.number, p.title, p.body));
    const { title, body } = this.host.buildDependencyBatchIssue(repoConfig.baseBranch, changes, repoConfig.github, repoConfig.baseBranch);
    return { title, body, changes };
  }
}

/**
 * The labels a batch issue is filed with: the trigger label AND the production grant
 * on a pre-approved repo (owner decisions 2026-09-29 and 2026-11-06), none otherwise.
 */
export function batchIssueLabels(repoConfig: Pick<RepoConfig, "dependencyPreApproved" | "triggerLabel">): string[] {
  return repoConfig.dependencyPreApproved ? [repoConfig.triggerLabel, PROD_GRANT_LABEL] : [];
}

/**
 * Step 4: the write. Carries the trigger and production-grant labels only on a pre-approved
 * repo (`dependencyPreApproved`), bare otherwise; the labels are the whole authorization,
 * in both directions. The issue always lands
 * on the repo's base branch, never production.
 */
export class BatchIssueFiler {
  constructor(private readonly host: Pick<DependencyHostPort, "createDependencyBatchIssue">) {}

  async file(repoConfig: RepoConfig, issue: ComposedIssue, logger: Logger): Promise<number | null> {
    return await this.host.createDependencyBatchIssue(
      repoConfig.githubRepo, repoConfig.repoPath, issue.title, issue.body,
      batchIssueLabels(repoConfig), logger,
    );
  }
}

/** Whether a dependency-batch issue is already open on the repo. */
export class OpenBatchIssueProbe {
  constructor(private readonly host: Pick<DependencyHostPort, "findOpenDependencyBatchIssue">) {}

  async isOpen(repoConfig: RepoConfig, logger: Logger): Promise<boolean> {
    return await this.host.findOpenDependencyBatchIssue(repoConfig.githubRepo, repoConfig.repoPath, logger, repoConfig.github) !== undefined;
  }
}
