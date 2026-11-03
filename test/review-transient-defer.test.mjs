// foreman#180: a transient GitHub error inside the Tech Lead, however it exits, is a silent tooling defer:
// no blocked event, a retry scheduled. Codex being unavailable stays the visible wait. Run end to end through
// tryReview with a fake Tech Lead process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { registerPlugin, startPlugins, resetRegistryForTests } from "../dist/plugins/registry.js";
import { TechLeadPlugin } from "../dist/plugins/tech-lead.js";
import { tryReview } from "../dist/phases/review.js";
import { addObserver, drainObservers } from "../dist/work-source.js";
import { ForemanRuntime } from "../dist/runtime.js";
let rt = new ForemanRuntime();

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const tmp = mkdtempSync(join(tmpdir(), "review-transient-defer-"));
process.env.TECHLEAD_GITHUB_KEY ||= "test-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";

const host = new Proxy({}, {
  get(_, key) {
    if (key === "then" || typeof key === "symbol") return undefined;
    return () => {
      switch (key) {
        case "findPRsNeedingReview": return { prNumber: 7, prUrl: "u", issueNumbers: [5], adopted: [] };
        case "blockedAmong": return [];
        case "getPRCheckVerdict": return { state: "passing", pending: [], failing: [] };
        case "readPrState": return "OPEN";
        case "findRevokedEmGates": return [];
        default: return [];
      }
    };
  },
});
const plugin = { id: "fake-host", roles: ["codeHost"], enabled: () => true, fills: (role, config) => role === "codeHost" && config.codeHost === "fake", codeHost: host };

// One repo per scenario: the review defer is kept per repo name.
const scenarios = {
  tlsExit3: 'console.error("gh pr view 7: net/http: TLS handshake timeout"); console.log("retry later"); process.exit(3);',
  unavailableExit3: 'console.log("GitHub unavailable after 4 attempts — nothing written; retry later."); process.exit(3);',
  http500Exit1: 'console.error("review-pr failed: gh pr view 7: HTTP 500: Internal Server Error"); process.exit(1);',
  codexExit3: 'console.log("Codex first read failed (signed-out) — nothing written"); process.exit(3);',
};
const events = [];
let config;
before(async () => {
  setStatePath(join(tmp, "state.json"));
  mkdirSync(join(tmp, "repo"));
  const repos = [];
  for (const [name, script] of Object.entries(scenarios)) {
    mkdirSync(join(tmp, name, "bin"), { recursive: true });
    writeFileSync(join(tmp, name, "bin/tech-lead.mjs"), script);
    repos.push({ name, repoPath: join(tmp, "repo"), githubRepo: "example/t", baseBranch: "features", featureBranch: "feature/ai", productionBranch: "main", reviewEnabled: true });
  }
  const p = join(tmp, "config.json");
  writeFileSync(p, JSON.stringify({ codeHost: "fake", techLeadPath: join(tmp, "tlsExit3"), emRepoPath: "/x", paperclip: { enabled: false }, repos }));
  config = loadConfig(p);
  resetRegistryForTests();
  const source = { id: "fake-src", roles: ["workSource"], enabled: () => true, workSource: { selectWork: async () => [], record: async () => false } };
  for (const pl of [plugin, source, new TechLeadPlugin()]) registerPlugin(pl);
  await startPlugins(config, { logger: quiet, configText: () => null });
  addObserver({ onEvent: (e) => { events.push(e); } });
});
after(() => { resetRegistryForTests(); rmSync(tmp, { recursive: true, force: true }); });

async function run(name) {
  events.length = 0;
  const repo = config.repos.find((r) => r.name === name);
  const result = await tryReview(rt, repo, { ...config, techLeadPath: join(tmp, name) }, quiet, 1);
  await drainObservers();
  return { result, blocked: events.filter((e) => e.kind === "blocked") };
}

for (const name of ["tlsExit3", "unavailableExit3", "http500Exit1"]) {
  test(`${name}: deferred for retry, no blocked event`, async () => {
    const { result, blocked } = await run(name);
    assert.equal(result, false);
    assert.deepEqual(blocked, []);
  });
}

test("codexExit3: the visible wait still blocks the card, anchored on inReview", async () => {
  const { result, blocked } = await run("codexExit3");
  assert.equal(result, false);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].at, "inReview");
});
