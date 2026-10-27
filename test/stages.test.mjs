// The stage pipeline: `stages` in config sets which phases a repo pass runs and
// in what order; omitted, it is the eight built-ins in the order they always
// ran. A custom stage `{ id, skillPath }` runs one Claude session on its skill,
// and a `blocked` or `failed` outcome ends the pass before any later stage.
//
// The pass-level cases drive the BUILT runRepoPass with a fake `gh` and a fake
// `claude` first on PATH; each records what it was asked. Nothing reaches
// GitHub or Anthropic, and no token is real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, configSchema } from "../dist/config.js";
import { BUILTIN_STAGES, dispatchStages, parseStageTrailer } from "../dist/stages.js";
import { runRepoPass } from "../dist/orchestrator.js";
import { configureIssueCache } from "../dist/github.js";
import { setStatePath } from "../dist/state.js";
import { createLogger } from "../dist/logger.js";

const DEFAULT = ["reconcile", "review", "verify", "promote", "release", "revise", "implement", "branch-sync", "dependabot", "unstick"];
const logger = createLogger({ format: "text", level: "error" });
const names = (stages) => stages.map((s) => s.type ?? s.id);

let tmp, F, saved;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-stages-test-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  // The fakes are CommonJS: pin it, so a stray "type": "module" package.json above the temp dir cannot make them ESM.
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  F = {
    ghLog: join(tmp, "gh.log"),
    ghState: join(tmp, "gh-state.json"),
    claudeLog: join(tmp, "claude.log"),
    claudeOut: join(tmp, "claude-out.txt"),
  };
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(F.ghLog)}, JSON.stringify(args) + "\\n");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(F.ghState)}, "utf8"));
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(args.includes("--head") ? st.featurePrs : st.openPrs));
} else if (args[0] === "api" && args.join(" ").includes("dependabot/alerts")) {
  if (st.alertsFail) { process.stderr.write("gh: Dependabot alerts are disabled for this repository. (HTTP 404)"); process.exit(1); }
  process.stdout.write((st.alerts || []).join("\\n") + ((st.alerts || []).length ? "\\n" : ""));
} else if (args[0] === "issue" && args[1] === "create") {
  process.stdout.write("https://github.com/example/repo/issues/42\\n");
} else {
  process.stdout.write("[]");
}
`);
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith("FOREMAN_STAGE_") || k === "FOREMAN_LIFECYCLE_LABELS" || k === "FOREMAN_TRIGGER_LABEL") env[k] = process.env[k];
fs.appendFileSync(${JSON.stringify(F.claudeLog)}, JSON.stringify({ prompt: process.argv[3], cwd: process.cwd(), env }) + "\\n");
process.stdout.write(fs.readFileSync(${JSON.stringify(F.claudeOut)}, "utf8"));
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
  // Transcripts land in <cwd>/logs and state in the state dir — keep both in tmp.
  process.chdir(tmp);
  setStatePath(tmp);
  configureIssueCache({ ttlMs: 0 });
});

after(() => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.FOREMAN_GITHUB_TOKEN === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.FOREMAN_GITHUB_TOKEN;
  rmSync(tmp, { recursive: true, force: true });
});

function load(cfg, repo = {}) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    repos: [{ name: "stages", repoPath: tmp, githubRepo: "example/repo", ...repo }],
    ...cfg,
  }));
  return loadConfig(p);
}

/** Reset the fakes for one pass. */
function arrange({ featurePrs = [], openPrs = [], claudeOut = "", alerts = [], alertsFail = false } = {}) {
  writeFileSync(F.ghLog, "");
  writeFileSync(F.claudeLog, "");
  writeFileSync(F.ghState, JSON.stringify({ featurePrs, openPrs, alerts, alertsFail }));
  writeFileSync(F.claudeOut, claudeOut);
}
const lines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const claudeRuns = () => lines(F.claudeLog);
const ghCalls = () => lines(F.ghLog);
/** The promote stage's first act is listing the ready-for-prod issues. */
const promoteRan = () => ghCalls().some((a) => a[0] === "issue" && a[1] === "list");

const SHA = "a".repeat(40);
const OPEN_PR = { number: 7, title: "feat: scan target (#3)", body: "Related to #4", commits: [], headRefOid: SHA };

// --- Config resolution -------------------------------------------------------

test("default stages: a config with no `stages` resolves to the ten built-ins, in order", () => {
  assert.deepEqual([...BUILTIN_STAGES], DEFAULT);
  assert.deepEqual(names(load({}).stages), DEFAULT);
  assert.deepEqual(names(configSchema.parse({}).stages), DEFAULT);
  assert.ok(!/slashbin/i.test(JSON.stringify(load({}).stages)), "default stages carry no Slashbin identity");
});

test("subset: a configured stages array resolves to exactly those stages, in that order", () => {
  assert.deepEqual(names(load({ stages: [{ type: "reconcile" }, { type: "implement" }] }).stages), ["reconcile", "implement"]);
  assert.deepEqual(names(load({ stages: [{ type: "promote" }, { type: "reconcile" }] }).stages), ["promote", "reconcile"]);
});

test("custom stage resolves in its position with its skillPath", () => {
  const c = load({ stages: [{ type: "implement" }, { id: "security", skillPath: "/opt/sec/SKILL.md" }, { type: "promote" }] });
  assert.deepEqual(c.stages[1], { id: "security", skillPath: "/opt/sec/SKILL.md" });
});

test("invalid stages are refused at startup", () => {
  assert.throws(() => load({ stages: [{ type: "deploy" }] }));
  assert.throws(() => load({ stages: [{ type: "implement" }, { type: "implement" }] }), /more than once/);
  assert.throws(() => load({ stages: [{ id: "review", skillPath: "/x/SKILL.md" }] }), /built-in stage name/);
  assert.throws(() => load({ stages: [{ type: "implement", skillPath: "/x/SKILL.md" }] }));
  assert.throws(() => load({ stages: [{ id: "sec" }] }));
});

test("review guard follows the stages: required only when `review` is configured", () => {
  assert.throws(() => load({ stages: [{ type: "review" }] }, { reviewEnabled: true }), /techLeadPath/);
  assert.doesNotThrow(() => load({ stages: [{ type: "implement" }] }, { reviewEnabled: true }));
  assert.throws(() => load({}, { reviewEnabled: true }), /techLeadPath/, "default stages include review");
});

// --- Dispatch loop -----------------------------------------------------------

test("dispatch: every stage runs in order when each returns ok", async () => {
  const seen = [];
  const r = await dispatchStages(load({}).stages, async (s) => { seen.push(s.type); return { outcome: "ok" }; });
  assert.deepEqual(seen, DEFAULT);
  assert.deepEqual(r.ran, DEFAULT);
  assert.equal(r.stoppedAt, undefined);
});

for (const outcome of ["blocked", "failed"]) {
  test(`dispatch: a ${outcome} stage stops every later stage in the pass`, async () => {
    const stages = [{ type: "implement" }, { id: "security", skillPath: "/s" }, { type: "promote" }];
    const seen = [];
    const r = await dispatchStages(stages, async (s) => {
      seen.push(s.type ?? s.id);
      return { outcome: s.id === "security" ? outcome : "ok", reason: "because" };
    });
    assert.deepEqual(seen, ["implement", "security"]);
    assert.deepEqual(r.stoppedAt, { stage: "security", outcome, reason: "because" });
  });
}

test("parseStageTrailer reads the last verdict line", () => {
  assert.deepEqual(parseStageTrailer("work\nFOREMAN_STAGE pass\n"), { verdict: "pass" });
  assert.deepEqual(parseStageTrailer('FOREMAN_STAGE pass\nFOREMAN_STAGE blocked reason="CVE-1"'), { verdict: "blocked", reason: "CVE-1" });
  assert.equal(parseStageTrailer("all good"), undefined);
});

// --- A repo pass with a custom stage ------------------------------------------

test("custom stage: one Claude session on its skillPath, told the work in flight; pass lets later stages run", async () => {
  arrange({ featurePrs: [OPEN_PR], claudeOut: "scanned\nFOREMAN_STAGE pass\n" });
  const config = load({ stages: [{ id: "security", skillPath: "/opt/sec/SKILL.md" }, { type: "promote" }] }, { name: "custom-pass" });
  const r = await runRepoPass(config.repos[0], config, logger);

  const runs = claudeRuns();
  assert.equal(runs.length, 1, "exactly one session");
  assert.match(runs[0].prompt, /Read and follow the skill at \/opt\/sec\/SKILL\.md/);
  assert.match(runs[0].prompt, /PR #7/);
  assert.equal(runs[0].cwd, tmp, "runs in the managed repo");
  assert.deepEqual(runs[0].env, {
    FOREMAN_TRIGGER_LABEL: "approved",
    FOREMAN_LIFECYCLE_LABELS: JSON.stringify(config.lifecycleLabels),
    FOREMAN_STAGE_ID: "security",
    FOREMAN_STAGE_REPO: "example/repo",
    FOREMAN_STAGE_BASE_BRANCH: "develop",
    FOREMAN_STAGE_FEATURE_BRANCH: "features",
    FOREMAN_STAGE_PR: "7",
    FOREMAN_STAGE_ISSUES: JSON.stringify([3, 4]),
    FOREMAN_STAGE_HEAD_SHA: SHA,
  });
  assert.ok(promoteRan(), "promote ran after a pass verdict");
  assert.ok(r.events.some((e) => /Stage "security" passed/.test(e.message)));

  // Same head next pass: the verdict stands, no second session.
  arrange({ featurePrs: [OPEN_PR], claudeOut: "FOREMAN_STAGE pass\n" });
  await runRepoPass(config.repos[0], config, logger);
  assert.equal(claudeRuns().length, 0, "verdict reused while the feature head is unchanged");
  assert.ok(promoteRan());
});

for (const [outcome, claudeOut] of [["blocked", 'FOREMAN_STAGE blocked reason="CVE in lodash"\n'], ["failed", "no verdict line\n"]]) {
  test(`custom stage: ${outcome} outcome keeps every later stage from running that pass`, async () => {
    arrange({ featurePrs: [OPEN_PR], claudeOut });
    const config = load({ stages: [{ id: "security", skillPath: "/opt/sec/SKILL.md" }, { type: "promote" }] }, { name: `custom-${outcome}` });
    const r = await runRepoPass(config.repos[0], config, logger);
    assert.equal(claudeRuns().length, 1);
    assert.ok(!promoteRan(), "promote must not run past a stopped stage");
    assert.ok(r.events.some((e) => e.message.includes(`Stage "security" ${outcome}`)));

    // Still the same head: still held, and no new session spent.
    arrange({ featurePrs: [OPEN_PR], claudeOut: "FOREMAN_STAGE pass\n" });
    await runRepoPass(config.repos[0], config, logger);
    assert.equal(claudeRuns().length, 0);
    assert.ok(!promoteRan());

    // The feature branch moved: the stage runs again and its new verdict rules.
    arrange({ featurePrs: [{ ...OPEN_PR, headRefOid: "b".repeat(40) }], claudeOut: "FOREMAN_STAGE pass\n" });
    await runRepoPass(config.repos[0], config, logger);
    assert.equal(claudeRuns().length, 1);
    assert.ok(promoteRan());
  });
}

test("custom stage: nothing in flight → no session, later stages run", async () => {
  arrange({ featurePrs: [], claudeOut: "FOREMAN_STAGE blocked\n" });
  const config = load({ stages: [{ id: "security", skillPath: "/opt/sec/SKILL.md" }, { type: "promote" }] }, { name: "custom-idle" });
  await runRepoPass(config.repos[0], config, logger);
  assert.equal(claudeRuns().length, 0);
  assert.ok(promoteRan());
});

test("a stage left out of `stages` never runs", async () => {
  arrange({ featurePrs: [OPEN_PR], claudeOut: "FOREMAN_STAGE pass\n" });
  const config = load({ stages: [{ id: "security", skillPath: "/opt/sec/SKILL.md" }] }, { name: "no-promote" });
  await runRepoPass(config.repos[0], config, logger);
  assert.equal(claudeRuns().length, 1);
  assert.ok(!promoteRan(), "promote is not configured");
});

// --- Built-in dispatch keeps per-repo behaviour -------------------------------

for (const pre of [true, false]) {
  test(`dependabot stage: dependencyPreApproved=${pre} ${pre ? "files the batch with" : "files the batch without"} the trigger label`, async () => {
    arrange({ alerts: ["lodash"], openPrs: [{ number: 11, url: "u", title: "Bump lodash from 4.17.20 to 4.17.21", body: "", headRefName: "dependabot/npm/lodash", baseRefName: "features" }] });
    const config = load({ stages: [{ type: "dependabot" }] }, { name: `dep-${pre}`, dependencyPreApproved: pre });
    await runRepoPass(config.repos[0], config, logger);
    const create = ghCalls().find((a) => a[0] === "issue" && a[1] === "create");
    assert.ok(create, "batch issue filed");
    const i = create.indexOf("--label");
    if (pre) assert.equal(create[i + 1], "approved");
    else assert.equal(i, -1);
  });
}

// --- Dependabot: security updates only -----------------------------------------

const depPr = (number, title, body = "") => ({ number, url: "u", title, body, headRefName: `dependabot/npm/p${number}`, baseRefName: "features" });
const issueCreates = () => ghCalls().filter((a) => a[0] === "issue" && a[1] === "create");

test("dependabot.securityOnly defaults to true and can be turned off", () => {
  assert.equal(load({}).repos[0].dependabot.securityOnly, true);
  assert.equal(load({ dependabot: { securityOnly: false } }).repos[0].dependabot.securityOnly, false);
});

test("securityOnly: only the PR whose package has an open alert is batched", async () => {
  arrange({
    alerts: ["ws"],
    openPrs: [depPr(1, "Bump ws from 8.0.0 to 8.22.0"), depPr(2, "Bump lodash from 4.17.20 to 4.17.21"), depPr(3, "Bump typescript from 5.0.0 to 5.9.0")],
  });
  const config = load({ stages: [{ type: "dependabot" }] }, { name: "sec-one" });
  await runRepoPass(config.repos[0], config, logger);
  const [create] = issueCreates();
  assert.ok(create, "a batch is filed for the security update");
  const body = create[create.indexOf("--body") + 1];
  assert.match(body, /#1\b/);
  assert.doesNotMatch(body, /#2\b|#3\b/, "version-update PRs are not in the batch");
  assert.ok(!ghCalls().some((a) => a[0] === "pr" && ["merge", "close"].includes(a[1])), "nothing merged or closed");
});

test("securityOnly: red before green — with it off the same PRs are all batched", async () => {
  arrange({ alerts: ["ws"], openPrs: [depPr(1, "Bump ws from 8.0.0 to 8.22.0"), depPr(2, "Bump lodash from 4.17.20 to 4.17.21")] });
  const config = load({ dependabot: { securityOnly: false }, stages: [{ type: "dependabot" }] }, { name: "sec-off" });
  await runRepoPass(config.repos[0], config, logger);
  const body = issueCreates()[0][issueCreates()[0].indexOf("--body") + 1];
  assert.match(body, /#1\b/);
  assert.match(body, /#2\b/);
});

test("securityOnly: no open alerts means no batch, and the PRs are left alone", async () => {
  arrange({ alerts: [], openPrs: [depPr(2, "Bump lodash from 4.17.20 to 4.17.21")] });
  const config = load({ stages: [{ type: "dependabot" }] }, { name: "sec-none" });
  await runRepoPass(config.repos[0], config, logger);
  assert.equal(issueCreates().length, 0);
});

test("securityOnly: a grouped PR with no packages in its title is read from its body", async () => {
  arrange({
    alerts: ["qs"],
    openPrs: [
      depPr(5, "chore(deps): bump the npm_and_yarn group across 1 directory with 2 updates", "Bumps the npm_and_yarn group with 2 updates in the / directory: [qs](https://github.com/ljharb/qs) and [express](https://github.com/expressjs/express).\n\nUpdates `qs` from 6.1.0 to 6.2.0\nUpdates `express` from 4.0.0 to 4.1.0"),
      depPr(6, "chore(deps): bump the dev-deps group with 3 updates", "no package list here"),
    ],
  });
  const config = load({ stages: [{ type: "dependabot" }] }, { name: "sec-group" });
  await runRepoPass(config.repos[0], config, logger);
  const body = issueCreates()[0][issueCreates()[0].indexOf("--body") + 1];
  assert.match(body, /#5\b/);
  assert.doesNotMatch(body, /#6\b/, "an unreadable group is treated as non-security");
});

test("securityOnly: an alerts-API failure batches nothing — it never falls back to everything", async () => {
  arrange({ alertsFail: true, openPrs: [depPr(1, "Bump ws from 8.0.0 to 8.22.0"), depPr(2, "Bump lodash from 4.17.20 to 4.17.21")] });
  const config = load({ stages: [{ type: "dependabot" }] }, { name: "sec-fail" });
  await runRepoPass(config.repos[0], config, logger);
  assert.equal(issueCreates().length, 0);
});
