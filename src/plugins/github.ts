import type { CodeHost } from "../code-host.js";
import type { AgentConfig } from "../config.js";
import * as branch from "../github/branch.js";
import * as cache from "../github/cache.js";
import * as ciGate from "../github/ci-gate.js";
import * as deadBlocker from "../github/dead-blocker.js";
import * as dependencies from "../github/dependencies.js";
import * as discovery from "../github/discovery.js";
import * as lifecycleScan from "../github/lifecycle-scan.js";
import * as prComments from "../github/pr-comments.js";
import * as prs from "../github/pr.js";
import * as promotion from "../github/promotion.js";
import * as readiness from "../github/readiness.js";
import * as releaseCarry from "../github/release-carry.js";
import * as releaseSignoff from "../github/release-signoff.js";
import * as release from "../github/release.js";
import * as reports from "../github/reports.js";
import * as reviewQueue from "../github/review-queue.js";
import * as reviewFreshness from "../github/review-freshness.js";
import * as skipHold from "../github/skip-hold.js";
import * as coreReads from "../github/core-reads.js";
import { gh } from "../github/gh.js";
import { clearActivity, configureGitHubState, recordActivity, setGitHubStateRepos, takeGitHubStateUsage } from "../github-state.js";
import { GitHubIssueConnector } from "../github-work-source.js";
import type { ForemanPlugin, PluginRole } from "./contract.js";

/** The id that selects this plugin as work source and as code host; the default for both. */
export const GITHUB_WORK_SOURCE = "github";

/**
 * GitHub's code host (EM#1150 f5): every operation delegates to src/github/*,
 * which stays the implementation and which only this plugin imports. Same
 * calls, tokens and caches as when the core called those modules directly.
 */
export function githubCodeHost(): CodeHost {
  return {
    configureIssueCache: cache.configureIssueCache,
    // The fleet state reads with the Foreman token from the daemon's cwd, as before.
    configureState: (opts) => configureGitHubState({ ...opts, run: (args) => gh(args, process.cwd()) }),
    setStateRepos: setGitHubStateRepos,
    takeStateUsage: takeGitHubStateUsage,
    recordActivity,
    clearActivity,

    issueLastEditedAt: coreReads.issueLastEditedAt,
    issueCommentRows: coreReads.issueCommentRows,
    openIssueRowsBy: coreReads.openIssueRowsBy,
    openPrsForBranch: coreReads.openPrsForBranch,
    closedPrsForBranch: coreReads.closedPrsForBranch,
    createPr: coreReads.createPr,
    labelNames: coreReads.labelNames,
    createLabel: coreReads.createLabel,
    featurePrUrlFallback: coreReads.featurePrUrlFallback,

    checkBranchDrift: branch.checkBranchDrift,
    checkPRHasChanges: branch.checkPRHasChanges,
    createSyncPR: branch.createSyncPR,
    findOpenSyncPR: branch.findOpenSyncPR,
    getRemoteBranchSha: branch.getRemoteBranchSha,
    productionDriftFiles: branch.productionDriftFiles,
    tryMergeSyncPR: branch.tryMergeSyncPR,
    forgetOpenPrs: cache.forgetOpenPrs,
    formatGhError: cache.formatGhError,
    getOpenIssues: cache.getOpenIssues,
    hasLabel: cache.hasLabel,
    isPrOpen: cache.isPrOpen,
    knownOpenPr: cache.knownOpenPr,
    openIssueLabels: cache.openIssueLabels,
    bounceForRedCI: ciGate.bounceForRedCI,
    commentOnIssue: ciGate.commentOnIssue,
    countCiBouncesSinceReview: ciGate.countCiBouncesSinceReview,
    getPRCheckVerdict: ciGate.getPRCheckVerdict,
    announceDeadBlocker: deadBlocker.announceDeadBlocker,
    closeAlreadyLanded: deadBlocker.closeAlreadyLanded,
    holdBlocker: deadBlocker.holdBlocker,
    isDeadBlockerReason: deadBlocker.isDeadBlockerReason,
    buildDependencyBatchIssue: dependencies.buildDependencyBatchIssue,
    createDependencyBatchIssue: dependencies.createDependencyBatchIssue,
    dependencyBatchBases: dependencies.dependencyBatchBases,
    describeDependencyPR: dependencies.describeDependencyPR,
    fetchOpenAlertPackages: dependencies.fetchOpenAlertPackages,
    findDependencyPRs: dependencies.findDependencyPRs,
    findOpenDependencyBatchIssue: dependencies.findOpenDependencyBatchIssue,
    selectSecurityPRs: dependencies.selectSecurityPRs,
    discoveryBatch: discovery.discoveryBatch,
    findIssuesAwaitingVerify: lifecycleScan.findIssuesAwaitingVerify,
    findIssuesMergedToBase: lifecycleScan.findIssuesMergedToBase,
    findIssuesStillUnderReview: lifecycleScan.findIssuesStillUnderReview,
    findOrphanedLifecycleIssues: lifecycleScan.findOrphanedLifecycleIssues,
    findRevokedEmGates: lifecycleScan.findRevokedEmGates,
    findStuckMergedIssues: lifecycleScan.findStuckMergedIssues,
    readReviewOutcomes: lifecycleScan.readReviewOutcomes,
    restoreEmGate: lifecycleScan.restoreEmGate,
    commentBodies: prComments.commentBodies,
    commentOnPr: prComments.commentOnPr,
    commentsWithTimes: prComments.commentsWithTimes,
    hasCommentContaining: prComments.hasCommentContaining,
    hasCommentStartingWith: prComments.hasCommentStartingWith,
    findOpenFeaturePR: prs.findOpenFeaturePR,
    getReferencedIssuesFromOpenPR: prs.getReferencedIssuesFromOpenPR,
    planFailedReviewOutcome: prs.planFailedReviewOutcome,
    verifyPRExists: prs.verifyPRExists,
    countBranchDiffFiles: promotion.countBranchDiffFiles,
    createPromotionPR: promotion.createPromotionPR,
    findOpenPromotionPR: promotion.findOpenPromotionPR,
    findReadyForProdIssues: promotion.findReadyForProdIssues,
    getPrState: promotion.getPrState,
    stripReadyForProdLabel: promotion.stripReadyForProdLabel,
    updatePromotionPR: promotion.updatePromotionPR,
    readIssueBody: readiness.readIssueBody,
    adoptCarried: releaseCarry.adoptCarried,
    noteCarried: releaseCarry.noteCarried,
    foremanAppliedOrHold: releaseSignoff.foremanAppliedOrHold,
    syncSignoff: releaseSignoff.syncSignoff,
    unsignedInHead: releaseSignoff.unsignedInHead,
    unsignedIssues: releaseSignoff.unsignedIssues,
    RELEASE_STOP_MARK: release.RELEASE_STOP_MARK,
    addBlockedLabel: release.addBlockedLabel,
    addReleasePrIssues: release.addReleasePrIssues,
    ensureReleaseTag: release.ensureReleaseTag,
    findPvComment: release.findPvComment,
    findReleaseStop: release.findReleaseStop,
    findSreSweepHold: release.findSreSweepHold,
    productionHead: release.productionHead,
    readPvResult: release.readPvResult,
    recentMergedReleasePrs: release.recentMergedReleasePrs,
    removeBlockedLabel: release.removeBlockedLabel,
    viewIssue: release.viewIssue,
    viewReleasePr: release.viewReleasePr,
    issueTitles: reports.issueTitles,
    prChangedFiles: reports.prChangedFiles,
    readLatestReviewBody: reports.readLatestReviewBody,
    readPrDigest: reports.readPrDigest,
    readRulingState: reports.readRulingState,
    findPRsNeedingReview: reviewQueue.findPRsNeedingReview,
    findPendingRevisions: reviewQueue.findPendingRevisions,
    findQaPendingPr: reviewQueue.findQaPendingPr,
    blockedAmong: reviewQueue.blockedAmong,
    readPrHeadSha: reviewFreshness.readPrHeadSha,
    hasPendingRevisions: reviewQueue.hasPendingRevisions,
    escalatedReason: skipHold.escalatedReason,
    foremanLogin: skipHold.foremanLogin,
    heldReason: skipHold.heldReason,
    issueActivitySince: skipHold.issueActivitySince,
    parseWaitingOn: skipHold.parseWaitingOn,
    refState: skipHold.refState,
    skipGate: skipHold.skipGate,
    waitingOnLabel: skipHold.waitingOnLabel,
  };
}

/**
 * GitHub as the work source and the code host (EM#1150 f4, f5). As work source it
 * selects approved issues and turns each lifecycle move into its labels
 * (github-work-source.ts); as code host it opens, reads, merges and comments on
 * PRs, branches and issues. Each role is on unless the config names another
 * plugin for it. The only place outside the GitHub code that constructs the
 * connector; the core reaches both roles through the registry.
 */
export class GitHubPlugin implements ForemanPlugin {
  readonly id = "github";
  readonly roles = ["workSource", "codeHost"] as const;
  /** Stateless: its holds and announcements live in github-work-source.ts's module state, as before. */
  readonly workSource = new GitHubIssueConnector();
  readonly codeHost = githubCodeHost();

  enabled(config: AgentConfig): boolean {
    return this.fills("workSource", config) || this.fills("codeHost", config);
  }

  fills(role: PluginRole, config: AgentConfig): boolean {
    if (role === "workSource") return (config.workSource ?? GITHUB_WORK_SOURCE) === GITHUB_WORK_SOURCE;
    if (role === "codeHost") return (config.codeHost ?? GITHUB_WORK_SOURCE) === GITHUB_WORK_SOURCE;
    return false;
  }

  disabledReason(config: AgentConfig): string | undefined {
    return `GitHub plugin off: workSource is "${config.workSource}" and codeHost is "${config.codeHost}"`;
  }
}
