import { registerPlugin, registeredPlugins } from "./registry.js";
import { GitHubPlugin } from "./github.js";
import { PaperclipPlugin } from "./paperclip.js";
import { MetricsPlugin } from "./metrics.js";
import { TechLeadPlugin } from "./tech-lead.js";
import { SrePlugin } from "./sre.js";
import { QaPlugin } from "./qa.js";
import { EmPlugin } from "./em.js";
import type { ForemanRuntime } from "../runtime.js";

// The package's GitHub exports (src/index.ts) come through the composition root,
// the one core file that may name plugin code.
export { hasPendingRevisions, verifyPRExists } from "../github.js";
export { GitHubIssueConnector } from "../github-work-source.js";

/**
 * The composition root (EM#1150): the only file that names a plugin. The CLI
 * calls `registerBuiltinPlugins` once; everything else reaches plugins through
 * the registry. Idempotent.
 */
export function registerBuiltinPlugins(runtime: ForemanRuntime): void {
  if (registeredPlugins().length > 0) return;
  registerPlugin(new GitHubPlugin((repo) => runtime.builds.isInFlight(repo)));
  registerPlugin(new PaperclipPlugin(runtime));
  registerPlugin(new MetricsPlugin());
  registerPlugin(new TechLeadPlugin());
  registerPlugin(new SrePlugin());
  registerPlugin(new QaPlugin());
  registerPlugin(new EmPlugin());
}
