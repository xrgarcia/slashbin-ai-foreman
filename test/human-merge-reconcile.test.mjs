// EM#1150 f3 review: with no reviewer, a PR a person merged is found and its
// issue settled by the reconcile stage itself, from `pr under review`, whatever
// the branch layout. Drives runReconcileStage against a fake `gh` on PATH backed
// by a JSON file; nothing reaches GitHub. The layout here is the one the
// dead-zone scan skips: feature branch = base branch = develop, production main.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReconcileStage, HUMAN_MERGE_CLOSE_MARK } from "../dist/phases/reconcile.js";
import { configureIssueCache } from "../dist/github.js";
import { loadConfig } from "../dist/config.js";
import { setStatePath } from "../dist/state.js";
import { createLogger } from "../dist/logger.js";
import { startAgentPlugins } from "./agent-plugins.mjs";

await startAgentPlugins();

const tmp = mkdtempSync(join(tmpdir(), "foreman-human-merge-"));
const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
const ST = join(tmp, "gh-state.json");
const REPO = "example/hm";

// A fake gh: open issues with labels, merged PRs, issue comments, and a log of label
// edits. `failOnce` lists "issue <verb>@<n>": the n-th such call fails, once.
writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(${JSON.stringify(ST)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(ST)}, JSON.stringify(st));
const out = (v) => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); };
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
const flags = (n) => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
const key = a[0] + " " + a[1];
st.calls[key] = (st.calls[key] || 0) + 1;
save();
const f = (st.failOnce || []).indexOf(key + "@" + st.calls[key]);
if (f >= 0) { st.failOnce.splice(f, 1); save(); process.stderr.write("HTTP 422: Validation Failed (test-injected)"); process.exit(1); }
if (a[0] === "issue") {
  const is = st.issues[a[2]];
  if (a[1] === "list") out(Object.values(st.issues).filter((i) => i.state === "OPEN").map((i) => ({ number: i.number, title: "t", labels: i.labels.map((name) => ({ name })) })));
  if (a[1] === "view") out(is ? { state: is.state, labels: is.labels.map((name) => ({ name })) } : "null");
  if (a[1] === "edit") {
    for (const l of flags("--remove-label")) { if (!is.labels.includes(l)) { process.stderr.write("label not on issue: " + l); process.exit(1); } is.labels = is.labels.filter((x) => x !== l); }
    for (const l of flags("--add-label")) if (!is.labels.includes(l)) is.labels.push(l);
    st.edits.push({ remove: flags("--remove-label"), add: flags("--add-label") });
    save(); out("");
  }
  if (a[1] === "close") { is.state = "CLOSED"; save(); out(""); }
  if (a[1] === "comment") { (st.comments[a[2]] = st.comments[a[2]] || []).push(flag("--body")); save(); out(""); }
}
if (a[0] === "pr" && a[1] === "list") out(flag("--state") === "merged" ? st.merged.filter((p) => p.baseRefName === flag("--base")) : []);
if (a[0] === "api") {
  const m = /issues\\/(\\d+)\\/comments/.exec(a[1]);
  if (m) out((st.comments[m[1]] || []).map((b) => JSON.stringify(b)).join("\\n"));
}
out("[]");
`);
chmodSync(join(bin, "gh"), 0o755);

const saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN };
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "placeholder-not-a-token";
configureIssueCache({ ttlMs: 0 });
test.after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

const cfgPath = join(tmp, "cfg.json");
writeFileSync(cfgPath, JSON.stringify({
  stages: [{ type: "reconcile" }, { type: "implement" }],
  repos: [{ name: "hm", repoPath: tmp, githubRepo: REPO, featureBranch: "develop", baseBranch: "develop", productionBranch: "main" }],
}));
const config = loadConfig(cfgPath);
const repo = config.repos[0];
const logger = createLogger({ format: "text", level: "error" });

function world(failOnce = []) {
  setStatePath(mkdtempSync(join(tmp, "state-")));
  writeFileSync(ST, JSON.stringify({
    issues: { 12: { number: 12, state: "OPEN", labels: ["approved", "pr under review"] } },
    merged: [{ number: 34, url: `https://github.com/${REPO}/pull/34`, title: "Fix the thing", body: "Closes #12", commits: [], baseRefName: "develop", mergedAt: new Date(Date.now() - 60_000).toISOString() }],
    comments: {},
    edits: [],
    calls: {},
    failOnce,
  }));
}
const gh = () => JSON.parse(readFileSync(ST, "utf8"));
const pass = () => runReconcileStage(repo, config, logger, []);

test("same-branch layout, no reviewer: an issue at `pr under review` whose PR a person merged is closed within two passes, merged and approved recorded, one comment", async () => {
  assert.equal(config.techLeadPath, undefined);
  world(["issue edit@2"]); // pass 1: `pr merged` lands, the `pr approved` edit fails
  await pass();
  let st = gh();
  assert.equal(st.issues[12].state, "OPEN", "pass 1: stopped at the failed edit");
  assert.deepEqual(st.issues[12].labels, ["approved", "pr merged"], "pass 1: merged recorded");
  await pass();
  st = gh();
  assert.equal(st.issues[12].state, "CLOSED", "pass 2: closed");
  assert.ok(st.edits.some((e) => e.remove.includes("pr under review") && e.add.includes("pr merged")), "merged recorded");
  assert.ok(st.edits.some((e) => e.remove.includes("pr merged") && e.add.includes("pr approved")), "approved recorded");
  assert.equal((st.comments[12] || []).length, 1, "exactly one completion comment");
  assert.ok(st.comments[12][0].includes(HUMAN_MERGE_CLOSE_MARK));
  assert.match(st.comments[12][0], /PR #34/);
});

test("the completion comment fails on pass 1: nothing closes; pass 2 comments once and closes", async () => {
  world(["issue comment@1"]);
  await pass();
  let st = gh();
  assert.equal(st.issues[12].state, "OPEN", "pass 1: not closed without its comment");
  assert.deepEqual(st.issues[12].labels, ["approved", "pr approved"], "pass 1: left at `pr approved`");
  assert.equal((st.comments[12] || []).length, 0);
  await pass();
  st = gh();
  assert.equal(st.issues[12].state, "CLOSED");
  assert.equal(st.comments[12].length, 1, "pass 2 commented once");
});
