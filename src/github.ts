// GitHub, through the gh CLI. The code lives in src/github/, one file per concern;
// this file is the public surface the rest of the Foreman imports, unchanged by the split.

export { isBackoffRefusal, gh } from "./github/gh.js";
export {
  type IssueSnapshot,
  configureIssueCache,
  dropIssueSnapshot,
  openIssueLabels,
  getOpenIssues,
  getOpenPrs,
  hasLabel,
  forgetOpenPrs,
  isPrOpen,
  findOpenPrs,
  knownOpenPr,
  ghKeyed,
  closedPrVersion,
} from "./github/cache.js";
export { extractImplementedIssues, issuesImplementedByCommits, discoveryBatch, type PrCommit } from "./github/discovery.js";
export {
  type PendingRevisionPR,
  type PendingRevisionInfo,
  findPendingRevisions,
  hasPendingRevisions,
  type ReviewCandidate,
  findPRsNeedingReview,
} from "./github/review-queue.js";
export {
  type MergedIssueRef,
  findIssuesMergedToBase,
  type StuckMergedIssue,
  findStuckMergedIssues,
  findOrphanedLifecycleIssues,
  findIssuesStillUnderReview,
  type ReviewOutcome,
  reviewOutcomesOf,
  readReviewOutcomes,
  findIssuesAwaitingVerify,
  type TimelineLabelEvent,
  wasGateRevokedSince,
  findRevokedEmGates,
  type EmGateRestoreStep,
  planEmGateRestore,
  restoreEmGate,
} from "./github/lifecycle-scan.js";
export {
  type CheckRollupEntry,
  type CheckVerdict,
  summarizeCheckRollup,
  getPRCheckVerdict,
  CI_GATE_MARKER,
  countCiBouncesSinceReview,
  ciBounceComment,
  bounceForRedCI,
  commentOnIssue,
} from "./github/ci-gate.js";
export {
  type PromotionIssue,
  findReadyForProdIssues,
  type OpenPromotionPR,
  findOpenPromotionPR,
  getPrState,
  updatePromotionPR,
  countBranchDiffFiles,
  stripReadyForProdLabel,
  createPromotionPR,
} from "./github/promotion.js";
export {
  type SignoffGate,
  unsignedIssues,
  unsignedInHead,
  foremanAppliedOrHold,
  syncSignoff,
  resetSignoff,
  SIGNOFF_MARK,
} from "./github/release-signoff.js";
export {
  type CarriedMerge,
  type ReleaseCarry,
  NO_CARRY,
  adoptCarried,
  noteCarried,
  listCarriedMerges,
  planCarry,
  mergedPrNumber,
  resetReleaseCarry,
} from "./github/release-carry.js";
export { issueTitles, readPrDigest, prChangedFiles, readLatestReviewBody, readRulingState, rulingState, EM_RULING_PATTERN, TECH_LEAD_ESCALATE_MARKER } from "./github/reports.js";
export {
  checkPRHasChanges,
  getRemoteBranchSha,
  type BranchDrift,
  checkBranchDrift,
  productionDriftFiles,
  isNonProductionPath,
  findOpenSyncPR,
  createSyncPR,
  tryMergeSyncPR,
} from "./github/branch.js";
export {
  dependencyBatchBases,
  findDependencyPRs,
  fetchOpenAlertPackages,
  dependencyPackagesOf,
  selectSecurityPRs,
  DEPENDENCY_BATCH_TITLE_PREFIX,
  type DependencyChange,
  describeDependencyPR,
  isMajorBump,
  buildDependencyBatchIssue,
  findOpenDependencyBatchIssue,
  dependencyBatchIssueCreateArgs,
  createDependencyBatchIssue,
} from "./github/dependencies.js";
export {
  verifyPRExists,
  getReferencedIssuesFromOpenPR,
  findOpenFeaturePR,
  type FailedReviewPlan,
  planFailedReviewOutcome,
} from "./github/pr.js";
export {
  type IssueView,
  viewIssue,
  type ReleasePrView,
  viewReleasePr,
  latestMergedReleasePr,
  recentMergedReleasePrs,
  PV_HEADING,
  findPvComment,
  readPvResult,
  SRE_SWEEP_HOLD,
  findSreSweepHold,
  RELEASE_STOP_MARK,
  findReleaseStop,
  productionHead,
  tagPrefix,
  ensureReleaseTag,
  addBlockedLabel,
  removeBlockedLabel,
  addReleasePrIssues,
} from "./github/release.js";
