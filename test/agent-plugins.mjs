// Test helper (EM#1150 f3, f4): the phases reach the Tech Lead, SRE, QA and EM,
// and the work source, only through the plugin registry, so a test that drives
// a phase registers and starts those plugins first. Each still checks its own
// path key against the config the phase is given, exactly as in the daemon.
import { registerPlugin, registeredPlugins, startPlugins } from "../dist/plugins/registry.js";
import { TechLeadPlugin } from "../dist/plugins/tech-lead.js";
import { SrePlugin } from "../dist/plugins/sre.js";
import { QaPlugin } from "../dist/plugins/qa.js";
import { EmPlugin } from "../dist/plugins/em.js";
import { GitHubPlugin } from "../dist/plugins/github.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const ALL_ON = { techLeadPath: "/x", srePath: "/x", qaPath: "/x", emRepoPath: "/x", qaRepos: [], paperclip: { enabled: false } };

async function start(plugins, config) {
  const have = new Set(registeredPlugins().map((p) => p.id));
  for (const p of plugins) if (!have.has(p.id)) registerPlugin(p);
  await startPlugins(config, { logger: quiet, configText: () => null });
}

/** The four agent plugins and the GitHub work source. */
export async function startAgentPlugins() {
  await start([new GitHubPlugin(), new TechLeadPlugin(), new SrePlugin(), new QaPlugin(), new EmPlugin()], ALL_ON);
}

/** The GitHub work source alone, as the daemon starts it (a fake `gh` first on PATH answers it). */
export async function startGitHubWorkSource() {
  await start([new GitHubPlugin()], { paperclip: { enabled: false } });
}
