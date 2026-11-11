#!/usr/bin/env node
/**
 * Acceptance for slashbin-ai-foreman#73 — an issue carrying only the trigger
 * label (`approved`), whose implementing PR has already merged to the base
 * branch, is a dead zone: implement skips it as "covered", and the dead-zone
 * detector only looked at `pr under review` / `pr pending actions`, so nothing
 * ever advanced it.
 *
 * Observed live 2026-10-02: Slashbin-Ingest-Gateway#155 — label `approved` only,
 * PR #156 merged to develop 2026-10-01T14:01:29Z, and the journal repeating
 * "Skipped …: 1 approved issue(s), all have linked PRs (open or merged)".
 *
 * Front door: the BUILT Foreman's `findStuckMergedIssues` (the candidate list the
 * orchestrator hands to `recoverDeadZonedIssue`) and `GitHubIssueConnector
 * .selectWork` (implement's selection), with a FAKE `gh` first on PATH serving a
 * board, open PRs and merged PRs, honouring --state/--base/--head. One child
 * process per scenario so no read cache crosses scenarios. No GitHub call.
 *
 *   A1 approved-only, PR "Closes #7" merged to develop 1h ago → #7 is a candidate (PR #20)
 *   N1 same, but an open features→develop PR also closes #7 → not a candidate
 *   N2 approved-only, the PR merged to a non-base branch (main) → not a candidate
 *   N3 approved-only, PR merged 5 minutes ago (inside the grace window) → not a candidate
 *   N4 approved + `pr approved` (already advanced) → not a candidate
 *   R1 `pr under review` + merged 1h ago → still a candidate (existing behaviour kept)
 *   L1 implement's "all have linked PRs" skip is logged at most once over three passes
 *
 * RED TODAY (features b2a7b2f): A1 and L1 fail. N1–N4 and R1 pass and must keep passing.
 *
 *   node scripts/acceptance/approved-merged-deadzone.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = fileURLToPath(import.meta.url);
const REPO = "example/acceptance";
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

const SCENARIOS = {
  A1: { labels: ["approved"], merged: [{ number: 20, base: "develop", body: "Closes #7", mergedAt: ago(60) }], open: [] },
  N1: { labels: ["approved"], merged: [{ number: 20, base: "develop", body: "Closes #7", mergedAt: ago(60) }],
    open: [{ number: 21, base: "develop", head: "features", body: "Closes #7" }] },
  N2: { labels: ["approved"], merged: [{ number: 20, base: "main", body: "Closes #7", mergedAt: ago(60) }], open: [] },
  N3: { labels: ["approved"], merged: [{ number: 20, base: "develop", body: "Closes #7", mergedAt: ago(5) }], open: [] },
  N4: { labels: ["approved", "pr approved"], merged: [{ number: 20, base: "develop", body: "Closes #7", mergedAt: ago(60) }], open: [] },
  R1: { labels: ["approved", "pr under review"], merged: [{ number: 20, base: "develop", body: "Closes #7", mergedAt: ago(60) }], open: [] },
};

// ───────────────────────────── child: one scenario ─────────────────────────────
async function child() {
  const sc = SCENARIOS[process.env.ACC_SCENARIO];
  const tmp = mkdtempSync(join(tmpdir(), "foreman-73-"));
  const out = { stuck: null, skipLogs: 0, logs: [], error: null };
  try {
    const bin = join(tmp, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}'); // fake gh is CJS; a stray ancestor type:module package.json must not make it ESM
    const board = [{ number: 7, title: "work item", labels: sc.labels.map((name) => ({ name })) }];
    const pr = (p, state) => ({ number: p.number, url: `https://github.com/${REPO}/pull/${p.number}`, title: `feat: work item`,
      body: p.body, headRefName: p.head ?? "features", baseRefName: p.base, state, mergedAt: p.mergedAt ?? null,
      commits: [], labels: [], isDraft: false, headRefOid: "h", updatedAt: ago(1) });
    const prs = [...sc.merged.map((p) => pr(p, "MERGED")), ...sc.open.map((p) => pr(p, "OPEN"))];
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const a=process.argv.slice(2);const opt=(f)=>{const i=a.indexOf(f);return i<0?undefined:a[i+1];};
const out=(v)=>{process.stdout.write(JSON.stringify(v));process.exit(0);};
if(a[0]==="issue"&&a[1]==="list")out(${JSON.stringify(board)});
if(a[0]==="pr"&&a[1]==="list"){const st=(opt("--state")||"open").toUpperCase();
  out(${JSON.stringify(prs)}.filter(p=>p.state===st&&(!opt("--base")||p.baseRefName===opt("--base"))&&(!opt("--head")||p.headRefName===opt("--head"))));}
out([]);
`);
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.FOREMAN_GITHUB_TOKEN = "acceptance-dummy-not-a-token";

    const imp = (f) => import(pathToFileURL(join(DIR, "dist", f)).href);
    const { loadConfig } = await imp("config.js");
    const github = await imp("github.js");
    github.configureIssueCache?.({ ttlMs: 0 });
    const cfgPath = join(tmp, "cfg.json");
    writeFileSync(cfgPath, JSON.stringify({ repos: [{ name: "acceptance", repoPath: tmp, githubRepo: REPO }] }));
    const config = loadConfig(cfgPath);
    const repo = config.repos[0];

    const rec = (level) => (msg) => { out.logs.push({ level, msg: String(msg) }); };
    const logger = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") };
    logger.child = () => logger;

    out.stuck = (await github.findStuckMergedIssues(repo, logger)).map((s) => ({ issue: s.issueNumber, pr: s.prNumber }));
    const src = new (await imp("github-work-source.js")).GitHubIssueConnector();
    for (let i = 0; i < 3; i++) await src.selectWork(repo, config, logger);
    out.skipLogs = out.logs.filter((l) => l.level !== "debug" && /all have linked PRs/.test(l.msg)).length;
  } catch (err) {
    out.error = err instanceof Error ? err.stack ?? err.message : String(err);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.stdout.write(`\nACC_RESULT ${JSON.stringify(out)}\n`);
  process.exit(0);
}

// ─────────────────────────────── parent: checks ───────────────────────────────
function run(name) {
  const r = spawnSync(process.execPath, [SELF], { env: { ...process.env, ACC_CHILD: "1", ACC_SCENARIO: name }, encoding: "utf8", timeout: 120_000 });
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("ACC_RESULT "));
  if (!line) return { error: `child produced no result (status ${r.status}): ${(r.stderr || "").slice(-400)}`, stuck: null, logs: [] };
  return JSON.parse(line.slice("ACC_RESULT ".length));
}

async function parent() {
  for (const f of ["config.js", "github.js"]) {
    if (!existsSync(join(DIR, "dist", f))) { console.error(`no build at ${join(DIR, "dist", f)}`); process.exit(2); }
  }
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
    if (!ok) failed++;
  };
  const r = Object.fromEntries(Object.keys(SCENARIOS).map((k) => [k, run(k)]));
  const is7 = (x) => !x.error && x.stuck?.length === 1 && x.stuck[0].issue === 7 && x.stuck[0].pr === 20;
  const none = (x) => !x.error && Array.isArray(x.stuck) && x.stuck.length === 0;
  const show = (x) => x.error ?? JSON.stringify(x.stuck);

  check("A1 approved-only, PR merged to base past grace → candidate #7 (PR #20)", is7(r.A1), show(r.A1));
  check("N1 an open feature PR also covers #7 → not a candidate", none(r.N1), show(r.N1));
  check("N2 PR merged to a non-base branch → not a candidate", none(r.N2), show(r.N2));
  check("N3 merged inside the grace window → not a candidate", none(r.N3), show(r.N3));
  check("N4 already `pr approved` → not a candidate", none(r.N4), show(r.N4));
  check("R1 `pr under review` + merged → still a candidate", is7(r.R1), show(r.R1));
  check("L1 'all have linked PRs' skip logged at most once over three passes", !r.A1.error && r.A1.skipLogs <= 1, `${r.A1.skipLogs} times`);

  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

if (process.env.ACC_CHILD) await child(); else await parent();
