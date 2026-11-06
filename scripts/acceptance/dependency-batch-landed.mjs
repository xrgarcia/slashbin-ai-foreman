#!/usr/bin/env node
// Acceptance for foreman#230 (A1-A5): a dependency batch that ends "landed" is remembered, so the sweep never files
// it again, and a batch that keeps coming back is held and put to the EM exactly once.
//
//   npm run build && node scripts/acceptance/dependency-batch-landed.mjs
//
// It drives the Foreman's runtime surface, the same phase entry points the daemon's lane pass calls
// (tryFileDependencyBatchIssue = the "dependabot" stage, tryBatchImplementation = the "implement" stage,
// tryUnstick = the "unstick" stage), against:
//   - a fixture CodeHost + work source plugin (a stateful fake of GitHub: Dependabot PRs, issues, retirement),
//   - a fake `claude` on PATH, whose stdout is the implement session's answer (the real spawn path runs),
//   - a fixture EM consumer at <emRepoPath>/bin/em.mjs, which fails until it "recovers",
//   - a DURABLE record backend (files on disk). A restart builds new runtime objects over the same files.
// Nothing here calls a collaborator (policy, ledger, landing, notifier) directly.
//
// Exit 0 when every check holds. Time is simulated with node:test's Date mock; nothing sleeps.

import assert from "node:assert/strict";
import { mock } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (p) => import(join(root, "dist", p));
const { loadConfig } = await dist("config.js");
const { setStateDir } = await dist("state-dir.js");
const { registerPlugin, startPlugins, resetRegistryForTests } = await dist("plugins/registry.js");
const { GitHubPlugin } = await dist("plugins/github.js");
const { EmPlugin } = await dist("plugins/em.js");
const { ForemanRuntime } = await dist("runtime.js");
const { tryFileDependencyBatchIssue } = await dist("phases/promote.js");
const { tryBatchImplementation } = await dist("phases/implement.js");
const { tryUnstick } = await dist("phases/unstick.js");
const { UNSTICK_MAX_ATTEMPTS } = await dist("unstick.js");
const deps = await dist("github/dependencies.js");

const say = process.env.ACCEPTANCE_VERBOSE ? (l) => (m) => console.log("    [" + l + "] " + m) : () => () => {};
const logger = { info: say("info"), warn: say("warn"), error: say("error"), debug: say("debug"), child() { return logger; } };
const HOUR = 3600_000;
const tmp = mkdtempSync(join(tmpdir(), "dep-batch-acceptance-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
mock.timers.enable({ apis: ["Date"], now: Date.now() });
const advance = (ms) => mock.timers.tick(ms);

let checks = 0;
const ok = (label) => { checks++; console.log(`  ok  ${label}`); };
const scenario = (name) => console.log(`\n${name}`);

// --- the durable record backend: one JSON file per record key ------------------------------------------------
const recordsDir = join(tmp, "records");
mkdirSync(recordsDir);
const fileOf = (key) => join(recordsDir, `${key.kind}-${key.number}.json`);
const backend = {
  async loadRecord(key) { return existsSync(fileOf(key)) ? { status: "found", record: JSON.parse(readFileSync(fileOf(key), "utf8")) } : { status: "absent" }; },
  async saveRecord(key, record) { writeFileSync(fileOf(key), JSON.stringify(record)); return true; },
};

// --- the fixture code host: the GitHub of the 2026-11-05 incident, as state ------------------------------------
const world = {
  prs: [], issues: [], nextIssue: 100, retireFails: false, retired: [], comments: [], closedAsLanded: [],
  openedPrs: [], sha: "base0", base: "develop",
};
const addDependabotPr = (number, headRefOid, title = `chore(deps): bump pkg${number} from 1.0.0 to 2.0.0`) => {
  world.prs = world.prs.filter((p) => p.number !== number);
  world.prs.push({ number, url: `https://github.com/o/svc/pull/${number}`, title, body: "", headRefName: `dependabot/npm_and_yarn/pkg${number}`, baseRefName: "features", headRefOid });
};
const openBatch = () => world.issues.filter((i) => i.open);
const fixtureHost = {
  RELEASE_STOP_MARK: "<!-- fixture-stop -->",
  dependencyBatchBases: deps.dependencyBatchBases,
  describeDependencyPR: deps.describeDependencyPR,
  buildDependencyBatchIssue: deps.buildDependencyBatchIssue,
  selectSecurityPRs: deps.selectSecurityPRs,
  fetchOpenAlertPackages: () => world.alerts ?? new Set(),
  formatGhError: (e) => ({ message: String(e), stderr: "", status: 1 }),
  findDependencyPRs: (_r, _c, bases) => world.prs.filter((p) => bases.includes(p.baseRefName)),
  findOpenDependencyBatchIssue: () => openBatch()[0],
  createDependencyBatchIssue(_r, _c, title, body, label) {
    const number = world.nextIssue++;
    world.issues.push({ number, title, body, labels: label ? [{ name: label }] : [], open: true, batch: true });
    return number;
  },
  retireDependencyPR(_cfg, number, comment) {
    if (world.retireFails) throw new Error("gh pr close: refused");
    world.prs = world.prs.filter((p) => p.number !== number);
    world.retired.push({ number, comment });
  },
  closeAlreadyLanded(_cfg, number, reason) { world.closedAsLanded.push({ number, reason }); world.issues.find((i) => i.number === number).open = false; },
  // read side of the implement stage
  getOpenIssues: () => openBatch().map((i) => ({ number: i.number, title: i.title, labels: i.labels, body: i.body })),
  hasLabel: (i, name) => (i.labels ?? []).some((l) => l.name === name),
  findOpenFeaturePR: () => (world.openedPrs[0] ? { number: world.openedPrs[0].number, headBranch: world.openedPrs[0].branch, issueNumbers: [world.openedPrs[0].issue] } : null),
  discoveryBatch: (_c, offered) => offered.slice(0, 1),
  getRemoteBranchSha: () => readFileSync(join(tmp, "sha"), "utf8"),
  forgetOpenPrs() {},
  verifyPRExists: (_r, branch) => world.openedPrs.some((p) => p.branch === branch),
  verifyPRCreated: (_r, url) => world.openedPrs.some((p) => p.url === url),
  checkPRHasChanges: () => 3,
  skipGate: () => ({ run: true }),
  isResolvedTransientSkip: () => false,
  findIssuesMergedToBase: () => [],
  foremanLogin: () => "foreman",
  hasPendingRevisions: () => false,
};
// Anything the stages ask the host that this scenario does not model answers "nothing there" and is reported at the end.
const unmodelled = new Set();
const host = new Proxy(fixtureHost, {
  get(target, key) {
    if (key === "then" || typeof key === "symbol") return undefined;
    if (key in target) return target[key];
    unmodelled.add(String(key));
    return (...a) => { if (process.env.ACCEPTANCE_VERBOSE) console.log("    [host] unmodelled " + String(key)); return []; };
  },
});

const workSource = {
  async selectWork(repo) { return openBatch().filter((i) => i.labels.some((l) => l.name === "approved")).map((i) => ({ issueNumber: i.number, title: i.title, repo: repo.githubRepo, labels: i.labels })); },
  async selectEligible() { return []; },
  async record() { return false; },
  async snapshot() { return []; },
  loadRecord: (key) => backend.loadRecord(key),
  saveRecord: (key, record) => backend.saveRecord(key, record),
};
const FixturePlugin = {
  id: "fixture-host", roles: ["codeHost", "workSource"], enabled: () => true,
  fills: (role, config) => (role === "codeHost" ? config.codeHost === "fixture" : config.workSource === "fixture"),
  codeHost: host, workSource,
};

// --- the fake claude (the implement session) and the fixture EM consumer ----------------------------------------
mkdirSync(join(tmp, "bin"));
const claudeOut = join(tmp, "claude-out.txt"), claudePush = join(tmp, "claude-push");
writeFileSync(join(tmp, "sha"), "base0");
writeFileSync(join(tmp, "bin", "claude"), `#!/bin/sh\ncat ${JSON.stringify(claudeOut)}\nif [ -f ${JSON.stringify(claudePush)} ]; then echo pushed${"$$"} > ${JSON.stringify(join(tmp, "sha"))}; fi\n`);
chmodSync(join(tmp, "bin", "claude"), 0o755);
process.env.PATH = `${join(tmp, "bin")}:${process.env.PATH}`;
process.env.EM_GITHUB_TOKEN ||= "acceptance-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "acceptance-token-not-real";

const em = join(tmp, "em");
mkdirSync(join(em, "bin"), { recursive: true });
const emUp = join(em, "up"), emLog = join(em, "calls.log");
// A consumer that knows dependency-batch-loop (exit 0 = invoked once it is up; exit 1 = a failed call while it is down).
writeFileSync(join(em, "bin", "em.mjs"), `import { existsSync, appendFileSync } from "node:fs";
const a = process.argv.slice(2); appendFileSync(${JSON.stringify(emLog)}, a.join(" ") + "\\n");
process.exit(existsSync(${JSON.stringify(emUp)}) ? 0 : 1);\n`);
const emCalls = () => (existsSync(emLog) ? readFileSync(emLog, "utf8").split("\n").filter(Boolean) : []);

// --- config, plugins, runtime -----------------------------------------------------------------------------------
const repoDir = join(tmp, "repo");
mkdirSync(repoDir);
execFileSync("git", ["init", "-q", "-b", "develop", repoDir]);
execFileSync("git", ["-C", repoDir, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
writeFileSync(join(tmp, "config.json"), JSON.stringify({
  codeHost: "fixture", workSource: "fixture", techLeadPath: "/x", srePath: "/x", qaPath: "/x", emRepoPath: em, paperclip: { enabled: false },
  repos: [{ name: "svc", repoPath: repoDir, githubRepo: "o/svc", baseBranch: "features", featureBranch: "feature/ai", productionBranch: "main", dependencyPreApproved: true }], dependabot: { securityOnly: false },
}));
setStateDir(join(tmp, "state.json"));
const config = loadConfig(join(tmp, "config.json"));
const repo = config.repos[0];
resetRegistryForTests();
for (const p of [new GitHubPlugin(), FixturePlugin, new EmPlugin()]) registerPlugin(p);
await startPlugins(config, { logger, configText: () => null });

/** A Foreman start: new runtime objects, the same durable backend. */
const boot = () => new ForemanRuntime();
let cycle = 0;
const sweep = (rt) => tryFileDependencyBatchIssue(rt, repo, logger, ++cycle);
/** The implement stage on the oldest open batch issue; the session answers `answer`. */
async function implement(rt, answer, { push = false } = {}) {
  writeFileSync(claudeOut, answer);
  if (push) writeFileSync(claudePush, ""); else rmSync(claudePush, { force: true });
  return tryBatchImplementation(rt, repo, config, logger, ++cycle);
}
const landedAnswer = (n, reason) => `Checked develop.\nFOREMAN_RESULT: landed issue=${n} reason="${reason}"\n`;
const unstick = (rt) => tryUnstick(rt, repo, config, logger, ++cycle);
const repoRecord = async (rt) => (await rt.records.loadRepoRecord(repo)) ?? {};
const batchRecord = async (rt) => Object.values((await repoRecord(rt)).dependencyBatches ?? {});
const emEntries = async (rt) => Object.values((await repoRecord(rt)).unstick ?? {}).filter((e) => e.kind === "dependency-batch-loop");
const reset = () => { world.nextIssue = 100; world.prs = []; world.issues = []; world.retired = []; world.closedAsLanded = []; world.openedPrs = []; world.retireFails = false; rmSync(recordsDir, { recursive: true, force: true }); mkdirSync(recordsDir); rmSync(emUp, { force: true }); rmSync(emLog, { force: true }); };

// === A1 ===================================================================================================================
scenario("A1  2026-11-05: PR #627 open, its version already on develop -> landed; #627 closed; next 3 sweeps file zero");
reset();
addDependabotPr(627, "sha627", "chore(deps): bump @hono/node-server from 1.19.17 to 2.1.6");
let rt = boot();
const first = await sweep(rt);
assert.equal(first, 100); ok("the sweep filed batch issue #100, pre-approved");
await implement(rt, landedAnswer(100, "2.1.6 is on develop via #633 (abc1234) and #637 (def5678)"));
assert.deepEqual(world.retired.map((r) => r.number), [627]); ok("PR #627 was closed");
assert.match(world.retired[0].comment, /#633 \(abc1234\) and #637 \(def5678\)/); ok("its comment names the carrying commits");
assert.equal(world.closedAsLanded.length, 1); ok("issue #100 closed as completed");
assert.deepEqual((await batchRecord(rt)).map((b) => b.outcome), ["landed"]); ok("the ledger holds `landed` for the batch key");
for (let i = 0; i < 3; i++) assert.equal(await sweep(rt), null);
assert.equal(world.issues.length, 1); ok("the next 3 sweep polls filed zero issues");

// === A4 (restart between polls of A1) ========================================================================================
scenario("A4  restarting the Foreman between polls does not re-file (new runtime over the same durable record)");
// even with the PR somehow still open, a landed ledger entry on a fresh runtime files nothing
addDependabotPr(627, "sha627", "chore(deps): bump @hono/node-server from 1.19.17 to 2.1.6");
for (let i = 0; i < 3; i++) { rt = boot(); assert.equal(await sweep(rt), null); }
assert.equal(world.issues.length, 1); ok("3 restarts, 3 polls each: zero issues filed; the landed outcome came from disk, not memory");
assert.deepEqual((await batchRecord(boot())).map((b) => b.outcome), ["landed"]); ok("a freshly built runtime reads `landed` from the backend");

// === A2 ===================================================================================================================
scenario("A2  after A1, a new head SHA on the same Dependabot PR files exactly one batch issue");
rt = boot();
addDependabotPr(627, "sha627-v2", "chore(deps): bump @hono/node-server from 1.19.17 to 2.1.6");
assert.equal(await sweep(rt), 101); ok("the new head files one issue");
assert.equal(await sweep(rt), null); assert.equal(await sweep(boot()), null);
assert.equal(world.issues.length, 2); ok("and only one: its issue is open, so polls and restarts file nothing more");

// === A3 ===================================================================================================================
scenario("A3  retirement disabled: the same key files at most 3 times in 24h, then a hold and ONE EM notice (EM down, then recovered, then a restart)");
reset();
addDependabotPr(627, "sha627", "chore(deps): bump @hono/node-server from 1.19.17 to 2.1.6");
world.retireFails = true;
rt = boot();
let filed = 0;
for (let i = 0; i < 8; i++) {
  const n = await sweep(rt);
  if (n !== null) { filed++; await implement(rt, landedAnswer(n, "already on develop")); }
  advance(HOUR);
}
assert.equal(filed, 3); assert.equal(world.issues.length, 3); ok("exactly 3 filings, no fourth issue");
assert.equal(world.retired.length, 0); assert.equal((await batchRecord(rt))[0].outcome, undefined); ok("the failed retirement left the batch unresolved (no terminal outcome hid it)");
let notices = await emEntries(rt);
assert.equal(notices.length, 1); ok("the sweep held the batch and recorded one dependency-batch-loop notice for the EM");

// R2: the EM consumer is down for the three calls the watch allows
for (let i = 1; i <= UNSTICK_MAX_ATTEMPTS; i++) assert.equal(await unstick(rt), 1);
assert.equal(emCalls().length, UNSTICK_MAX_ATTEMPTS);
assert.deepEqual([(await emEntries(rt))[0].status, (await emEntries(rt))[0].attempts], ["failed", UNSTICK_MAX_ATTEMPTS]); ok("R2: three EM calls failed; the notice is spent undelivered");
assert.equal(await unstick(rt), 0); ok("the unstick watch alone never asks again (the state that used to lose the notice)");
writeFileSync(emUp, ""); // the EM recovers
advance(2 * HOUR);
rt = boot(); // the Foreman restarts
assert.equal(await sweep(rt), null); ok("after the restart the held sweep still files nothing");
assert.equal((await emEntries(rt)).length, 1); ok("it re-opened the SAME notice (no second one)");
assert.equal(await unstick(rt), 1); ok("R2: the next unstick pass delivered it to the recovered EM");
const delivered = (await emEntries(rt))[0];
assert.equal(delivered.status, "invoked"); ok("the notice holds an accepted EM answer");
assert.match(emCalls().at(-1), /--kind dependency-batch-loop/); ok("the EM received the dependency-batch-loop kind");
const callsAfterDelivery = emCalls().length;

// R3: delivered once means delivered once, across polls and restarts
for (let i = 0; i < 4; i++) { rt = boot(); advance(HOUR); assert.equal(await sweep(rt), null); }
assert.deepEqual((await emEntries(rt)), [delivered]); ok("R3: 4 more held polls, each after a restart: the delivered notice is untouched");
assert.equal(emCalls().length, callsAfterDelivery); ok("R3: no further EM call from the sweep");
assert.equal(world.issues.length, 3); ok("still no fourth issue");

// === A5 ===================================================================================================================
scenario("A5  existing behaviour holds: a batch with real changes opens its PR as today; security-only selection is unchanged");
reset();
addDependabotPr(1, "s1", "chore(deps): bump vite from 1.0.0 to 1.1.0");
addDependabotPr(2, "s2", "chore(deps): bump zod from 3.0.0 to 4.0.0");
rt = boot();
const real = await sweep(rt);
assert.equal(real, 100);
assert.ok(world.issues[0].labels.some((l) => l.name === "approved")); ok("a batch with real changes is filed pre-approved, queued to build");
assert.match(world.issues[0].title, /2 dependency updates.*\(1 major\)/); ok("its title reports both updates and the major");
const branch = `foreman/100-x`;
world.openedPrs.push({ number: 700, url: "https://github.com/o/svc/pull/700", branch, issue: 100 });
const r = await implement(rt, `Implemented.\nPR: https://github.com/o/svc/pull/700\n`, { push: true });
assert.equal(r?.success, true); assert.match(r.prUrl, /pull\/700$/); ok("the implement session opened its PR (success + PR url), not a `landed` close");
assert.equal(world.retired.length, 0); assert.deepEqual((await batchRecord(rt)).map((b) => b.outcome), [undefined]); ok("so no Dependabot PR is retired and no outcome is recorded: the PR path is as today");
// security-only selection
reset();
world.alerts = new Set(["lodash"]);
addDependabotPr(11, "a", "chore(deps): bump vite from 1.0.0 to 2.0.0");
addDependabotPr(12, "b", "chore(deps): bump lodash from 1.0.0 to 1.0.1");
world.prs.push({ ...world.prs[1], number: 13, headRefOid: "c", baseRefName: "main", title: "chore(deps): bump lodash from 1.0.0 to 1.0.2" });
const secRepo = { ...repo, dependabot: { securityOnly: true } };
const secIssue = await tryFileDependencyBatchIssue(boot(), secRepo, logger, ++cycle);
assert.equal(secIssue, 100);
assert.match(world.issues[0].body, /#12 /); assert.doesNotMatch(world.issues[0].body, /#11 |#13 /); ok("security-only: only the alerted package's PR on the working branch is batched; the production-branch PR never is");

if (unmodelled.size) console.log(`\n(host calls this fixture does not model, answered empty: ${[...unmodelled].join(", ")})`);
console.log(`\nPASS: ${checks} checks`);
mock.timers.reset();
