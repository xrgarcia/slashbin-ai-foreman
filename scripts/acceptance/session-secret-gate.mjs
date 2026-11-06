#!/usr/bin/env node
/**
 * Acceptance for the Foreman's session secret gate — every Claude session the
 * Foreman spawns runs under a PreToolUse Bash hook that blocks commands which
 * would PRINT an environment or credential value, while commands that merely
 * USE one (gh, curl with an Authorization header) still run.
 *
 * Why: 2026-10-01 an e2e stage session ran `env`; FOREMAN_GITHUB_TOKEN landed
 * in that session's transcript and had to be rotated. Sessions hold GH_TOKEN
 * and run with --dangerously-skip-permissions in the service repo, so neither
 * a permission prompt nor the EM's own hooks applied. The env allowlist (#62)
 * narrowed what a session holds; it does nothing about printing what it holds.
 *
 * Front doors:
 *   A. the BUILT spawn path — implementApprovedIssues / revisePRFeedback /
 *      runCustomStage from dist/phases/*-workflow.js with a fake `claude` first on PATH
 *      that records its argv. Each must carry --settings whose PreToolUse Bash
 *      hook points at a file that exists.
 *   B. that hook command, run exactly as Claude Code runs it (JSON on stdin),
 *      with a DUMMY token in its env. Deny = exit 2, stderr names a safe path,
 *      stdout+stderr never contain the dummy value. Allow = exit 0.
 *   C. source: one `spawn("claude"` site, so no session can bypass the gate.
 *   D. the same hook on file tools (Read / Grep / Edit): a credential file —
 *      .env and .env.* (not .env.example / .sample), ~/.netrc, ~/.git-credentials,
 *      gh hosts.yml, doppler config, /proc/<pid>/environ — is blocked.
 * No Anthropic, no GitHub, no real credential anywhere.
 *
 * RED on features 3d2f222 (no gate at all); A and D red on 2c20bf2 (Bash-only gate).
 *
 *   node scripts/acceptance/session-secret-gate.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DUMMY = "dummy-gate-value-0123456789abcdef";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), "foreman-secret-gate-"));
const bin = join(tmp, "bin");
mkdirSync(bin);
const argvLog = join(tmp, "argv.jsonl");
writeFileSync(join(bin, "claude"),
  `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write("done\\n");\n`);
// The implement path reads the branch head first (github/branch.ts getRemoteBranchSha): answer it with a fixed sha.
writeFileSync(join(bin, "gh"), "#!/bin/sh\ncase \"$*\" in *branches/*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; *) echo '[]';; esac\n");
chmodSync(join(bin, "claude"), 0o755);
chmodSync(join(bin, "gh"), 0o755);

const saved = { PATH: process.env.PATH, TOKEN: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
process.env.PATH = `${bin}:${saved.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = DUMMY;
for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
process.chdir(tmp);

let hookCommand = null;
try {
  // agent.ts was split (EM#1267): the three session entry points now live in phases/*-workflow.
  const distOf = (f) => join(DIR, "dist", f);
  for (const f of ["phases/implement-workflow.js", "phases/revise-workflow.js", "phases/custom-workflow.js"]) {
    if (!existsSync(distOf(f))) { console.error(`no build at ${distOf(f)}`); process.exit(2); }
  }
  const agent = {
    ...(await import(pathToFileURL(distOf("phases/implement-workflow.js")).href)),
    ...(await import(pathToFileURL(distOf("phases/revise-workflow.js")).href)),
    ...(await import(pathToFileURL(distOf("phases/custom-workflow.js")).href)),
  };
  const { loadConfig } = await import(pathToFileURL(join(DIR, "dist", "config.js")).href);
  const { createLogger } = await import(pathToFileURL(join(DIR, "dist", "logger.js")).href);
  // Claude trust lives on the runtime (Foreman #203); the spawn paths take it first.
  const { ForemanRuntime } = await import(pathToFileURL(join(DIR, "dist", "runtime.js")).href);
  const { trust } = new ForemanRuntime();
  // The core reaches the code host through the plugin registry (EM#1150 f5); a bare script has none
  // started, so install the built-in GitHub plugin's hosts directly (pure; they only run `gh`, here a fake).
  const imp2 = (f) => import(pathToFileURL(join(DIR, "dist", f)).href);
  {
    const reg = await imp2("plugins/registry.js");
    const { GitHubPlugin } = await imp2("plugins/github.js");
    const ghPlugin = new GitHubPlugin();
    reg.setCodeHost(ghPlugin.codeHost);
    reg.setWorkSource(ghPlugin.workSource);
  }
  const logger = createLogger({ format: "text", level: "error" });
  const repoDir = join(tmp, "repo");
  mkdirSync(repoDir);
  const cfgPath = join(tmp, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify({ repos: [{ name: "t", repoPath: repoDir, githubRepo: "example/t" }] }));
  const cfg = loadConfig(cfgPath);
  const repo = { ...cfg.repos[0], skillPath: "builtin:", revisionSkillPath: "builtin:" };

  // ── A: every spawn path carries the gate ──
  const settingsOf = (argv) => {
    const i = argv.indexOf("--settings");
    if (i < 0) return null;
    const raw = argv[i + 1];
    try { return JSON.parse(raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf8")); } catch { return null; }
  };
  const covers = (h, tool) => { try { return new RegExp(`^(?:${h.matcher})$`).test(tool); } catch { return false; } };
  const bashHook = (s) => {
    const h = s?.hooks?.PreToolUse?.find((x) => covers(x, "Bash"));
    // The same hook must also see every tool that returns file content.
    if (h && !["Read", "Grep", "Edit"].every((t) => covers(h, t))) return null;
    return h?.hooks?.[0]?.command ?? null;
  };
  const paths = [
    ["implement", () => agent.implementApprovedIssues(trust, repo, logger)],
    ["revise", () => agent.revisePRFeedback(trust, repo, logger, undefined, 7, [3])],
    ["custom stage", () => agent.runCustomStage(trust, repo, { id: "lint", skillPath: "/opt/lint/SKILL.md" },
      { prNumber: 7, headSha: "a".repeat(40), issueNumbers: [3] }, logger)],
  ];
  for (const [name, call] of paths) {
    rmSync(argvLog, { force: true });
    try { await call(); } catch { /* the fake returns nothing useful; argv is what matters */ }
    const lines = existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean) : [];
    if (lines.length === 0) { check(`A ${name}: spawned a session`, false, "fake claude never ran"); continue; }
    const cmd = bashHook(settingsOf(JSON.parse(lines[0])));
    hookCommand ??= cmd;
    const file = cmd?.match(/"([^"]+\.m?js)"\s*$/)?.[1] ?? cmd?.split(/\s+/).pop();
    check(`A ${name}: --settings carries a PreToolUse hook on Bash, Read, Grep and Edit`, !!cmd, cmd ?? "no --settings / no Bash hook");
    check(`A ${name}: the hook file exists`, !!file && existsSync(file), file ?? "");
  }

  // ── B: the hook, run as Claude Code runs it ──
  if (!hookCommand) {
    check("B hook command resolved", false);
  } else {
    const run = (command) => spawnSync("/bin/sh", ["-c", hookCommand], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: DUMMY, MY_API_KEY: DUMMY },
      timeout: 10_000,
    });
    const deny = [
      "env", "printenv", "printenv GH_TOKEN", "env | grep GH", "export -p", "set", "declare -px",
      "echo $GH_TOKEN", 'echo "token=${GH_TOKEN}"', "printf '%s' \"$MY_API_KEY\"",
      "cat /proc/self/environ", "cat /proc/1234/cmdline", "ps aux", "ps -ef", "pgrep -a node",
      "gh auth token", "gh auth status --show-token", "gh auth status -t",
      "git config --get-all http.https://github.com/.extraheader", "echo url=https://github.com | git credential fill",
      "set -x; gh pr list", "bash -x deploy.sh",
      `node -e 'console.log(process.env)'`, `node -e 'console.log(process.env.GH_TOKEN)'`,
      `python3 -c 'import os; print(os.environ)'`, `python3 -c 'import os; print(os.environ["GH_TOKEN"])'`,
      `curl -v -H "Authorization: token $GH_TOKEN" https://api.github.com/user`,
      "cat .env", "cat <<EOF\n$GH_TOKEN\nEOF",
      "x=1; env",
      "cat ~/.netrc", "cat ~/.git-credentials", "cat ~/.config/gh/hosts.yml", "cat ~/.doppler/.doppler.yaml",
      "grep TOKEN .env.production", "head -3 /proc/1/environ",
    ];
    const allow = [
      "gh pr list --repo example/t", "gh issue view 7", "gh auth status", "git push origin features",
      `curl -fsSL -H "Authorization: token $GH_TOKEN" -o /tmp/img.png "https://github.com/x.png"`,
      'test -n "$GH_TOKEN" && echo set', "echo ${#GH_TOKEN}", "npm test", "env NODE_ENV=test npm test",
      "ps -o pid=,rss= -p 123", "echo done; set -e", "cat .env.example", "export FOO=bar",
      `node -e 'fetch(u,{headers:{a:process.env.GH_TOKEN}})'`, "git log --oneline -5",
    ];
    const badDeny = [], leaked = [], noSafe = [];
    for (const c of deny) {
      const r = run(c);
      if (r.status !== 2) badDeny.push(`${JSON.stringify(c)}→${r.status}`);
      if (`${r.stdout}${r.stderr}`.includes(DUMMY)) leaked.push(c);
      if (r.status === 2 && !/gh auth status|test -n/.test(r.stderr)) noSafe.push(c);
    }
    check(`B ${deny.length} printing commands are blocked (exit 2)`, badDeny.length === 0, badDeny.join(", "));
    check("B a blocked command's message names a safe path", noSafe.length === 0, noSafe.join(", "));
    check("B the hook itself never prints the value", leaked.length === 0, leaked.join(", "));
    const badAllow = allow.filter((c) => run(c).status !== 0);
    check(`B ${allow.length} commands that only USE a credential still run`, badAllow.length === 0, badAllow.join(" | "));
    // ── D: file tools on credential files ──
    const tool = (tool_name, tool_input) => spawnSync("/bin/sh", ["-c", hookCommand], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }), encoding: "utf8",
      env: { ...process.env, GH_TOKEN: DUMMY } });
    const fileDeny = [
      ["Read", { file_path: "/srv/app/.env" }], ["Read", { file_path: ".env.local" }], ["Read", { file_path: ".env.production" }],
      ["Read", { file_path: "/home/u/.config/gh/hosts.yml" }], ["Read", { file_path: "/home/u/.netrc" }],
      ["Read", { file_path: "/home/u/.git-credentials" }], ["Read", { file_path: "/proc/1/environ" }],
      ["Read", { file_path: "/home/u/.doppler/.doppler.yaml" }],
      ["Grep", { pattern: "TOKEN", path: "/srv/app/.env" }], ["Grep", { pattern: "TOKEN", glob: ".env*" }],
      ["Grep", { pattern: "TOKEN", glob: "**/.env" }], ["Edit", { file_path: ".env", old_string: "a", new_string: "b" }],
    ];
    const fileAllow = [
      ["Read", { file_path: ".env.example" }], ["Read", { file_path: "/srv/app/.env.sample" }], ["Read", { file_path: "src/env.ts" }],
      ["Read", { file_path: "docs/environment.md" }], ["Grep", { pattern: "process.env", path: "src" }],
      ["Edit", { file_path: "src/config.ts", old_string: "a", new_string: "b" }], ["Write", { file_path: ".env", content: "X=" }],
      ["Glob", { pattern: "**/.env*" }],
    ];
    const badFileDeny = fileDeny.filter(([t, i]) => { const r = tool(t, i); return r.status !== 2 || !/\.env\.example/.test(r.stderr); });
    check(`D ${fileDeny.length} file-tool reads of credential files are blocked, naming .env.example`, badFileDeny.length === 0,
      badFileDeny.map((x) => JSON.stringify(x)).join(" | "));
    const badFileAllow = fileAllow.filter(([t, i]) => tool(t, i).status !== 0);
    check(`D ${fileAllow.length} ordinary file-tool calls still run`, badFileAllow.length === 0, badFileAllow.map((x) => JSON.stringify(x)).join(" | "));
    const garbage = spawnSync("/bin/sh", ["-c", hookCommand], { input: "not json", encoding: "utf8" });
    check("B unreadable input fails open (never stops a build)", garbage.status === 0);
  }
} finally {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.TOKEN === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = saved.TOKEN;
  rmSync(tmp, { recursive: true, force: true });
}

// ── C: no spawn path around the gate ──
// The single spawn site is session/runner.ts (it owns --settings too); scan all of src/ for others.
const src = readFileSync(join(DIR, "src", "session", "runner.ts"), "utf8");
const spawnSites = (src.match(/spawn\(\s*["']claude["']/g) || []).length;
const others = readdirSync(join(DIR, "src"), { recursive: true })
  .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && f !== join("session", "runner.ts"))
  .map((f) => (readFileSync(join(DIR, "src", f), "utf8").match(/spawn(?:Sync)?\(\s*["']claude["']/g) || []).length)
  .reduce((a, b) => a + b, 0);
check("C exactly one claude spawn site, in session/runner.ts", spawnSites === 1 && others === 0, `session/runner.ts ${spawnSites}, elsewhere ${others}`);
check("C that site's args include --settings", /"--settings"/.test(src));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
