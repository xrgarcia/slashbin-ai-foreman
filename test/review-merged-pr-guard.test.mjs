// foreman#180: the review phase never starts a review for a PR that is already merged or closed, whatever
// the snapshot that produced the candidate says. The state is read live just before the Tech Lead is offered.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { registerPlugin, startPlugins, resetRegistryForTests } from "../dist/plugins/registry.js";
import { TechLeadPlugin } from "../dist/plugins/tech-lead.js";
import { tryReview } from "../dist/phases/review.js";
import { readPrState } from "../dist/github/review-freshness.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const tmp = mkdtempSync(join(tmpdir(), "review-merged-guard-"));
const saved = { PATH: process.env.PATH, KEY: process.env.TECHLEAD_GITHUB_KEY };
process.env.TECHLEAD_GITHUB_KEY ||= "test-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";

let state = "MERGED";
const calls = [];
const host = new Proxy({}, {
  get(_, key) {
    if (key === "then" || typeof key === "symbol") return undefined;
    return (...args) => {
      calls.push(key);
      switch (key) {
        case "findPRsNeedingReview": return { prNumber: 7, prUrl: "u", issueNumbers: [5], adopted: [] };
        case "blockedAmong": return [];
        case "getPRCheckVerdict": return { state: "passing", pending: [], failing: [] };
        case "readPrState": if (state === "THROW") throw new Error("TLS handshake timeout"); return state;
        case "forgetOpenPrs": return undefined;
        default: throw new Error(`fake code host: ${String(key)}`);
      }
    };
  },
});
const plugin = {
  id: "fake-host", roles: ["codeHost"], enabled: () => true,
  fills: (role, config) => role === "codeHost" && config.codeHost === "fake", codeHost: host,
};

let config, repo, ranMarker;
before(async () => {
  ranMarker = join(tmp, "ran");
  mkdirSync(join(tmp, "tl/bin"), { recursive: true });
  writeFileSync(join(tmp, "tl/bin/tech-lead.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ranMarker)}, "x"); process.exit(3);`);
  setStatePath(join(tmp, "state.json"));
  mkdirSync(join(tmp, "repo"));
  const p = join(tmp, "config.json");
  writeFileSync(p, JSON.stringify({
    codeHost: "fake", techLeadPath: join(tmp, "tl"), emRepoPath: "/x", paperclip: { enabled: false },
    repos: [{ name: "t", repoPath: join(tmp, "repo"), githubRepo: "example/t", baseBranch: "features", featureBranch: "feature/ai", productionBranch: "main", reviewEnabled: true }],
  }));
  config = loadConfig(p);
  repo = config.repos[0];
  resetRegistryForTests();
  for (const pl of [plugin, new TechLeadPlugin()]) registerPlugin(pl);
  await startPlugins(config, { logger: quiet, configText: () => null });
});
after(() => { process.env.PATH = saved.PATH; resetRegistryForTests(); rmSync(tmp, { recursive: true, force: true }); });

test("a candidate whose PR is already merged starts no review and drops the snapshot", async () => {
  state = "MERGED"; calls.length = 0;
  assert.equal(await tryReview(repo, config, quiet, 1), false);
  assert.ok(calls.includes("readPrState"));
  assert.ok(calls.includes("forgetOpenPrs"));
  assert.equal(existsSync(ranMarker), false, "the Tech Lead was offered a merged PR");
});

test("a closed PR starts no review either", async () => {
  state = "CLOSED"; calls.length = 0;
  assert.equal(await tryReview(repo, config, quiet, 1), false);
  assert.equal(existsSync(ranMarker), false);
});

test("a PR whose state cannot be read fails the pass: no review is spent", async () => {
  state = "THROW"; calls.length = 0;
  await assert.rejects(() => tryReview(repo, config, quiet, 1));
  assert.equal(existsSync(ranMarker), false);
});

test("readPrState reads the live state from gh and throws when gh fails", () => {
  mkdirSync(join(tmp, "bin"), { recursive: true });
  const gh = (body) => { writeFileSync(join(tmp, "bin/gh"), `#!/bin/sh\n${body}\n`); chmodSync(join(tmp, "bin/gh"), 0o755); };
  process.env.PATH = `${join(tmp, "bin")}:${saved.PATH}`;
  gh('echo \'{"state":"MERGED"}\'');
  assert.equal(readPrState(repo, 7, quiet), "MERGED");
  gh('echo \'{"state":"OPEN"}\'');
  assert.equal(readPrState(repo, 7, quiet), "OPEN");
  gh('echo "TLS handshake timeout" >&2; exit 1');
  assert.throws(() => readPrState(repo, 7, quiet));
  process.env.PATH = saved.PATH;
});
