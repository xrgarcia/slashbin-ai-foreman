// QA registry bearer and registry-answered coverage (slashbin-ai-foreman#242, EM#794 C).
// A fake secrets runner in a temp dir records its argv and answers `covers` as told.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QaPlugin } from "../dist/plugins/qa.js";
import { qaApplies, qaBeforeMergeApplies } from "../dist/qa-report.js";
import { qaFor, registerPlugin, registeredPlugins, startPlugins } from "../dist/plugins/registry.js";
import { TechLeadPlugin } from "../dist/plugins/tech-lead.js";
import { isToolingHold, verifyHoldPlan } from "../dist/phases/verify.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const tmp = mkdtempSync(join(tmpdir(), "qa-coverage-"));
const em = join(tmp, "em"), qa = join(tmp, "qa"), out = join(tmp, "out");
for (const d of [em, qa, out]) mkdirSync(d);
const calls = join(tmp, "calls.jsonl"), mode = join(tmp, "mode.json");
writeFileSync(calls, "");
const setMode = (m) => writeFileSync(mode, JSON.stringify(m));
writeFileSync(join(em, "runner.mjs"), `
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const m = JSON.parse(readFileSync(${JSON.stringify(mode)}, "utf8"));
const covers = process.argv.includes("covers");
if (covers && m.sleepMs) await new Promise((r) => setTimeout(r, m.sleepMs));
if (covers && m.say) console.error(m.say);
process.exit(covers ? (m.code ?? 1) : 2);
`);
const all = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const coversCalls = () => all().filter((a) => a.includes("covers"));
const keysOf = (a) => a[a.indexOf("--keys") + 1].split(",");

const CONSOLE = "xrgarcia/Slashbin-console";
const config = {
  qaPath: qa, emRepoPath: em, qaSecretsRunner: "runner.mjs", qaRepos: [CONSOLE], sessionEnv: [],
  pollIntervalMs: 1500, qaBeforeMerge: true, techLeadPath: "/x", qaBearerKey: "BEARER@home",
};
const QA_BEARER_KEYS = ["BEARER@home"];
const plugin = new QaPlugin();
const have = new Set(registeredPlugins().map((p) => p.id));
if (!have.has("qa")) registerPlugin(new QaPlugin());
if (!have.has("tech-lead")) registerPlugin(new TechLeadPlugin());
await startPlugins({ ...config, paperclip: { enabled: false } }, { logger: quiet, configText: () => null });
const ask = (repo, cfg = config) => qaApplies({ githubRepo: repo }, cfg);

test("the runner is asked for the one configured bearer key, pin included", async () => {
  setMode({ code: 0 });
  await ask("o/onekey");
  assert.deepEqual(keysOf(coversCalls().pop()), ["BEARER@home"]);
});

test("checkDev --keys carries the mint key and both bearer keys, searched dev,prd", async () => {
  setMode({});
  await plugin.qa.check({}, config, { repo: CONSOLE, pr: 1, out, local: false }, quiet);
  const c = all().filter((a) => a.includes("check") && !a.includes("--local")).pop();
  assert.deepEqual(keysOf(c), [`DEV_SESSION_MINT_KEY@${CONSOLE}`, ...QA_BEARER_KEYS]);
  assert.equal(c[c.indexOf("--keys") + 2], "dev,prd");
});

test("checkLocal runs the runner with the bearer keys and no mint key; unset runner is errored", async () => {
  setMode({});
  await plugin.qa.check({}, config, { repo: CONSOLE, pr: 2, out, local: true }, quiet);
  const c = all().find((a) => a.includes("--local"));
  assert.deepEqual(keysOf(c), [...QA_BEARER_KEYS]);
  assert.equal(c[c.indexOf("--keys") + 2], "dev,prd");
  const r = await plugin.qa.check({}, { ...config, qaSecretsRunner: undefined }, { repo: CONSOLE, pr: 3, out, local: true }, quiet);
  assert.equal(r.kind, "errored");
});

test("a qaRepos repo is covered with zero spawns", async () => {
  const n = all().length;
  assert.equal(await ask(CONSOLE), true);
  assert.equal(await qaBeforeMergeApplies({ githubRepo: CONSOLE }, config), true);
  assert.equal(all().length, n);
});

test("QA answers for any other repo: 0 covered, 1 not, unset runner / emRepoPath / old QA not covered", async () => {
  setMode({ code: 0 });
  assert.equal(await ask("o/covered"), true);
  const c = coversCalls().pop();
  assert.equal(c[c.indexOf("--repo") + 1], "o/covered");
  assert.deepEqual(keysOf(c), [...QA_BEARER_KEYS]);
  assert.equal(c[c.indexOf("--keys") + 2], "prd");
  setMode({ code: 1 });
  assert.equal(await ask("o/uncovered"), false);
  assert.equal(await ask("o/norunner", { ...config, qaSecretsRunner: undefined }), false);
  assert.equal(await ask("o/noem", { ...config, emRepoPath: undefined }), false);
  setMode({ code: 2, say: "unknown command covers" });
  assert.equal(await ask("o/oldqa"), false);
});

test("registry-unavailable and a timeout are unknown: never covered, never a merge, a no-charge tooling hold", async () => {
  setMode({ code: 3, say: "HELD registry-unavailable" });
  assert.equal(await ask("o/down"), "unknown");
  assert.equal(await qaBeforeMergeApplies({ githubRepo: "o/down" }, config), "unknown");
  assert.equal(await qaFor({ githubRepo: "o/down" }, config), "unknown");
  setMode({ code: 0, sleepMs: 6000 });
  const t0 = Date.now();
  assert.equal(await ask("o/slow"), "unknown");
  assert.ok(Date.now() - t0 < 5000, "killed at pollIntervalMs");
  assert.equal(isToolingHold("qa-coverage-unknown"), true);
  assert.equal(verifyHoldPlan("qa-coverage-unknown").kind, "defer");
  // QA's HELD registry-unavailable (slashbin_ai_qa#32) reaches the gate as qa-held-<hold>: deferred, not charged.
  assert.equal(isToolingHold("qa-held-registry-unavailable"), true);
  assert.equal(verifyHoldPlan("qa-held-registry-unavailable").kind, "defer");
});

test("a second ask within the TTL spawns zero times; concurrent asks share one spawn", async () => {
  setMode({ code: 0 });
  let n = coversCalls().length;
  await ask("o/ttl");
  assert.equal(coversCalls().length - n, 1);
  n = coversCalls().length;
  await ask("o/ttl");
  assert.equal(coversCalls().length, n);
  n = coversCalls().length;
  await Promise.all([ask("o/fresh"), ask("o/fresh"), ask("o/fresh")]);
  assert.equal(coversCalls().length - n, 1);
});

test("a coverage spawn that never launches (EM checkout missing, ENOENT) is unknown, and stays unknown from the cache", async () => {
  const bad = { ...config, emRepoPath: join(tmp, "no-such-em") };
  assert.equal(await ask("o/enoent", bad), "unknown");
  assert.equal(await ask("o/enoent", bad), "unknown");
  assert.equal(await qaBeforeMergeApplies({ githubRepo: "o/enoent" }, bad), "unknown");
  assert.equal(await qaFor({ githubRepo: "o/enoent" }, bad), "unknown");
});

test("the phases never treat unknown as covered or as an advance", () => {
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(src("phases/verify.ts"), /qaCovers === "unknown"[\s\S]{0,300}reason: "qa-coverage-unknown"/);
  assert.match(src("phases/review.ts"), /qaPre === "unknown"[\s\S]{0,500}return false/);
  assert.match(src("phases/qa-before-merge.ts"), /qaBeforeMergeApplies\(repoConfig, config\)\) !== true\) return "none"/);
  assert.match(src("phases/revise.ts"), /\(await qaBeforeMergeApplies\(repoConfig, config\)\) === true/);
});

test("a settled answer outlives the poll interval; an unknown one is re-asked after it (2026-11-07 Doppler flood)", async () => {
  setMode({ code: 0 });
  let n = coversCalls().length;
  assert.equal(await ask("o/settled"), true);
  setMode({ code: 3, say: "HELD registry-unavailable" });
  assert.equal(await ask("o/flaky"), "unknown");
  assert.equal(coversCalls().length - n, 2);
  await new Promise((r) => setTimeout(r, config.pollIntervalMs + 200));
  n = coversCalls().length;
  assert.equal(await ask("o/settled"), true, "kept past pollIntervalMs");
  assert.equal(coversCalls().length, n);
  await ask("o/flaky");
  assert.equal(coversCalls().length - n, 1, "unknown is asked again");
});
