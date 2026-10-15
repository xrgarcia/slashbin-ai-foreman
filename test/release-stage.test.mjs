// The release stage (EM#578): from `release pending` to closed-on-prod-
// verification with no person in the loop. These drive the built stage
// (`tryRelease`) and the promote stage's release paths against fakes on PATH:
// a `gh` backed by a JSON file it mutates, a `tech-lead.mjs` and an `sre.mjs`
// that answer from a control file. Nothing here reaches GitHub.
//
// What they hold the stage to:
//   - the Tech Lead approves at the PR's head before the SRE deploys it, and a
//     refusal (exit 4) or an SRE `predeploy-stop` blocks the issues with a
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
import { tryRelease, resetReleaseStage, SOAK_DELAY_MS } from "../dist/phases/release.js";
import { tryPromotion } from "../dist/phases/promote.js";
import { STALL_CHECK_CYCLE_INTERVAL } from "../dist/phases/common.js";
import { parseDeployTrailer } from "../dist/agent.js";
import { readPvResult, configureIssueCache, productionDriftFiles } from "../dist/github.js";
import { releaseTagName } from "../dist/github/conventions.js";
import { loadConfig, releaseStageWarning } from "../dist/config.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { setStatePath, loadRepoState, saveRepoState } from "../dist/state.js";
import { createLogger } from "../dist/logger.js";

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
  (st.comments[n] = st.comments[n] || []).push({ url: "https://github.com/${REPO}/issues/" + n + "#issuecomment-" + st.seq, body, at: new Date().toISOString() });
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
    const want = flag("--state") === "merged" ? "MERGED" : "OPEN";
    let l = Object.values(st.prs).filter((p) => p.state === want);
    if (flag("--base")) l = l.filter((p) => p.baseRefName === flag("--base"));
    if (flag("--head")) l = l.filter((p) => p.headRefName === flag("--head"));
    const since = /^merged:>=(.+)$/.exec(flag("--search") || "");
    if (since) l = l.filter((p) => p.mergedAt && p.mergedAt.slice(0, 19) >= since[1]);
    out(l.sort((x, y) => y.number - x.number).slice(0, Number(flag("--limit") || 100)));
  }
  if (a[1] === "view") { const p = st.prs[a[2]]; if (!p) fail("no PR " + a[2]); out(p); }
  if (a[1] === "create") fail("no pr create in this fake");
}
if (a[0] === "api") {
  const valued = new Set(["--method", "--jq", "-f"]);
  const path = a.find((x, i) => i > 0 && !x.startsWith("-") && !valued.has(a[i - 1]));
  const method = flag("--method") || "GET";
  let m;
  if ((m = /issues\\/(\\d+)\\/comments/.exec(path))) out((st.comments[m[1]] || []).map((c) => JSON.stringify(c)).join("\\n"));
  if (/\\/commits\\//.test(path)) out(st.prodHead);
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
const config = loadConfig(writeCfg("cfg.json", { techLeadPath: techLeadDir, srePath: sreDir }));
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
function world({ issues = [], prs = [], comments = {}, refs = [], tagObjects = {}, compareFiles = 0, comparePaths, prodHead = MERGE }, ctl = {}) {
  writeFileSync(GH_STATE, JSON.stringify({
    issues: Object.fromEntries(issues.map((i) => [i.number, i])),
    prs: Object.fromEntries(prs.map((p) => [p.number, p])),
    comments, refs, tagObjects, compareFiles, prodHead, ...(comparePaths ? { comparePaths } : {}),
  }));
  writeFileSync(CTL, JSON.stringify(ctl));
  writeFileSync(GH_LOG, "");
  writeFileSync(AGENT_LOG, "");
  stateDir = mkdtempSync(join(tmp, "state-"));
  setStatePath(stateDir);
  resetReleaseStage();
}
const gh = () => JSON.parse(readFileSync(GH_STATE, "utf8"));
const ghCalls = () => readFileSync(GH_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const agentCalls = () => readFileSync(AGENT_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const commentsOn = (n) => (gh().comments[n] ?? []).map((c) => c.body);
const editState = (fn) => { const st = loadRepoState("rel"); fn(st); saveRepoState("rel", st); };
const run = (cycle = 1) => tryRelease(repo, config, logger, cycle);

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

  const rs = loadRepoState("rel");
  assert.equal(rs.prodReleases[100].phase, "soaking");
  assert.equal(Date.parse(rs.prodReleases[100].soakAt) - Date.parse(rs.prodReleases[100].mergedAt), SOAK_DELAY_MS);
  assert.equal(rs.prodVerified[5].mergeSha, MERGE);
  assert.equal(rs.prodVerified[6].tag, tag);

  // Before the soak is due nothing runs.
  assert.equal(await run(2), false);
  assert.equal(agentCalls().length, 2);
});

test("the soak runs once, 30 minutes on: a pass ends the release", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass"), soak: VERIFY(100) });
  await run();
  editState((st) => { st.prodReleases[100].soakAt = new Date(Date.now() - 1000).toISOString(); });
  assert.equal(await run(2), true);
  assert.deepEqual(agentCalls()[2], ["sre", "verify", "--mode", "soak", "--repo", REPO, "--pr", "100"]);
  assert.equal(loadRepoState("rel").prodReleases?.[100], undefined, "settled");
  assertClosedVerified(5);
  assert.equal(await run(3), false);
  assert.equal(agentCalls().length, 3, "soaked once");
});

test("a soak hold reopens the closed issues at `prod verification held` and forgets their verification", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass"), soak: VERIFY(100, "error-rate-up") });
  await run();
  editState((st) => { st.prodReleases[100].soakAt = new Date(Date.now() - 1000).toISOString(); });
  await run(2);
  assertHeld(5, "soak:error-rate-up");
  assertHeld(6, "soak:error-rate-up");
  const rs = loadRepoState("rel");
  assert.equal(rs.prodReleases[100].phase, "held");
  assert.equal(rs.prodReleases[100].soaked, true);
  assert.equal(rs.prodVerified?.[5], undefined);
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
  resetReleaseStage();
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
  assert.equal(loadRepoState("rel").prodReleases?.[100], undefined);
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
    resetReleaseStage();
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

test("predeploy-stop is the one deploy STOP: the issues are blocked with the evidence", async () => {
  world(pending(), {
    approve: { exit: 0 },
    deploy: { exit: 0, out: "SRE_DEPLOY pr=#100 merged=no merge_sha=none verify=none hold=predeploy-stop evidence=https://example.test/stop" },
  });
  assert.equal(await run(), true);
  for (const n of [5, 6]) {
    assert.ok(gh().issues[n].labels.includes("blocked"));
    assert.match(commentsOn(n)[0], /predeploy-stop/);
    assert.match(commentsOn(n)[0], /https:\/\/example\.test\/stop/);
  }
});

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
  const rel = loadRepoState("rel").prodReleases[100];
  assert.equal(rel.phase, "held");
  assert.ok(Date.parse(rel.retryAt) - Date.now() >= DEFAULT_BACKOFF.prodVerifyRetry.baseMs - 60_000, "on the prodVerifyRetry back-off");

  assert.equal(await run(2), false, "not before retryAt");
  editState((st) => { st.prodReleases[100].retryAt = new Date(Date.now() - 1000).toISOString(); });
  assert.equal(await run(3), true);
  assert.deepEqual(agentCalls().at(-1), ["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "100"]);
  const tag = gh().refs[0].ref.replace("refs/tags/", "");
  assertClosedVerified(5, { tag });
  assertClosedVerified(6, { tag });
  assert.equal(tagsCreated().length, 1, "tagged once");
});

test("a held re-verify that holds for the same reason comments once", async () => {
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("fail"), prod: VERIFY(100, "prod-verify-failed") });
  await run();
  assertHeld(5, "prod-verify-failed");
  editState((st) => { st.prodReleases[100].retryAt = new Date(Date.now() - 1000).toISOString(); });
  await run(2);
  assert.equal(commentsOn(5).filter((b) => b.startsWith("**Production verification held")).length, 1);
  assert.equal(loadRepoState("rel").prodReleases[100].attempts, 2);
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
  editState((st) => { st.prodReleases = { 100: { pr: 100, headSha: HEAD, issues: [5, 6], phase: "deploying", attempts: 0, since: new Date().toISOString() } }; });
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
  assert.ok(Date.parse(loadRepoState("rel").prodReleases[90].soakAt) <= Date.now());

  // Once verified, it is never adopted again.
  editState((st) => { delete st.prodReleases; });
  resetReleaseStage();
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
  assert.equal(loadRepoState("rel").prodReleases, undefined);
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
  const seed = (phase) => {
    world({ issues: [issue(5, "prod verification held"), issue(9, "release pending")], prs: [mergedPr(100, "### Issues included\n- #5: Issue 5\n\n---\nsigned", MERGE, 20)], compareFiles: 0, prodHead: MERGE });
    editState((st) => {
      st.prodReleases = { 100: { pr: 100, headSha: HEAD, issues: [5], phase, mergeSha: MERGE, mergedAt: new Date().toISOString(),
        attempts: 1, retryAt: new Date(Date.now() + 3_600_000).toISOString(), since: new Date().toISOString() } };
    });
  };
  seed("held");
  await run();
  const i = gh().issues[9];
  assert.ok(!i.labels.includes("blocked"), "not blocked");
  assert.ok(i.labels.includes("prod verification held"), "held with the release it joined");
  assert.match(gh().prs[100].body, /- #5: Issue 5\n- #9: Issue 9\n/, "the release PR now names it, so the SRE grades it");
  assert.deepEqual(loadRepoState("rel").prodReleases[100].issues, [5, 9]);
  assert.match(commentsOn(9)[0], /^\*\*Joined release PR #100\.\*\*/);

});

test("an issue orphaned after its release passed rejoins it, and the release is verified again with it named", async () => {
  world({
    issues: [{ number: 5, title: "Issue 5", state: "CLOSED", labels: ["approved"] }, issue(9, "release pending")],
    prs: [mergedPr(100, "### Issues included\n- #5: Issue 5\n\n---\nsigned", MERGE, 20)], compareFiles: 0, prodHead: MERGE,
  }, { prod: VERIFY(100) });
  editState((st) => {
    st.prodReleases = { 100: { pr: 100, headSha: HEAD, issues: [5], phase: "soaking", mergeSha: MERGE, mergedAt: new Date().toISOString(),
      attempts: 0, soakAt: new Date(Date.now() + 1_800_000).toISOString(), since: new Date().toISOString() } };
  });
  await run();
  assert.ok(!gh().issues[9].labels.includes("blocked"), "not blocked");
  assert.match(gh().prs[100].body, /- #5: Issue 5\n- #9: Issue 9\n/);
  assert.match(commentsOn(9)[0], /re-run production verification/);
  assert.deepEqual(agentCalls(), [["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "100"]], "verified again, with #9 named");
  assertClosedVerified(9);
  assert.deepEqual(loadRepoState("rel").prodReleases[100].issues, [5, 9]);
  assert.deepEqual(commentsOn(5), [], "the issue the first pass closed is left alone");
});

test("an issue orphaned after its release soaked and was dropped rejoins it from the recorded pass", async () => {
  world({
    issues: [{ number: 5, title: "Issue 5", state: "CLOSED", labels: ["approved"] }, issue(9, "release pending")],
    prs: [mergedPr(100, "### Issues included\n- #5: Issue 5\n\n---\nsigned", MERGE, 20)], compareFiles: 0, prodHead: MERGE,
  }, { prod: VERIFY(100) });
  editState((st) => {
    st.prodReleases = {};
    st.prodVerified = { 5: { pr: 100, mergeSha: MERGE, tag: "release-x-pr100", at: "2026-10-15T18:12:00Z" } };
  });
  await run();
  assert.ok(!gh().issues[9].labels.includes("blocked"), "not blocked");
  assert.match(gh().prs[100].body, /- #5: Issue 5\n- #9: Issue 9\n/, "the release PR now names it");
  assert.match(commentsOn(9)[0], /^\*\*Joined release PR #100\.\*\*.*re-run production verification/s);
  assert.deepEqual(agentCalls(), [["sre", "verify", "--mode", "prod", "--repo", REPO, "--pr", "100"]], "a fresh verification, with #9 named");
  assertClosedVerified(9);
  assert.equal(loadRepoState("rel").prodReleases[100], undefined, "already soaked, so the pass drops it without a second soak");
  assert.equal(loadRepoState("rel").prodVerified[9].pr, 100);
  assert.deepEqual(commentsOn(5), [], "the issue the first pass closed is left alone");
});

test("an orphan with no release, tracked or passed, at production's head is still blocked", async () => {
  world({ issues: [issue(9, "release pending")], compareFiles: 0, prodHead: MERGE });
  editState((st) => { st.prodReleases = {}; st.prodVerified = { 5: { pr: 90, mergeSha: OLD, at: "2026-10-09T00:00:00Z" } }; });
  await run();
  assert.ok(gh().issues[9].labels.includes("blocked"));
  assert.match(commentsOn(9)[0], /no release carries this issue/);
});

test("without srePath and techLeadPath the stage does nothing at all", async () => {
  const off = loadConfig(writeCfg("cfg-off.json", {}));
  world(pending(), { approve: { exit: 0 }, deploy: DEPLOYED("pass") });
  assert.equal(await tryRelease(off.repos[0], off, logger, 1), false);
  assert.deepEqual(ghCalls(), []);
  assert.deepEqual(agentCalls(), []);
});

// --- Promote's release paths -----------------------------------------------------

const promote = (cycle, active = true) => tryPromotion(repo, logger, cycle, active);

test("promote, 0-file diff: closes only an issue prod-verified at production's head; the rest go to `release pending`", async () => {
  world({ issues: [issue(5, "ready for prod release"), issue(6, "ready for prod release")], compareFiles: 0, prodHead: MERGE });
  editState((st) => { st.prodVerified = { 5: { pr: 100, mergeSha: MERGE, at: "2026-10-10T00:00:00Z" }, 6: { pr: 90, mergeSha: OLD, at: "2026-10-09T00:00:00Z" } }; });
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
  assert.deepEqual(loadRepoState("rel").promotionStallNoted, [5]);
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
  await tryPromotion(repo, log, 20_000, true);
  assert.deepEqual(log.at("warn"), [], "nothing at WARN");
  assert.ok(!log.at("info").some((m) => /waiting on EM verification/.test(m)), "nothing at INFO either");
  assert.ok(log.at("debug").some((m) => /only under \.claude\//.test(m)), "a debug line says why");
  assert.deepEqual(commentsOn(5), [], "the pr-approved issue is not told a release is stalled");
});

test("one file outside .claude/ still counts: the stall is reported, with only the production files counted", async () => {
  world({ issues: [], comparePaths: [".claude/skills/a/SKILL.md", "src/server.ts"] });
  const log = captureLogger();
  await tryPromotion(repo, log, 21_000, true);
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
  await tryPromotion(repo, log, base, true);
  const warns = log.at("warn");
  assert.equal(warns.length, 1, "one WARN");
  assert.ok(!STALLED.test(warns[0]), "not reported as an unnamed stall");
  assert.match(warns[0], /release of #5 held: blocked after predeploy-stop on PR #100 — waiting on a person/);
  assert.match(warns[0], /release of #6 held: blocked after predeploy-stop on PR #100 — waiting on a person/);
  assert.equal(loadRepoState("rel").promotionHeldNoted, "5,6");

  // The next check, unchanged: a debug line, no WARN, no comment read, nothing commented.
  log.clear();
  const callsBefore = ghCalls().length;
  await tryPromotion(repo, log, base + STALL_CHECK_CYCLE_INTERVAL, true);
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
  await tryPromotion(repo, log, base + 2 * STALL_CHECK_CYCLE_INTERVAL, true);
  const again = log.at("warn");
  assert.equal(again.length, 1);
  assert.match(again[0], /release of #5 held/);
  assert.ok(!/#6/.test(again[0]));
  assert.equal(loadRepoState("rel").promotionHeldNoted, "5");
});

test("a held issue with no stop comment is still named, by the release PR that lists it", async () => {
  world({
    issues: [issue(1283, "release pending", "blocked")],
    prs: [releasePr(1292, "## Production Promotion\n\n### Issues included\n- #1283: Issue 1283")],
    compareFiles: 4,
  });
  const log = captureLogger();
  await tryPromotion(repo, log, 23_000, true);
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
