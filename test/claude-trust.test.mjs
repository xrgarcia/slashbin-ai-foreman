// Claude Code ignores an untrusted checkout's .claude/settings.json and .mcp.json
// in a headless session and says so only on stderr. The Foreman trusts every
// checkout it runs a session in (src/claude-trust.ts) — without ever clobbering
// the operator's Claude config, which holds their login.
//
// Every config file here lives under a temp HOME / CLAUDE_CONFIG_DIR.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, symlinkSync, existsSync, readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claudeConfigPath, configureClaudeTrust, ensureClaudeTrust, isUntrustedWarning, trustManagedRepos,
  resetClaudeTrustForTests,
} from "../dist/claude-trust.js";
import { runCustomStage } from "../dist/agent.js";
import { loadConfig } from "../dist/config.js";

const capture = () => {
  const lines = [];
  const log = (level) => (msg) => lines.push(`${level} ${msg}`);
  const logger = { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
  logger.child = () => logger;
  return { logger, lines };
};

let tmp;
before(() => { tmp = mkdtempSync(join(tmpdir(), "foreman-trust-")); });
after(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => { resetClaudeTrustForTests(); configureClaudeTrust({ enabled: true }); });

/** A fresh HOME with a checkout in it; returns its env, config file and repo. */
const fixture = (cfg) => {
  const home = mkdtempSync(join(tmp, "home-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  const file = join(home, ".claude.json");
  if (cfg !== undefined) writeFileSync(file, typeof cfg === "string" ? cfg : JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { env: { HOME: home }, file, repo, home };
};
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("config path: CLAUDE_CONFIG_DIR wins over HOME", () => {
  assert.equal(claudeConfigPath({ HOME: "/h" }), "/h/.claude.json");
  assert.equal(claudeConfigPath({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" }), "/c/.claude.json");
});

test("trusts a checkout with no entry, and logs it once", () => {
  const { env, file, repo } = fixture({ projects: {} });
  const { logger, lines } = capture();
  assert.equal(ensureClaudeTrust(repo, logger, env), "trusted");
  assert.equal(read(file).projects[repo].hasTrustDialogAccepted, true);
  assert.deepEqual(lines, [`info trusted ${repo} for Claude Code (managed repo)`]);
  assert.equal(ensureClaudeTrust(repo, logger, env), "already");
  assert.equal(lines.length, 1);
});

test("creates the config when there is none", () => {
  const { env, file, repo } = fixture();
  assert.equal(ensureClaudeTrust(repo, capture().logger, env), "trusted");
  assert.equal(read(file).projects[repo].hasTrustDialogAccepted, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("writes under CLAUDE_CONFIG_DIR when the session env sets it", () => {
  const { env, repo, home } = fixture({});
  const dir = join(home, "cfgdir");
  mkdirSync(dir);
  writeFileSync(join(dir, ".claude.json"), "{}");
  ensureClaudeTrust(repo, capture().logger, { ...env, CLAUDE_CONFIG_DIR: dir });
  assert.equal(read(join(dir, ".claude.json")).projects[repo].hasTrustDialogAccepted, true);
  assert.deepEqual(read(join(home, ".claude.json")), {});
});

test("an already-trusted checkout is not written at all", () => {
  const { env, file, repo } = fixture({});
  writeFileSync(file, JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
  const before = statSync(file);
  const bytes = readFileSync(file, "utf8");
  assert.equal(ensureClaudeTrust(repo, capture().logger, env), "already");
  const after = statSync(file);
  assert.equal(after.ino, before.ino, "file was replaced");
  assert.equal(after.mtimeMs, before.mtimeMs, "file was rewritten");
  assert.equal(readFileSync(file, "utf8"), bytes);
});

test("keeps every other key, the project's own keys, and the file mode", () => {
  const { env, file, repo } = fixture({});
  const original = {
    oauthAccount: { emailAddress: "someone@example.test" },
    numStartups: 41,
    projects: {
      "/elsewhere": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] },
      [repo]: { history: [{ display: "hi" }], hasTrustDialogAccepted: false },
    },
  };
  writeFileSync(file, JSON.stringify(original));
  chmodSync(file, 0o640);
  assert.equal(ensureClaudeTrust(repo, capture().logger, env), "trusted");
  const got = read(file);
  assert.deepEqual(got.oauthAccount, original.oauthAccount);
  assert.equal(got.numStartups, 41);
  assert.deepEqual(got.projects["/elsewhere"], original.projects["/elsewhere"]);
  assert.deepEqual(got.projects[repo], { history: [{ display: "hi" }], hasTrustDialogAccepted: true });
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(join(file, "..")).filter((f) => f.includes(".trust-")), [], "temp file left behind");
});

test("refuses to touch a config that does not parse, and never logs its contents", () => {
  const broken = '{"oauthAccount": {"secret": "dummy-not-a-real-value"';
  const { env, file, repo } = fixture(broken);
  const { logger, lines } = capture();
  assert.equal(ensureClaudeTrust(repo, logger, env), "skipped");
  assert.equal(readFileSync(file, "utf8"), broken);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^warn .*does not parse.*stays untrusted/);
  assert.ok(!lines[0].includes("dummy-not-a-real-value"));
});

test("refuses a config whose top level is not an object", () => {
  const { env, file, repo } = fixture("[]");
  assert.equal(ensureClaudeTrust(repo, capture().logger, env), "skipped");
  assert.equal(readFileSync(file, "utf8"), "[]");
});

test("trustManagedRepos: false — nothing is written", () => {
  const { env, file, repo } = fixture({});
  configureClaudeTrust({ enabled: false });
  assert.equal(ensureClaudeTrust(repo, capture().logger, env), "disabled");
  trustManagedRepos([{ repoPath: repo }], capture().logger, env);
  assert.deepEqual(read(file), {});
});

test("a symlinked checkout is trusted under its real path too", () => {
  const { env, file, repo, home } = fixture({});
  const link = join(home, "link");
  symlinkSync(repo, link);
  ensureClaudeTrust(link, capture().logger, env);
  const p = read(file).projects;
  assert.equal(p[link].hasTrustDialogAccepted, true);
  assert.equal(p[repo].hasTrustDialogAccepted, true);
});

test("trustManagedRepos trusts every configured checkout on disk and skips one not cloned yet", () => {
  const { env, file, repo, home } = fixture({});
  const other = join(home, "other");
  mkdirSync(other);
  trustManagedRepos([{ repoPath: repo }, { repoPath: other }, { repoPath: join(home, "missing") }], capture().logger, env);
  assert.deepEqual(Object.keys(read(file).projects).sort(), [other, repo].sort());
});

test("config: trustManagedRepos defaults on; the env var turns it off", () => {
  const p = join(tmp, "cfg.json");
  writeFileSync(p, JSON.stringify({ repos: [{ name: "t", repoPath: tmp, githubRepo: "example/t" }] }));
  assert.equal(loadConfig(p).trustManagedRepos, true);
  process.env.AI_AGENT_TRUST_MANAGED_REPOS = "false";
  try { assert.equal(loadConfig(p).trustManagedRepos, false); }
  finally { delete process.env.AI_AGENT_TRUST_MANAGED_REPOS; }
  writeFileSync(p, JSON.stringify({ trustManagedRepos: false, repos: [{ name: "t", repoPath: tmp, githubRepo: "example/t" }] }));
  assert.equal(loadConfig(p).trustManagedRepos, false);
});

test("recognises both of Claude Code's untrusted-workspace warnings", () => {
  assert.ok(isUntrustedWarning("Warning: this workspace has not been trusted; project settings ignored"));
  assert.ok(isUntrustedWarning("headersHelper not run — this workspace has no persisted trust"));
  assert.ok(!isUntrustedWarning("some other warning"));
});

// --- the spawn path ----------------------------------------------------------
// A fake `claude` first on PATH. It reports what the config said about its cwd
// when it started, then — like a concurrent Claude process rewriting the file —
// drops that trust and prints the untrusted warning.

const spawnFixture = () => {
  const f = fixture({ numStartups: 1 });
  const bin = join(f.home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  const seen = join(f.home, "seen.json");
  writeFileSync(join(bin, "claude"),
    `#!/usr/bin/env node\nconst fs = require("fs");\n` +
    `const file = process.env.HOME + "/.claude.json";\n` +
    `const cfg = JSON.parse(fs.readFileSync(file, "utf8"));\n` +
    `fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(cfg.projects?.[process.cwd()] ?? null));\n` +
    `if (process.env.FAKE_DROP_TRUST) { delete cfg.projects[process.cwd()]; fs.writeFileSync(file, JSON.stringify(cfg)); }\n` +
    `process.stderr.write("Warning: this workspace has not been trusted\\n");\n` +
    `process.stdout.write("FOREMAN_STAGE pass\\n");\n`);
  chmodSync(join(bin, "claude"), 0o755);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n");
  chmodSync(join(bin, "gh"), 0o755);
  return { ...f, bin, seen };
};

const runStage = async (f, logger, extraEnv = {}) => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  Object.assign(process.env, { PATH: `${f.bin}:${saved.PATH}`, HOME: f.home, FOREMAN_GITHUB_TOKEN: "dummy" }, extraEnv);
  delete process.env.CLAUDE_CONFIG_DIR;
  process.chdir(f.home);
  try {
    const p = join(f.home, "cfg.json");
    writeFileSync(p, JSON.stringify({ repos: [{ name: "t", repoPath: f.repo, githubRepo: "example/t" }] }));
    const repo = { ...loadConfig(p).repos[0], sessionEnv: [...loadConfig(p).repos[0].sessionEnv, "FAKE_DROP_TRUST"] };
    await runCustomStage(repo, { id: "lint", skillPath: "/opt/lint/SKILL.md" },
      { prNumber: 7, headSha: "a".repeat(40), issueNumbers: [3] }, logger).catch(() => {});
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};

test("spawn: the checkout is trusted before the session starts", async () => {
  const f = spawnFixture();
  const { logger, lines } = capture();
  await runStage(f, logger);
  assert.ok(existsSync(f.seen), "claude was not launched");
  assert.deepEqual(JSON.parse(readFileSync(f.seen, "utf8")), { hasTrustDialogAccepted: true });
  assert.ok(lines.includes(`info trusted ${f.repo} for Claude Code (managed repo)`));
  assert.equal(read(f.file).numStartups, 1);
});

test("spawn: an untrusted warning on stderr is named and the checkout re-trusted for the next session", async () => {
  const f = spawnFixture();
  const { logger, lines } = capture();
  await runStage(f, logger, { FAKE_DROP_TRUST: "1" });
  assert.ok(lines.some((l) => l.startsWith(`warn Claude Code reports ${f.repo} is not trusted`)), lines.join("\n"));
  assert.equal(read(f.file).projects[f.repo].hasTrustDialogAccepted, true);
});

test("spawn: with trust off, the warning tells the operator and nothing is written", async () => {
  const f = spawnFixture();
  configureClaudeTrust({ enabled: false });
  const { logger, lines } = capture();
  await runStage(f, logger);
  assert.equal(JSON.parse(readFileSync(f.seen, "utf8")), null);
  assert.ok(lines.some((l) => /is not trusted, and trustManagedRepos is off/.test(l)), lines.join("\n"));
  assert.deepEqual(read(f.file), { numStartups: 1 });
});
