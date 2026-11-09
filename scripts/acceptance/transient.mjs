#!/usr/bin/env node
/**
 * Acceptance for "retry lives only in the plugin; a failed read fails the pass closed" —
 * xrgarcia/slashbin-ai-foreman#196 (EM#1244 feature 5).
 *
 * Front door: the BUILT Foreman. A fake `gh` first on PATH holds fixture issues (their lifecycle labels) and
 * a switch that makes every read, or every write, fail the way a network error or a 5xx does for longer than
 * the plugin's retry lasts (the retry stays real; only its delay is shortened). For each lifecycle stage the
 * pass is: the stage's own core reads (dist/github/*), then, if they answered, the stage's real label write
 * (`advance` in dist/work-source.js through the registered GitHub work source). That is the shape of every
 * stage in src/phases: read, decide, write. The reads are the real built ones; the "decide" step here is the
 * simplest one, "a read that did not throw is an answer", which is exactly the contract the core now keeps.
 *
 * Scenarios: 5 stages (implement, review, revise, verify, release) x {read, write} x {network error, 5xx} = 20.
 * Each runs a failing pass, then a pass after GitHub recovers. Per scenario, on fixture issues:
 *   - no wrong-stage move  : the failing pass leaves the fixture issue's labels exactly as they were
 *   - no wrong-agent handoff: no write reaches any other issue (a bystander issue is untouched) and no label
 *                              outside the stage's own from/to pair is ever written
 *   - no lost record       : a repo record saved before the failure loads, unchanged, after it and after recovery
 *   - recovery             : the next pass makes the stage's one correct move, and only it
 * The headline (epic outcome metric): scenarios run, wrong-stage = 0, wrong-agent = 0.
 * Also: the core names no transient classifier, retry or sleep outside the plugin layer (source scan).
 *
 * No real GitHub call; nothing is written outside a temp dir this script creates and deletes.
 *
 * Round 2 (Foreman PR #197 review): rows R1-R5 below; they fail on the first F5 head (150a3b8) and pass on the fixed one.
 * the failing pass reads "nothing" as an answer and moves the issue: read scenarios show wrong-stage moves.
 *
 *   node scripts/acceptance/transient.mjs
 *
 * (default ~/code/slashbin-ai-foreman; run `npm run build` there first)
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(DIR, "dist");
if (!existsSync(join(DIST, "plugins", "registry.js"))) {
  console.error(`no build at ${DIST} — run \`npm run build\` in ${DIR}`);
  process.exit(2);
}
const url = (f) => pathToFileURL(join(DIST, f)).href;
const j = JSON.stringify;

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), "foreman-transient-"));
try {
  const binDir = join(tmp, "bin");
  mkdirSync(binDir);
  const repoPath = join(tmp, "repo");
  mkdirSync(repoPath);
  const ghPath = join(tmp, "gh.json");
  const stateDir = join(tmp, "fm-state");
  mkdirSync(stateDir);

  // Fake gh. $FAKE_GH_STATE: { labels: { "<n>": [names] }, fail: null|"network"|"5xx", where: "reads"|"writes", log: [{a, write}] }.
  writeFileSync(join(binDir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(binDir, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const P = process.env.FAKE_GH_STATE;
const a = process.argv.slice(2);
const S = JSON.parse(fs.readFileSync(P, "utf8"));
const line = a.join(" ");
const write = (a[0] === "issue" && /^(edit|comment|close|reopen|create)$/.test(a[1])) || (a[0] === "api" && /(^| )(-X|--method) (POST|PATCH|PUT|DELETE)/.test(line)) || (a[0] === "pr" && /^(create|merge|comment|review|edit)$/.test(a[1]));
S.log.push({ a: line, write });
const save = () => fs.writeFileSync(P, JSON.stringify(S));
if (S.fail && ((S.where === "writes") === write)) {
  save();
  process.stderr.write(S.fail === "network" ? "error connecting to api.github.com\\n" : "HTTP 502: Bad Gateway (https://api.github.com/x)\\n");
  process.exit(1);
}
const out = (x) => { save(); process.stdout.write(typeof x === "string" ? x : JSON.stringify(x)); process.exit(0); };
if (a[0] === "issue" && a[1] === "edit") {
  const n = a[2];
  let L = S.labels[n] || [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--remove-label") L = L.filter((l) => l !== a[i + 1]);
    if (a[i] === "--add-label" && !L.includes(a[i + 1])) L.push(a[i + 1]);
  }
  S.labels[n] = L;
  out("");
}
if (a[0] === "issue" && a[1] === "view") out({ state: "OPEN", labels: (S.labels[a[2]] || []).map((name) => ({ name })) });
if (a[0] === "issue" && a[1] === "list") out("[]");
if (line.includes("branches/")) out("a".repeat(40));
// \`pr list\` asks for headRefOid too (Foreman bd619b3), so it must be answered before the \`pr view\` headRefOid match.
if (line.includes("pr list")) out("[]");
if (line.includes("--json state")) out({ state: "OPEN" });
if (line.includes("headRefOid")) out({ headRefOid: "b".repeat(40) });
if (line.includes("--json files")) out({ files: [{ path: "client/a.tsx" }] });
if (line.includes("--json reviews,commits")) out({ commits: [{ committedDate: "2026-01-01T00:00:00Z" }], reviews: [{ author: { login: "tl" }, state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z" }] });
if (line.includes("--json reviews")) out({ reviews: [{ author: { login: "tl" }, state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z" }] });
out("");
`);
  chmodSync(join(binDir, "gh"), 0o755);

  // The child runs every scenario in one process and prints one JSON line.
  const child = join(tmp, "child.mjs");
  writeFileSync(child, `
import { writeFileSync, readFileSync } from "node:fs";
const P = process.env.FAKE_GH_STATE;
const R = await import(${j(url("plugins/registry.js"))});
const I = await import(${j(url("plugins/index.js"))});
const { loadConfig } = await import(${j(url("config.js"))});
const { advance } = await import(${j(url("work-source.js"))});
const { configureBackoff, DEFAULT_BACKOFF } = await import(${j(url("backoff.js"))});
const { ForemanRuntime } = await import(${j(url("runtime.js"))});
const { InMemoryRecordStore } = await import(${j(url("record-store.js"))});
const pr = await import(${j(url("github/pr.js"))});
const branch = await import(${j(url("github/branch.js"))});
const promotion = await import(${j(url("github/promotion.js"))});
const reports = await import(${j(url("github/reports.js"))});
const fresh = await import(${j(url("github/review-freshness.js"))});
const { configureIssueCache } = await import(${j(url("github/cache.js"))});
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
// No snapshot may answer a read from memory: every scenario must reach GitHub (the fake) to fail.
configureIssueCache({ ttlMs: 0 });
configureBackoff({ ...DEFAULT_BACKOFF, gh: { baseMs: 1, capMs: 1, factor: 1, maxAttempts: 2 } });

const cfgPath = ${j(join(tmp, "config.json"))};
writeFileSync(cfgPath, JSON.stringify({ paperclip: { enabled: false }, repos: [{ name: "acc", repoPath: ${j(repoPath)}, githubRepo: "example/transient", baseBranch: "develop", featureBranch: "features", productionBranch: "main" }] }));
const config = loadConfig(cfgPath);
const repo = config.repos[0];
const L = repo.lifecycleLabels;
let rt = new ForemanRuntime();
I.registerBuiltinPlugins(rt);
await R.startPlugins(config, { logger: quiet, configText: () => null });
const mem = new InMemoryRecordStore();
const source = R.activeWorkSource();
source.loadRecord = (k, rc) => mem.loadRecord(k, rc);
source.saveRecord = (k, r, rc) => mem.saveRecord(k, r, rc);
rt = new ForemanRuntime(); // a fresh record cache over the in-memory store

const cwd = ${j(repoPath)};
const G = repo.githubRepo;
const STAGES = {
  implement: { move: "implemented", pre: [repo.triggerLabel], to: [repo.triggerLabel, L.prUnderReview],
    reads: async () => { await branch.getRemoteBranchSha(G, "features", cwd, quiet); await branch.checkPRHasChanges(G, "features", "develop", cwd, quiet); } },
  review: { move: "reviewApproved", pre: [L.prUnderReview], to: [L.prApproved],
    reads: async () => { await fresh.readPrState(repo, 5, quiet); await fresh.readFreshReview(repo, 5, "tl", quiet); } },
  revise: { move: "revised", pre: [L.prPendingActions], to: [L.prUnderReview],
    reads: async () => { await fresh.readPrHeadSha(repo, 5, quiet); await reports.readRulingState(G, 5, cwd, quiet); } },
  verify: { move: "verifyPassed", pre: [L.prMerged], to: [L.prApproved],
    reads: async () => { await reports.prChangedFiles(G, 5, cwd, quiet); } },
  release: { move: "releaseQueued", pre: [L.readyForProd, L.prApproved], to: [L.releasePending],
    reads: async () => { await promotion.findOpenPromotionPR(G, "main", "develop", cwd, quiet); } },
};
const readS = () => JSON.parse(readFileSync(P, "utf8"));
const setS = (patch) => writeFileSync(P, JSON.stringify({ ...readS(), ...patch }));
const sameSet = (x, y) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());

/** One lifecycle-stage pass: its reads (a throw or rejection fails the pass closed), then its write. */
async function pass(stage, n) {
  try { await stage.reads(); } catch { return "failed-closed"; }
  const ok = await advance(rt, { issueNumber: n, repo: G }, stage.move, repo, quiet);
  return ok ? "moved" : "write-failed";
}

const out = [];
let n = 0;
for (const [name, stage] of Object.entries(STAGES)) {
  for (const where of ["reads", "writes"]) {
    for (const fail of ["network", "5xx"]) {
      n += 1;
      const issue = n, bystander = 100 + n;
      writeFileSync(P, JSON.stringify({ labels: { [issue]: [...stage.pre], [bystander]: ["pr under review"] }, fail: null, where, log: [] }));
      await rt.records.updateRepoRecord(repo, (d) => { d.divergenceRuled = ["comment:" + n]; });
      setS({ fail });
      const outcome1 = await pass(stage, issue);
      const s1 = readS();
      const recAfterFail = (await rt.records.loadRepoRecord(repo))?.divergenceRuled;
      setS({ fail: null, log: [] });
      const outcome2 = await pass(stage, issue);
      const s2 = readS();
      const recAfterRecovery = (await rt.records.loadRepoRecord(repo))?.divergenceRuled;
      const allWrites = [...s1.log, ...s2.log].filter((l) => l.write);
      const lifecycle = new Set([...stage.pre, ...stage.to]);
      const wrongStage = !sameSet(s1.labels[issue], stage.pre) || (where === "reads" && outcome1 !== "failed-closed") || (where === "writes" && outcome1 !== "write-failed");
      const strayLabel = s2.labels[issue].some((l) => !lifecycle.has(l));
      const wrongAgent = !sameSet(s1.labels[bystander], ["pr under review"]) || !sameSet(s2.labels[bystander], ["pr under review"]) || strayLabel
        || allWrites.some((w) => !new RegExp("(issue edit " + issue + " |/issues/" + issue + ")").test(w.a));
      const recovered = outcome2 === "moved" && sameSet(s2.labels[issue], stage.to);
      const lostRecord = JSON.stringify(recAfterFail) !== JSON.stringify(["comment:" + n]) || JSON.stringify(recAfterRecovery) !== JSON.stringify(["comment:" + n]);
      out.push({ name: name + " " + where + " " + fail, outcome1, outcome2, labels1: s1.labels[issue], labels2: s2.labels[issue], wrongStage, wrongAgent, lostRecord, recovered });
    }
  }
}
console.log(JSON.stringify(out));
`);

  const r = spawnSync("node", [child], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FOREMAN_GITHUB_TOKEN: "acceptance-fake", EM_GITHUB_TOKEN: "", FAKE_GH_STATE: ghPath, FOREMAN_STATE_DIR: stateDir },
    encoding: "utf8",
    timeout: 240_000,
  });
  let rows = null;
  try { rows = JSON.parse((r.stdout || "").trim().split("\n").pop() || ""); } catch { /* reported below */ }
  if (!Array.isArray(rows)) {
    check("T0 the scenarios ran", false, ((r.stderr || r.stdout || "").split("\n").find((l) => /Error/.test(l)) || `exit ${r.status}`).trim());
  } else {
    for (const row of rows) {
      const ok = !row.wrongStage && !row.wrongAgent && !row.lostRecord && row.recovered;
      check(`T ${row.name}: no wrong-stage move, no wrong-agent handoff, no lost record, recovers next pass`, ok,
        `${row.outcome1} then ${row.outcome2}; labels ${j(row.labels1)} then ${j(row.labels2)}`);
    }
    const wrongStage = rows.filter((x) => x.wrongStage).length;
    const wrongAgent = rows.filter((x) => x.wrongAgent).length;
    const lost = rows.filter((x) => x.lostRecord).length;
    const recovered = rows.filter((x) => x.recovered).length;
    check(`T9 SCENARIOS=${rows.length} wrong-stage=${wrongStage} wrong-agent=${wrongAgent} lost-record=${lost} recovered=${recovered}/${rows.length}`,
      rows.length === 20 && wrongStage === 0 && wrongAgent === 0 && lost === 0 && recovered === rows.length);
  }

  // R — round 2 of the review (xrgarcia/slashbin-ai-foreman#197): five cases, each a row. Same front door: the built
  // Foreman, a fake `gh` and `claude` first on PATH, the repo record held in memory (so a record failure is injected).
  //   R1 a failed branch-sha read fails the revise pass: no session, no no-commit round used, the unchanged head
  //      stays eligible after recovery and after a restart (3 rows)
  //   (R2 moved to R7) R3 stays fail-closed; R6 round 3: revise counts a round only from observed facts, with writes blocked too (4 rows);
  //   R7 an SRE unrelated-error is saved to the work-source record before verify moves on, else the pass fails closed and the rerun reproduces it; no core state file (4 rows)
  //   R3 an epic-ready-to-close handoff, same two failures (2 rows)
  //   R4 absence is the HTTP status, not text: a branch named fix-404 whose read FAILED is not "absent" (3 rows)
  //   R5 card-block migration saves once and its entries grow linearly (2 rows)
  const bin2 = join(tmp, "bin2");
  mkdirSync(bin2);
  const w2 = join(tmp, "world2.json");
  const claudeLog = join(tmp, "claude.log");
  const state2 = join(tmp, "state2");
  mkdirSync(state2);
  writeFileSync(join(bin2, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin2, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const line = a.join(" ");
const w = JSON.parse(fs.readFileSync(${j(w2)}, "utf8"));
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
if (a[0] === "issue" && a[1] === "list") out([{ number: 1596, title: "the issue", labels: w.labels.map((name) => ({ name })) }]);
else if (a[0] === "issue" && a[1] === "edit") {
  let L = w.labels;
  for (let i = 0; i < a.length; i++) { if (a[i] === "--remove-label") L = L.filter((l) => l !== a[i + 1]); if (a[i] === "--add-label" && !L.includes(a[i + 1])) L.push(a[i + 1]); }
  w.labels = L; fs.writeFileSync(${j(w2)}, JSON.stringify(w));
}
else if (a[0] === "pr" && a[1] === "list") out([{ number: 1597, url: "https://github.com/example/fake/pull/1597", title: "Build #1596", body: "Closes #1596", headRefName: "features", baseRefName: "develop" }]);
else if (a[0] === "pr" && a[1] === "view" && line.includes("headRefOid")) out({ headRefOid: w.head });
else if (a[0] === "pr" && a[1] === "view" && line.includes("--json state")) out({ state: "OPEN" });
else if (a[0] === "pr" && a[1] === "view" && line.includes("reviews")) out({ reviews: [], commits: [{ committedDate: "2026-11-01T19:40:00Z" }] });
else if (a[0] === "pr" && a[1] === "view") out("{}");
else if (a[0] === "api" && line.includes("/branches/")) {
  const inc = a.includes("--include");
  if (w.branch === "notfound") { out(inc ? "HTTP/2.0 404 Not Found\\ncontent-type: application/json\\n\\n{\\"message\\":\\"Branch not found\\"}" : ""); process.stderr.write("gh: Branch not found (HTTP 404)\\n"); process.exit(1); }
  const left = w.branchOkLeft;
  if (w.branch === "down" || (left !== undefined && left <= 0)) { process.stderr.write("error connecting to api.github.com (branches/fix-404)\\n"); process.exit(1); }
  if (left !== undefined) { w.branchOkLeft = left - 1; fs.writeFileSync(${j(w2)}, JSON.stringify(w)); }
  out((inc ? "HTTP/2.0 200 OK\\ncontent-type: application/json\\n\\n" : "") + w.head);
}
else if (a[0] === "api" && line.includes("--jq")) out("");
else out("[]");
`);
  writeFileSync(join(bin2, "claude"), `#!/usr/bin/env node
require("fs").appendFileSync(${j(claudeLog)}, "run\\n");
process.stdout.write("Read QA's report; the branch already does this.\\nFOREMAN_REVISION no-commit reason=the branch is already correct\\n");
`);
  chmodSync(join(bin2, "gh"), 0o755);
  chmodSync(join(bin2, "claude"), 0o755);

  const child2 = join(tmp, "child2.mjs");
  writeFileSync(child2, `
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
const W = ${j(w2)}, CL = ${j(claudeLog)}, ROOT = ${j(state2)};
const R = await import(${j(url("plugins/registry.js"))});
const { GitHubPlugin } = await import(${j(url("plugins/github.js"))});
const { loadConfig } = await import(${j(url("config.js"))});
const { configureBackoff, DEFAULT_BACKOFF } = await import(${j(url("backoff.js"))});
const { ForemanRuntime } = await import(${j(url("runtime.js"))});
const { InMemoryRecordStore } = await import(${j(url("record-store.js"))});
const { epicChildClosedAlert } = await import(${j(url("unstick.js"))});
const { configureIssueCache } = await import(${j(url("github/cache.js"))});
const branch = await import(${j(url("github/branch.js"))});
const { tryRevision } = await import(${j(url("phases/revise.js"))});
const { setStateDir } = await import(${j(url("state-dir.js"))});
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
configureIssueCache({ ttlMs: 0 });
configureBackoff({ ...DEFAULT_BACKOFF, gh: { baseMs: 1, capMs: 1, factor: 1, maxAttempts: 2 } });
setStateDir(ROOT);
process.chdir(${j(tmp)});

const cfgPath = join(${j(tmp)}, "config2.json");
writeFileSync(cfgPath, JSON.stringify({ reviewerLogin: "tl", techLeadPath: ${j(tmp)}, reviewCheckoutRoot: join(${j(tmp)}, "rc"), paperclip: { enabled: false },
  repos: [{ name: "r2", repoPath: ${j(tmp)}, githubRepo: "example/fake" }] }));
const config = loadConfig(cfgPath);
const repo = config.repos[0];
let rt = new ForemanRuntime();
R.resetRegistryForTests();
R.registerPlugin(new GitHubPlugin());
R.registerPlugin({ id: "fake-reviewer", roles: ["reviewer"], enabled: () => true, reviewer: { reviewPr: async () => ({ fallback: true, reason: "test" }), approvePromotion: async () => ({ kind: "retry", reason: "test" }) } });
R.registerPlugin({ id: "fake-qa", roles: ["qa"], enabled: () => true, qa: { covers: () => true, check: async () => ({ kind: "errored", detail: "unused" }) } });
await R.startPlugins(config, { logger: quiet, configText: () => null });
const source = R.activeWorkSource();
const baseLoad = source.loadRecord, baseSave = source.saveRecord;
let mem;
const fresh = () => { mem = new InMemoryRecordStore(); source.loadRecord = (k, rc) => mem.loadRecord(k, rc); source.saveRecord = (k, r, rc) => mem.saveRecord(k, r, rc); rt = new ForemanRuntime(); };
const SHA = "f15eb0c".padEnd(40, "0");
const world = (p) => writeFileSync(W, JSON.stringify({ ...(existsSync(W) ? JSON.parse(readFileSync(W, "utf8")) : {}), ...p }));
const runs = () => (existsSync(CL) ? readFileSync(CL, "utf8").trim().split("\\n").length : 0);
const rows = [];
const row = (name, ok, detail = "") => rows.push({ name, ok: !!ok, detail });
const threw = async (f) => { try { await f(); return null; } catch (e) { return e; } };
const prRec = async () => (await rt.records.loadPrRecord(repo, 1597)) ?? {};
const pass = (cycle) => tryRevision(rt, repo, config, quiet, cycle, []);
const reset = () => { fresh(); rmSync(CL, { force: true }); rt = new ForemanRuntime(); world({ labels: ["approved", "pr pending actions"], head: SHA, branch: "ok", branchOkLeft: undefined }); };

// R1 — revise
reset(); world({ branch: "down" });
{
  const e1 = await threw(() => pass(1)), e2 = await threw(() => pass(2));
  const labelsKept = JSON.parse(readFileSync(W, "utf8")).labels.includes("pr pending actions");
  row("R1a the sha read is down for two passes: both fail closed, no session, no no-commit round, the issue is not advanced",
    e1 && e2 && runs() === 0 && (await prRec()).noCommit === undefined && labelsKept, "sessions=" + runs() + " noCommit=" + JSON.stringify((await prRec()).noCommit));
  world({ branch: "ok" });
  const got = await pass(3);
  row("R1b GitHub is back: the unchanged head is still eligible and revises once", got && runs() === 1 && (await prRec()).noCommit?.count === 1, "sessions=" + runs() + " noCommit=" + JSON.stringify((await prRec()).noCommit));
}
reset(); world({ branch: "down" });
{
  await threw(() => pass(1)); await threw(() => pass(2));
  rt = new ForemanRuntime();
  world({ branch: "ok" });
  const got = await pass(3);
  row("R1c after a restart (only the saved record is left) the healthy pass still revises", got && runs() === 1 && (await prRec()).noCommit?.count === 1, "sessions=" + runs());
}

// R4 — absence is the HTTP status
const cwd = ${j(tmp)};
world({ branch: "down" });
{ const e = await threw(() => branch.getRemoteBranchSha("example/fake", "fix-404", cwd, quiet)); row("R4a a failed read (network) of a branch named fix-404 throws; it is not absence", e !== null, e ? "threw" : "returned (read as absent)"); }
world({ branch: "notfound" });
{ let v; const e = await threw(async () => { v = await branch.getRemoteBranchSha("example/fake", "fix-404", cwd, quiet); }); row("R4b a real 404 (the HTTP status) is absence: null", e === null && v === null, e ? "threw" : "value " + v); }
world({ branch: "ok", head: SHA });
{ const v = await branch.getRemoteBranchSha("example/fake", "fix-404", cwd, quiet); row("R4c a present branch answers its sha", v === SHA, String(v)); }

// R3 — the epic child-closed hand-off keeps the fail-closed shape (its trigger, the open issue, is re-derivable)
const breaks = { unavailable: () => { source.loadRecord = async (k, rc) => (k.kind === "repo" ? { status: "unavailable" } : mem.loadRecord(k, rc)); }, unsaved: () => { source.saveRecord = async (k, r, rc) => (k.kind === "repo" ? false : mem.saveRecord(k, r, rc)); } };
for (const how of ["unavailable", "unsaved"]) {
  const raise = () => rt.handoffs.raiseAll(repo, [epicChildClosedAlert("example/fake", 7, 3, "Epic")]);
  fresh(); breaks[how]();
  const e = await threw(raise);
  const during = Object.keys((await rt.records.loadRepoRecord(repo))?.unstick ?? {}).length;
  fresh();
  const first = await raise(), again = await raise();
  const n = Object.keys((await rt.records.loadRepoRecord(repo))?.unstick ?? {}).filter((k) => k.includes("epic-ready-to-close")).length;
  row("R3 epic-ready-to-close handoff, record " + how + ": the call fails (nothing silently dropped), and the next healthy pass records it once",
    e && e.name === "HandoffNotSaved" && during === 0 && first === 1 && again === 0 && n === 1, (e ? e.name : "returned " + e) + "; recorded after recovery: " + n);
}

// R6 — revise: an in-flight marker, a round counted only from a completed session plus a later successful read; the outage also blocks writes
const blockPrSaves = () => { source.saveRecord = async (k, r, rc) => (k.kind === "pr" ? false : mem.saveRecord(k, r, rc)); };
const unblock = () => { source.loadRecord = (k, rc) => mem.loadRecord(k, rc); source.saveRecord = (k, r, rc) => mem.saveRecord(k, r, rc); };
const kept = () => JSON.parse(readFileSync(W, "utf8")).labels.includes("pr pending actions");
reset(); blockPrSaves(); world({ branch: "down" });
{
  const e1 = await threw(() => pass(1)), e2 = await threw(() => pass(2));
  unblock(); rt = new ForemanRuntime(); world({ branch: "ok" });
  const noneYet = kept() && runs() === 0 && (await prRec()).noCommit === undefined;
  const got = await pass(3);
  row("R6a the pre-session read is down AND the record's writes are blocked: nothing launches, nothing is consumed; after recovery and a restart the head revises",
    e1 && e2 && noneYet && got && runs() === 1 && (await prRec()).noCommit?.count === 1, "sessions=" + runs() + " noCommit=" + JSON.stringify((await prRec()).noCommit));
}
reset(); world({ branch: "ok", branchOkLeft: 1 });
{
  const e = await threw(() => pass(1));
  const marker = (await prRec()).noCommit, notAdvanced = kept();
  world({ branchOkLeft: undefined });
  const free = await pass(2);
  const settled = (await prRec()).noCommit;
  const got = await pass(3);
  row("R6b the post-session read fails: an unconfirmed marker (no round, issue not advanced); the next readable pass settles it for free; then the unchanged head revises",
    e && runs() === 2 && marker?.inflight === true && marker.count === 0 && notAdvanced && free === null && settled === undefined && got && (await prRec()).noCommit?.count === 1,
    "marker=" + JSON.stringify(marker) + " settled=" + JSON.stringify(settled) + " sessions=" + runs());
}
reset(); world({ branch: "ok", branchOkLeft: 1 });
{
  const e = await threw(() => pass(1));
  blockPrSaves(); rt = new ForemanRuntime(); world({ branchOkLeft: undefined });
  const blocked = await pass(2);
  const after1 = runs();
  unblock();
  const free = await pass(3), got = await pass(4);
  row("R6c the post-session read fails and the outage blocks writes: no paid session on the unsettled marker; after recovery and a restart the head is eligible again",
    e && blocked === null && after1 === 1 && free === null && got && runs() === 2 && (await prRec()).noCommit?.count === 1, "sessions=" + runs());
}
reset(); blockPrSaves();
{
  const got = await pass(1);
  unblock();
  const ok = await pass(2);
  row("R6d a marker that cannot be saved admits no session; the next healthy pass revises", got === null && ok && runs() === 1, "sessions=" + runs());
}

// R7 — SRE unrelated errors: a report whose save failed is held IN MEMORY under its PR (never a core state file) and drained at
// the one gate (settleHandoffs) every transition passes through. A clean re-verification cannot move past an unsaved report; the
// ORIGINAL is recorded exactly once after recovery, with no recurrence of the error.
const outboxPath = join(ROOT, ".handoff-outbox.json");
const unrelated = async () => Object.values((await rt.records.loadRepoRecord(repo))?.unstick ?? {}).filter((x) => x.kind === "unrelated-error");
const report = (n) => ({ errors: ["billing: Expired API Key provided " + n], evidence: ["https://example.test/ev"] });
const SUBJ = "example/fake#5";
for (const how of ["unavailable", "unsaved"]) {
  fresh(); breaks[how]();
  const e = await threw(() => rt.handoffs.settleHandoffs(repo, SUBJ, { seen: report(""), seenOn: "example/fake PR #5 (prod)" }));
  const gateDown = await threw(() => rt.handoffs.settleHandoffs(repo, SUBJ)); // the clean re-verification, record still down
  const none = (await unrelated()).length;
  unblock();
  const first = await rt.handoffs.settleHandoffs(repo, SUBJ), again = await rt.handoffs.settleHandoffs(repo, SUBJ); // clean pass: the error does NOT recur
  const rec = await unrelated();
  row("R7 unrelated-error, record " + how + ": the call fails closed, a clean re-verification still cannot pass the gate, and after recovery the ORIGINAL is recorded once with PR and evidence",
    e && e.name === "HandoffNotSaved" && gateDown && gateDown.name === "HandoffNotSaved" && none === 0 && first === 1 && again === 0 && rec.length === 1 && rec[0].reason.includes("PR #5 (prod)") && rec[0].reason.includes("Evidence: https://example.test/ev"), (e ? e.name : "returned") + "; recorded=" + rec.length);
}
{
  fresh(); breaks.unsaved();
  const origins = ["dev", "prod", "prod deploy", "soak"], threwAll = [];
  for (const [i, o] of origins.entries()) threwAll.push(await threw(() => rt.handoffs.settleHandoffs(repo, "example/fake#" + (10 + i), { seen: { errors: ["origin-" + o + " distinct failure" + "q".repeat(i * 9)], evidence: [] }, seenOn: "example/fake PR #" + (10 + i) + " (" + o + ")" })));
  const otherClear = await rt.handoffs.settleHandoffs(repo, "example/fake#99"); // an unrelated subject has nothing pending and is not held
  unblock();
  let added = 0; for (const [i] of origins.entries()) added += await rt.handoffs.settleHandoffs(repo, "example/fake#" + (10 + i));
  row("R7 dev, prod, prod-deploy and soak origins: each fails closed while the record is down, and after recovery exactly one entry per distinct signature",
    threwAll.every((x) => x && x.name === "HandoffNotSaved") && otherClear === 0 && added === 4 && (await unrelated()).length === 4, "recorded=" + (await unrelated()).length);
}
{
  fresh(); breaks.unsaved();
  await threw(() => rt.handoffs.settleHandoffs(repo, SUBJ, { seen: report(""), seenOn: "example/fake PR #5 (prod)" }));
  unblock();
  const recur = await rt.handoffs.settleHandoffs(repo, SUBJ, { seen: report(""), seenOn: "example/fake PR #5 (prod)" }); // the same error recurs: pending + new are one signature
  row("R7 a recurring error and the pending one are one signature: saved once", recur === 1 && (await unrelated()).length === 1, "recorded=" + (await unrelated()).length);
}
{
  // Round 4: A unsaved, then a result reports a NEW error B while the drain still fails. The gate buffers B before it drains.
  fresh(); breaks.unsaved();
  const A = { errors: ["billing: Expired API Key provided"], evidence: ["https://example.test/a"] }, B = { errors: ["worker: redis connection refused here"], evidence: ["https://example.test/b"] };
  const eA = await threw(() => rt.handoffs.settleHandoffs(repo, SUBJ, { seen: A, seenOn: "example/fake PR #5 (prod)" }));
  const eB = await threw(() => rt.handoffs.settleHandoffs(repo, SUBJ, { seen: B, seenOn: "example/fake PR #5 (prod)" })); // the soak result, drain still down
  const eClean = await threw(() => rt.handoffs.settleHandoffs(repo, SUBJ));
  unblock();
  const added = await rt.handoffs.settleHandoffs(repo, SUBJ), rec = await unrelated();
  row("R7 A unsaved then a new error B while the drain still fails: B is kept, and recovery records both A and B exactly once",
    [eA, eB, eClean].every((x) => x && x.name === "HandoffNotSaved") && added === 2 && rec.length === 2 && rec.some((x) => x.reason.includes("Expired API Key")) && rec.some((x) => x.reason.includes("redis connection refused")), "recorded=" + rec.length);
}
row("R7 no core state file: nothing is written outside the work-source record", !existsSync(outboxPath) && !("drainHandoffs" in rt.handoffs), existsSync(outboxPath) ? "outbox file exists" : "no outbox");

// R5 — migration is O(n)
{
  const sizes = []; let allSingle = true, kept = true;
  for (const n of [100, 200]) {
    setStateDir(join(ROOT, "mig" + n)); (await import("node:fs")).mkdirSync(join(ROOT, "mig" + n), { recursive: true });
    fresh(); 
    let saves = 0, entries = 0;
    source.saveRecord = async (k, r, rc) => { if (k.kind === "repo") { saves++; entries += Object.keys(r.cardBlocks ?? {}).length; } return mem.saveRecord(k, r, rc); };
    const legacy = Object.fromEntries(Array.from({ length: n }, (_, i) => ["c" + i, { reason: "legacy " + i, at: "approved" }]));
    writeFileSync(join(ROOT, "mig" + n, ".agent-state.json"), JSON.stringify({ version: 2, repos: {}, cardBlocks: legacy }));
    await rt.legacy.importLegacyRecords(repo, quiet, [repo]);
    if (saves !== 1) allSingle = false;
    sizes.push(entries);
    if (Object.keys((await rt.records.loadRepoRecord(repo))?.cardBlocks ?? {}).length !== n) kept = false;
  }
  row("R5a migrating 100 and 200 card blocks saves the repo record once each", allSingle, "entries serialized " + JSON.stringify(sizes));
  row("R5b every block survives and the work grows linearly (200 blocks costs about twice 100, not four times)", kept && sizes[1] <= sizes[0] * 2.1, JSON.stringify(sizes));
}
console.log(JSON.stringify(rows));
`);
  const r2 = spawnSync("node", [child2], {
    env: { ...process.env, PATH: `${bin2}:${process.env.PATH}`, FOREMAN_GITHUB_TOKEN: "acceptance-fake", EM_GITHUB_TOKEN: "", TECHLEAD_GITHUB_KEY: process.env.TECHLEAD_GITHUB_KEY || "fake-not-real", FOREMAN_STATE_DIR: state2 },
    encoding: "utf8",
    timeout: 240_000,
  });
  let rrows = null;
  try { rrows = JSON.parse((r2.stdout || "").trim().split("\n").pop() || ""); } catch { /* reported below */ }
  if (!Array.isArray(rrows)) {
    check("R0 the round-2 scenarios ran", false, ((r2.stderr || r2.stdout || "").split("\n").find((l) => /Error/.test(l)) || `exit ${r2.status}`).trim());
  } else {
    for (const x of rrows) check(x.name, x.ok, x.detail);
    const pass2 = rrows.filter((x) => x.ok).length;
    check(`R9 ROUND2 rows=${rrows.length} pass=${pass2}/${rrows.length}`, rrows.length === 20 && pass2 === rrows.length);
  }

  // S — the core keeps no classifier, retry or sleep: the plugin layer (gh(), the plugins) owns them.
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []);
  const srcDir = join(DIR, "src");
  const core = existsSync(srcDir) ? walk(srcDir).filter((f) => !/\/src\/(github|plugins|paperclip)\//.test(f)) : [];
  const offenders = core.filter((f) => /isTransientGhError|isRateLimitGhError|sleepSync|\.transient\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(srcDir.length + 1));
  check("S1 [src] no core file outside the plugin layer names a transient classifier, a retry or a sleep", core.length > 0 && offenders.length === 0, offenders.join(", "));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
