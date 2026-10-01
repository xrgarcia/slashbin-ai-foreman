export {
  loadConfig, defaultLifecycleLabels, type AgentConfig, type RepoConfig, type LifecycleLabels,
} from "./config.js";
export {
  BUILTIN_STAGES, defaultStages, type StageEntry, type StageType, type StageOutcome,
} from "./stages.js";
export { createLogger, type Logger, type LogLevel } from "./logger.js";
export { GitHubIssueConnector, hasPendingRevisions, verifyPRExists } from "./github.js";
export type { WorkItem, WorkSourceAdapter } from "./adapters.js";
export { implementApprovedIssues, revisePRFeedback, type ImplementationResult, type RevisionResult } from "./agent.js";
export { reconcileRepo, type ReconciliationResult } from "./reconciler.js";
export { runCycle, getState, type OrchestratorState, type CycleResult } from "./orchestrator.js";
export { startDaemon, type DaemonHandle } from "./daemon.js";
export { BridgeClient, type BridgeConfig, type IncomingCommand } from "./bridge-client.js";
