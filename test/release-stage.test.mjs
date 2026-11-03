// The release stage (EM#578): from `release pending` to closed-on-prod-
// verification with no person in the loop. These drive the built stage
// (`tryRelease`) and the promote stage's release paths against fakes on PATH:
// a `gh` backed by a JSON file it mutates, a `tech-lead.mjs` and an `sre.mjs`
// that answer from a control file. Nothing here reaches GitHub.
//
// What they hold the stage to:
//   - the Tech Lead approves at the PR's head before the SRE deploys it, and a
//     refusal (exit 4) or an SRE `predeploy-stop`, `merge-refused-repeatedly` or
//     `merge-blocked-check` blocks the issues with a
//     comment; every other failure retries on a back-off and writes nothing;
//   - a merge is tagged with a plain annotated tag (never a GitHub Release, never
//     a `v*` name), reused when one is already on the merge commit;
//   - a pass closes each issue with one comment and no lifecycle label; a hold
//     reopens it at `prod verification held`; never closed-but-unverified;
//   - it adopts merged releases it did not deploy, and the SRE sweep's holds.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tryRelease, SOAK_DELAY_MS } from "../dist/phases/release.js";
import { tryPromotion } from "../dist/phases/promote.js";
import { STALL_CHECK_CYCLE_INTERVAL } from "../dist/phases/common.js";
import { parseDeployTrailer } from "../dist/plugins/sre.js";
import { readPvResult, configureIssueCache, productionDriftFiles, mergedPrNumber } from "../dist/github.js";
import { releaseTagName } from "../dist/github/conventions.js";
import { loadConfig, releaseStageWarning } from "../dist/config.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { createLogger } from "../dist/logger.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, repoRecordOf, seed, recordOf, breakRecords, breakPrRecords, seedRelease, releaseOf } from "./issue-records.mjs";
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
  if (a[1] === "close") { is.state = "CLOSED"; is.reason = flag("--reason"); save(); out(""); }
  if (a[1] === "reopen") { is.state = "OPEN"; save(); out(""); }
  if (a[1] === "comment") { comment(a[2], flag("--body")); save(); out(""); }
}
if (a[0] === "pr") {
  if (a[1] === "list") {
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
  if ((m = /issues\\/(\\d+)\\/events/.exec(path))) out(((st.events || {})[m[1]] || []).map((e) => JSON.stringify(e)).join("\\n"));
  if (method === "POST" && /\\/statuses\\//.test(path)) { (st.statuses = st.statuses || []).push({ sha: path.split("/").pop(), ...fields() }); save(); out(""); }
  if (method === "POST" && (m = /issues\\/(\\d+)\\/comments$/.exec(path))) { comment(m[1], fields().body); save(); out(""); }
  if ((m = /issues\\/(\\d+)\\/comments/.exec(path))) out((st.comments[m[1]] || []).map((c) => JSON.stringify(c)).join("\\n"));
  if (/\\/commits\\//.test(path)) out(st.prodHead);
  if (method === "GET" && (m = /issues\\/(\\d+)$/.exec(path))) out((st.issues[m[1]] || {}).body || "");
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
fs.appendFileSync(${JSON.stringify(AGENT_LOG)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
const ctl = JSON.parse(fs.readFileSync(${JSON.stringify(CTL)}, "utf8"));
const kind = args[0] === "verify" ? args[args.indexOf("--mode") + 1] : args[0] === "deploy" ? "deploy" : "approve";
const q = ctl[kind];
const r = (Array.isArray(q) ? q.shift() : q) || { exit: 2, out: "no response configured for " + kind };
fs.writeFileSync(${JSON.stringify(CTL)}, JSON.stringify(ctl));
const pr = args[args.indexOf("--pr") + 1];
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
// Slashbin's profile: its epic label (`engineering-manager #N`) is what the epic tests read.
const config = loadConfig(writeCfg("cfg.json", { profile: "slashbin", techLeadPath: techLeadDir, srePath: sreDir }));
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
function world({ issues = [], prs = [], comments = {}, refs = [], tagObjects = {}, compareFiles = 0, comparePaths, compareCommits, prodHead = MERGE }, ctl = {}) {
  writeFileSync(GH_STATE, JSON.stringify({
    issues: Object.fromEntries(issues.map((i) => [i.number, i])),
    prs: Object.fromEntries(prs.map((p) => [p.number, p])),
    comments, refs, tagObjects, compareFiles, prodHead, ...(comparePaths ? { comparePaths } : {}), ...(compareCommits ? { compareCommits } : {}),
  }));
  writeFileSync(CTL, JSON.stringify(ctl));
  writeFileSync(GH_LOG, "");
  writeFileSync(AGENT_LOG, "");
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

const DEPLOYED = (verify, rest = "") =>
  ({ exit: 0, merge: MERGE, out: `SRE_DEPLOY pr=#100 merged=yes merge_sha=${MERGE} verify=${verify}${rest}` });
const VERIFY = (pr, hold) =>
  ({ exit: 0, out: `FOREMAN_REVIEW pr=#${pr} verdict=APPROVE merged=yes deploy=SUCCESS${hold ? ` hold=${hold}` : ""}` });
const pending = () => ({
  issues: [issue(5, "release pending"), issue(6, "release pending")],
  prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5\n- #6: Issue 6")],
  compareFiles: 3,
});

function assertClosedVerified(n, { tag, evidence } = {}) {
  const i = gh().issues[n];
  assert.equal(i.state, "CLOSED", `#${n} closed`);
  assert.equal(i.reason, "completed", `#${n} closed as completed`);
  assert.deepEqual(i.labels, ["approved"], `#${n} carries no lifecycle label`);
  const pass = commentsOn(n).filter((b) => b.startsWith("**Verified in production.**"));
  assert.equal(pass.length, 1, `#${n} has one closing comment`);
  assert.ok(pass[0].includes(MERGE.slice(0, 10)), "the comment names the merge commit");
  if (tag) assert.ok(pass[0].includes(tag), "the comment names the tag");
  if (evidence) assert.ok(pass[0].includes(evidence), "the comment links the evidence");
}

function assertHeld(n, slug) {
  const i = gh().issues[n];
  assert.equal(i.state, "OPEN", `#${n} open`);
  assert.ok(i.labels.includes("prod verification held"), `#${n} at prod verification held`);
  assert.ok(!i.labels.includes("release pending"), `#${n} left release pending`);
  assert.ok(commentsOn(n).some((b) => b.startsWith(`**Production verification held: \`${slug}\`.**`)), `#${n} says why (${slug})`);
}

const tagsCreated = () => ghCalls().filter((c) => c.includes("POST") && c.some((x) => /git\/tags$/.test(x)));

// --- The deploy path -----------------------------------------------------------

test("approve → deploy → pass: tagged, every issue closed with one comment, the soak queued", async () => {
  world(pending(), { approve: { exit: 0, out: "approved" }, deploy: DEPLOYED("pass", " evidence=https://example.test/pv") });
  assert.equal(await run(), true);

  const calls = agentCalls();
  assert.deepEqual(calls[0], ["tech-lead", "approve-promotion", "--repo", REPO, "--pr", "100", "--sha", HEAD]);
  assert.deepEqual(calls[1], ["sre", "deploy", "--repo", REPO, "--pr", "100", "--sha", HEAD]);
  assert.equal(calls.length, 2);

  const st = gh();
  assert.equal(st.refs.length, 1, "one tag ref");
  const tag = st.refs[0].ref.replace("refs/tags/", "");
  assert.match(tag, TAG_RE);
  assert.ok(!tag.startsWith("v"));
  const obj = st.tagObjects[st.refs[0].object.sha];
  assert.equal(obj.object, MERGE, "the tag is on the merge commit");
  assert.equal(obj.type, "commit");
  assert.match(obj.message, /- #5\n- #6/, "the tag message lists the issues");
  assert.ok(!ghCalls().some((c) => c.some((x) => /releases/.test(x))), "never a GitHub Release");

  assertClosedVerified(5, { tag, evidence: "https://example.test/pv" });
  assertClosedVerified(6, { tag });

  const rs = await prodReleases();
  assert.equal(rs[100].phase, "soaking");
  assert.equal(Date.parse(rs[100].soakAt) - Date.parse(rs[100].mergedAt), SOAK_DELAY_MS);
  assert.equal((await recordOf(rt, repo, 5)).prodVerified.mergeSha, MERGE);
  assert.equal((await recordOf(rt, repo, 6)).prodVerified.tag, tag);

  // Before the soak is due nothing runs.
  assert.equal(await run(2), false);
  assert.equal(agentCalls().length, 2);
});

// foreman#148: an error the SRE excluded during a production verification reaches the EM, and the release still ships.
const unrelatedEntries = async () => Object.values((await repoRecordOf(rt, repo)).unstick ?? {}).filter((e) => e.kind === "unrelated-error");
const TRIAGE = (prefix) => [`${prefix}Evidence: https://example.test/pv-ev`, `${prefix}Not caused by this release, needs triage: billing: Expired API Key provided: rk_test_1234`].join("\n");

test("the first prod deploy's excluded error reaches the EM with its evidence; the release still closes", async () => {
  const d = DEPLOYED("pass", " evidence=https://example.test/pv");
  world(pending(), { approve: { exit: 0, out: "approved" }, deploy: { ...d, out: `${TRIAGE("verify: ")}\n${d.out}` } });
  assert.equal(await run(), true);
  assertClosedVerified(5);
  const u = await unrelatedEntries();
  assert.equal(u.length, 1);
  assert.equal(u[0].issue, 0);
  assert.match(u[0].reason, /PR #100 \(prod deploy\).*Expired API Key.*Evidence: https:\/\/example\.test\/pv-ev/);
});

test("a prod deploy whose evidence is only on its SRE_DEPLOY trailer still hands that link to the EM", async () => {
  const d = DEPLOYED("pass", " evidence=https://example.test/pv-trailer");
  world(pending(), { approve: { exit: 0, out: "approved" }, deploy: { ...d, out: `verify: Not caused by this release, needs triage: billing: Expired API Key provided: rk_test_1234\n${d.out}` } });
  assert.equal(await run(), true);
  assertClosedVerified(5);
  const u = await unrelatedEntries();
  assert.equal(u.length, 1);
  assert.match(u[0].reason, /PR #100 \(prod deploy\).*Expired API Key.*Evidence: https:\/\/example\.test\/pv-trailer/);
});

test("a prod verification's excluded error reaches the EM once; the release still closes", async () => {
  const v = VERIFY(90);
  world({ issues: [issue(7, "pr approved")], prs: [mergedPr(90, "- #7: Issue 7", MERGE, 60)] }, { prod: { ...v, out: `${TRIAGE("")}\n${v.out}` } });
  assert.equal(await run(), true);
  assertClosedVerified(7);
  const u = await unrelatedEntries();
  assert.equal(u.length, 1);
  assert.match(u[0].reason, /PR #90 \(prod\).*Evidence: https:\/\/example\.test\/pv-ev/);
});

// foreman#151: a prod close tells the EM the epic may be ready to close, once per epic and issue.
const epicEntries = async () => Object.values((await repoRecordOf(rt, repo)).unstick ?? {}).filter((e) => e.kind === "epic-ready-to-close");
const setBodies = (bodies) => { const g = gh(); for (const [n, b] of Object.entries(bodies)) { g.issues[n].body = b; } writeFileSync(GH_STATE, JSON.stringify(g)); };

test("closing an epic's child in production asks the EM whether the epic is ready to close; the release still closes", async () => {
  world(pending(), { approve: { exit: 0, out: "approved" }, deploy: DEPLOYED("pass") });
  setBodies({ 5: "## References\n- engineering-manager #880" });
  assert.equal(await run(), true);
  assertClosedVerified(5);
  const e = await epicEntries();
  assert.equal(e.length, 1, "only the issue that names an epic");
  assert.equal(e[0].issue, 0);
  assert.match(e[0].reason, /example\/rel#5 was closed .*engineering-manager #880/);
  assert.equal(await run(2), false);
  assert.equal((await epicEntries()).length, 1, "a later cycle adds nothing");
});

// EM#1244 f5 review: a hand-off to the EM is saved BEFORE the event that raised it is acknowledged. Unsaved, the
// pass fails closed with the child still open, and the next healthy pass raises it again.
const REPO_RECORD = { kind: "repo" };
/** Break the repo record (`saves`: only its saves), run `during`, then put the work source back the way it was. */
async function withRepoRecordBroken(saves, during) {
  const source = activeWorkSource();
  const [load, save] = [source.loadRecord, source.saveRecord];
  breakRecords([0], { saves, ...REPO_RECORD });
  try { await during(); } finally { source.loadRecord = load; source.saveRecord = save; }
}

for (const [name, saves] of [["R1: the repo record is unavailable", false], ["R2: the repo record cannot be saved", true]]) {
  test(`epic hand-off ${name}: the child is not closed, and the next healthy pass closes it with the hand-off recorded`, async () => {
    world({ ...pending(), prs: [mergedPr(100, "- #5\n- #6", MERGE, 5)] }, { prod: VERIFY(100) });
    await trackedMerged([5, 6]);
    setBodies({ 5: "## References\n- engineering-manager #880" });
    await withRepoRecordBroken(saves, async () => {
      await assert.rejects(run(), /hand-off to the EM could not be saved|epic-ready-to-close/);
    });
    assert.equal(gh().issues[5].state, "OPEN", "the child is still open: the trigger is intact");
    assert.equal(commentsOn(5).length, 0, "and was not commented on");
    assert.equal((await epicEntries()).length, 0);
    assert.equal(await run(2), true, "the healthy pass");
    assertClosedVerified(5);
    const e = await epicEntries();
    assert.equal(e.length, 1, "the hand-off survived the failure and is recorded");
    assert.match(e[0].reason, /example\/rel#5 was closed .*engineering-manager #880/);
  });
}

// EM#1244 f5 (Foreman PR #197), unrelated R1-R9: an unrelated-error report whose save failed is held IN MEMORY under its
// PR and drained at the gate every transition passes through, so a clean re-verification cannot advance, settle or drop
// the release past an unsaved report, and the ORIGINAL is recorded exactly once after recovery.
const setCtl = (ctl) => writeFileSync(CTL, JSON.stringify(ctl));
const DIRTY = (v) => ({ ...v, out: `${TRIAGE("")}\n${v.out}` });
const original = (e) => e.length === 1 && /Expired API Key/.test(e[0].reason) && /Evidence: https:\/\/example\.test\/pv-ev/.test(e[0].reason);

for (const [name, saves] of [["unavailable", false], ["unsaved", true]]) {
  test(`prod merged phase, repo record ${name}: the issue stays open; the CLEAN re-verification still saves the original report once, then closes`, async () => {
    world({ issues: [issue(7, "pr approved")], prs: [mergedPr(90, "- #7: Issue 7", MERGE, 60)] }, { prod: DIRTY(VERIFY(90)) });
    await withRepoRecordBroken(saves, async () => { await assert.rejects(run(), /hand-off to the EM could not be saved/); });
    assert.equal(gh().issues[7].state, "OPEN", "nothing was closed on a verdict whose hand-off is unsaved");
    assert.equal((await unrelatedEntries()).length, 0);
    setCtl({ prod: VERIFY(90) }); // the error does not recur
    await withRepoRecordBroken(saves, async () => { await assert.rejects(run(2), /hand-off to the EM could not be saved/); });
    assert.equal(gh().issues[7].state, "OPEN", "a clean result does not get past the gate while the record is down");
    assert.equal(await run(3), true);
    assertClosedVerified(7);
    assert.ok(original(await unrelatedEntries()), "the original, once");
    await run(4);
    assert.equal((await unrelatedEntries()).length, 1, "and not again");
  });
}

test("prod merged phase: a repeat of the same error and the pending one save once", async () => {
  world({ issues: [issue(7, "pr approved")], prs: [mergedPr(90, "- #7: Issue 7", MERGE, 60)] }, { prod: DIRTY(VERIFY(90)) });
  await withRepoRecordBroken(true, async () => { await assert.rejects(run(), /hand-off to the EM could not be saved/); });
  assert.equal(await run(2), true, "the error recurs: the pending report and the new one are one signature");
  assertClosedVerified(7);
  assert.equal((await unrelatedEntries()).length, 1);
});

test("prod held phase: the clean re-verification (prodReverified) waits for the saved report, then records the original once", async () => {
  world({ issues: [issue(5, "prod verification held")], prs: [mergedPr(100, "### Issues included\n- #5: Issue 5", MERGE, 20)], compareFiles: 0, prodHead: MERGE }, { prod: DIRTY(VERIFY(100)) });
  await seedRelease(rt, repo, { pr: 100, headSha: HEAD, issues: [5], phase: "held", mergeSha: MERGE, mergedAt: new Date().toISOString(), attempts: 1, hold: "x", retryAt: new Date(Date.now() - 1000).toISOString(), since: new Date().toISOString() });
  await withRepoRecordBroken(true, async () => { await assert.rejects(run(), /hand-off to the EM could not be saved/); });
  assert.equal((await prodReleases())[100].phase, "held", "not settled");
  setCtl({ prod: VERIFY(100) });
  assert.equal(await run(2), true);
  assertClosedVerified(5);
  assert.ok(original(await unrelatedEntries()));
});

test("prod deploy origin: the merged deploy's report survives a clean recovery verification, recorded once, without redeploying", async () => {
  const d = DEPLOYED("pass", " evidence=https://example.test/pv");
  world(pending(), { approve: { exit: 0, out: "approved" }, deploy: { ...d, out: `${TRIAGE("verify: ")}\n${d.out}` }, prod: VERIFY(100) });
  await withRepoRecordBroken(true, async () => { await assert.rejects(run(), /hand-off to the EM could not be saved/); });
  assert.equal((await unrelatedEntries()).length, 0);
  assert.equal(await run(2), true, "recovery recognizes the merge and verifies; that verification is clean");
  assertClosedVerified(5);
  assert.ok(original(await unrelatedEntries()));
  assert.equal(agentCalls().filter((c) => c[1] === "deploy").length, 1, "deployed once");
});

test("soak: the clean soak that follows a failed hand-off does not drop the release until the original is saved, then records it once", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass"), soak: DIRTY(VERIFY(100)) });
  await run();
  await editRel(100, (r) => { r.soakAt = new Date(Date.now() - 1000).toISOString(); });
  await withRepoRecordBroken(true, async () => { await assert.rejects(run(2), /hand-off to the EM could not be saved/); });
  assert.ok((await prodReleases())[100], "the release is kept");
  setCtl({ approve: { exit: 0 }, deploy: DEPLOYED("pass"), soak: VERIFY(100) });
  await withRepoRecordBroken(true, async () => { await assert.rejects(run(3), /hand-off to the EM could not be saved/); });
  assert.ok((await prodReleases())[100], "a clean soak cannot drop it while the record is down");
  assert.equal(await run(4), true);
  assert.equal((await prodReleases())[100], undefined, "settled once saved");
  assert.ok(original(await unrelatedEntries()));
});

// R1 (round 4): while A's drain is still failing, a result reporting a NEW error B must still keep B. The gate buffers
// the fresh result's reports before it drains, at every site.
const DIRTY_B = (v) => ({ ...v, out: `Evidence: https://example.test/b-ev\nNot caused by this release, needs triage: worker: redis connection refused here\n${v.out}` });
const bothRecorded = async () => {
  const e = await unrelatedEntries();
  return e.length === 2 && e.some((x) => /Expired API Key/.test(x.reason)) && e.some((x) => /redis connection refused/.test(x.reason));
};

test("soak R1: A unsaved, then a soak reports B while the drain still fails; B is kept, and a later clean soak records both before dropping", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass"), soak: DIRTY(VERIFY(100)) });
  await run();
  await editRel(100, (r) => { r.soakAt = new Date(Date.now() - 1000).toISOString(); });
  await withRepoRecordBroken(true, async () => { await assert.rejects(run(2), /hand-off to the EM could not be saved/); });
  setCtl({ approve: { exit: 0 }, deploy: DEPLOYED("pass"), soak: DIRTY_B(VERIFY(100)) });
  await withRepoRecordBroken(true, async () => { await assert.rejects(run(3), /hand-off to the EM could not be saved/); });
  assert.ok((await prodReleases())[100], "kept");
  setCtl({ approve: { exit: 0 }, deploy: DEPLOYED("pass"), soak: VERIFY(100) });
  assert.equal(await run(4), true);
  assert.equal((await prodReleases())[100], undefined, "settled once saved");
  assert.ok(await bothRecorded(), "A and B, once each");
});

test("merged R1: A unsaved, then the re-verification reports B while the drain still fails; B is kept, and a clean pass records both before closing", async () => {
  world({ issues: [issue(7, "pr approved")], prs: [mergedPr(90, "- #7: Issue 7", MERGE, 60)] }, { prod: DIRTY(VERIFY(90)) });
  await withRepoRecordBroken(true, async () => { await assert.rejects(run(), /hand-off to the EM could not be saved/); });
  setCtl({ prod: DIRTY_B(VERIFY(90)) });
  await withRepoRecordBroken(true, async () => { await assert.rejects(run(2), /hand-off to the EM could not be saved/); });
  assert.equal(gh().issues[7].state, "OPEN");
  setCtl({ prod: VERIFY(90) });
  assert.equal(await run(3), true);
  assertClosedVerified(7);
  assert.ok(await bothRecorded(), "A and B, once each");
});

test("no epicRefLabel (no profile): a prod close reads no epic and asks the EM nothing; the release still closes", async () => {
  const neutral = loadConfig(writeCfg("neutral.json", { techLeadPath: techLeadDir, srePath: sreDir }));
  assert.equal(neutral.repos[0].epicRefLabel, undefined);
  world(pending(), { approve: { exit: 0, out: "approved" }, deploy: DEPLOYED("pass") });
  setBodies({ 5: "## References\n- engineering-manager #880" });
  assert.equal(await tryRelease(rt, neutral.repos[0], neutral, logger, 1), true);
  assertClosedVerified(5);
  assert.equal((await epicEntries()).length, 0);
});

test("the soak runs once, 30 minutes on: a pass ends the release", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass"), soak: VERIFY(100) });
  await run();
  await editRel(100, (r) => { r.soakAt = new Date(Date.now() - 1000).toISOString(); });
  assert.equal(await run(2), true);
  assert.deepEqual(agentCalls()[2], ["sre", "verify", "--mode", "soak", "--repo", REPO, "--pr", "100"]);
  assert.equal((await prodReleases())[100], undefined, "settled");
  assertClosedVerified(5);
  assert.equal(await run(3), false);
  assert.equal(agentCalls().length, 3, "soaked once");
});

test("a soak hold reopens the closed issues at `prod verification held` and forgets their verification", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass"), soak: VERIFY(100, "error-rate-up") });
  await run();
  await editRel(100, (r) => { r.soakAt = new Date(Date.now() - 1000).toISOString(); });
  await run(2);
  assertHeld(5, "soak:error-rate-up");
  assertHeld(6, "soak:error-rate-up");
  const rs = await prodReleases();
  assert.equal(rs[100].phase, "held");
  assert.equal(rs[100].soaked, true);
  assert.equal((await recordOf(rt, repo, 5)).prodVerified, undefined);
});

test("the Tech Lead refuses (exit 4): the issues are blocked with the reason, and the SRE never runs", async () => {
  world(pending(), { approve: { exit: 4, out: "head moved since the review" } });
  assert.equal(await run(), true);
  assert.equal(agentCalls().length, 1);
  for (const n of [5, 6]) {
    const i = gh().issues[n];
    assert.ok(i.labels.includes("blocked"));
    assert.ok(i.labels.includes("release pending"), "release pending stays");
    assert.equal(i.state, "OPEN");
    const c = commentsOn(n);
    assert.equal(c.length, 1);
    assert.match(c[0], /^\*\*Release stopped: needs a person\.\*\*/);
    assert.match(c[0], /head moved since the review/);
  }
  rt = withFreshMemory(rt);
  assert.equal(await run(2), false, "a blocked release is not retried");
  assert.equal(agentCalls().length, 1);
});

test("a Tech Lead that could not run (exit 3) writes nothing and backs off", async () => {
  world(pending(), { approve: { exit: 3, out: "codex unavailable" } });
  assert.equal(await run(), true);
  assert.equal(await run(2), false, "inside the back-off");
  assert.equal(agentCalls().length, 1);
  for (const n of [5, 6]) {
    assert.deepEqual(gh().issues[n].labels, ["approved", "release pending"]);
    assert.deepEqual(commentsOn(n), []);
  }
});

test("SRE deploy exit 3 retries whatever its trailer says; nothing is blocked or tracked", async () => {
  world(pending(), {
    approve: { exit: 0 },
    deploy: { exit: 3, out: "SRE_DEPLOY pr=#100 merged=no merge_sha=none verify=none hold=predeploy-stop" },
  });
  assert.equal(await run(), true);
  assert.equal(await run(2), false, "inside the back-off");
  assert.equal(agentCalls().length, 2);
  assert.deepEqual(gh().issues[5].labels, ["approved", "release pending"]);
  assert.deepEqual(commentsOn(5), []);
  assert.equal((await prodReleases())[100], undefined);
});

for (const hold of ["predeploy-post-failed", "merge-failed", "merge-refused", "dry-run"]) {
  test(`SRE deploy merged=no hold=${hold}: a retry, never a block`, async () => {
    world(pending(), {
      approve: [{ exit: 0 }, { exit: 0 }],
      deploy: { exit: 0, out: `SRE_DEPLOY pr=#100 merged=no merge_sha=none verify=none hold=${hold}` },
    });
    assert.equal(await run(), true);
    assert.deepEqual(gh().issues[5].labels, ["approved", "release pending"]);
    assert.deepEqual(commentsOn(5), []);
    assert.equal(gh().refs.length, 0, "nothing merged, nothing tagged");
    // Once the back-off passes it asks the Tech Lead again (a new head needs a new approval).
    rt = withFreshMemory(rt);
    await run(2);
    assert.deepEqual(agentCalls().map((c) => c[1]), ["approve-promotion", "deploy", "approve-promotion", "deploy"]);
  });
}

test("SRE deploy refused (exit 1) retries", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: { exit: 1, out: "no Tech Lead approval at this head" } });
  assert.equal(await run(), true);
  assert.deepEqual(gh().issues[5].labels, ["approved", "release pending"]);
  assert.equal(await run(2), false);
});

for (const hold of ["predeploy-stop", "merge-refused-repeatedly", "merge-blocked-check"]) {
  test(`${hold} is a deploy STOP: the issues are blocked with the evidence`, async () => {
    world(pending(), {
      approve: { exit: 0 },
      deploy: { exit: 0, out: `SRE_DEPLOY pr=#100 merged=no merge_sha=none verify=none hold=${hold} evidence=https://example.test/stop` },
    });
    assert.equal(await run(), true);
    for (const n of [5, 6]) {
      assert.ok(gh().issues[n].labels.includes("blocked"));
      assert.match(commentsOn(n)[0], new RegExp(hold));
      assert.match(commentsOn(n)[0], /https:\/\/example\.test\/stop/);
    }
  });
}

test("merged but held: reopened at `prod verification held`, re-verified on the back-off, closed on a pass", async () => {
  world(pending(), {
    approve: { exit: 0 },
    // GitHub's closing keywords closed #5 at the merge: the hold reopens it.
    deploy: { ...DEPLOYED("hold", " hold=healthcheck-red evidence=https://example.test/pv1"), closeIssues: [5] },
    prod: VERIFY(100),
  });
  assert.equal(await run(), true);
  assertHeld(5, "healthcheck-red");
  assertHeld(6, "healthcheck-red");
  assert.match(commentsOn(5).at(-1), /https:\/\/example\.test\/pv1/);
  assert.equal(gh().refs.length, 1, "a held release is tagged too");
  const rel = (await prodReleases())[100];
  assert.equal(rel.phase, "held");
  assert.ok(Date.parse(rel.retryAt) - Date.now() >= DEFAULT_BACKOFF.prodVerifyRetry.baseMs - 60_000, "on the prodVerifyRetry back-off");

  assert.equal(await run(2), false, "not before retryAt");
  await editRel(100, (r) => { r.retryAt = new Date(Date.now() - 1000).toISOString(); });
  assert.equal(await run(3), true);
  assert.deepEqual(agentCalls().at(-1), ["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "100"]);
  const tag = gh().refs[0].ref.replace("refs/tags/", "");
  assertClosedVerified(5, { tag });
  assertClosedVerified(6, { tag });
  assert.equal(tagsCreated().length, 1, "tagged once");
});

test("a held release is due now once the production head moves, then the back-off resumes", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("hold", " hold=publish-failed evidence=https://example.test/pv1"), prod: VERIFY(100, "publish-failed") });
  await run();
  const setHead = (sha) => { const st = gh(); st.prodHead = sha; writeFileSync(GH_STATE, JSON.stringify(st)); };
  assert.equal((await prodReleases())[100].verifiedHead, MERGE, "the head at the hold is recorded");

  rt = withFreshMemory(rt);
  assert.equal(await run(2), false, "head unchanged: not due");

  setHead("f".repeat(40));
  rt = withFreshMemory(rt);
  assert.equal(await run(3), true, "head changed: due now");
  assert.deepEqual(agentCalls().at(-1), ["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "100"]);
  const rel = (await prodReleases())[100];
  assert.equal(rel.attempts, 2);
  assert.equal(rel.verifiedHead, "f".repeat(40));
  assert.ok(Date.parse(rel.retryAt) - Date.now() >= DEFAULT_BACKOFF.prodVerifyRetry.baseMs, "back-off resumes");

  rt = withFreshMemory(rt);
  assert.equal(await run(4), false, "same head: once per head");
});

test("a hold persisted before heads were recorded is due on the first probe, then waits per head", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("hold", " hold=publish-failed"), prod: VERIFY(100, "publish-failed") });
  await run();
  await editRel(100, (r) => {
    delete r.verifiedHead;
    r.retryAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
  });
  rt = withFreshMemory(rt);
  assert.equal(await run(2), true, "no recorded head: verified on the first probe, not after six hours");
  assert.deepEqual(agentCalls().at(-1), ["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "100"]);
  assert.equal((await prodReleases())[100].verifiedHead, MERGE, "the head is recorded");

  rt = withFreshMemory(rt);
  assert.equal(await run(3), false, "same head on the next probe: the back-off holds");
});

test("a head change across many held releases is one head read; a hold in that pass adds no read", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("hold", " hold=publish-failed"), prod: VERIFY(100, "publish-failed") });
  await run();
  const old = new Date(Date.now() + 3_600_000).toISOString();
  for (let pr = 200; pr < 232; pr++) await seedRelease(rt, repo, { pr, headSha: MERGE, issues: [], phase: "held", attempts: 1, retryAt: old, verifiedHead: MERGE, since: old });
  await editRel(100, (r) => { r.retryAt = old; });
  const st0 = gh(); st0.prodHead = "e".repeat(40); writeFileSync(GH_STATE, JSON.stringify(st0));
  rt = withFreshMemory(rt);
  const reads = () => ghCalls().filter((c) => c.some((x) => /\/commits\//.test(x))).length;
  const before = reads();
  assert.equal(await run(2), true, "a moved head makes a held release due");
  assert.equal(reads() - before, 1, "one head read for the pass, the hold included");
  const rs = await prodReleases();
  assert.ok(Object.values(rs).every((r) => r.verifiedHead === "e".repeat(40)), "every held release records the new head");
});

test("a held re-verify that holds for the same reason comments once", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("fail"), prod: VERIFY(100, "prod-verify-failed") });
  await run();
  assertHeld(5, "prod-verify-failed");
  await editRel(100, (r) => { r.retryAt = new Date(Date.now() - 1000).toISOString(); });
  await run(2);
  assert.equal(commentsOn(5).filter((b) => b.startsWith("**Production verification held")).length, 1);
  assert.equal((await prodReleases())[100].attempts, 2);
});

test("a tag already on the merge commit is reused, never duplicated", async () => {
  const existing = "release-20261001-0000-pr100";
  const tagObj = "d".repeat(40);
  world({
    ...pending(),
    refs: [{ ref: "refs/tags/release-20260901-0000-pr90", object: { sha: OLD, type: "commit" } },
      { ref: `refs/tags/${existing}`, object: { sha: tagObj, type: "tag" } }],
    tagObjects: { [tagObj]: { object: MERGE } },
  }, { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  await run();
  assert.equal(tagsCreated().length, 0);
  assert.equal(gh().refs.length, 2);
  assertClosedVerified(5, { tag: existing });
});

test("the deploy is interrupted (Foreman restart): a release found merged is verified, not deployed again", async () => {
  world({ ...pending(), prs: [mergedPr(100, "- #5\n- #6", MERGE, 5)] }, { prod: VERIFY(100) });
  await seedRelease(rt, repo, { pr: 100, headSha: HEAD, issues: [5, 6], phase: "deploying", attempts: 0, since: new Date().toISOString() });
  assert.equal(await run(), true);
  assert.deepEqual(agentCalls().map((c) => c.slice(0, 3)), [["sre", "verify", "--mode"]]);
  assertClosedVerified(5);
});

// --- Adoption ------------------------------------------------------------------

test("adopts a release a person merged: no Tech Lead, no deploy, a prod verify, tag, close", async () => {
  world({ issues: [issue(7, "pr approved")], prs: [mergedPr(90, "- #7: Issue 7", MERGE, 60)] }, { prod: VERIFY(90) });
  assert.equal(await run(), true);
  assert.deepEqual(agentCalls(), [["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "90"]]);
  const tag = gh().refs[0].ref.replace("refs/tags/", "");
  assert.match(tag, /-pr90$/);
  assertClosedVerified(7, { tag });
  // Its soak is due: merged an hour ago.
  assert.ok(Date.parse((await prodReleases())[90].soakAt) <= Date.now());

  // Once verified, it is never adopted again.
  await setReleases({});
  rt = withFreshMemory(rt);
  assert.equal(await run(2), false);
  assert.equal(agentCalls().length, 1);
});

test("adoption reads an existing Production Verification instead of running one", async () => {
  const pv = "## Production Verification\n\n| Check | Result | Details |\n|---|---|---|\n| **Acceptance** | PASS | ok |\n| **Grafana** | CLEAN | |\n| **Soak** | PENDING | later |";
  world({
    issues: [issue(7, "pr approved")], prs: [mergedPr(90, "- #7", MERGE, 60)],
    comments: { 90: [{ url: "https://github.com/example/rel/pull/90#issuecomment-1", body: pv, at: "2026-10-10T00:00:00Z" }] },
  });
  assert.equal(await run(), true);
  assert.deepEqual(agentCalls(), [], "no SRE run");
  assertClosedVerified(7, { evidence: "https://github.com/example/rel/pull/90#issuecomment-1" });
});

test("an adopted release whose Production Verification failed is held, not closed", async () => {
  const pv = "## Production Verification\n\n| Check | Result | Details |\n|---|---|---|\n| **Acceptance** | FAIL | 500s |";
  world({
    issues: [issue(7, "pr approved")], prs: [mergedPr(90, "- #7", MERGE, 60)],
    comments: { 90: [{ url: "https://github.com/example/rel/pull/90#issuecomment-1", body: pv, at: "2026-10-10T00:00:00Z" }] },
  });
  await run();
  assertHeld(7, "prod-verify-failed");
  assert.ok(!gh().issues[7].labels.includes("pr approved"), "one stage label");
});

test("a merged release naming no lifecycle issue, or older than 48 hours, is not adopted", async () => {
  world({
    issues: [{ number: 7, title: "x", state: "OPEN", labels: ["docs"] }, issue(4, "pr approved")],
    prs: [mergedPr(90, "- #7", MERGE, 60), mergedPr(80, "- #4", OLD, 49 * 60)],
  });
  assert.equal(await run(), false);
  assert.deepEqual(agentCalls(), []);
  assert.deepEqual(await prodReleases(), {});
});

test("takes over an SRE sweep hold: `blocked` goes, `prod verification held` comes, and a pass closes it", async () => {
  world({
    issues: [issue(8, "blocked")],
    prs: [mergedPr(90, "- #8", MERGE, 120)],
    comments: { 8: [{ url: "https://github.com/example/rel/issues/8#issuecomment-9", at: "2026-10-10T00:00:00Z",
      body: "**Production release check needs a person.** Release https://github.com/example/rel/pull/90 held: healthcheck-red." }] },
  }, { prod: VERIFY(90) });
  assert.equal(await run(), true);
  assert.ok(commentsOn(8).some((b) => b.startsWith("**The Foreman took over this production release check**")));
  assert.deepEqual(agentCalls(), [["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "90"]]);
  assertClosedVerified(8);
  assert.ok(!gh().issues[8].labels.includes("blocked"));
});

test("an SRE sweep hold naming an unmerged release is left for a person", async () => {
  world({
    issues: [issue(8, "blocked")],
    prs: [releasePr(90, "- #8")],
    comments: { 8: [{ url: "u", at: "2026-10-10T00:00:00Z", body: "**Production release check needs a person.** https://github.com/example/rel/pull/90" }] },
  });
  await run();
  assert.deepEqual(gh().issues[8].labels, ["approved", "blocked"]);
  assert.deepEqual(agentCalls(), []);
});

test("a `release pending` issue nothing can carry is blocked, never closed unverified", async () => {
  world({ issues: [issue(9, "release pending")], compareFiles: 0 });
  await run();
  const i = gh().issues[9];
  assert.equal(i.state, "OPEN");
  assert.ok(i.labels.includes("blocked"));
  assert.match(commentsOn(9)[0], /no release carries this issue/);

  world({ issues: [issue(9, "release pending")], compareFiles: 4 });
  await run();
  assert.deepEqual(gh().issues[9].labels, ["approved", "release pending"], "promote opens a release PR for it next");
});

test("a `release pending` issue the production release shipped joins that release instead of being blocked", async () => {
  const seedPhase = async (phase) => {
    world({ issues: [issue(5, "prod verification held"), issue(9, "release pending")], prs: [mergedPr(100, "### Issues included\n- #5: Issue 5\n\n---\nsigned", MERGE, 20)], compareFiles: 0, prodHead: MERGE });
    await seedRelease(rt, repo, { pr: 100, headSha: HEAD, issues: [5], phase, mergeSha: MERGE, mergedAt: new Date().toISOString(),
      attempts: 1, retryAt: new Date(Date.now() + 3_600_000).toISOString(), since: new Date().toISOString() });
  };
  await seedPhase("held");
  await run();
  const i = gh().issues[9];
  assert.ok(!i.labels.includes("blocked"), "not blocked");
  assert.ok(i.labels.includes("prod verification held"), "held with the release it joined");
  assert.match(gh().prs[100].body, /- #5: Issue 5\n- #9: Issue 9\n/, "the release PR now names it, so the SRE grades it");
  assert.deepEqual((await prodReleases())[100].issues, [5, 9]);
  assert.match(commentsOn(9)[0], /^\*\*Joined release PR #100\.\*\*/);

});

test("an issue orphaned after its release passed rejoins it, and the release is verified again with it named", async () => {
  world({
    issues: [{ number: 5, title: "Issue 5", state: "CLOSED", labels: ["approved"] }, issue(9, "release pending")],
    prs: [mergedPr(100, "### Issues included\n- #5: Issue 5\n\n---\nsigned", MERGE, 20)], compareFiles: 0, prodHead: MERGE,
  }, { prod: VERIFY(100) });
  await seedRelease(rt, repo, { pr: 100, headSha: HEAD, issues: [5], phase: "soaking", mergeSha: MERGE, mergedAt: new Date().toISOString(),
    attempts: 0, soakAt: new Date(Date.now() + 1_800_000).toISOString(), since: new Date().toISOString() });
  await run();
  assert.ok(!gh().issues[9].labels.includes("blocked"), "not blocked");
  assert.match(gh().prs[100].body, /- #5: Issue 5\n- #9: Issue 9\n/);
  assert.match(commentsOn(9)[0], /re-run production verification/);
  assert.deepEqual(agentCalls(), [["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "100"]], "verified again, with #9 named");
  assertClosedVerified(9);
  assert.deepEqual((await prodReleases())[100].issues, [5, 9]);
  assert.deepEqual(commentsOn(5), [], "the issue the first pass closed is left alone");
});

test("an issue that shipped unlisted joins the release at production's head after that release settled", async () => {
  // Slashbin-console #1297: on `main` via a release naming only another issue; the head release had already settled.
  world({
    issues: [{ number: 5, title: "Issue 5", state: "CLOSED", labels: ["approved"] }, issue(9, "release pending")],
    prs: [mergedPr(90, "### Issues included\n- #4: Issue 4", OLD, 300), mergedPr(100, "### Issues included\n- #5: Issue 5\n\n---\nsigned", MERGE, 120)],
    compareFiles: 0, prodHead: MERGE,
  }, { prod: VERIFY(100) });
  await seed(rt, repo, 5, { prodVerified: { pr: 100, mergeSha: MERGE, at: new Date().toISOString() } });
  await run();
  assert.ok(!gh().issues[9].labels.includes("blocked"), "not blocked");
  assert.match(gh().prs[100].body, /- #5: Issue 5\n- #9: Issue 9\n/, "the head release now names it");
  assert.match(commentsOn(9)[0], /did not name it; release PR #100 is at production's head/);
  assert.deepEqual(agentCalls(), [["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "100"]], "verified fresh, with #9 named");
  assertClosedVerified(9);
  assert.deepEqual(commentsOn(5), [], "the head release's own issue is left alone");
});

test("no release at production's head: the issue is still blocked for a person", async () => {
  world({ issues: [issue(9, "release pending")], prs: [mergedPr(90, "- #4", OLD, 300)], compareFiles: 0, prodHead: MERGE });
  await run();
  assert.ok(gh().issues[9].labels.includes("blocked"));
  assert.match(commentsOn(9)[0], /no release carries this issue/);
});

test("without srePath and techLeadPath the stage does nothing at all", async () => {
  const off = loadConfig(writeCfg("cfg-off.json", {}));
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  assert.equal(await tryRelease(rt, off.repos[0], off, logger, 1), false);
  assert.deepEqual(ghCalls(), []);
  assert.deepEqual(agentCalls(), []);
});

// --- Promote's release paths -----------------------------------------------------

const promote = (cycle, active = true) => tryPromotion(rt, repo, logger, cycle, active);

test("promote, 0-file diff: closes only an issue prod-verified at production's head; the rest go to `release pending`", async () => {
  world({ issues: [issue(5, "ready for prod release"), issue(6, "ready for prod release")], compareFiles: 0, prodHead: MERGE });
  await seed(rt, repo, 5, { prodVerified: { pr: 100, mergeSha: MERGE, at: "2026-10-10T00:00:00Z" } });
  await seed(rt, repo, 6, { prodVerified: { pr: 90, mergeSha: OLD, at: "2026-10-09T00:00:00Z" } });
  await promote(1);
  const st = gh();
  assert.equal(st.issues[5].state, "CLOSED");
  assert.deepEqual(st.issues[5].labels, ["approved"]);
  assert.equal(st.issues[6].state, "OPEN", "verified at an older head is not evidence for this one");
  assert.deepEqual(st.issues[6].labels, ["approved", "release pending"]);
});

test("promote without the release stage keeps the legacy strip on a 0-file diff", async () => {
  world({ issues: [issue(5, "ready for prod release")], compareFiles: 0 });
  await promote(1, false);
  assert.equal(gh().issues[5].state, "OPEN");
  assert.deepEqual(gh().issues[5].labels, ["approved"]);
});

test("promote, open release PR: a newly authorized issue is added and moves to `release pending`; listed ones stay", async () => {
  world({
    issues: [issue(5, "release pending"), issue(6, "ready for prod release")],
    prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5")],
    compareFiles: 3,
  });
  await promote(1);
  const st = gh();
  assert.match(st.prs[100].body, /#5: Issue 5/);
  assert.match(st.prs[100].body, /#6: Issue 6/);
  assert.deepEqual(st.issues[6].labels, ["approved", "release pending"]);
  assert.deepEqual(st.issues[5].labels, ["approved", "release pending"]);
});

test("a promotion stall comments once on each issue waiting on EM verification, never in Discord", async () => {
  world({ issues: [issue(5, "pr approved")], compareFiles: 4 });
  const base = 10_000;
  await promote(base);
  await promote(base + STALL_CHECK_CYCLE_INTERVAL);
  const stall = commentsOn(5).filter((b) => b.includes("<!-- foreman:promotion-stall -->"));
  assert.equal(stall.length, 1, "deduped across checks");
  assert.match(stall[0], /Waiting on EM verification/);
  assert.equal((await recordOf(rt, repo, 5)).promotionStallNoted, true);
});

/** A logger that keeps every line, by level. */
function captureLogger() {
  const lines = [];
  const l = {
    debug: (msg) => lines.push(["debug", msg]),
    info: (msg) => lines.push(["info", msg]),
    warn: (msg) => lines.push(["warn", msg]),
    error: (msg) => lines.push(["error", msg]),
    child: () => l,
    at: (level) => lines.filter(([lv]) => lv === level).map(([, m]) => m),
    clear: () => { lines.length = 0; },
  };
  return l;
}
const STALLED = /promotion is STALLED/;

test("a develop-vs-main difference confined to .claude/ is not a stalled promotion: no WARN, no comment", async () => {
  world({
    issues: [issue(5, "pr approved")],
    comparePaths: [".claude/skills/implement-approved-issues/SKILL.md", ".claude/skills/revise-pr-feedback/SKILL.md"],
  });
  const log = captureLogger();
  await tryPromotion(rt, repo, log, 20_000, true);
  assert.deepEqual(log.at("warn"), [], "nothing at WARN");
  assert.ok(!log.at("info").some((m) => /waiting on EM verification/.test(m)), "nothing at INFO either");
  assert.ok(log.at("debug").some((m) => /only under \.claude\//.test(m)), "a debug line says why");
  assert.deepEqual(commentsOn(5), [], "the pr-approved issue is not told a release is stalled");
});

test("one file outside .claude/ still counts: the stall is reported, with only the production files counted", async () => {
  world({ issues: [], comparePaths: [".claude/skills/a/SKILL.md", "src/server.ts"] });
  const log = captureLogger();
  await tryPromotion(rt, repo, log, 21_000, true);
  const warns = log.at("warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0], STALLED);
  assert.match(warns[0], /carries 1 changed file\(s\)/);
});

test("a release stopped for a person names its issue and hold, once per change — never 'no issue names the work'", async () => {
  // The SRE's pre-deploy check stops release PR #100: #5 and #6 are blocked, `release pending` stays.
  world(pending(), {
    approve: { exit: 0 },
    deploy: { exit: 0, out: "SRE_DEPLOY pr=#100 merged=no merge_sha=none verify=none hold=predeploy-stop evidence=https://example.test/stop" },
  });
  assert.equal(await run(), true);
  const before = { 5: commentsOn(5).length, 6: commentsOn(6).length };

  const log = captureLogger();
  const base = 22_000;
  await tryPromotion(rt, repo, log, base, true);
  const warns = log.at("warn");
  assert.equal(warns.length, 1, "one WARN");
  assert.ok(!STALLED.test(warns[0]), "not reported as an unnamed stall");
  assert.match(warns[0], /release of #5 held: blocked after predeploy-stop on PR #100 — waiting on a person/);
  assert.match(warns[0], /release of #6 held: blocked after predeploy-stop on PR #100 — waiting on a person/);

  // The next check, unchanged: a debug line, no WARN, no comment read, nothing commented.
  log.clear();
  const callsBefore = ghCalls().length;
  await tryPromotion(rt, repo, log, base + STALL_CHECK_CYCLE_INTERVAL, true);
  assert.deepEqual(log.at("warn"), [], "not repeated at WARN");
  assert.ok(log.at("debug").some((m) => /release of #5 held/.test(m)), "named at debug");
  assert.ok(!ghCalls().slice(callsBefore).some((c) => c.some((x) => /issues\/\d+\/comments/.test(x))), "no comments read on a repeat");
  assert.deepEqual({ 5: commentsOn(5).length, 6: commentsOn(6).length }, before, "the stop comment is the record; nothing more is written");

  // A change in what is held is named again.
  const st = gh();
  st.issues[6].labels = st.issues[6].labels.filter((l) => l !== "blocked");
  st.issues[6].state = "CLOSED";
  writeFileSync(GH_STATE, JSON.stringify(st));
  log.clear();
  await tryPromotion(rt, repo, log, base + 2 * STALL_CHECK_CYCLE_INTERVAL, true);
  const again = log.at("warn");
  assert.equal(again.length, 1);
  assert.match(again[0], /release of #5 held/);
  assert.ok(!/#6/.test(again[0]));
});

test("a held issue with no stop comment is still named, by the release PR that lists it", async () => {
  world({
    issues: [issue(1283, "release pending", "blocked")],
    prs: [releasePr(1292, "## Production Promotion\n\n### Issues included\n- #1283: Issue 1283")],
    compareFiles: 4,
  });
  const log = captureLogger();
  await tryPromotion(rt, repo, log, 23_000, true);
  const warns = log.at("warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /release of #1283 held: blocked on PR #1292 — waiting on a person/);
});

// --- Pure pieces ------------------------------------------------------------------

test("productionDriftFiles: .claude/ paths do not count; unknown or possibly truncated lists count everything", () => {
  const d = (paths, files = paths?.length ?? 0) => ({ developAheadOfMain: 2, developBehindMain: 0, developAheadFiles: files, ...(paths ? { developAheadPaths: paths } : {}) });
  assert.equal(productionDriftFiles(d([".claude/skills/a/SKILL.md", ".claude/settings.json"])), 0);
  assert.equal(productionDriftFiles(d([".claude/skills/a/SKILL.md", "src/a.ts", ".claudeignore"])), 2, "only the .claude/ directory is exempt");
  assert.equal(productionDriftFiles(d(undefined, 3)), 3, "no path list: every file counts");
  assert.equal(productionDriftFiles(d([".claude/x"], 2)), 2, "a list that disagrees with the count: every file counts");
  assert.equal(productionDriftFiles(d(Array.from({ length: 300 }, (_, i) => `.claude/f${i}`))), 300, "a list at GitHub's cap may hide files");
});

test("parseDeployTrailer: the last trailer for the PR wins; a malformed sha reads as none", () => {
  const out = [
    "SRE_DEPLOY pr=#100 merged=no merge_sha=none verify=none hold=merge-refused",
    "SRE_DEPLOY pr=#101 merged=yes merge_sha=" + MERGE + " verify=pass",
    `SRE_DEPLOY pr=#100 merged=yes merge_sha=${MERGE} verify=hold hold=healthcheck-red evidence=https://example.test/pv`,
  ].join("\n");
  assert.deepEqual(parseDeployTrailer(out, 100), {
    pr: 100, merged: true, mergeSha: MERGE, verify: "hold", hold: "healthcheck-red", evidence: "https://example.test/pv",
  });
  assert.equal(parseDeployTrailer("SRE_DEPLOY pr=#7 merged=yes merge_sha=abc verify=pass", 7).mergeSha, null);
  assert.equal(parseDeployTrailer("nothing here", 7), null);
  assert.equal(parseDeployTrailer(out, 102), null);
});

test("readPvResult reads a Production Verification table; the soak row is its own step", () => {
  const table = (...rows) => ["## Production Verification", "", "| Check | Result | Details |", "|---|---|---|", ...rows].join("\n");
  assert.deepEqual(readPvResult(table("| **Acceptance** | PASS | ok |", "| **Grafana** | CLEAN | |", "| **Soak** | FAIL | x |")), { pass: true });
  assert.deepEqual(readPvResult(table("| **Acceptance** | FAIL | 500 |")), { pass: false, hold: "prod-verify-failed" });
  assert.deepEqual(readPvResult(table("| **Grafana** | REGRESSIONS | p95 |")), { pass: false, hold: "prod-verify-failed" });
  assert.deepEqual(readPvResult(table("| **Acceptance** | NOT YET ELIGIBLE until 2026-10-10 12:15 UTC | |")), { pass: false, hold: "wait-until-20261010T1215Z" });
  assert.deepEqual(readPvResult(table("| **Acceptance** | NOT VERIFIED | |")), { pass: false, hold: "acceptance-not-verified" });
  assert.deepEqual(readPvResult(table("| **Outcome vs baseline** | WATCH — no post-deploy chat yet | |", "| **Grafana** | N/A | |")), { pass: true });
  assert.equal(readPvResult("## Production Verification\n\nprose only"), null);
});

test("release tags: the default format, UTC, never a `v*` name", () => {
  const fmt = config.github.releaseTagFormat;
  assert.equal(fmt, "release-{yyyy}{mm}{dd}-{HHMM}-pr{N}");
  assert.equal(releaseTagName(fmt, 42, new Date(Date.UTC(2026, 9, 10, 9, 5))), "release-20261010-0905-pr42");
  for (let i = 0; i < 50; i++) {
    const tag = releaseTagName(fmt, i * 37 + 1, new Date(Date.UTC(2020 + (i % 9), i % 12, (i % 28) + 1, i % 24, i % 60)));
    assert.ok(!/^v/i.test(tag), tag);
    assert.match(tag, TAG_RE);
  }
  assert.throws(() => releaseTagName("v{N}", 1, new Date()), /starts with "v"/);
  assert.throws(() => loadConfig(writeCfg("cfg-v.json", { github: { releaseTagFormat: "v-{N}" } })), /releaseTagFormat must not start with/);
});

test("config: release stage readiness, refusal, and the deploy timeout", () => {
  assert.equal(config.sreDeployMaxDurationMs, 7_200_000, "room for a ~90-minute deploy");
  const prev = process.env.AI_AGENT_SRE_DEPLOY_MAX_DURATION_MS;
  process.env.AI_AGENT_SRE_DEPLOY_MAX_DURATION_MS = "5400000";
  try {
    assert.equal(loadConfig(writeCfg("cfg-env.json", {})).sreDeployMaxDurationMs, 5_400_000);
  } finally {
    if (prev === undefined) delete process.env.AI_AGENT_SRE_DEPLOY_MAX_DURATION_MS;
    else process.env.AI_AGENT_SRE_DEPLOY_MAX_DURATION_MS = prev;
  }
  assert.equal(releaseStageWarning(config), null);
  const off = loadConfig(writeCfg("cfg-off2.json", { srePath: sreDir }));
  assert.match(releaseStageWarning(off), /release stage skipped: techLeadPath not set/);
  assert.throws(
    () => loadConfig(writeCfg("cfg-explicit.json", { srePath: sreDir, stages: [{ type: "promote" }, { type: "release" }] })),
    /stages lists "release" but techLeadPath/,
  );
});

test("the release back-offs exist and start at ten minutes or less", () => {
  for (const k of ["releaseRetry", "prodVerifyRetry"]) {
    assert.ok(DEFAULT_BACKOFF[k], k);
    assert.ok(DEFAULT_BACKOFF[k].baseMs <= 600_000, `${k} base ≤ 10 min`);
  }
  assert.equal(config.backoff.releaseRetry.baseMs, DEFAULT_BACKOFF.releaseRetry.baseMs);
});


// --- The release carries every merge on develop (foreman#90) ----------------------

const mergedFeature = (number, title, body, extra = {}) => ({
  number, url: `https://github.com/${REPO}/pull/${number}`, title, state: "MERGED", headRefName: `feat-${number}`,
  baseRefName: "develop", mergeCommit: { oid: "d".repeat(40) }, mergedAt: new Date().toISOString(), body, ...extra,
});
const mergeCommit = (pr, ch = "1") => ({ sha: ch.repeat(40), headline: `Merge pull request #${pr} from example/feat-${pr}` });
const CARRIED = "<!-- foreman:release-carried";
const carriedNotes = (n) => commentsOn(n).filter((b) => b.startsWith(CARRIED));
const openedReleases = () => ghCalls().filter((c) => c[0] === "pr" && c[1] === "create");
const newestRelease = () => Object.values(gh().prs).find((p) => p.number >= 200);
const issueNumbersIn = (body) => [...new Set([...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];

test("carry: authorized A + unauthorized B on develop: the release PR lists both, only A is signed, B is told once", async () => {
  world({
    issues: [issue(5, "ready for prod release"), issue(7, "pr approved")],
    prs: [mergedFeature(50, "feat: A", "Related to #5"), mergedFeature(51, "feat: B", "Closes #7")],
    compareFiles: 3,
    // The constituent commits end in an ISSUE number (#5, #7), not a PR: they must not abort the read.
    compareCommits: [{ sha: "8".repeat(40), headline: "feat: A (#5)" }, mergeCommit(50, "1"), { sha: "9".repeat(40), headline: "feat: B (#7)" }, mergeCommit(51, "2")],
  });
  assert.equal(await promote(1), "promoted");
  assert.equal(openedReleases().length, 1, "the release is not refused");
  const pr = newestRelease();
  assert.match(pr.body, /### Issues included\n- #5: Issue 5\n- #7: Issue 7/);
  assert.deepEqual(gh().issues[5].labels, ["approved", "release pending"], "the EM's issue moves on");
  assert.deepEqual(gh().issues[7].labels, ["approved", "pr approved"], "the Foreman never signs B for the EM (foreman#128)");
  assert.equal(carriedNotes(5).length, 0, "the authorized issue is not told it was carried");
  const c = carriedNotes(7);
  assert.equal(c.length, 1);
  assert.match(c[0], new RegExp(`Carried to production in release PR #${pr.number} alongside #5`));
  assert.match(c[0], /PR #51/);

  // A re-run adds nothing and posts nothing more.
  await promote(2);
  assert.equal(carriedNotes(7).length, 1);
  assert.equal(openedReleases().length, 1);
});

test("carry: legacy (no release stage) lists the adopted issue and strips only the authorized one's label", async () => {
  world({
    issues: [issue(5, "ready for prod release"), issue(7, "pr approved")],
    prs: [mergedFeature(50, "feat: A", "Related to #5"), mergedFeature(51, "feat: B", "Closes #7")],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1"), mergeCommit(51, "2")],
  });
  assert.equal(await promote(1, false), "promoted");
  assert.match(newestRelease().body, /- #7: Issue 7/);
  assert.ok(!gh().issues[5].labels.includes("ready for prod release"), "#5 stripped");
  assert.deepEqual(gh().issues[7].labels, ["approved", "pr approved"], "#7 is listed, never signed by the Foreman");
});

test("carry: only authorized merges (and sync/bot PRs): the release PR is what it was, with nothing adopted", async () => {
  world({
    issues: [issue(5, "ready for prod release")],
    prs: [
      mergedFeature(50, "feat: A", "Related to #5"),
      mergedFeature(53, "chore: sync develop with main", "Branch Sync", { headRefName: "main" }),
      mergedFeature(54, "Bump left-pad", "bump", { headRefName: "dependabot/npm/left-pad-2" }),
    ],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1"), mergeCommit(53, "2"), mergeCommit(54, "3"), { sha: "4".repeat(40), headline: "feat: part of A" }],
  });
  assert.equal(await promote(1), "promoted");
  const pr = newestRelease();
  assert.deepEqual(issueNumbersIn(pr.body), [5]);
  assert.doesNotMatch(pr.body, /no linked issue/);
  assert.deepEqual(gh().issues[5].labels, ["approved", "release pending"]);
  assert.deepEqual(carriedNotes(5), []);
});

test("carry: a merge that links to no issue is listed by PR number, apart from the issues", async () => {
  world({
    issues: [issue(5, "ready for prod release")],
    prs: [mergedFeature(50, "feat: A", "Related to #5"), mergedFeature(55, "hotfix: straight to develop (#55)", "no issue here")],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1"), { sha: "5".repeat(40), headline: "hotfix: straight to develop (#55)" }],
  });
  assert.equal(await promote(1), "promoted");
  const pr = newestRelease();
  assert.match(pr.body, /### Merges with no linked issue\n- PR 55: hotfix: straight to develop \(55\)/);
  assert.deepEqual(issueNumbersIn(pr.body), [5], "a PR number is never read as an issue");
});

test("carry: an open release PR is rewritten to list the adopted issue", async () => {
  world({
    issues: [issue(5, "release pending"), issue(7, "pr approved")],
    prs: [
      releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5"),
      mergedFeature(50, "feat: A", "Related to #5"), mergedFeature(52, "feat: B", "Refs #7"),
    ],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1"), mergeCommit(52, "3")],
  });
  await promote(1);
  assert.match(gh().prs[100].body, /- #5: Issue 5\n- #7: Issue 7/);
  assert.deepEqual(gh().issues[7].labels, ["approved", "pr approved"]);
  assert.match(carriedNotes(7)[0], /release PR #100 alongside #5/);
});

test("carry: only a merge commit or a (#N) squash suffix is a merge", () => {
  assert.equal(mergedPrNumber("Merge pull request #648 from x/y"), 648);
  assert.equal(mergedPrNumber("feat: thing (#650)"), 650);
  assert.equal(mergedPrNumber("feat: thing, see #650 for more"), null);
  assert.equal(mergedPrNumber("Merge branch 'main' into develop"), null);
});

test("carry: one PR linking an authorized and an unauthorized issue adopts the unauthorized one (new release)", async () => {
  world({
    issues: [issue(5, "ready for prod release"), issue(7, "pr approved")],
    prs: [mergedFeature(50, "feat: A and B", "Closes #5\nCloses #7")],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1")],
  });
  assert.equal(await promote(1), "promoted");
  assert.match(newestRelease().body, /- #5: Issue 5\n- #7: Issue 7/);
  assert.deepEqual(gh().issues[7].labels, ["approved", "pr approved"]);
  assert.equal(carriedNotes(7).length, 1);
  assert.match(carriedNotes(7)[0], /alongside #5/);
  assert.equal(carriedNotes(5).length, 0);
});

test("carry: one PR linking an authorized and an unauthorized issue adopts the unauthorized one (existing release)", async () => {
  world({
    issues: [issue(5, "release pending"), issue(7, "pr approved")],
    prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5"), mergedFeature(50, "feat: A and B", "Closes #5\nCloses #7")],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1")],
  });
  await promote(1);
  assert.match(gh().prs[100].body, /- #5: Issue 5\n- #7: Issue 7/);
  assert.deepEqual(gh().issues[7].labels, ["approved", "pr approved"]);
  assert.match(carriedNotes(7)[0], /release PR #100 alongside #5/);
});

test("carry: a corrected PR body is re-read on the next pass", async () => {
  world({
    issues: [issue(5, "ready for prod release"), issue(7, "pr approved")],
    prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5"), mergedFeature(50, "feat: A", "Closes #5")],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1")],
  });
  await promote(1);
  assert.deepEqual(gh().issues[7].labels, ["approved", "pr approved"], "not linked yet");
  const st = gh();
  st.prs[50].body = "Closes #5\nCloses #7";
  writeFileSync(GH_STATE, JSON.stringify(st));
  await promote(2);
  assert.match(gh().prs[100].body, /- #7: Issue 7/);
});

// --- The release holds until the EM has signed every issue it lists (foreman#128) ---

const statuses = () => gh().statuses ?? [];
const heldComments = (pr) => commentsOn(pr).filter((b) => b.startsWith("<!-- foreman:release-unsigned"));
const unsignedWorld = () => ({
  // Slashbin-console#1455: #5 and #6 signed and moved on; #1434-like #7 listed with no sign-off.
  issues: [issue(5, "release pending"), issue(6, "release pending"), issue(7, "pr approved")],
  prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5\n- #6: Issue 6\n- #7: Issue 7")],
  compareFiles: 3,
});

test("signoff: a release listing an unsigned issue is not approved or deployed, and names the issue on the PR", async () => {
  world(unsignedWorld(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  assert.equal(await run(), false);
  assert.equal(agentCalls().length, 0, "neither the Tech Lead nor the SRE is asked while an issue is unsigned");
  assert.equal(gh().prs[100].state, "OPEN");
  const [st] = statuses();
  assert.equal(st.sha, HEAD);
  assert.equal(st.state, "failure");
  assert.equal(st.context, "foreman/em-sign-off");
  assert.match(st.description, /#7/);
  assert.doesNotMatch(st.description, /#5|#6/);
  assert.equal(heldComments(100).length, 1);
  assert.match(heldComments(100)[0], /#7/);
  assert.match(heldComments(100)[0], /ready for prod release/);

  // Another pass repeats neither the status nor the comment.
  await run(2);
  assert.equal(statuses().length, 1);
  assert.equal(heldComments(100).length, 1);
  assert.equal(agentCalls().length, 0);
});

test("signoff: the hold clears on its own once the EM signs the issue", async () => {
  world(unsignedWorld(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  await run();
  assert.equal(agentCalls().length, 0);

  const g = gh();
  g.issues[7].labels.push("ready for prod release");
  writeFileSync(GH_STATE, JSON.stringify(g));
  await promote(2);  // moves the signed issue to release pending
  assert.ok(gh().issues[7].labels.includes("release pending"));
  assert.equal(await run(3), true);
  assert.deepEqual(agentCalls().map((c) => c[0]), ["tech-lead", "sre"], "approved and deployed once signed");
  assert.deepEqual(statuses().map((s) => s.state), ["failure", "success"]);
});

test("signoff: a release whose every issue is signed is deployed, with a passing status", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  assert.equal(await run(), true);
  assert.equal(agentCalls().length, 2);
  assert.deepEqual(statuses().map((s) => s.state), ["success"]);
  assert.equal(heldComments(100).length, 0);
});

test("signoff: an issue carried in by a develop merge is never signed by the Foreman", async () => {
  world({
    issues: [issue(5, "ready for prod release"), issue(7, "pr approved")],
    prs: [mergedFeature(50, "feat: A", "Related to #5"), mergedFeature(51, "feat: B", "Closes #7")],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1"), mergeCommit(51, "2")],
  }, { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  await promote(1);
  assert.ok(!gh().issues[7].labels.includes("ready for prod release"));
  assert.ok(!gh().issues[7].labels.includes("release pending"));
  const n = newestRelease().number;
  assert.equal(await run(2), false);
  assert.equal(agentCalls().length, 0, "the carried release does not merge");
  assert.equal(statuses()[0].state, "failure");
  assert.match(heldComments(n)[0], /#7/);
});

test("signoff: an unsigned issue that merged after the release body was written holds the release at the head that carries it", async () => {
  world({
    issues: [issue(5, "release pending"), issue(7, "pr approved")],
    prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5"), mergedFeature(50, "feat: A", "Related to #5"), mergedFeature(51, "feat: B", "Closes #7")],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1"), mergeCommit(51, "2")],
  }, { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  assert.equal(await run(), false);
  assert.equal(agentCalls().length, 0, "neither the Tech Lead nor the SRE is asked");
  assert.deepEqual(statuses().map((s) => s.state), ["failure"]);
  assert.match(heldComments(100)[0], /#7/);
  assert.doesNotMatch(heldComments(100)[0], /#5/);

  // Signed (and moved on by promote): the same head deploys.
  const g = gh();
  g.issues[7].labels.push("ready for prod release");
  writeFileSync(GH_STATE, JSON.stringify(g));
  await promote(2);
  assert.equal(await run(3), true);
  assert.deepEqual(agentCalls().map((c) => c[0]), ["tech-lead", "sre"]);
});

test("signoff: an issue the Foreman itself labelled before this fix is unsigned until someone else signs it", async () => {
  const marked = { url: "u", body: "<!-- foreman:release-carried pr=100 -->\n**Carried to production in release PR #100.**", at: "2026-10-28T10:00:00Z", by: "foreman-bot" };
  world({ ...pending(), comments: { 6: [marked] }, }, { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  // #6 was labelled `release pending` by the old adoption; the only `ready for prod release` event is the Foreman's own.
  let g = gh();
  g.events = { 6: [{ label: "ready for prod release", by: "foreman-bot" }] };
  writeFileSync(GH_STATE, JSON.stringify(g));
  assert.equal(await run(), false);
  assert.equal(agentCalls().length, 0);
  assert.match(statuses()[0].description, /#6/);
  assert.doesNotMatch(statuses()[0].description, /#5/);

  // The EM applies `ready for prod release` himself: a label event by someone else.
  g = gh();
  g.events = { 6: [{ label: "ready for prod release", by: "foreman-bot" }, { label: "ready for prod release", by: "ray" }] };
  writeFileSync(GH_STATE, JSON.stringify(g));
  assert.equal(await run(2), true);
  assert.deepEqual(agentCalls().map((c) => c[0]), ["tech-lead", "sre"]);
});

test("signoff: a merged PR that cannot be read holds the release and is named, then clears when readable", async () => {
  world({
    issues: [issue(5, "release pending"), issue(7, "pr approved")],
    prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5"), mergedFeature(50, "feat: A", "Related to #5"), mergedFeature(51, "feat: B", "Closes #7")],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1"), mergeCommit(51, "2")],
  }, { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  let g = gh();
  g.unreadable = [51];
  writeFileSync(GH_STATE, JSON.stringify(g));
  assert.equal(await run(), false);
  assert.equal(agentCalls().length, 0, "neither agent is asked while a merge is unread");
  assert.deepEqual(statuses().map((s) => s.state), ["failure"]);
  assert.match(statuses()[0].description, /#51/);
  assert.match(heldComments(100)[0], /#51/);

  // Readable again: #7 is now found and named.
  g = gh();
  g.unreadable = [];
  writeFileSync(GH_STATE, JSON.stringify(g));
  assert.equal(await run(2), false);
  assert.match(statuses().at(-1).description, /#7/);
});

test("signoff: an unreadable merged PR whose number contains 404 is still named and holds the release", async () => {
  world({
    issues: [issue(5, "release pending"), issue(7, "pr approved")],
    prs: [releasePr(100, "## Production Promotion\n\n### Issues included\n- #5: Issue 5"), mergedFeature(50, "feat: A", "Related to #5"), mergedFeature(404, "feat: B", "Closes #7")],
    compareFiles: 3,
    compareCommits: [mergeCommit(50, "1"), mergeCommit(404, "2")],
  }, { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  const g = gh();
  g.unreadable = [404];
  writeFileSync(GH_STATE, JSON.stringify(g));
  assert.equal(await run(), false);
  assert.equal(agentCalls().length, 0);
  assert.match(statuses()[0].description, /#404/);
});

test("the release reaches its reviewer and deployer through the registry: a fake registered plugin is the one invoked", async () => {
  const calls = [];
  const fake = {
    id: "fake-release-agents",
    roles: ["reviewer", "deployer", "verifier"],
    enabled: (c) => c.fakeAgents === true,
    reviewer: {
      reviewPr: async () => ({ fallback: true, reason: "not used" }),
      approvePromotion: async (_r, _c, pr, sha) => { calls.push(["approve", pr, sha]); return { kind: "approved" }; },
    },
    deployer: {
      deploy: async (_r, _c, pr, sha) => {
        calls.push(["deploy", pr, sha]);
        const st = gh();
        Object.assign(st.prs[pr], { state: "MERGED", mergeCommit: { oid: MERGE }, mergedAt: new Date().toISOString() });
        writeFileSync(GH_STATE, JSON.stringify(st));
        return { kind: "trailer", trailer: parseDeployTrailer(DEPLOYED("pass").out, 100) };
      },
    },
    verifier: {
      verifyDev: async () => ({ kind: "error", error: "not used" }),
      verifyProd: async () => ({ kind: "error", error: "not used" }),
    },
  };
  registerPlugin(fake);
  const fakeConfig = { ...config, techLeadPath: undefined, srePath: undefined, fakeAgents: true };
  await startPlugins(fakeConfig, { logger, configText: () => null });
  world(pending());
  assert.equal(await tryRelease(rt, repo, fakeConfig, logger, 1), true);
  assert.deepEqual(calls, [["approve", 100, HEAD], ["deploy", 100, HEAD]], "the fake approved, then deployed, at the PR's head");
  assert.deepEqual(agentCalls(), [], "neither the Tech Lead nor the SRE CLI ran");
  assertClosedVerified(5);
  assertClosedVerified(6);
});

// --- An unreadable issue record excludes the issue from the whole pass (EM#1244 f2) ----------------------
// One owner (issue-records.ts `actionableIssues`) answers which issues a release pass may act on, before
// anything comments, labels, closes, approves or deploys. These hold every release path to it.

const trackedMerged = (issues) => seedRelease(rt, repo, { pr: 100, headSha: HEAD, issues, phase: "merged", mergeSha: MERGE, mergedAt: new Date().toISOString(), attempts: 0, since: new Date().toISOString() });
const untouched = (n) => {
  const i = gh().issues[n];
  assert.equal(i.state, "OPEN", `#${n} still open`);
  assert.equal(commentsOn(n).length, 0, `#${n} not commented on`);
};

test("tracked merged release: an unreadable record means no verification, comment or close for any of its issues", async () => {
  world({ ...pending(), prs: [mergedPr(100, "- #5\n- #6", MERGE, 5)] }, { prod: VERIFY(100) });
  await trackedMerged([5, 6]);
  breakRecords([6]);
  assert.equal(await run(), false);
  assert.equal(agentCalls().length, 0, "the SRE never ran");
  untouched(5); untouched(6);
  assert.equal((await prodReleases())[100].phase, "merged", "it resumes when the record reads again");
});

test("tracked merged release: a record that cannot be saved leaves the issue open, never closed without its record", async () => {
  world({ ...pending(), prs: [mergedPr(100, "- #5\n- #6", MERGE, 5)] }, { prod: VERIFY(100) });
  await trackedMerged([5, 6]);
  breakRecords([6], { saves: true });
  await run();
  assertClosedVerified(5);
  untouched(6);
  assert.equal((await prodReleases())[100].phase, "merged", "not soaking: verified again next pass");
});

test("open release: an unreadable record means no sign-off sync, Tech Lead approval or SRE deploy", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  breakRecords([6]);
  assert.equal(await run(), false);
  assert.equal(agentCalls().length, 0);
  assert.deepEqual(await prodReleases(), {});
  untouched(5); untouched(6);
});

test("orphan recovery: an unreadable record is neither joined to a release, commented on, nor blocked", async () => {
  world({ issues: [issue(9, "release pending")], compareFiles: 0 });
  breakRecords([9]);
  await run();
  assert.deepEqual(gh().issues[9].labels, ["approved", "release pending"]);
  untouched(9);
  const seedJoin = async () => {
    world({ issues: [issue(5, "prod verification held"), issue(9, "release pending")], prs: [mergedPr(100, "### Issues included\n- #5: Issue 5\n\n---\nsigned", MERGE, 20)], compareFiles: 0, prodHead: MERGE });
    await seedRelease(rt, repo, { pr: 100, headSha: HEAD, issues: [5], phase: "held", mergeSha: MERGE, mergedAt: new Date().toISOString(),
      attempts: 1, retryAt: new Date(Date.now() + 3_600_000).toISOString(), since: new Date().toISOString() });
  };
  await seedJoin();
  breakRecords([9]);
  await run();
  assert.deepEqual((await prodReleases())[100].issues, [5], "not joined");
  assert.doesNotMatch(gh().prs[100].body, /#9/);
  untouched(9);
});

test("SRE sweep hold: an issue with an unreadable record keeps its blocked label and is looked at again", async () => {
  world({
    issues: [issue(8, "blocked")],
    prs: [mergedPr(90, "- #8", MERGE, 120)],
    comments: { 8: [{ url: "https://github.com/example/rel/issues/8#issuecomment-9", at: "2026-10-10T00:00:00Z",
      body: "**Production release check needs a person.** Release https://github.com/example/rel/pull/90 held: healthcheck-red." }] },
  }, { prod: VERIFY(90) });
  breakRecords([8]);
  await run();
  assert.ok(gh().issues[8].labels.includes("blocked"));
  assert.equal(commentsOn(8).length, 1, "only the SRE's own comment");
  assert.equal(agentCalls().length, 0);
});

test("promote, 0-file diff: an unreadable record gets no event, label move, notification or close; readable ones proceed", async () => {
  world({ issues: [issue(5, "ready for prod release"), issue(6, "ready for prod release")], compareFiles: 0, prodHead: MERGE });
  await seed(rt, repo, 5, { prodVerified: { pr: 100, mergeSha: MERGE, at: "2026-10-10T00:00:00Z" } });
  await seed(rt, repo, 6, { prodVerified: { pr: 100, mergeSha: MERGE, at: "2026-10-10T00:00:00Z" } });
  breakRecords([6]);
  await promote(1);
  assert.equal(gh().issues[5].state, "CLOSED");
  assert.equal(gh().issues[6].state, "OPEN");
  assert.deepEqual(gh().issues[6].labels, ["approved", "ready for prod release"], "untouched");
  assert.equal(commentsOn(6).length, 0);
  // The legacy (no release stage) strip is held to the same rule.
  world({ issues: [issue(6, "ready for prod release")], compareFiles: 0 });
  breakRecords([6]);
  await promote(1, false);
  assert.deepEqual(gh().issues[6].labels, ["approved", "ready for prod release"]);
});

// --- A release's record is saved before the irreversible step (EM#1244 f3) -----------------------------
// The release lives on its PR's record. No deploy, merge or tag happens on the strength of a record that could
// not be read, and a record that could not be saved stops the step it was recorded for.

test("open release: an unreadable PR record means no approval and no deploy", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  breakPrRecords([100]);
  assert.equal(await run(), false);
  assert.equal(agentCalls().length, 0, "neither the Tech Lead nor the SRE ran");
  assert.equal(gh().prs[100].state, "OPEN");
});

test("open release: a record that cannot be saved means the deploy does not happen this pass", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  breakPrRecords([100], { saves: true });
  await run();
  assert.ok(!agentCalls().some((c) => c[0] === "sre" && c[1] === "deploy"), "no SRE deploy without 'deploying' on the record");
  assert.equal(gh().prs[100].state, "OPEN");
  assert.equal(gh().refs.length, 0, "and nothing tagged");
});

test("a restart after the deploy whose 'merged' record could not be saved verifies; it never deploys again", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass"), prod: VERIFY(100) });
  const source = activeWorkSource();
  const save = source.saveRecord;
  source.saveRecord = async (key, record, rc) => (key.kind === "pr" && record?.release?.phase === "merged" ? false : save(key, record, rc));
  await run();
  assert.equal(gh().prs[100].state, "MERGED", "the SRE merged it");
  assert.equal(agentCalls().filter((c) => c[0] === "sre" && c[1] === "deploy").length, 1);
  assert.equal((await releaseOf(rt, repo, 100)).phase, "deploying", "the record still says deploying");
  assert.equal(gh().refs.length, 0, "nothing tagged on the strength of an unsaved 'merged'");
  // The store recovers; the process restarts.
  source.saveRecord = save;
  rt = new ForemanRuntime();
  await run(2);
  assert.equal(agentCalls().filter((c) => c[0] === "sre" && c[1] === "deploy").length, 1, "no second deploy");
  assert.ok(agentCalls().some((c) => c[0] === "sre" && c[1] === "verify"), "it verifies the merged release instead");
  assert.equal(gh().refs.length, 1);
  assertClosedVerified(5);
});

// --- Review follow-up (xrgarcia/slashbin-ai-foreman#192) ----------------------------------------------

test("orphan scan: while a release PR's record is unreadable, ownership is unknown: no issue is joined or blocked, and none needs unblocking after", async () => {
  const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
  const seedOld = async () => {
    world({ issues: [issue(5, "release pending")], prs: [mergedPr(100, "### Issues included\n- #5: Issue 5\n\n---\nsigned", MERGE, 72 * 60)], compareFiles: 0, prodHead: MERGE });
    await seedRelease(rt, repo, { pr: 100, headSha: HEAD, issues: [5], phase: "merged", mergeSha: MERGE, mergedAt: old, attempts: 0, since: old });
  };
  await seedOld();
  breakPrRecords([100]);
  await run();
  assert.deepEqual(gh().issues[5].labels, ["approved", "release pending"], "not blocked as an orphan");
  assert.deepEqual(commentsOn(5), [], "no orphan comment");
});

test("release discovery: a stored release behind any number of newer closed release PRs is recovered after a restart", async () => {
  const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
  const newer = Array.from({ length: 30 }, (_, k) => mergedPr(101 + k, "newer", "f".repeat(40), 60));
  world({ issues: [issue(5, "prod verification held")], prs: [mergedPr(100, "### Issues included\n- #5: Issue 5", MERGE, 72 * 60), ...newer], compareFiles: 0, prodHead: MERGE });
  await seedRelease(rt, repo, { pr: 100, headSha: HEAD, issues: [5], phase: "held", mergeSha: MERGE, mergedAt: old, attempts: 1,
    retryAt: new Date(Date.now() + 3_600_000).toISOString(), since: old });
  rt = new ForemanRuntime();
    const found = await rt.releases.loadReleases(repo, logger);
  assert.deepEqual(found.releases.map((r) => r.pr), [100], "found although 30 newer PRs were listed first");
});

test("release view: updating R releases is O(R), not O(R^2): the view is a map, ordered once per read", () => {
  const src = readFileSync(new URL("../src/phases/release.ts", import.meta.url), "utf8");
  const follow = src.slice(src.indexOf("const byPr = new Map"), src.indexOf("const view = "));
  assert.match(follow, /byPr\.delete\(next\)/);
  assert.match(follow, /byPr\.set\(next\.pr, next\)/);
  assert.doesNotMatch(follow, /\.filter\(|\.sort\(/, "no per-update scan or sort");
});
