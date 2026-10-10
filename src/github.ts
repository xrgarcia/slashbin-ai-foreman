// GitHub, through the gh CLI. The code lives in src/github/, one file per concern;
// this file is the public surface the rest of the Foreman imports, unchanged by the split.

export { isBackoffRefusal, gh } from "./github/gh.js";
export {
  type IssueSnapshot,
  configureIssueCache,
  dropIssueSnapshot,
  openIssueLabels,
  getOpenIssues,
  hasLabel,
  forgetOpenPrs,
  isPrOpen,
  findOpenPrs,
  knownOpenPr,
  ghKeyed,
  closedPrVersion,
} from "./github/cache.js";
export { extractImplementedIssues, discoveryBatch } from "./github/discovery.js";
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
  MAX_CI_BOUNCES,
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
export { issueTitles, readPrDigest, readLatestReviewBody, countChangesRequested } from "./github/reports.js";
export {
  checkPRHasChanges,
  getRemoteBranchSha,
  type BranchDrift,
  checkBranchDrift,
  findOpenSyncPR,
  createSyncPR,
  tryMergeSyncPR,
} from "./github/branch.js";
export {
  dependencyBatchBases,
  findDependencyPRs,
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
