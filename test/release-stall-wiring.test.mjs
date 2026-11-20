// The release phase reports its sign-off wait and blocked-label hold to StallClock (slashbin-ai-foreman#373).
// Drives the built stage (`tryRelease`) against the same fakes as release-stage.test.mjs, in a temporary state
// directory: the holds still return false, the clock starts once and is kept, the clearing event resolves it.
// Runs with FOREMAN_STALL_CLOCK on and off.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tryRelease, SOAK_DELAY_MS, REARM_SETTLE_MS } from "../dist/phases/release.js";
import { STALL_CHECK_CYCLE_INTERVAL } from "../dist/phases/common.js";
import { parseDeployTrailer } from "../dist/plugins/sre.js";
import { formatResultV1 } from "../dist/contract/result-v1.js";
import { readPvResult, configureIssueCache, productionDriftFiles, mergedPrNumber } from "../dist/github.js";
import { releaseTagName } from "../dist/github/conventions.js";
import { loadConfig, releaseStageWarning } from "../dist/config.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { createLogger } from "../dist/logger.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, repoRecordOf, seed, recordOf, breakRecords, breakPrRecords, seedRelease, releaseOf, prRecordOf } from "./issue-records.mjs";
import { registerPlugin, startPlugins, activeWorkSource, setCodeHost } from "../dist/plugins/registry.js";
import { githubCodeHost } from "../dist/plugins/github.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { withFreshMemory } from "./fresh-memory.mjs";
let rt = new ForemanRuntime();

await startAgentPlugins();

const tmp = mkdtempSync(join(tmpdir(), "foreman-release-test-"));
const bin = join(tmp, "bin");
mkdirSync(bin);
// The fakes are CommonJS: pin it, so a stray "type": "module" package.json above the temp dir cannot make them ESM.
writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
const GH_STATE = join(tmp, "gh-state.json");
const GH_LOG = join(tmp, "gh.log");
const CTL = join(tmp, "ctl.json");
const AGENT_LOG = join(tmp, "agents.log");
const SNAP = join(tmp, "deploy-labels.log");
const REPO = "example/rel";

// A fake gh over GH_STATE: issues, PRs, comments, tag refs and tag objects.
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
const comment = (n, body) => {
  st.seq = (st.seq || 0) + 1;
  (st.comments[n] = st.comments[n] || []).push({ url: "https://github.com/${REPO}/issues/" + n + "#issuecomment-" + st.seq, body, at: new Date().toISOString(), by: "foreman-bot" });
};
if (a.some((x) => /\\/releases(\\/|$)/.test(x)) || a[0] === "release") fail("the release stage must never touch GitHub Releases");
if (a[0] === "issue") {
  const is = st.issues[a[2]];
  if (a[1] === "list") out(Object.values(st.issues).filter((i) => i.state === "OPEN").map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((name) => ({ name })) })));
  if (a[1] === "view") out(is ? { state: is.state, labels: is.labels.map((name) => ({ name })) } : "null");
  if (!is) fail("no issue " + a[2]);
  if (a[1] === "edit") {
    for (const l of flags("--remove-label")) is.labels = is.labels.filter((x) => x !== l);
    for (const l of flags("--add-label")) if (!is.labels.includes(l)) is.labels.push(l);
    save(); out("");
  }
  if (a[1] === "close" && (st.failClose || []).includes(Number(a[2]))) fail("HTTP 502: Bad Gateway");
  if (a[1] === "close") { is.state = "CLOSED"; is.reason = flag("--reason"); save(); out(""); }
  if (a[1] === "reopen") { is.state = "OPEN"; save(); out(""); }
  if (a[1] === "comment") { comment(a[2], flag("--body")); save(); out(""); }
}
if (a[0] === "pr") {
  if (a[1] === "list") {
    if (st.mergedListFail && flag("--state") === "merged" && flag("--limit") === "40") fail("HTTP 502: Bad Gateway");
    const want = flag("--state") === "merged" ? "MERGED" : flag("--state") === "all" ? null : "OPEN";
    let l = Object.values(st.prs).filter((p) => want === null || p.state === want);
    if (flag("--base")) l = l.filter((p) => p.baseRefName === flag("--base"));
    if (flag("--head")) l = l.filter((p) => p.headRefName === flag("--head"));
    const since = /^merged:>=(.+)$/.exec(flag("--search") || "");
    if (since) l = l.filter((p) => p.mergedAt && p.mergedAt.slice(0, 19) >= since[1]);
    out(l.sort((x, y) => y.number - x.number).slice(0, Number(flag("--limit") || 100)));
  }
  if (a[1] === "view") { if ((st.unreadable || []).includes(Number(a[2]))) fail("HTTP 502: Bad Gateway"); const p = st.prs[a[2]]; if (!p) fail("Could not resolve to a PullRequest with the number of " + a[2]); out(p); }
  if (a[1] === "create") {
    const number = 200 + Object.keys(st.prs).length;
    st.prs[number] = { number, url: "https://github.com/${REPO}/pull/" + number, title: flag("--title"), state: "OPEN",
      headRefName: flag("--head"), baseRefName: flag("--base"), headRefOid: "a".repeat(40), mergeCommit: null, mergedAt: null, body: flag("--body") };
    save(); out("https://github.com/${REPO}/pull/" + number + "\\n");
  }
}
if (a[0] === "api") {
  const valued = new Set(["--method", "--jq", "-f"]);
  const path = a.find((x, i) => i > 0 && !x.startsWith("-") && !valued.has(a[i - 1]));
  const method = flag("--method") || "GET";
  let m;
  if ((m = /issues\\/(\\d+)\\/events/.exec(path)) && (flag("--jq") || "").includes("reopened")) { if (st.eventsFail) { process.stderr.write("GraphQL: could not resolve"); process.exit(1); } out(((st.reopened || {})[m[1]] || []).map((t) => JSON.stringify(t)).join("\\n")); }
  if ((m = /issues\\/(\\d+)\\/events/.exec(path))) out(((st.events || {})[m[1]] || []).map((e) => JSON.stringify(e)).join("\\n"));
  if ((m = /issues\\/(\\d+)\\/dependencies\\/blocking/.exec(path))) out(JSON.stringify((st.blocking || {})[m[1]] || []));
  if (method === "POST" && /\\/statuses\\//.test(path)) { (st.statuses = st.statuses || []).push({ sha: path.split("/").pop(), ...fields() }); save(); out(""); }
  if (method === "POST" && (m = /issues\\/(\\d+)\\/comments$/.exec(path))) { comment(m[1], fields().body); save(); out(""); }
  if ((m = /issues\\/(\\d+)\\/comments/.exec(path))) out((st.comments[m[1]] || []).map((c) => JSON.stringify(c)).join("\\n"));
  if (/\\/commits\\//.test(path)) out(st.prodHead);
  if (method === "GET" && flag("--jq") === ".state" && (m = /issues\\/(\\d+)$/.exec(path))) out((st.epicStates || {})[m[1]] || "open");
  if (method === "GET" && (m = /issues\\/(\\d+)$/.exec(path))) out((st.issues[m[1]] || {}).body || "");
  if (/\\/compare\\//.test(path) && flag("--jq") === ".status") {
    if (st.compareStatusFail) fail("HTTP 502: Bad Gateway");
    out((st.compareStatus || {})[path.split("/compare/")[1].split("...")[0]] || "behind");
  }
  if (/\\/compare\\//.test(path) && st.compareCommits && (flag("--jq") || "").includes("headline")) {
    out(st.compareCommits.map((c) => JSON.stringify(c)).join("\\n"));
  }
  if (/\\/compare\\//.test(path)) {
    const files = st.comparePaths ? st.comparePaths.length : st.compareFiles;
    out({ ahead: files > 0 ? 2 : 1, files, ...(st.comparePaths ? { paths: st.comparePaths } : {}) });
  }
  if ((m = /git\\/matching-refs\\/tags\\/(.*)$/.exec(path))) out(st.refs.filter((r) => r.ref.startsWith("refs/tags/" + m[1])));
  if (method === "GET" && (m = /git\\/tags\\/([0-9a-f]+)$/.exec(path))) out(st.tagObjects[m[1]].object);
  if (method === "POST" && /git\\/tags$/.test(path)) {
    const f = fields();
    const sha = (st.tagSeq = (st.tagSeq || 0) + 1).toString(16).padStart(40, "e");
    st.tagObjects[sha] = { tag: f.tag, message: f.message, object: f.object, type: f.type };
    save(); out(sha);
  }
  if (method === "POST" && /git\\/refs$/.test(path)) {
    const f = fields();
    st.refs.push({ ref: f.ref, object: { sha: f.sha, type: "tag" } });
    save(); out("");
  }
  if (method === "PATCH" && (m = /pulls\\/(\\d+)$/.exec(path))) { st.prs[m[1]].body = fields().body; save(); out(""); }
}
out("[]");
`);
chmodSync(join(bin, "gh"), 0o755);

// The Tech Lead and the SRE: each run takes the next response for its command
// from CTL ({ approve, deploy, prod, soak }: a list, or one response for every
// run) and may act on GitHub the way the real one would.
const agentScript = (name) => `import fs from "node:fs";
const args = process.argv.slice(2);
// The prerequisite preview is a flag-off SRE here (release-prereq-preview.test.mjs holds it): refused, unlogged, no queue read.
if (args.includes("--preview")) { process.stdout.write("preview disabled. Nothing ran.\\n"); process.exit(1); }
fs.appendFileSync(${JSON.stringify(AGENT_LOG)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
const ctl = JSON.parse(fs.readFileSync(${JSON.stringify(CTL)}, "utf8"));
const kind = args[0] === "verify" ? args[args.indexOf("--mode") + 1] : args[0] === "deploy" ? "deploy" : "approve";
const q = ctl[kind];
const r = (Array.isArray(q) ? q.shift() : q) || { exit: 2, out: "no response configured for " + kind };
fs.writeFileSync(${JSON.stringify(CTL)}, JSON.stringify(ctl));
const pr = args[args.indexOf("--pr") + 1];
if (kind === "deploy") {
  const g = JSON.parse(fs.readFileSync(${JSON.stringify(GH_STATE)}, "utf8"));
  fs.appendFileSync(${JSON.stringify(SNAP)}, JSON.stringify(Object.fromEntries(Object.values(g.issues).map((i) => [i.number, i.labels]))) + "\\n");
}
if (r.merge || r.pv || r.closeIssues) {
  const st = JSON.parse(fs.readFileSync(${JSON.stringify(GH_STATE)}, "utf8"));
  if (r.merge) Object.assign(st.prs[pr], { state: "MERGED", mergeCommit: { oid: r.merge }, mergedAt: new Date().toISOString() });
  for (const n of r.closeIssues || []) st.issues[n].state = "CLOSED";
  if (r.pv) {
    st.seq = (st.seq || 0) + 1;
    (st.comments[pr] = st.comments[pr] || []).push({ url: "https://github.com/${REPO}/pull/" + pr + "#issuecomment-" + st.seq, body: r.pv, at: new Date().toISOString() });
  }
  fs.writeFileSync(${JSON.stringify(GH_STATE)}, JSON.stringify(st));
}
process.stdout.write((r.out || "") + "\\n");
process.exit(r.exit ?? 0);
`;
const techLeadDir = join(tmp, "tech-lead");
const sreDir = join(tmp, "sre");
mkdirSync(join(techLeadDir, "bin"), { recursive: true });
mkdirSync(join(sreDir, "bin"), { recursive: true });
writeFileSync(join(techLeadDir, "bin", "tech-lead.mjs"), agentScript("tech-lead"));
writeFileSync(join(sreDir, "bin", "sre.mjs"), agentScript("sre"));
// The EM's follow-up booking (scripts/routines/deferred-verify.mjs in emRepoPath, which is tmp): logs the call and
// answers from CTL.schedule (default: booked).
mkdirSync(join(tmp, "scripts", "routines"), { recursive: true });
writeFileSync(join(tmp, "scripts", "routines", "deferred-verify.mjs"), `import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(AGENT_LOG)}, JSON.stringify(["em", ...args]) + "\\n");
let r = JSON.parse(fs.readFileSync(${JSON.stringify(CTL)}, "utf8")).schedule ?? { exit: 0, out: "scheduled R1 Deferred verify: o/r at then o/r:100=5" };
if (r.rejectPr !== undefined) r = String(r.rejectPr) === args[args.indexOf("--pr") + 1] ? { exit: 1, out: "rejected" } : { exit: 0, out: "scheduled R2 Deferred verify" };
process.stdout.write((r.out ?? "") + "\\n");
process.exit(r.exit ?? 0);
`);

const ENV = {
  PATH: `${bin}:${process.env.PATH}`,
  FOREMAN_GITHUB_TOKEN: "placeholder-not-a-token",
  EM_GITHUB_TOKEN: "placeholder-not-a-token",
  TECHLEAD_GITHUB_KEY: "placeholder-not-a-token",
  SRE_GITHUB_KEY: "placeholder-not-a-token",
};
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
const savedCwd = process.cwd();
Object.assign(process.env, ENV);
// Transcripts land under ./logs/release: keep them in the temp dir.
process.chdir(tmp);
configureIssueCache({ ttlMs: 0 });
test.after(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const logger = createLogger({ format: "text", level: "error" });
const writeCfg = (name, extra) => {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify({ emRepoPath: tmp, repos: [{ name: "rel", repoPath: tmp, githubRepo: REPO }], ...extra }));
  return p;
};
// The deployment's epic label (`engineering-manager #N`) is what the epic tests read.
const config = loadConfig(writeCfg("cfg.json", { epicRefLabel: "engineering-manager", epicRepo: "acme/slashbin-engineering-manager", prodGrantLabel: "deliver-to-prod", techLeadPath: techLeadDir, srePath: sreDir }));
const repo = config.repos[0];

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const OLD = "c".repeat(40);
const TAG_RE = /^release-\d{8}-\d{4}-pr(\d+)$/;

const issue = (number, ...labels) => ({ number, title: `Issue ${number}`, state: "OPEN", labels: ["approved", ...labels] });
const releasePr = (number, body, extra = {}) => ({
  number, url: `https://github.com/${REPO}/pull/${number}`, title: "Promote", state: "OPEN",
  headRefName: "develop", baseRefName: "main", headRefOid: HEAD, mergeCommit: null, mergedAt: null, body, ...extra,
});
const mergedPr = (number, body, mergeSha, minutesAgo) =>
  releasePr(number, body, { state: "MERGED", mergeCommit: { oid: mergeSha }, mergedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() });

let stateDir;
/** A fresh world: GitHub, the agents' answers, the Foreman's state and the stage's memory. */
function world({ issues = [], prs = [], comments = {}, refs = [], tagObjects = {}, compareFiles = 0, comparePaths, compareCommits, prodHead = MERGE, events = {} }, ctl = {}) {
  writeFileSync(GH_STATE, JSON.stringify({
    issues: Object.fromEntries(issues.map((i) => [i.number, i])),
    prs: Object.fromEntries(prs.map((p) => [p.number, p])),
    comments, events, refs, tagObjects, compareFiles, prodHead, ...(comparePaths ? { comparePaths } : {}), ...(compareCommits ? { compareCommits } : {}),
  }));
  writeFileSync(CTL, JSON.stringify(ctl));
  writeFileSync(GH_LOG, "");
  writeFileSync(AGENT_LOG, "");
  writeFileSync(SNAP, "");
  stateDir = mkdtempSync(join(tmp, "state-"));
  setStatePath(stateDir);
  rt = new ForemanRuntime();
  memoryRecords();
  setCodeHost(githubCodeHost()); // a fresh code host: its release sign-off memory starts empty
}
const gh = () => JSON.parse(readFileSync(GH_STATE, "utf8"));
const ghCalls = () => readFileSync(GH_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const agentCalls = () => readFileSync(AGENT_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const commentsOn = (n) => (gh().comments[n] ?? []).map((c) => c.body);
// The releases the stage carries live on their PR's record (EM#1244 f3): these read and change them the way the
// tests once read `prodReleases` in the state file.
const RELEASE_PRS = [80, 90, 100, ...Array.from({ length: 32 }, (_, i) => 200 + i)];
const prodReleases = async () => {
  const out = {};
  for (const n of RELEASE_PRS) { const r = await releaseOf(rt, repo, n); if (r) out[n] = r; }
  return out;
};
const editRel = async (pr, fn) => { const r = structuredClone(await releaseOf(rt, repo, pr)); fn(r); await seedRelease(rt, repo, r); };
const setReleases = async (rels) => {
  for (const n of RELEASE_PRS) if (!rels[n] && (await releaseOf(rt, repo, n))) await rt.releases.dropRelease(repo, n);
  for (const r of Object.values(rels)) await seedRelease(rt, repo, r);
};
const run = (cycle = 1) => tryRelease(rt, repo, config, logger, cycle);
const DEPLOYED = (verify) => ({ exit: 0, merge: MERGE, out: `SRE_DEPLOY pr=#100 merged=yes merge_sha=${MERGE} verify=${verify}` });
const pending = () => ({
  issues: [issue(5, "release pending"), issue(6, "release pending")],
  prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5\n- #6: Issue 6")],
  compareFiles: 3,
});
const setBodies = (bodies) => { const g = gh(); for (const [n, b] of Object.entries(bodies)) { g.issues[n].body = b; } writeFileSync(GH_STATE, JSON.stringify(g)); };
// The repo the release ships, for the dark-flag tests: develop, whose one file names `code`.
// A flag counts only once the shipped code names it, so the release PR's head is that commit.
function shippedCode(code) {
  const git = (...a) => execFileSync("git", a, { cwd: tmp, encoding: "utf8" }).trim();
  rmSync(join(tmp, ".git"), { recursive: true, force: true });
  git("init", "-q", "-b", "develop");
  writeFileSync(join(tmp, "flag.txt"), `${code}\n`);
  git("add", "flag.txt");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "code");
  git("remote", "add", "origin", tmp);
  const g = gh();
  g.prs[100].headRefOid = git("rev-parse", "HEAD");
  writeFileSync(GH_STATE, JSON.stringify(g));
}
const dropShippedCode = () => { rmSync(join(tmp, ".git"), { recursive: true, force: true }); rmSync(join(tmp, "flag.txt"), { force: true }); };

const stallOf = async (n, cause) => (await recordOf(rt, repo, n)).stalls?.[cause];
const unsignedWorld = () => ({
  issues: [issue(5, "release pending"), issue(6, "release pending"), issue(7, "pr approved"), issue(8, "pr approved")],
  prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5\n- #6: Issue 6\n- #7: Issue 7\n- #8: Issue 8")],
  compareFiles: 3,
});
const setLabels = (n, labels) => { const g = gh(); g.issues[n].labels = labels; writeFileSync(GH_STATE, JSON.stringify(g)); };
const statuses = () => gh().statuses ?? [];

for (const flag of ["on", "off"]) {
  const on = flag === "on";
  const before = process.env.FOREMAN_STALL_CLOCK;
  const setFlag = () => { if (on) process.env.FOREMAN_STALL_CLOCK = "1"; else delete process.env.FOREMAN_STALL_CLOCK; };
  test.afterEach(() => { if (before === undefined) delete process.env.FOREMAN_STALL_CLOCK; else process.env.FOREMAN_STALL_CLOCK = before; });

  test(`flag ${flag}: unsigned issues hold the release; one stall on the first one, its start kept across passes and a restart`, async () => {
    setFlag();
    world(unsignedWorld(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
    assert.equal(await run(), false);
    assert.equal(agentCalls().length, 0, "nothing is approved or deployed");
    assert.deepEqual(statuses().map((s) => s.state), ["failure"]);
    assert.match(statuses()[0].description, /#7, #8|#7.*#8/);
    const first = await stallOf(7, "release-sign-off");
    if (!on) { assert.equal(first, undefined, "flag off: nothing recorded"); assert.equal(await stallOf(8, "release-sign-off"), undefined); return; }
    assert.equal(first.id, `${REPO}#7:release-sign-off`);
    assert.deepEqual(first.affected, [`${REPO}#7`, `${REPO}#8`]);
    assert.equal(first.nextAction, "sign");
    assert.equal(first.resolver, "EM");
    assert.equal(first.state, "open");
    assert.equal(await stallOf(8, "release-sign-off"), undefined, "one stall for the release, not one per issue");
    await run(2);
    rt = withFreshMemory(new ForemanRuntime()); // a restart reads the same records
    await run(3);
    const again = await stallOf(7, "release-sign-off");
    assert.equal(again.startedAt, first.startedAt);
    assert.equal(again.state, "open");
  });

  test(`flag ${flag}: signing every issue resolves the sign-off stall`, async () => {
    setFlag();
    world(unsignedWorld(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
    await run();
    setLabels(7, ["approved", "release pending"]);
    setLabels(8, ["approved", "release pending"]);
    await run(2);
    const s = await stallOf(7, "release-sign-off");
    if (!on) return assert.equal(s, undefined);
    assert.equal(s.state, "resolved");
    assert.ok(s.resolvedAt);
  });

  test(`flag ${flag}: the stall stays on its issue when an earlier issue is signed; the clock is not reset`, async () => {
    setFlag();
    world(unsignedWorld(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
    await run();
    setLabels(7, ["approved", "release pending"]);
    await run(2);
    if (!on) return;
    const s = await stallOf(7, "release-sign-off");
    assert.equal(s.state, "open");
    assert.deepEqual(s.affected, [`${REPO}#8`]);
    assert.equal(await stallOf(8, "release-sign-off"), undefined);
  });

  test(`flag ${flag}: an unsigned issue that ships dark opens no stall`, async () => {
    setFlag();
    world({ ...unsignedWorld(), issues: [issue(5, "release pending"), issue(7, "pr approved")], prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5\n- #7: Issue 7")] },
      { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
    setBodies({ 7: "## Pre-Flight\n- **Dark flag:** `X_ENABLED`" });
    shippedCode("if (process.env.X_ENABLED) start();");
    try {
      await run();
      assert.equal(await stallOf(7, "release-sign-off"), undefined);
    } finally { dropShippedCode(); }
  });

  test(`flag ${flag}: a blocked issue holds the release, opens one stall, and removing the label resolves it`, async () => {
    setFlag();
    world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
    setLabels(5, ["approved", "release pending", "blocked"]);
    assert.equal(await run(), false);
    assert.equal(agentCalls().length, 0);
    const s = await stallOf(5, "release-blocked-label");
    if (!on) assert.equal(s, undefined);
    else {
      assert.equal(s.id, `${REPO}#5:release-blocked-label`);
      assert.deepEqual(s.affected, [`${REPO}#5`]);
      assert.equal(s.state, "open");
      await run(2);
      assert.equal((await stallOf(5, "release-blocked-label")).startedAt, s.startedAt);
    }
    setLabels(5, ["approved", "release pending"]);
    await run(3);
    const done = await stallOf(5, "release-blocked-label");
    if (on) assert.equal(done.state, "resolved");
    else assert.equal(done, undefined);
  });

  test(`flag ${flag}: a Foreman predeploy-stop holds the release; a passing re-check resolves its stall, a repeat STOP keeps it`, async () => {
    setFlag();
    const STOP = { exit: 0, out: "SRE_DEPLOY pr=#100 merged=no merge_sha=none verify=none hold=predeploy-stop evidence=https://example.test/stop" };
    const due = async () => {
      const g = gh(); g.events = { 5: [{ label: "blocked", by: "foreman-bot" }], 6: [{ label: "blocked", by: "foreman-bot" }] }; writeFileSync(GH_STATE, JSON.stringify(g));
      await rt.records.updatePrRecord(repo, 100, (d) => { d.predeployStop.at = new Date(Date.now() - DEFAULT_BACKOFF.predeployStopRecheckMs - 60_000).toISOString(); });
      rt = withFreshMemory(rt);
    };
    world(pending(), { approve: [{ exit: 0 }, { exit: 0 }, { exit: 0 }], deploy: [STOP, STOP, DEPLOYED("pass")] });
    assert.equal(await run(), true);
    assert.equal(await run(2), false, "waiting on the recorded stop");
    const s = await stallOf(5, "release-blocked-label");
    if (!on) assert.equal(s, undefined);
    else { assert.equal(s.state, "open"); assert.equal(s.episode, undefined); }
    await due();
    assert.equal(await run(3), true, "the re-check runs and the SRE stops again");
    const kept = await stallOf(5, "release-blocked-label");
    if (on) { assert.equal(kept.state, "open"); assert.equal(kept.startedAt, s.startedAt); assert.equal(kept.episode, undefined); }
    else assert.equal(kept, undefined);
    await due();
    assert.equal(await run(4), true, "the re-check passes and the release merges");
    assert.equal((await prRecordOf(rt, repo, 100)).predeployStop, undefined);
    const done = await stallOf(5, "release-blocked-label");
    if (on) { assert.equal(done.state, "resolved"); assert.ok(done.resolvedAt); } else assert.equal(done, undefined);
    await run(5);
    if (on) assert.equal((await stallOf(5, "release-blocked-label")).state, "resolved");
  });

  test(`flag ${flag}: a stall that cannot be written leaves the hold and the sign-off status unchanged`, async () => {
    setFlag();
    world(unsignedWorld(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
    breakRecords([7], { saves: true });
    assert.equal(await run(), false);
    assert.equal(agentCalls().length, 0);
    assert.deepEqual(statuses().map((s) => s.state), ["failure"]);
  });
}
