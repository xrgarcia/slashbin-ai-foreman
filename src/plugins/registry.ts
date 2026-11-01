import type { WorkObserver, WorkSourceAdapter } from "../adapters.js";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { AgentRole, ForemanPlugin, PluginCommand, PluginContext, PluginRole, QaRunner } from "./contract.js";

/**
 * The plugin registry (EM#1150): the core's only way to reach a plugin.
 * Plugins are registered once (`plugins/index.ts`), the enabled ones started
 * once at startup, and every role is resolved here. Holds no plugin's code.
 */
const registered: ForemanPlugin[] = [];
const started: ForemanPlugin[] = [];
/** The observer each started plugin contributed, so stopping it can take it back out. */
const startedObservers = new Map<ForemanPlugin, WorkObserver>();

/** Observers in delivery order: started plugins' and directly added ones, as they arrived. */
const observerList: WorkObserver[] = [];
/** A work source set directly (tests, an embedding host); wins over a plugin's. */
let workSourceOverride: WorkSourceAdapter | null = null;

export function registerPlugin(p: ForemanPlugin): void {
  if (registered.some((r) => r.id === p.id)) throw new Error(`plugin "${p.id}" is registered twice`);
  registered.push(p);
}

export function registeredPlugins(): readonly ForemanPlugin[] {
  return registered;
}

/** Start every registered plugin this config enables, in registration order. */
export async function startPlugins(config: AgentConfig, ctx: PluginContext): Promise<readonly ForemanPlugin[]> {
  for (const p of registered) {
    if (started.includes(p)) continue;
    if (!p.enabled(config)) {
      const why = p.disabledReason?.(config);
      if (why) ctx.logger.info(why);
      continue;
    }
    await startOne(p, config, ctx);
  }
  return started;
}

/**
 * Apply a reloaded config (EM#1150): a plugin it newly enables starts, one it
 * disables stops and leaves the fan-out, one that stays on is reconfigured.
 * One plugin's failure never stops the rest.
 */
export async function reconfigurePlugins(config: AgentConfig, ctx: PluginContext): Promise<void> {
  for (const p of registered) {
    let action = "reload";
    try {
      const on = started.includes(p);
      const want = p.enabled(config);
      if (on && !want) {
        await stopOne(p);
        ctx.logger.info(`plugin ${p.id} switched off by config reload`);
      } else if (on) {
        action = "reconfigure";
        await p.reconfigure?.(config, ctx);
        syncObserver(p);
      } else if (want) {
        await startOne(p, config, ctx);
        ctx.logger.info(`plugin ${p.id} switched on by config reload`);
      }
    } catch (err) {
      ctx.logger.warn(`plugin ${p.id} ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function startOne(p: ForemanPlugin, config: AgentConfig, ctx: PluginContext): Promise<void> {
  await p.start?.(config, ctx);
  started.push(p);
  const o = p.roles.includes("observer") ? p.observer : undefined;
  if (o) {
    observerList.push(o);
    startedObservers.set(p, o);
  }
}

/**
 * A reconfigure may replace the plugin's observer (Paperclip restarts its mirror
 * when the company, agent, URL or identity changes). The fan-out follows: the new
 * observer takes the old one's place in delivery order, and the old one hears nothing more.
 */
function syncObserver(p: ForemanPlugin): void {
  const before = startedObservers.get(p);
  const now = p.roles.includes("observer") ? p.observer : undefined;
  if (before === now) return;
  const i = before ? observerList.indexOf(before) : -1;
  if (now) {
    if (i >= 0) observerList[i] = now;
    else observerList.push(now);
    startedObservers.set(p, now);
  } else {
    if (i >= 0) observerList.splice(i, 1);
    startedObservers.delete(p);
  }
}

async function stopOne(p: ForemanPlugin): Promise<void> {
  started.splice(started.indexOf(p), 1);
  const o = startedObservers.get(p);
  startedObservers.delete(p);
  if (o) {
    const i = observerList.indexOf(o);
    if (i >= 0) observerList.splice(i, 1);
  }
  await p.stop?.();
}

export async function stopPlugins(): Promise<void> {
  for (const p of [...started].reverse()) {
    try {
      await stopOne(p);
    } catch {
      // stopping is best-effort
    }
  }
}

/** The started plugins that fill `role`. */
export function pluginsFor(role: PluginRole): readonly ForemanPlugin[] {
  return started.filter((p) => p.roles.includes(role));
}

/**
 * The agent filling `role` for this config: a started plugin that this config
 * enables, or undefined when none does (the stage then does not run). The
 * phases reach the Tech Lead, the SRE, QA and the EM only through this.
 */
export function roleFor<R extends AgentRole>(role: R, config: AgentConfig): NonNullable<ForemanPlugin[R]> | undefined {
  for (const p of pluginsFor(role)) {
    const impl = p[role];
    if (impl && p.enabled(config)) return impl as NonNullable<ForemanPlugin[R]>;
  }
  return undefined;
}

/** The QA runner that covers `repo`, or undefined. */
export function qaFor(repo: RepoConfig, config: AgentConfig): QaRunner | undefined {
  for (const p of pluginsFor("qa")) {
    if (p.qa && p.enabled(config) && p.qa.covers(repo, config)) return p.qa;
  }
  return undefined;
}

/**
 * Whether this config enables a registered plugin filling `role`, started or
 * not: for startup warnings and the doctor, which judge a config without
 * starting anything.
 */
export function enabledFor(role: PluginRole, config: AgentConfig): boolean {
  return registered.some((p) => p.roles.includes(role) && p.enabled(config));
}

/** A CLI command any registered plugin adds, or undefined. */
export function pluginCommand(name: string): PluginCommand | undefined {
  for (const p of registered) {
    const c = p.commands?.[name];
    if (c) return c;
  }
  return undefined;
}

/** Every CLI command name registered plugins add. */
export function pluginCommandNames(): string[] {
  return registered.flatMap((p) => Object.keys(p.commands ?? {}));
}

/** Add an observer outside any plugin. No de-duplication: a double registration doubles its events visibly. */
export function addObserver(o: WorkObserver): void {
  observerList.push(o);
}

export function observers(): readonly WorkObserver[] {
  return observerList;
}

function anyObserver(ask: (o: WorkObserver) => boolean | undefined): boolean {
  return observerList.some((o) => {
    try {
      return ask(o) === true;
    } catch {
      return false;
    }
  });
}

/** Does any enabled observer want a session's report (goals, PR digest, review progress)? */
export function observersWantSessionReports(): boolean {
  return anyObserver((o) => o.wantsSessionReports?.());
}

/** Does any enabled observer want the board snapshot each pass? */
export function observersWantSnapshot(): boolean {
  return anyObserver((o) => o.wantsSnapshot?.() || o.wantsCards?.());
}

export function setWorkSource(adapter: WorkSourceAdapter | null): void {
  workSourceOverride = adapter;
}

/** The directly set work source, else the first started plugin's, else null (the caller's default). */
export function activeWorkSource(): WorkSourceAdapter | null {
  return workSourceOverride ?? pluginsFor("workSource").find((p) => p.workSource)?.workSource ?? null;
}

/** Tests only: forget every plugin and observer. */
export function resetRegistryForTests(): void {
  registered.length = 0;
  started.length = 0;
  startedObservers.clear();
  observerList.length = 0;
  workSourceOverride = null;
}
