// Every Claude session the Foreman spawns runs under hooks/session-secret-gate.mjs
// (a PreToolUse Bash hook passed with --settings). It blocks commands that would
// PRINT an environment or credential value; commands that only USE one — gh,
// git, curl with an Authorization header — still run.
//
// The spawn cases run the BUILT implement / revise / custom-stage entry points
// with fake `claude` and `gh` first on PATH; the fake claude records its argv.
// The hook cases run the hook file as Claude Code does: JSON on stdin. No
// token here is real.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(root, "hooks", "session-secret-gate.mjs");
const { violation } = await import(HOOK);
const { implementApprovedIssues, revisePRFeedback, runCustomStage, sessionSettings, SESSION_SECRET_GATE } =
  await import(join(root, "dist/agent.js"));
const { loadConfig } = await import(join(root, "dist/config.js"));
const { createLogger } = await import(join(root, "dist/logger.js"));
const logger = createLogger({ format: "text", level: "error" });
const DUMMY = "test-dummy-value-not-a-token";

const DENY = [
  "env", "printenv", "printenv GH_TOKEN", "env | base64", "env | grep GH", "export -p", "set", "declare -px",
  "x=1; env", "$(printenv)",
  "echo $GH_TOKEN", 'echo "t=${GH_TOKEN}"', "printf '%s' \"$MY_API_KEY\"", "cat <<EOF\n$GH_TOKEN\nEOF",
  "cat /proc/1/environ", "cat /proc/self/cmdline", "ps aux", "ps -ef", "ps -o pid,args", "pgrep -a node",
  "gh auth token", "gh auth status -t", "gh auth status --show-token",
  "git credential fill", "git config --get http.https://github.com/.extraheader",
  `curl -v -H "Authorization: token $GH_TOKEN" https://api.github.com/user`,
  `node -e 'console.log(process.env)'`, `node -e 'console.log(process.env.GH_TOKEN)'`,
  `python3 -c 'import os; print(os.environ)'`,
  "set -x", "set -o xtrace", "bash -x run.sh", "cat .env", "doppler secrets",
];
const ALLOW = [
  "gh pr list", "gh issue view 7 --json body", "gh auth status", "git push origin features", "git log -5",
  `curl -sL -H "Authorization: token $GH_TOKEN" -o /tmp/foreman-image-1.png "https://github.com/a.png"`,
  'test -n "$GH_TOKEN" && echo set', "echo ${#GH_TOKEN}", "env FOO=1 npm test", "npm test",
  "ps -o pid=,ppid=", "pgrep -P 123", "echo done; set -e", "export FOO=bar", "cat .env.example",
  "cat <<'EOF'\n$GH_TOKEN\nEOF", `node -e 'fetch(u,{headers:{a:process.env.GH_TOKEN}})'`, "doppler secrets --only-names",
];

const runHook = (input) => spawnSync(process.execPath, [HOOK], {
  input: typeof input === "string" ? input : JSON.stringify(input),
  encoding: "utf8",
  env: { ...process.env, GH_TOKEN: DUMMY },
});

for (const c of DENY) {
  test(`blocks: ${JSON.stringify(c)}`, () => assert.ok(violation(c), "not blocked"));
}
for (const c of ALLOW) {
  test(`allows: ${JSON.stringify(c)}`, () => assert.equal(violation(c)?.id, undefined));
}

test("as a hook: a block is exit 2, names a safe path, and never echoes the value", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "env" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /BLOCKED \(env-dump\)/);
  assert.match(r.stderr, /test -n "\$NAME"/);
  assert.ok(!`${r.stdout}${r.stderr}`.includes(DUMMY));
});

test("as a hook: allowed Bash, other tools and unreadable input exit 0", () => {
  assert.equal(runHook({ tool_name: "Bash", tool_input: { command: "gh pr list" } }).status, 0);
  assert.equal(runHook({ tool_name: "Read", tool_input: { file_path: "/x" } }).status, 0);
  assert.equal(runHook("not json").status, 0);
});

test("sessionSettings: a Bash PreToolUse hook running this node on the shipped file", () => {
  const s = JSON.parse(sessionSettings());
  const h = s.hooks.PreToolUse.find((x) => x.matcher === "Bash").hooks[0];
  assert.equal(h.type, "command");
  assert.ok(h.command.includes(JSON.stringify(process.execPath)), "node must be absolute — systemd PATH may not have it");
  assert.ok(h.command.includes(JSON.stringify(SESSION_SECRET_GATE)));
  assert.ok(existsSync(SESSION_SECRET_GATE));
});

test("the hook ships in the package", () => {
  assert.ok(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files.includes("hooks"));
});

test("the hook names no operator", () => {
  assert.ok(!/slashbin|jerky/i.test(readFileSync(HOOK, "utf8")));
});

// --- every spawn path carries the gate --------------------------------------

let tmp, argvLog, saved;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-secret-gate-"));
  const bin = join(tmp, "bin");
  argvLog = join(tmp, "argv.jsonl");
  mkdirSync(bin);
  mkdirSync(join(tmp, "repo"));
  writeFileSync(join(bin, "claude"),
    `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
    `process.stdout.write("done\\n");\n`);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n");
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  saved = { PATH: process.env.PATH, token: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = DUMMY;
  process.chdir(tmp);
});

after(() => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.token === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.token;
  rmSync(tmp, { recursive: true, force: true });
});

const repo = () => {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ repos: [{ name: "t", repoPath: join(tmp, "repo"), githubRepo: "example/t" }] }));
  return { ...loadConfig(p).repos[0], skillPath: "builtin:", revisionSkillPath: "builtin:" };
};

const settingsArg = async (fn) => {
  rmSync(argvLog, { force: true });
  await fn().catch(() => {});
  assert.ok(existsSync(argvLog), "claude was not launched");
  const argv = JSON.parse(readFileSync(argvLog, "utf8").split("\n")[0]);
  const i = argv.indexOf("--settings");
  assert.ok(i > -1, "no --settings on the spawn");
  return argv[i + 1];
};

for (const [name, fn] of [
  ["implement", () => implementApprovedIssues(repo(), logger)],
  ["revise", () => revisePRFeedback(repo(), logger, undefined, 7, [3])],
  ["custom stage", () => runCustomStage(repo(), { id: "lint", skillPath: "/opt/lint/SKILL.md" },
    { prNumber: 7, headSha: "a".repeat(40), issueNumbers: [3] }, logger)],
]) {
  test(`${name}: the session is spawned with the secret gate`, async () => {
    assert.equal(await settingsArg(fn), sessionSettings());
  });
}
