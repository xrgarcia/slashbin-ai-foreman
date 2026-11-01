import type { WorkObserver, WorkSourceAdapter } from "../adapters.js";
import type { AgentConfig } from "../config.js";
import type { Logger } from "../logger.js";

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

/*
 * Role interfaces not yet carried through the plugin. Each is filled in by
 * the feature that moves its calls behind the registry (EM#1150 Deployment
 * Order); until then they mark the role and nothing more.
 */
export interface CodeHost {}
export interface Reviewer {}
export interface Verifier {}
export interface Deployer {}
export interface QaRunner {}
export interface Unsticker {}

export interface ForemanPlugin {
  readonly id: string;
  readonly roles: readonly PluginRole[];
  /** Whether this config turns the plugin on. Read at startup; a disabled plugin is never started or called. */
  enabled(config: AgentConfig): boolean;
  /** Why an apparently requested plugin is off, logged once at startup (e.g. a missing id). */
  disabledReason?(config: AgentConfig): string | undefined;
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
