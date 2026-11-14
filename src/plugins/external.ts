import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ForemanPlugin } from "./contract.js";
import { registerPlugin } from "./registry.js";

/** What an external plugin module's factory is handed. */
export interface ExternalPluginContext {
  readonly config: AgentConfig;
  readonly logger: Logger;
}

/** The shapes a module's default export (or its `plugin` export) may take. */
export type ExternalPluginExport =
  | ForemanPlugin
  | readonly ForemanPlugin[]
  | ((ctx: ExternalPluginContext) => ForemanPlugin | readonly ForemanPlugin[] | Promise<ForemanPlugin | readonly ForemanPlugin[]>);

/** A specifier as `import()` takes it: a path becomes a file URL (relative to the config file's directory), a package name stays. */
export function moduleSpecifier(spec: string, baseDir: string): string {
  if (spec.startsWith("~/")) return pathToFileURL(resolve(homedir(), spec.slice(2))).href;
  if (isAbsolute(spec) || spec.startsWith("./") || spec.startsWith("../")) return pathToFileURL(resolve(baseDir, spec)).href;
  return spec;
}

/** The first problem with a value claimed to be a plugin, or null. */
function pluginProblem(p: unknown): string | null {
  const x = p as Partial<ForemanPlugin> | null;
  if (!x || typeof x !== "object") return "is not an object";
  if (typeof x.id !== "string" || !x.id) return "has no string `id`";
  if (!Array.isArray(x.roles)) return "has no `roles` array";
  if (typeof x.enabled !== "function") return "has no `enabled(config)` function";
  if (!x.catalog || typeof x.catalog !== "object") return "has no `catalog`";
  return null;
}

/**
 * Import each module `config.plugins` lists and register the plugin(s) it exports, through the same
 * registry the built-ins use (docs/plugins.md). Called once at startup, after `registerBuiltinPlugins`
 * and before `startPlugins`. One module failing (missing, throws, wrong shape, an id already
 * registered) is logged and skipped: the Foreman then runs without that plugin, which for a change
 * signal means polling in full. Returns the ids registered.
 */
export async function registerExternalPlugins(config: AgentConfig, logger: Logger, baseDir: string): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of config.plugins ?? []) {
    try {
      const mod = (await import(moduleSpecifier(spec, baseDir))) as { default?: ExternalPluginExport; plugin?: ExternalPluginExport };
      const exported = mod.default ?? mod.plugin;
      if (exported === undefined) throw new Error("exports neither `default` nor `plugin`");
      const made = typeof exported === "function" ? await exported({ config, logger }) : exported;
      const plugins = Array.isArray(made) ? made : [made as ForemanPlugin];
      for (const p of plugins) {
        const problem = pluginProblem(p);
        if (problem) throw new Error(`an exported plugin ${problem}`);
        registerPlugin(p);
        ids.push(p.id);
        logger.info(`registered external plugin ${p.id} from ${spec}`);
      }
    } catch (err) {
      logger.warn(`external plugin "${spec}" not loaded — running without it: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  return ids;
}
