import { registerPlugin, registeredPlugins } from "./registry.js";
import { PaperclipPlugin } from "./paperclip.js";

/**
 * The composition root (EM#1150): the only file that names a plugin. The CLI
 * calls `registerBuiltinPlugins` once; everything else reaches plugins through
 * the registry. Idempotent.
 */
export function registerBuiltinPlugins(): void {
  if (registeredPlugins().length > 0) return;
  registerPlugin(new PaperclipPlugin());
}
