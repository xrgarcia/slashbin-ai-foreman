#!/usr/bin/env node
// `npm run doctor [-- --config <path>]`: is this Foreman ready to run? A
// read-only check of everything the daemon needs before its first cycle — the
// tools, the tokens, the config, and per repo the checkout, the GitHub repo, the
// branches, the skills and the labels. One line per check:
//
//   PASS  <check> — <what was found>
//   WARN  <check> — <what will not work, and how to fix it>
//   FAIL  <check> — <why the Foreman cannot run, and how to fix it>
//
// Exits 1 on any FAIL; a WARN alone exits 0. `npm run setup` runs it last.
//
// Read-only by construction: gh is only ever called with `api` and no method
// flag (a GET) or with `auth status`; git only with `rev-parse`. A token is
// reported as set or unset, never printed.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist", "config.js");
if (!existsSync(built)) {
  console.log(`FAIL  build — ${built} not found. Run \`npm install && npm run build\`.`);
  process.exit(1);
}
const { loadConfig, findConfigFile } = await import(built);

const args = process.argv.slice(2);
const configArg = args.includes("--config") ? args[args.indexOf("--config") + 1] : args.find((a) => !a.startsWith("-"));

let failed = 0;
const line = (level, check, detail) => {
  if (level === "FAIL") failed++;
  console.log(`${level.padEnd(4)}  ${check} — ${detail}`);
};

const ghEnv = { ...process.env };
if (process.env.FOREMAN_GITHUB_TOKEN) ghEnv.GH_TOKEN = process.env.FOREMAN_GITHUB_TOKEN;
function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, env: ghEnv, ...opts }).trim();
}
function ghGet(path) {
  return JSON.parse(run("gh", ["api", path]) || "null");
}
function reason(err) {
  const text = `${err?.stderr ?? ""}`.trim() || `${err?.message ?? err}`;
  return text.split("\n")[0];
}

// --- Tools ---

const major = Number(process.versions.node.split(".")[0]);
if (major >= 18) line("PASS", "node", `v${process.versions.node}`);
else line("FAIL", "node", `v${process.versions.node}; the Foreman needs 18 or newer.`);

let haveGh = false;
for (const [tool, hint] of [["claude", "install Claude Code and log in: https://docs.claude.com/claude-code"], ["gh", "install the GitHub CLI: https://cli.github.com"]]) {
  try {
    line("PASS", tool, run(tool, ["--version"]).split("\n")[0]);
    if (tool === "gh") haveGh = true;
  } catch {
    line("FAIL", tool, `not found on PATH — ${hint}.`);
  }
}

// --- Config ---

const configFile = findConfigFile(configArg);
if (!configFile && !process.env.AI_AGENT_REPO_PATH) {
  line("FAIL", "config", `${configArg ?? ".ai-agent.json"} not found. Create it first: docs/setup.md, or ask Claude to "set up the Foreman".`);
  process.exit(1);
}
let config;
try {
  config = loadConfig(configArg);
  line("PASS", "config", `${configFile ?? "AI_AGENT_* env"} loads: ${config.repos.length} repo(s)`);
} catch (err) {
  line("FAIL", "config", `${configFile ?? "AI_AGENT_* env"} does not load: ${err?.message ?? err}`);
  process.exit(1);
}

// --- Tokens (set or unset; a value is never printed) ---

if (process.env.FOREMAN_GITHUB_TOKEN) {
  line("PASS", "FOREMAN_GITHUB_TOKEN", "set — gh runs as the Foreman's account");
} else if (haveGh) {
  try {
    run("gh", ["auth", "status"]);
    line("WARN", "FOREMAN_GITHUB_TOKEN", "unset — the Foreman will act as the account gh is logged in as. Set it to give the Foreman its own GitHub identity.");
  } catch {
    line("FAIL", "FOREMAN_GITHUB_TOKEN", "unset, and gh is not logged in. Set FOREMAN_GITHUB_TOKEN or run `gh auth login`.");
  }
}
const anyReview = config.repos.some((r) => r.reviewEnabled);
const syncs = config.stages.some((s) => s.type === "branch-sync");
if (process.env.TECHLEAD_GITHUB_KEY) line("PASS", "TECHLEAD_GITHUB_KEY", "set");
else if (anyReview) line("FAIL", "TECHLEAD_GITHUB_KEY", "unset, and review is enabled — the review stage refuses to run without the reviewer's own token.");
else if (syncs) line("WARN", "TECHLEAD_GITHUB_KEY", "unset — branch-sync PRs (production back into base) will open but not merge; merge them by hand or set it.");
if (config.srePath) {
  if (process.env.SRE_GITHUB_KEY) line("PASS", "SRE_GITHUB_KEY", "set");
  else line("FAIL", "SRE_GITHUB_KEY", "unset, and srePath is set — the verify stage refuses to run without it.");
}

// --- Per repo ---

const skillFile = (repo, path) => (path === "builtin:" ? join(root, "skills") : isAbsolute(path) ? path : resolve(repo.repoPath, path));

for (const repo of config.repos) {
  const at = `${repo.name}`;
  if (!existsSync(repo.repoPath)) {
    line("FAIL", `${at}: checkout`, `${repo.repoPath} does not exist. Clone ${repo.githubRepo} there, or fix repoPath.`);
  } else {
    try {
      run("git", ["-C", repo.repoPath, "rev-parse", "--is-inside-work-tree"]);
      line("PASS", `${at}: checkout`, repo.repoPath);
    } catch {
      line("FAIL", `${at}: checkout`, `${repo.repoPath} is not a git checkout.`);
    }
  }

  if (!haveGh) continue;
  let meta;
  try {
    meta = ghGet(`repos/${repo.githubRepo}`);
  } catch (err) {
    line("FAIL", `${at}: github`, `${repo.githubRepo} is not readable with this token — ${reason(err)}`);
    continue;
  }
  if (meta?.permissions && !meta.permissions.push) {
    line("FAIL", `${at}: github`, `${repo.githubRepo}: this account cannot push — the Foreman needs write access to open PRs and set labels.`);
  } else {
    line("PASS", `${at}: github`, `${repo.githubRepo}, write access`);
  }

  const branches = [["base", repo.baseBranch], ["feature", repo.featureBranch], ["production", repo.productionBranch]];
  const missing = [];
  for (const [role, b] of branches) {
    try {
      ghGet(`repos/${repo.githubRepo}/branches/${encodeURIComponent(b)}`);
    } catch {
      missing.push(`${role} "${b}"`);
    }
  }
  if (missing.length) line("FAIL", `${at}: branches`, `missing on GitHub: ${missing.join(", ")}. Create them, or set baseBranch / featureBranch / productionBranch.`);
  else line("PASS", `${at}: branches`, branches.map(([role, b]) => `${role} ${b}`).join(", "));

  for (const [key, path] of [["skillPath", repo.skillPath], ["revisionSkillPath", repo.revisionSkillPath]]) {
    if (!path) {
      line("WARN", `${at}: ${key}`, `unset — the session gets a short generic prompt. "builtin:" uses the skill shipped in skills/.`);
    } else if (existsSync(skillFile(repo, path))) {
      line("PASS", `${at}: ${key}`, path);
    } else {
      line("FAIL", `${at}: ${key}`, `${path} not found in ${repo.repoPath}. Use "builtin:" or fix the path.`);
    }
  }

  const wanted = [...new Set([repo.triggerLabel, ...Object.values(config.lifecycleLabels), config.github.blockedLabel])];
  try {
    const have = new Set(run("gh", ["api", `repos/${repo.githubRepo}/labels`, "--paginate", "--jq", ".[].name"]).split("\n"));
    const absent = wanted.filter((l) => !have.has(l));
    if (absent.length) line("FAIL", `${at}: labels`, `missing ${absent.map((l) => `"${l}"`).join(", ")}. Run \`npm run labels:install\`.`);
    else line("PASS", `${at}: labels`, `all ${wanted.length} present`);
  } catch (err) {
    line("FAIL", `${at}: labels`, `could not read labels — ${reason(err)}`);
  }
}

console.log(failed ? `\n${failed} check(s) failed — the Foreman is not ready.` : "\nReady. Start it with `npm start`.");
process.exit(failed ? 1 : 0);
