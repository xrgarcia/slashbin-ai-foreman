export {
  loadConfig, defaultLifecycleLabels, type AgentConfig, type RepoConfig, type LifecycleLabels,
} from "./config.js";
export {
  BUILTIN_STAGES, defaultStages, type StageEntry, type StageType, type StageOutcome,
} from "./stages.js";
export { createLogger, type Logger, type LogLevel } from "./logger.js";
export { hasPendingRevisions, verifyPRExists, GitHubIssueConnector } from "./plugins/index.js";
export type { WorkItem, WorkSourceAdapter, WorkObserver, WorkEvent, SnapshotItem, SnapshotCard, SnapshotHold } from "./adapters.js";
export { DEFAULT_BACKOFF, backoffDelay, type BackoffConfig, type BackoffWindow } from "./backoff.js";
export { STAGES, MOVES, transition, type Stage, type Move, type Transition } from "./lifecycle.js";
export { ClaudeTrust, claudeConfigPath } from "./claude-trust.js";
export { ForemanRuntime } from "./runtime.js";
export { implementApprovedIssues } from "./phases/implement-workflow.js";
export { revisePRFeedback } from "./phases/revise-workflow.js";
export type { ImplementationResult, RevisionResult } from "./session/protocol.js";
export { reconcileRepo, type ReconciliationResult } from "./reconciler.js";
export { runCycle, runRepoPass, runLanePass, getState, type OrchestratorState, type CycleResult } from "./orchestrator.js";
export { lanesFor, type Lane } from "./lanes.js";
export { startDaemon, type DaemonHandle } from "./daemon.js";
export { registerBuiltinPlugins } from "./plugins/index.js";
export { startPlugins } from "./plugins/registry.js";
export { BridgeClient, type BridgeConfig, type IncomingCommand } from "./bridge-client.js";
