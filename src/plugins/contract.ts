import type { WorkObserver, WorkSourceAdapter } from "../adapters.js";
import type { CodeHost } from "../code-host.js";
import type { ReviewResult, ReviewTrailer } from "../agent.js";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { QaOutcome } from "../qa-report.js";
import type { ReviewMilestone } from "../review-progress.js";

/**
 * The one contract every Foreman plugin implements (EM#1150). The core never
 * imports a plugin: it asks the registry (`registry.ts`) for the enabled
 * plugins that fill a role and calls them. GitHub, Paperclip and each agent
 * (Tech Lead, SRE, QA, EM) are plugins; `plugins/index.ts` is the only file
 * that names them.
 *
 * This module, like `adapters.ts`, stays free of any plugin's code so a plugin
 * can import it alone.
 */
export type PluginRole =
  | "workSource" // selects work and records its moves (adapters.ts)
  | "codeHost" // PRs, labels, comments, checks, branches, releases
  | "observer" // hears every event; every enabled observer is called
  | "reviewer" // reviews and merges a PR
  | "verifier" // verifies a merge on dev, and production
  | "deployer" // ships a release
  | "qa" // checks a change before or after merge
  | "unstick"; // takes stuck work to someone who can move it

/** What a plugin is handed when it starts or reloads. */
export interface PluginContext {
  readonly logger: Logger;
  /** The config file's current text, or null when there is none. */
  configText(): string | null;
}

/** A command a plugin adds to the CLI (`slashbin-ai-agent <name>`). Resolves true on success. */
export type PluginCommand = (config: AgentConfig) => Promise<boolean>;

/** The code-host role (EM#1150 f5): every PR, branch, merge, comment and label operation. */
export type { CodeHost } from "../code-host.js";

// --- Agent roles (EM#1150 f3). Each returns the outcome the phases consume;
// how the agent is run, and how its exit code and trailers are read, stay
// inside the plugin. ---

/** A review that could not be taken and wrote nothing (Tech Lead exit 3): offered again later. */
export type ReviewFallback = { fallback: true; reason: string };

/** How a reviewer answered a promotion approval. */
export type PromotionApproval =
  | { kind: "approved" }
  /** The reviewer looked and refused. A person must decide. */
  | { kind: "refused"; reason: string }
  /** It could not run, an error, a timeout: ask again later. */
  | { kind: "retry"; reason: string };

export interface Reviewer {
  /**
   * Review (and merge) one PR. `noMerge` approves and stops; `mergeApprovedSha`
   * merges exactly that head on the reviewer's own approval and never judges
   * (qaBeforeMerge).
   */
  reviewPr(
    repo: RepoConfig, config: AgentConfig, pr: number, logger: Logger,
    abortSignal?: AbortSignal, transcriptPath?: string, onProgress?: (m: ReviewMilestone) => void,
    noMerge?: boolean, mergeApprovedSha?: string,
  ): Promise<ReviewResult | ReviewFallback>;
  /** Approve release PR `pr` at exactly `sha`; the deployer refuses one without it. */
  approvePromotion(
    repo: RepoConfig, config: AgentConfig, pr: number, sha: string, logger: Logger,
    abortSignal?: AbortSignal, transcriptPath?: string,
  ): Promise<PromotionApproval>;
}

/** Errors a verifier excluded from a verification, with the evidence links beside them. */
export interface UnrelatedErrors { errors: string[]; evidence: string[] }

/** What a verification came back with. */
export type VerifyResult =
  /** Finished with a verdict: `pass` advances the issue; anything else holds it. */
  | { kind: "verdict"; pass: boolean; trailer: ReviewTrailer; reason?: string; summary: string; by?: "QA"; unrelated?: UnrelatedErrors }
  /** No verdict: an error or a timeout. Nothing was written. */
  | { kind: "error"; error: string };

export interface Verifier {
  /** Verify one merged PR on dev. */
  verifyDev(repo: RepoConfig, config: AgentConfig, pr: number, logger: Logger, abortSignal?: AbortSignal, transcriptPath?: string): Promise<VerifyResult>;
  /** Verify a merged release PR in production, or run its soak (nothing left to soak: `{ kind: "nothing" }`). */
  verifyProd(
    repo: RepoConfig, config: AgentConfig, pr: number, logger: Logger,
    abortSignal?: AbortSignal, transcriptPath?: string, mode?: "prod" | "soak",
  ): Promise<VerifyResult | { kind: "nothing"; reason: string }>;
}

/** What a deploy reported on its last line. */
export interface DeployTrailer {
  pr: number;
  merged: boolean;
  mergeSha: string | null;
  verify: "pass" | "hold" | "fail" | "none";
  hold?: string;
  evidence?: string;
}

/** What a deploy came back with. */
export type DeployResult =
  | { kind: "trailer"; trailer: DeployTrailer; unrelated?: UnrelatedErrors }
  /** A precondition was refused (PR not open, head moved, no approval at that head); nothing ran. */
  | { kind: "refused"; reason: string }
  /** It could not run, a timeout or any other failure: nothing merged that the Foreman knows of; ask again later. */
  | { kind: "retry"; reason: string };

export interface Deployer {
  /** Merge release PR `pr` at `sha`, wait for the deploy and verify production. Never tags, relabels or closes. */
  deploy(
    repo: RepoConfig, config: AgentConfig, pr: number, sha: string, logger: Logger,
    abortSignal?: AbortSignal, transcriptPath?: string,
  ): Promise<DeployResult>;
}

export interface QaRunner {
  /** Whether QA checks this repo. */
  covers(repo: RepoConfig, config: AgentConfig): boolean;
  /**
   * Check PR `pr`, writing its manifest under `out`: on dev (`local` false), or
   * booted locally from the PR (`local` true, before the merge).
   */
  check(
    repo: RepoConfig, config: AgentConfig, args: { repo: string; pr: number; out: string; local: boolean }, logger: Logger,
  ): Promise<QaOutcome>;
}

/** How an unstick call was answered. The Foreman never clears a block on any of them. */
export type UnstickOutcome =
  /** It acted; the block is released by the normal unblock checks, not by this. */
  | { kind: "invoked"; detail: string }
  /** It escalated to a person; no retry until the reason changes. */
  | { kind: "escalated"; detail: string }
  | { kind: "declined"; detail: string }
  /** Anything else (error, timeout, not configured): retried up to the attempt cap. */
  | { kind: "failed"; detail: string };

export interface Unsticker {
  unstick(
    repo: RepoConfig, config: AgentConfig, issue: number, kind: string, reason: string, logger: Logger,
    abortSignal?: AbortSignal, transcriptPath?: string,
  ): Promise<UnstickOutcome>;
}

/** The agent roles, each named as its field on ForemanPlugin. */
export type AgentRole = "reviewer" | "verifier" | "deployer" | "qa" | "unstick";

export interface ForemanPlugin {
  readonly id: string;
  readonly roles: readonly PluginRole[];
  /** Whether this config turns the plugin on. Read at startup; a disabled plugin is never started or called. */
  enabled(config: AgentConfig): boolean;
  /** Why an apparently requested plugin is off, logged once at startup (e.g. a missing id). */
  disabledReason?(config: AgentConfig): string | undefined;
  /**
   * Whether this config has the plugin fill `role`, for a plugin with several roles
   * that a config may select one at a time (GitHub as work source, code host, or
   * both). Absent: an enabled plugin fills every role it lists.
   */
  fills?(role: PluginRole, config: AgentConfig): boolean;
  start?(config: AgentConfig, ctx: PluginContext): void | Promise<void>;
  /** A config reload. Only started plugins are told. */
  reconfigure?(config: AgentConfig, ctx: PluginContext): void | Promise<void>;
  stop?(): void | Promise<void>;
  /** CLI commands this plugin adds, runnable whether or not it is enabled. */
  readonly commands?: Readonly<Record<string, PluginCommand>>;

  // Role implementations. Read after `start`, so a plugin may build them there.
  readonly workSource?: WorkSourceAdapter;
  readonly codeHost?: CodeHost;
  readonly observer?: WorkObserver;
  readonly reviewer?: Reviewer;
  readonly verifier?: Verifier;
  readonly deployer?: Deployer;
  readonly qa?: QaRunner;
  readonly unstick?: Unsticker;
}
