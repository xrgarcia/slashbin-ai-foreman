import type { WorkObserver, WorkSourceAdapter } from "../adapters.js";
import type { AgentConfig } from "../config.js";
import type { ForemanPlugin, PluginCommand, PluginContext, PluginRole } from "./contract.js";

/**
 * The plugin registry (EM#1150): the core's only way to reach a plugin.
 * Plugins are registered once (`plugins/index.ts`), the enabled ones started
 * once at startup, and every role is resolved here. Holds no plugin's code.
 */
const registered: ForemanPlugin[] = [];
const started: ForemanPlugin[] = [];

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
    await p.start?.(config, ctx);
    started.push(p);
    if (p.roles.includes("observer") && p.observer) observerList.push(p.observer);
  }
  return started;
}

/** Hand a reloaded config to every started plugin. One plugin's failure never stops the rest. */
export async function reconfigurePlugins(config: AgentConfig, ctx: PluginContext): Promise<void> {
  for (const p of started) {
    try {
      await p.reconfigure?.(config, ctx);
    } catch (err) {
      ctx.logger.warn(`plugin ${p.id} reconfigure failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function stopPlugins(): Promise<void> {
  for (const p of started.splice(0).reverse()) {
    try {
      await p.stop?.();
    } catch {
      // stopping is best-effort
    }
  }
}

/** The started plugins that fill `role`. */
export function pluginsFor(role: PluginRole): readonly ForemanPlugin[] {
  return started.filter((p) => p.roles.includes(role));
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
  observerList.length = 0;
  workSourceOverride = null;
}
