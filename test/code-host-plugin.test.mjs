// The code host is a plugin (EM#1150 f5): every phase reaches PRs, branches,
// merges, comments and labels through `codeHost()` in the registry, never
// GitHub's code or the gh CLI. A fake code-host plugin is registered and
// selected by `codeHost: "fake"`; each phase is driven one pass and must call
// the fake, while a gh first on PATH logs every run and must log none.
// The fake records the call and throws, so a phase stops at its first host
// read: the test proves the route, not the phase's logic.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { setStatePath } from "../dist/state.js";
import { registerPlugin, startPlugins, resetRegistryForTests, codeHost } from "../dist/plugins/registry.js";
import { TechLeadPlugin } from "../dist/plugins/tech-lead.js";
import { SrePlugin } from "../dist/plugins/sre.js";
import { QaPlugin } from "../dist/plugins/qa.js";
import { EmPlugin } from "../dist/plugins/em.js";
import { GitHubPlugin } from "../dist/plugins/github.js";
import { tryBatchImplementation } from "../dist/phases/implement.js";
import { tryReview } from "../dist/phases/review.js";
import { tryVerify } from "../dist/phases/verify.js";
import { tryRelease } from "../dist/phases/release.js";
import { runReconcileStage } from "../dist/phases/reconcile.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const tmp = mkdtempSync(join(tmpdir(), "code-host-plugin-"));
const ghLog = join(tmp, "gh.log");
const saved = { PATH: process.env.PATH };

/** Every method name the phases called on the fake, in order. */
const calls = [];
const fakeHost = new Proxy({}, {
  get(_, key) {
    if (key === "then" || typeof key === "symbol") return undefined;
    if (key === "RELEASE_STOP_MARK") return "<!-- fake-stop -->";
    return () => {
      calls.push(key);
      throw new Error(`fake code host: ${key}`);
    };
  },
});

/** Hands out one approved item, so implement goes past its gate to the host. */
const workSource = {
  selectWork: async (repo) => [{ issueNumber: 7, title: "Seven", repo: repo.githubRepo, labels: [] }],
  selectEligible: async () => [],
  record: async () => false,
  snapshot: async () => [],
};

const FakeCodeHostPlugin = {
  id: "fake-host",
  roles: ["codeHost", "workSource"],
  enabled: () => true,
  fills: (role, config) => (role === "codeHost" ? config.codeHost === "fake" : config.workSource === "fake"),
  codeHost: fakeHost,
  workSource,
};

let config, repo;

before(async () => {
  mkdirSync(join(tmp, "bin"));
  writeFileSync(join(tmp, "bin", "gh"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(ghLog)}\nexit 1\n`);
  chmodSync(join(tmp, "bin", "gh"), 0o755);
  process.env.PATH = `${join(tmp, "bin")}:${saved.PATH}`;
  setStatePath(join(tmp, "state.json"));
  mkdirSync(join(tmp, "repo"));
  const p = join(tmp, "config.json");
  writeFileSync(p, JSON.stringify({
    codeHost: "fake", workSource: "fake",
    techLeadPath: "/x", srePath: "/x", qaPath: "/x", emRepoPath: "/x",
    paperclip: { enabled: false },
    repos: [{ name: "t", repoPath: join(tmp, "repo"), githubRepo: "example/t", baseBranch: "features", featureBranch: "feature/ai", productionBranch: "main", reviewEnabled: true }],
  }));
  config = loadConfig(p);
  repo = config.repos[0];
  resetRegistryForTests();
  // The GitHub plugin is installed too, as in the daemon: this config selects neither of its roles.
  for (const plugin of [new GitHubPlugin(), FakeCodeHostPlugin, new TechLeadPlugin(), new SrePlugin(), new QaPlugin(), new EmPlugin()]) registerPlugin(plugin);
  await startPlugins(config, { logger: quiet, configText: () => null });
});

after(() => {
  process.env.PATH = saved.PATH;
  resetRegistryForTests();
  rmSync(tmp, { recursive: true, force: true });
});

const ghRuns = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8").split("\n").filter(Boolean) : []);

/** Drive one pass; the phase must have asked the fake host, and gh must never have run. */
async function viaFake(run) {
  calls.length = 0;
  rmSync(ghLog, { force: true });
  await run().catch(() => {});
  assert.deepEqual(ghRuns(), [], "the phase ran gh itself, around the code host");
  assert.ok(calls.length > 0, "the phase never reached the code host");
  return calls;
}

test("the registry hands the core the configured code host, not GitHub's", () => {
  assert.equal(codeHost(), fakeHost);
});

test("implement: reaches the PRs through the code host plugin, never gh", async () => {
  const c = await viaFake(() => tryBatchImplementation(repo, config, quiet, 1));
  assert.deepEqual(c, ["findOpenFeaturePR", "getOpenIssues", "discoveryBatch"]);
});

test("review: reaches the PRs through the code host plugin, never gh", async () => {
  assert.deepEqual(await viaFake(() => tryReview(repo, config, quiet, 1)), ["findPRsNeedingReview"]);
});

test("verify: reads the pr merged issues through the code host plugin, never gh", async () => {
  assert.deepEqual(await viaFake(() => tryVerify(repo, config, quiet, 1)), ["findIssuesAwaitingVerify"]);
});

test("release: reaches the release PRs through the code host plugin, never gh", async () => {
  assert.deepEqual(await viaFake(() => tryRelease(repo, config, quiet, 1)), ["getOpenIssues"]);
});

test("reconcile: looks up stuck merged issues through the code host plugin, never gh", async () => {
  assert.deepEqual(await viaFake(() => runReconcileStage(repo, config, quiet, [])), ["findStuckMergedIssues"]);
});
