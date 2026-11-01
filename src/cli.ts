#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findConfigFile, loadConfig, type AgentConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startDaemon } from "./daemon.js";
import { runCycle } from "./orchestrator.js";
import { configureClaudeTrust, trustManagedRepos } from "./claude-trust.js";
import { claimPidFile, releasePidFile } from "./pidfile.js";
import { buildRefusal } from "./build-info.js";
import { registerBuiltinPlugins } from "./plugins/index.js";
import { pluginCommand, reconfigurePlugins, startPlugins } from "./plugins/registry.js";
import type { PluginContext } from "./plugins/contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  console.log(`
slashbin-ai-agent v${getVersion()}

Usage: slashbin-ai-agent [options]
       slashbin-ai-agent paperclip:doctor [--config <path>]

Options:
  --config <path>  Path to .ai-agent.json config file
  --repo <name>    Only process this repo (must match a name in repos[])
  --once           Run a single poll cycle and exit
  --version        Print version and exit
  --help           Show this help message

Commands:
  npm run setup     Install, build, install the labels, then run the doctor (needs a config)
  npm run doctor    Is the Foreman ready to run? Tools, tokens, config, and per repo the
                    checkout, branches, skills and labels (read-only; exits non-zero on any FAIL)
  paperclip:doctor  Check Paperclip reachability, company, agent registration, and config
                    (read-only; prints PASS/FAIL per check, exits non-zero on any FAIL)

Multi-repo: configure repos[] in .ai-agent.json. Each repo entry has its own
repoPath, githubRepo, baseBranch, featureBranch, triggerLabel, skillPath, prompt.
Top-level values are defaults. Use --repo to run one repo per daemon instance.

Single-repo (backward compat): omit repos[] and set repoPath/githubRepo directly.

Environment variables:
  AI_AGENT_REPO_PATH        Path to local repo clone (default: .)
  AI_AGENT_GITHUB_REPO      GitHub repo owner/name
  AI_AGENT_TRIGGER_LABEL    Trigger label (default: approved)
  AI_AGENT_POLL_INTERVAL_MS Poll interval in ms (default: 300000)
  AI_AGENT_ISSUE_CACHE_TTL_MS   Open-issue snapshot TTL in ms (default: 30000; 0 disables)
  AI_AGENT_ISSUE_SNAPSHOT_LIMIT Max open issues fetched per snapshot (default: 500)
  AI_AGENT_SKILL_PATH       Path to skill file
  AI_AGENT_BASE_BRANCH      PR target branch (default: develop)
  AI_AGENT_FEATURE_BRANCH   Commit branch (default: features)
  AI_AGENT_PRODUCTION_BRANCH  Production branch for sync/promotion (default: main)
  AI_AGENT_MAX_TURNS        Max agent turns (default: 30)
  AI_AGENT_LOG_FORMAT       json or text (default: text)
  AI_AGENT_LOG_LEVEL        debug, info, warn, error (default: info)
`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    console.log(getVersion());
    process.exit(0);
  }

  if (args.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  const configPath = getArg(args, "--config");
  const repoFilter = getArg(args, "--repo");
  const once = args.includes("--once");

  // A plugin's own command (e.g. the read-only `paperclip:doctor`). Handled here,
  // before anything that needs a GitHub token, a logger or the PID file: a
  // plugin command needs only the config.
  registerBuiltinPlugins();
  const command = args[0] ? pluginCommand(args[0]) : undefined;
  if (command) {
    let doctorConfig;
    try {
      doctorConfig = loadConfig(configPath);
    } catch (err) {
      console.log(`FAIL: config-complete — the config does not load: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    const allPassed = await command(doctorConfig);
    process.exit(allPassed ? 0 : 1);
  }

  // No config file and no repo in the env: loadConfig would default repoPath to
  // "." and infer githubRepo from this checkout's remote — the Foreman would
  // build issues on its own repo. Refuse, and say how to set it up.
  if (!findConfigFile(configPath) && !process.env.AI_AGENT_REPO_PATH) {
    console.error(
      configPath
        ? `Configuration error: ${configPath} not found.`
        : "Configuration error: no .ai-agent.json (or ai-agent.config.json) in this directory, and AI_AGENT_REPO_PATH is unset.\n" +
          "Set the Foreman up first: see docs/setup.md, or ask Claude to \"set up the Foreman\". Then run `npm run setup`.",
    );
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Filter to a single repo if --repo is specified
  if (repoFilter) {
    const match = config.repos.find((r) => r.name === repoFilter);
    if (!match) {
      const available = config.repos.map((r) => r.name).join(", ");
      console.error(`No repo named "${repoFilter}". Available: ${available}`);
      process.exit(1);
    }
    config = { ...config, repos: [match], allRepos: config.repos };
  }

  const logger = createLogger({
    format: config.logFormat,
    level: config.logLevel,
  });

  logger.info(`slashbin-ai-agent v${getVersion()}`);

  // Plugins (EM#1150): every registered plugin this config enables is started
  // here. A config reload starts one it newly enables, stops one it disables,
  // and hands the reloaded config to one that stays on.
  const pluginCtx: PluginContext = {
    logger,
    configText: () => {
      const p = findConfigFile(configPath);
      return p ? readFileSync(p, "utf-8") : null;
    },
  };
  await startPlugins(config, pluginCtx);

  if (once) {
    // Single cycle mode. The daemon does this on start and reload; --once must
    // too, or trustManagedRepos: false would be ignored here.
    configureClaudeTrust({ enabled: config.trustManagedRepos });
    trustManagedRepos(config.repos, logger);
    try {
      const { lastImplementation } = await runCycle(config, logger, 1);
      process.exit(lastImplementation?.success === false ? 1 : 0);
    } catch (err) {
      logger.error("Cycle failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  } else {
    // Daemon mode.
    //
    // Only a committed build runs as the daemon (src/build-info.ts).
    const refusal = buildRefusal(__dirname);
    if (refusal) {
      logger.error(`Refusing to start: ${refusal}`);
      // 78 (EX_CONFIG): a restart cannot fix an uncommitted build, so the unit's
      // RestartPreventExitStatus=78 stops on it instead of retrying every 30s
      // (45 refused starts in a row, 2026-10-14 5:43-6:12 pm CT).
      process.exit(78);
    }

    // Register the PID before starting any work. This is what makes `status`,
    // `stop` and `restart` see a daemon no matter how it was launched, and it
    // is the guard against a second daemon reviewing and merging the same PRs.
    const claim = claimPidFile(repoFilter);
    if (!claim.ok) {
      logger.error(
        `A daemon is already running for this scope (PID ${claim.pid}) — refusing to start a second. ` +
        `Two agents would review and merge the same PRs. Stop that one first.`
      );
      process.exit(1);
    }

    const onReload = (fresh: AgentConfig): void => {
      void reconfigurePlugins(fresh, pluginCtx);
    };
    const daemon = startDaemon(config, logger, { configPath, repoFilter, onReload });

    const shutdown = async () => {
      await daemon.stop();
      releasePidFile(claim.path);
      process.exit(0);
    };

    // Covers the paths shutdown() never reaches (a plain return, process.exit
    // elsewhere). Leaving a stale file behind is recoverable — claimPidFile
    // takes over a dead PID — but cleaning up keeps `status` honest.
    process.on("exit", () => releasePidFile(claim.path));

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    process.on("uncaughtException", (err) => {
      logger.error("Uncaught exception", { error: err.message });
      shutdown();
    });

    process.on("unhandledRejection", (reason) => {
      logger.error("Unhandled rejection", {
        error: reason instanceof Error ? reason.message : String(reason),
      });
    });
  }
}

main();
