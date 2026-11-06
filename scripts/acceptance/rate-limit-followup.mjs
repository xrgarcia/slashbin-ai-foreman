#!/usr/bin/env node
/**
 * Acceptance for the Foreman GitHub rate-limit follow-up to slashbin-ai-foreman#52
 * (back-off refusals logged at ERROR, probe clearing on the wrong bucket, no
 * per-hour call accounting) — xrgarcia/slashbin-ai-foreman, filed 2026-10-02.
 *
 * Front door: the BUILT Foreman's own entry points — `gh()` and the six discovery
 * functions from dist/github.js, the dist/upstream-backoff.js state API, and the
 * new dist/gh-usage.js. A fake `gh` (node, not `date +%s%3N`, which is broken on
 * this host) sits first on PATH: it logs "<ms> <GH_TOKEN> <args>" and answers from
 * files this script controls. Dummy tokens only. No real GitHub call, no write
 * anywhere outside a temp dir this script creates and deletes. Each case runs in
 * its own `node` child so module state starts fresh.
 *
 * RED TODAY (features 1da9e09):
 *   R1 — the six lookups log ERROR/WARN "… GitHub back-off active" while blocked.
 *   R2 — probeGitHub reads `gh api rate_limit`, whose graphql bucket reports
 *        remaining > 0 while the GraphQL endpoint itself still refuses, so it clears.
 *   R3 — dist/gh-usage.js does not exist.
 *   Red run 2026-10-02 on 1da9e09: 10 of 13 checks fail. Three pass and are regression
 *   guards, not discriminators: A0 (back-off entered — #52), A7 (runGh refuses while
 *   blocked — #52), B3 (the episode clears eventually; today it clears too early, B1).
 *
 *   A1..A6  during an active back-off, each lookup logs nothing at error or warn
 *   B1      a GraphQL-tripped back-off does NOT clear while `gh api rate_limit` says
 *           graphql remaining 4956 but `gh api graphql` is still refused
 *   B2      the probe that decides it ran `gh api graphql` with the token that tripped
 *   B3      once `gh api graphql` answers rateLimit.remaining > 0, it clears
 *   C1      configureGhUsage({ intervalMs }) emits one info summary per interval with
 *           total / graphql / core counts of spawned gh calls
 *
 *   npm run build && node scripts/acceptance/rate-limit-followup.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(DIR, "dist");
if (!existsSync(join(DIST, "github.js"))) {
  console.error(`no build at ${DIST} — run \`npm run build\` in ${DIR}`);
  process.exit(2);
}
const url = (f) => pathToFileURL(join(DIST, f)).href;

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), "foreman-ratelimit-"));
const binDir = join(tmp, "bin");
mkdirSync(binDir);
const fakeGh = join(binDir, "gh");
// Fake gh. Logs "<ms> <GH_TOKEN> <args>" to $FAKE_GH_LOG (tokens are dummies).
//   gh api rate_limit → $FAKE_GH_RATE
//   gh api graphql …  → exit 1 with $FAKE_GH_GQL_ERR when non-empty, else $FAKE_GH_GQL
//   anything else     → exit 1 with $FAKE_GH_ERR when non-empty, else "[]"
writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
fs.appendFileSync(process.env.FAKE_GH_LOG, Date.now() + " " + (process.env.GH_TOKEN || "-") + " " + a.join(" ") + "\\n");
if (a[0] === "api" && a[1] === "rate_limit") { process.stdout.write(read(process.env.FAKE_GH_RATE)); process.exit(0); }
if (a[0] === "api" && a[1] === "graphql") {
  const e = read(process.env.FAKE_GH_GQL_ERR);
  if (e.length) { process.stderr.write(e); process.exit(1); }
  process.stdout.write(read(process.env.FAKE_GH_GQL)); process.exit(0);
}
const err = read(process.env.FAKE_GH_ERR);
if (err.length) { process.stderr.write(err); process.exit(1); }
process.stdout.write("[]\\n");
`);
chmodSync(fakeGh, 0o755);

const GQL_LIMIT = "GraphQL: API rate limit already exceeded for user ID 1.";

/** Run one case body in a fresh node child; it must print one JSON line. */
function runCase(name, body, timeoutMs = 20_000) {
  const dir = mkdtempSync(join(tmp, `${name}-`));
  const files = {
    log: join(dir, "gh.log"), rate: join(dir, "rate.json"), err: join(dir, "err.txt"),
    gql: join(dir, "gql.json"), gqlErr: join(dir, "gql-err.txt"),
  };
  for (const f of Object.values(files)) writeFileSync(f, "");
  const prelude = `
    import { writeFileSync, readFileSync } from "node:fs";
    const F = ${JSON.stringify(files)};
    const CWD = ${JSON.stringify(dir)};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const calls = () => readFileSync(F.log, "utf8").split("\\n").filter(Boolean)
      .map((l) => { const [ts, token, ...a] = l.split(" "); return { ts: Number(ts), token, args: a.join(" ") }; });
    const nowSec = () => Math.floor(Date.now() / 1000);
    const lines = [];
    const mk = (ctx = {}) => {
      const L = {};
      for (const lvl of ["debug", "info", "warn", "error"]) L[lvl] = (msg, data) => lines.push({ lvl, msg, data: { ...ctx, ...data } });
      L.child = (c) => mk({ ...ctx, ...c });
      return L;
    };
    const logger = mk();
    const notes = [];
    const B = await import(${JSON.stringify(url("upstream-backoff.js"))});
    const G = await import(${JSON.stringify(url("github.js"))});
    const K = await import(${JSON.stringify(url("backoff.js"))});
    K.configureBackoff({ ...K.DEFAULT_BACKOFF, upstream: { ...K.DEFAULT_BACKOFF.upstream, baseMs: 300, capMs: 2400 } });
    B.configureUpstreamBackoff({ notify: (t) => notes.push(t), logger });
    const trip = (stderr) => { writeFileSync(F.err, stderr);
      try { G.gh(["issue", "list", "--repo", "example/acceptance"], CWD); } catch {} writeFileSync(F.err, ""); };
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `${prelude}\n${body}`], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FOREMAN_GITHUB_TOKEN: "acceptance-foreman",
      EM_GITHUB_TOKEN: "acceptance-em",
      FAKE_GH_LOG: files.log, FAKE_GH_RATE: files.rate, FAKE_GH_ERR: files.err,
      FAKE_GH_GQL: files.gql, FAKE_GH_GQL_ERR: files.gqlErr,
    },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  try {
    return JSON.parse(line);
  } catch {
    const err = (r.stderr || r.stdout || "").split("\n").find((l) => /Error/.test(l));
    return { __error: (err || `exit ${r.status}`).trim() };
  }
}
const why = (o) => (o && o.__error ? o.__error : "");

try {
  // A — the six lookups that logged ERROR/WARN in the 2026-10-02 journal, called while blocked.
  const a = runCase("quiet", `
    const C = await import(${JSON.stringify(url("config.js"))});
    const repo = "example/acceptance";
    const cfg = { name: "acceptance", githubRepo: repo, repoPath: CWD, triggerLabel: "approved",
      baseBranch: "develop", featureBranch: "features", lifecycleLabels: C.defaultLifecycleLabels() };
    writeFileSync(F.rate, JSON.stringify({ resources: { core: { remaining: 0, reset: nowSec() + 3600 }, graphql: { remaining: 0, reset: nowSec() + 3600 } } }));
    trip(${JSON.stringify(GQL_LIMIT)});
    const blocked = B.isUpstreamBlocked("github");
    const before = lines.length;
    const run = async (label, fn) => { const s = lines.length; try { await fn(); } catch {}
      return { label, loud: lines.slice(s).filter((l) => l.lvl === "error" || l.lvl === "warn").map((l) => l.lvl + " " + l.msg) }; };
    const out = [
      await run("selectWork (approved issues)", async () => new (await import(${JSON.stringify(url("github-work-source.js"))})).GitHubIssueConnector().selectWork(cfg, {}, logger)),
      await run("findPendingRevisions", () => G.findPendingRevisions(cfg, logger)),
      await run("findPRsNeedingReview", () => G.findPRsNeedingReview(cfg, undefined, logger)),
      await run("findReadyForProdIssues", () => G.findReadyForProdIssues(repo, CWD, cfg.lifecycleLabels, logger)),
      await run("checkBranchDrift", () => G.checkBranchDrift(repo, CWD, logger)),
      await run("findDependencyPRs", () => G.findDependencyPRs(repo, CWD, ["develop"], logger)),
    ];
    const spawned = calls().filter((c) => !c.args.startsWith("api rate_limit") && !c.args.startsWith("api graphql")).length;
    console.log(JSON.stringify({ blocked, out, spawned }));
  `);
  check("A0 back-off is active before the lookups run", a.blocked === true, `got ${a.blocked ?? why(a)}`);
  for (const [i, o] of (a.out ?? []).entries()) {
    check(`A${i + 1} ${o.label}: no error/warn line while backing off`, o.loud.length === 0, JSON.stringify(o.loud));
  }
  if (!a.out) check("A1..A6 lookups ran", false, why(a));
  check("A7 no gh spawned for the six refused lookups", a.spawned === 1, `fake ran ${a.spawned} time(s) (1 = the trip)`);

  // B — GraphQL-tripped back-off; /rate_limit's graphql bucket says plenty, the endpoint still refuses.
  const b = runCase("probe", `
    writeFileSync(F.rate, JSON.stringify({ resources: {
      core: { limit: 5000, remaining: 5000, reset: nowSec() + 3600 },
      graphql: { limit: 5000, remaining: 4956, reset: nowSec() + 1700 } } }));
    writeFileSync(F.gqlErr, ${JSON.stringify(GQL_LIMIT)});
    trip(${JSON.stringify(GQL_LIMIT)});
    await sleep(500);                                   // first probe at ~300ms
    const stillBlocked = B.isUpstreamBlocked("github");
    const clearedEarly = notes.filter((t) => /cleared/.test(t)).length;
    const gqlProbes = calls().filter((c) => c.args.startsWith("api graphql")).map((c) => c.token);
    writeFileSync(F.gqlErr, "");
    writeFileSync(F.gql, JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4999, used: 1,
      resetAt: new Date(Date.now() + 3600_000).toISOString() } } }));
    await sleep(1000);                                  // second probe at ~300+600ms
    console.log(JSON.stringify({ stillBlocked, clearedEarly, gqlProbes,
      clearedLater: notes.filter((t) => /cleared/.test(t)).length, blockedLater: B.isUpstreamBlocked("github") }));
  `);
  check("B1 not cleared while the GraphQL endpoint still refuses (rate_limit graphql remaining 4956)",
    b.stillBlocked === true && b.clearedEarly === 0, JSON.stringify(b.__error ? why(b) : { stillBlocked: b.stillBlocked, cleared: b.clearedEarly }));
  check("B2 the deciding probe called `gh api graphql` with the token that tripped (FOREMAN)",
    Array.isArray(b.gqlProbes) && b.gqlProbes.length >= 1 && b.gqlProbes.every((t) => t === "acceptance-foreman"),
    JSON.stringify(b.gqlProbes ?? null));
  check("B3 clears once `gh api graphql` reports rateLimit.remaining > 0",
    b.clearedLater === 1 && b.blockedLater === false, `cleared=${b.clearedLater} blocked=${b.blockedLater}`);

  // C — per-interval call summary by resource.
  const c = runCase("usage", `
    const U = await import(${JSON.stringify(url("gh-usage.js"))});
    U.configureGhUsage({ intervalMs: 400, logger });
    for (let i = 0; i < 3; i++) G.gh(["issue", "list", "--repo", "example/acceptance"], CWD);
    for (let i = 0; i < 2; i++) G.gh(["api", "repos/example/acceptance/compare/main...develop"], CWD);
    await sleep(600);
    const s = lines.filter((l) => l.lvl === "info" && typeof l.data?.total === "number");
    console.log(JSON.stringify({ summaries: s.map((l) => ({ msg: l.msg, total: l.data.total, graphql: l.data.graphql, core: l.data.core })) }));
  `);
  const first = c.summaries?.[0];
  check("C1 an info summary is emitted within one interval", !!first, JSON.stringify(c.__error ? why(c) : c.summaries ?? null));
  check("C1 counts by resource: total 5, graphql 3, core 2",
    first?.total === 5 && first?.graphql === 3 && first?.core === 2, JSON.stringify(first ?? null));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
