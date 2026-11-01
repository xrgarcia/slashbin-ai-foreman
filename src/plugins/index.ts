import { registerPlugin, registeredPlugins } from "./registry.js";
import { GitHubPlugin } from "./github.js";
import { PaperclipPlugin } from "./paperclip.js";
import { TechLeadPlugin } from "./tech-lead.js";
import { SrePlugin } from "./sre.js";
import { QaPlugin } from "./qa.js";
import { EmPlugin } from "./em.js";

/**
 * The composition root (EM#1150): the only file that names a plugin. The CLI
 * calls `registerBuiltinPlugins` once; everything else reaches plugins through
 * the registry. Idempotent.
 */
export function registerBuiltinPlugins(): void {
  if (registeredPlugins().length > 0) return;
  registerPlugin(new GitHubPlugin());
  registerPlugin(new PaperclipPlugin());
  registerPlugin(new TechLeadPlugin());
  registerPlugin(new SrePlugin());
  registerPlugin(new QaPlugin());
  registerPlugin(new EmPlugin());
}
