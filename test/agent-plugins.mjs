// Test helper (EM#1150 f3): the phases reach the Tech Lead, SRE, QA and EM only
// through the plugin registry, so a test that drives a phase registers and
// starts the four agent plugins first. Each still checks its own path key
// against the config the phase is given, exactly as in the daemon.
import { registerPlugin, registeredPlugins, startPlugins } from "../dist/plugins/registry.js";
import { TechLeadPlugin } from "../dist/plugins/tech-lead.js";
import { SrePlugin } from "../dist/plugins/sre.js";
import { QaPlugin } from "../dist/plugins/qa.js";
import { EmPlugin } from "../dist/plugins/em.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const ALL_ON = { techLeadPath: "/x", srePath: "/x", qaPath: "/x", emRepoPath: "/x", qaRepos: [], paperclip: { enabled: false } };

export async function startAgentPlugins() {
  const have = new Set(registeredPlugins().map((p) => p.id));
  for (const p of [new TechLeadPlugin(), new SrePlugin(), new QaPlugin(), new EmPlugin()]) if (!have.has(p.id)) registerPlugin(p);
  await startPlugins(ALL_ON, { logger: quiet, configText: () => null });
}
