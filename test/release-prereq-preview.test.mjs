// Release-phase prerequisite preview (EM#2357): while a release PR waits on EM sign-off, the Foreman asks the
// SRE's read-only preview once per head sha, before it writes the sign-off status, and never merges or
// verifies on it. Fixture `gh` and SRE binaries on PATH; nothing here reaches GitHub or a live system.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryRelease } from "../dist/phases/release.js";
import { configureIssueCache } from "../dist/github.js";
import { loadConfig } from "../dist/config.js";
import { setStateDir } from "../dist/state-dir.js";
import { createLogger } from "../dist/logger.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { githubCodeHost } from "../dist/plugins/github.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords } from "./issue-records.mjs";

const tmp = mkdtempSync(join(tmpdir(), "foreman-prereq-preview-"));

const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
const GH_STATE = join(tmp, "gh-state.json"), GH_LOG = join(tmp, "gh.log"), AGENT_LOG = join(tmp, "agents.log");
const REPO = "example/rel";
const HEAD_A = "a".repeat(40), HEAD_B = "d".repeat(40);

// Fixture gh over GH_STATE: issues, PRs, comments, statuses. Anything it does not know answers an empty list.
writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(a) + "\\n");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(GH_STATE)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(GH_STATE)}, JSON.stringify(st));
const out = (v) => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); };
const fail = (m) => { process.stderr.write(m); process.exit(1); };
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
const flags = (n) => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
const fields = () => Object.fromEntries(flags("-f").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
const comment = (n, body) => { st.seq = (st.seq || 0) + 1; (st.comments[n] = st.comments[n] || []).push({ url: "https://github.com/${REPO}/issues/" + n + "#issuecomment-" + st.seq, body, at: new Date().toISOString(), by: "foreman-bot" }); };
if (a[0] === "issue") {
  const is = st.issues[a[2]];
  if (a[1] === "list") out(Object.values(st.issues).filter((i) => i.state === "OPEN").map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((name) => ({ name })) })));
  if (a[1] === "view") out(is ? { state: is.state, labels: is.labels.map((name) => ({ name })) } : "null");
  if (!is) fail("no issue " + a[2]);
  if (a[1] === "edit") { for (const l of flags("--remove-label")) is.labels = is.labels.filter((x) => x !== l); for (const l of flags("--add-label")) if (!is.labels.includes(l)) is.labels.push(l); save(); out(""); }
  if (a[1] === "comment") { comment(a[2], flag("--body")); save(); out(""); }
}
if (a[0] === "pr") {
  if (a[1] === "list") {
    const want = flag("--state") === "merged" ? "MERGED" : flag("--state") === "all" ? null : "OPEN";
    let l = Object.values(st.prs).filter((p) => want === null || p.state === want);
    if (flag("--base")) l = l.filter((p) => p.baseRefName === flag("--base"));
    if (flag("--head")) l = l.filter((p) => p.headRefName === flag("--head"));
    out(l.sort((x, y) => y.number - x.number).slice(0, Number(flag("--limit") || 100)));
  }
  if (a[1] === "view") { const p = st.prs[a[2]]; if (!p) fail("Could not resolve to a PullRequest with the number of " + a[2]); out(p); }
}
if (a[0] === "api") {
  const valued = new Set(["--method", "--jq", "-f"]);
  const path = a.find((x, i) => i > 0 && !x.startsWith("-") && !valued.has(a[i - 1]));
  const method = flag("--method") || "GET";
  let m;
  if ((m = /issues\\/(\\d+)\\/events/.exec(path))) out(((st.events || {})[m[1]] || []).map((e) => JSON.stringify(e)).join("\\n"));
  if ((m = /issues\\/(\\d+)\\/dependencies\\/blocking/.exec(path))) out("[]");
  if (method === "POST" && /\\/statuses\\//.test(path)) { (st.statuses = st.statuses || []).push({ sha: path.split("/").pop(), ...fields() }); save(); out(""); }
  if (method === "POST" && (m = /issues\\/(\\d+)\\/comments$/.exec(path))) { comment(m[1], fields().body); save(); out(""); }
  if ((m = /issues\\/(\\d+)\\/comments/.exec(path))) out((st.comments[m[1]] || []).map((c) => JSON.stringify(c)).join("\\n"));
  if (/\\/commits\\//.test(path)) out(st.prodHead);
  if (method === "GET" && (m = /issues\\/(\\d+)$/.exec(path))) out((st.issues[m[1]] || {}).body || "");
  if (/\\/compare\\//.test(path) && flag("--jq") === ".status") out("behind");
  if (/\\/compare\\//.test(path)) out({ ahead: 2, files: 3 });
  if (/git\\/matching-refs\\/tags\\//.test(path)) out([]);
}
out("[]");
`);
chmodSync(join(bin, "gh"), 0o755);

// Fixture SRE and Tech Lead. Every call is logged. The SRE answers `deploy --preview` per the seam contract.
const agentScript = (name) => `import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(AGENT_LOG)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
const arg = (n) => args[args.indexOf(n) + 1];
if (${JSON.stringify(name)} === "sre" && args[0] === "deploy" && args.includes("--preview")) {
  const ctl = JSON.parse(fs.readFileSync(${JSON.stringify(join(tmp, "ctl.json"))}, "utf8"));
  if (process.env.SRE_PREREQ_PREVIEW !== "1") { process.stdout.write("preview disabled. Nothing ran.\\n"); process.exit(1); }
  if (ctl.previewExit === 3) { process.stdout.write("could not run: codex unavailable\\n"); process.exit(3); }
  const pr = arg("--pr"), sha = arg("--sha");
  const st = JSON.parse(fs.readFileSync(${JSON.stringify(GH_STATE)}, "utf8"));
  (st.comments[pr] = st.comments[pr] || []).push({ url: "https://github.com/${REPO}/pull/" + pr + "#issuecomment-p" + sha.slice(0, 4), at: new Date().toISOString(),
    body: "## Production Prerequisites (preview)\\n\\nVerdict: PROMOTE\\n\\nSRE_PREREQ_PREVIEW pr=#" + pr + " sha=" + sha + " verdict=PROMOTE at=" + new Date().toISOString() });
  fs.writeFileSync(${JSON.stringify(GH_STATE)}, JSON.stringify(st));
  fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(["PREVIEW-COMMENT-POSTED", sha]) + "\\n");
  process.stdout.write("SRE_PREREQ_PREVIEW pr=#" + pr + " sha=" + sha + " verdict=PROMOTE at=" + new Date().toISOString() + "\\n");
  process.exit(0);
}
process.stdout.write("fixture agent: unexpected call\\n");
process.exit(2);
`;
const sreDir = join(tmp, "sre"), techLeadDir = join(tmp, "tech-lead");
for (const [d, n, f] of [[sreDir, "sre", "sre.mjs"], [techLeadDir, "tech-lead", "tech-lead.mjs"]]) {
  mkdirSync(join(d, "bin"), { recursive: true });
  writeFileSync(join(d, "bin", f), agentScript(n));
}

Object.assign(process.env, {
  PATH: `${bin}:${process.env.PATH}`,
  FOREMAN_GITHUB_TOKEN: "placeholder-not-a-token", EM_GITHUB_TOKEN: "placeholder-not-a-token",
  TECHLEAD_GITHUB_KEY: "placeholder-not-a-token", SRE_GITHUB_KEY: "placeholder-not-a-token",
});
await startAgentPlugins();
configureIssueCache({ ttlMs: 0 });

const logger = createLogger({ format: "text", level: "error" });
const cfgPath = join(tmp, "cfg.json");
writeFileSync(cfgPath, JSON.stringify({ emRepoPath: tmp, repos: [{ name: "rel", repoPath: tmp, githubRepo: REPO }], epicRefLabel: "engineering-manager", epicRepo: "acme/engineering-manager", prodGrantLabel: "deliver-to-prod", techLeadPath: techLeadDir, srePath: sreDir }));
const config = loadConfig(cfgPath);
const repo = config.repos[0];

const issue = (number, ...labels) => ({ number, title: `Issue ${number}`, state: "OPEN", labels: ["approved", ...labels] });
const releasePr = (head) => ({
  number: 100, url: `https://github.com/${REPO}/pull/100`, title: "Promote", state: "OPEN", headRefName: "develop", baseRefName: "main",
  headRefOid: head, mergeCommit: null, mergedAt: null, body: "## Production Promotion\n\n### Issues included\n- #5: Issue 5\n- #7: Issue 7",
});
const gh = () => JSON.parse(readFileSync(GH_STATE, "utf8"));
const putGh = (g) => writeFileSync(GH_STATE, JSON.stringify(g));
const ghCalls = () => readFileSync(GH_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const agentCalls = () => readFileSync(AGENT_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const previews = () => (gh().comments[100] ?? []).filter((c) => c.body.startsWith("## Production Prerequisites (preview)"));
const statuses = () => gh().statuses ?? [];
const previewCalls = () => agentCalls().filter((c) => c[0] === "sre" && c.includes("--preview"));

let rt, n = 0;
/** A fresh world: issue 5 signed (release pending), issue 7 not (pr approved), one open release PR at `head`. */
function world({ flagOn, previewExit } = {}) {
  putGh({ issues: { 5: issue(5, "release pending"), 7: issue(7, "pr approved") }, prs: { 100: releasePr(HEAD_A) }, comments: {}, events: {}, prodHead: "b".repeat(40), statuses: [] });
  writeFileSync(join(tmp, "ctl.json"), JSON.stringify({ previewExit }));
  for (const f of [GH_LOG, AGENT_LOG]) writeFileSync(f, "");
  if (flagOn) process.env.SRE_PREREQ_PREVIEW = "1"; else delete process.env.SRE_PREREQ_PREVIEW;
  setStateDir(mkdtempSync(join(tmp, "state-")));
  rt = new ForemanRuntime();
  memoryRecords();
  setCodeHost(githubCodeHost());
}
const run = () => tryRelease(rt, repo, config, logger, ++n);
const setHead = (h) => { const g = gh(); g.prs[100].headRefOid = h; putGh(g); };
/** No path ever merges the release PR or runs a deploy or verify: no `--preview`-less deploy, no verify, no `pr merge`. */
const neverMergedOrVerified = () => agentCalls().every((c) => !(c[0] === "sre" && (c[1] === "verify" || (c[1] === "deploy" && !c.includes("--preview")))))
  && gh().prs[100].state === "OPEN" && ghCalls().every((c) => !(c[0] === "pr" && c[1] === "merge"));


test.after(() => { delete process.env.SRE_PREREQ_PREVIEW; rmSync(tmp, { recursive: true, force: true }); });

test("flag unset: the SRE refuses, no comment, the sign-off status is still written, no merge", async () => {
  world({ flagOn: false });
  assert.equal(await run(), false);
  assert.equal(previews().length, 0);
  assert.ok(statuses().length >= 1 && statuses().every((s) => s.state !== "success"));
  assert.ok(neverMergedOrVerified());
});

test("flag set: the preview comment is posted before the sign-off status", async () => {
  world({ flagOn: true });
  await run();
  const log = ghCalls();
  const posted = log.findIndex((c) => c[0] === "PREVIEW-COMMENT-POSTED");
  const status = log.findIndex((c) => c[0] === "api" && c.some((x) => /\/statuses\//.test(x)));
  assert.equal(previews().length, 1);
  assert.ok(posted > -1 && status > -1 && posted < status);
  assert.ok(neverMergedOrVerified());
});

test("the preview is keyed by head sha: the same head is not asked again, a new head is", async () => {
  world({ flagOn: true });
  await run(); await run();
  assert.equal(previewCalls().length, 1);
  setHead(HEAD_B);
  await run();
  assert.equal(previewCalls().length, 2);
  const bodies = previews().map((c) => c.body);
  assert.ok(bodies.some((b) => b.includes(`sha=${HEAD_A}`)) && bodies.some((b) => b.includes(`sha=${HEAD_B}`)));
  assert.ok(neverMergedOrVerified());
});

test("an unavailable preview (exit 3) posts nothing, leaves the wait unchanged and is asked again next scan", async () => {
  world({ flagOn: true, previewExit: 3 });
  await run();
  assert.equal(previews().length, 0);
  assert.ok(statuses().length >= 1);
  writeFileSync(join(tmp, "ctl.json"), JSON.stringify({}));
  await run();
  assert.equal(previewCalls().length, 2);
  assert.equal(previews().length, 1);
  assert.ok(neverMergedOrVerified());
});

test("no path runs a deploy or a verify, or asks the Tech Lead", async () => {
  world({ flagOn: true });
  await run(); setHead(HEAD_B); await run();
  assert.ok(agentCalls().every((c) => c[0] === "sre" && c[1] === "deploy" && c.includes("--preview")));
});
