#!/usr/bin/env node
/**
 * Acceptance for the Foreman work-source record store — xrgarcia/slashbin-ai-foreman#187
 * (EM#1244 feature 1).
 *
 * Front door: the BUILT Foreman's registered work source — builtin plugins
 * registered and started as the daemon does, then `activeWorkSource()` from
 * dist/plugins/registry.js, then `loadRecord` / `saveRecord`. A fake `gh` sits
 * first on PATH: it logs every call and answers from a comment board this script
 * controls (a JSON file). No real GitHub call, no write outside a temp dir this
 * script creates and deletes. Each step runs in its own `node` child, so a
 * "fresh process" has an empty cache and only the board in common.
 *
 * RED TODAY (features 081fba5): the work source has no loadRecord / saveRecord,
 * so every row fails.
 *
 *   R1 persist     — a record saved in one process is loaded by a fresh one, equal, from the
 *                    issue's Foreman comment (marker foreman:record v1, authored by the Foreman login)
 *   R2 edit        — a second save with a changed value PATCHes the same comment; one record comment per item
 *   R3 transient   — one transient gh failure on the load and one on the save: both succeed, caller sees no error
 *   R4 unchanged   — a save identical to the stored record makes no gh call (same process, and a fresh one after one read)
 *   R5 unreachable — gh stays unreachable: load returns `unavailable`, never absent or an empty record
 *   R6 other login — a marker comment written by another login is ignored on load and left alone by a save
 *
 *   node scripts/acceptance/record-store.mjs
 *   (default ~/code/slashbin-ai-foreman; run `npm run build` there first)
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
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

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const SELF = "foreman-acceptance-bot";
const MARKER = "<!-- foreman:record v1 -->";
const tmp = mkdtempSync(join(tmpdir(), "foreman-record-store-"));
const binDir = join(tmp, "bin");
mkdirSync(binDir);
// Fake gh. State file $FAKE_GH_STATE: { board: { "<issue>": [{id, login, body}] }, failNext: n, failAll: bool, log: [] }.
// `api user` answers SELF. A comment call (list / POST / PATCH) first spends a failure from failNext/failAll
// (stderr "error connecting to api.github.com", the transient shape), else lists the marker comments
// (the --jq filter's output: one JSON row per line), creates one, or edits one in place.
writeFileSync(join(binDir, "package.json"), '{"type":"commonjs"}');
writeFileSync(join(binDir, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const P = process.env.FAKE_GH_STATE;
const a = process.argv.slice(2);
const S = JSON.parse(fs.readFileSync(P, "utf8"));
S.log.push(a.join(" "));
const save = () => fs.writeFileSync(P, JSON.stringify(S));
if (a[0] === "api" && a[1] === "user") { save(); process.stdout.write(${JSON.stringify(SELF)} + "\\n"); process.exit(0); }
const url = a.find((x) => x.startsWith("repos/")) || "";
const isComment = /\\/issues\\/(\\d+\\/comments|comments\\/\\d+)/.test(url);
if (isComment && (S.failAll || S.failNext > 0)) {
  if (S.failNext > 0) S.failNext--;
  save(); process.stderr.write("error connecting to api.github.com\\n"); process.exit(1);
}
const body = (a.find((x) => x.startsWith("body=")) || "").slice(5);
let m;
if ((m = url.match(/\\/issues\\/(\\d+)\\/comments/)) && !a.includes("-X")) {
  save();
  process.stdout.write((S.board[m[1]] || []).filter((c) => c.body.startsWith(${JSON.stringify(MARKER)})).map((c) => JSON.stringify(c)).join("\\n"));
} else if (m && a.includes("POST")) {
  const row = { id: 9000 + S.log.length, login: ${JSON.stringify(SELF)}, body };
  (S.board[m[1]] = S.board[m[1]] || []).push(row); save(); process.stdout.write(String(row.id));
} else if ((m = url.match(/\\/issues\\/comments\\/(\\d+)$/)) && a.includes("PATCH")) {
  for (const rows of Object.values(S.board)) for (const c of rows) if (c.id === Number(m[1])) c.body = body;
  save(); process.stdout.write("{}");
} else { save(); process.stderr.write("fake gh: unexpected " + a.join(" ") + "\\n"); process.exit(1); }
`);
chmodSync(join(binDir, "gh"), 0o755);

/** One scenario: its own state file and checkout dir; steps run in fresh node children against them. */
function scenario(name, initial = {}) {
  const dir = mkdtempSync(join(tmp, `${name}-`));
  const statePath = join(dir, "state.json");
  const write = (s) => writeFileSync(statePath, JSON.stringify(s));
  write({ board: {}, failNext: 0, failAll: false, log: [], ...initial });
  const read = () => JSON.parse(readFileSync(statePath, "utf8"));
  const cwd = join(dir, "repo");
  mkdirSync(cwd);
  /** Run `body` in a fresh child with `source` (the active work source), `key`, `cfg`; it prints one JSON line. */
  function step(body) {
    const prelude = `
      const R = await import(${JSON.stringify(url("plugins/registry.js"))});
      const I = await import(${JSON.stringify(url("plugins/index.js"))});
      const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
      const { ForemanRuntime } = await import(${JSON.stringify(url("runtime.js"))});
      I.registerBuiltinPlugins(new ForemanRuntime());
      await R.startPlugins({ paperclip: { enabled: false } }, { logger: quiet, configText: () => null });
      const source = R.activeWorkSource();
      const key = { repo: "example/acceptance", kind: "issue", number: 42 };
      const cfg = { repoPath: ${JSON.stringify(cwd)}, githubRepo: "example/acceptance" };
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `${prelude}\n${body}`], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FOREMAN_GITHUB_TOKEN: "acceptance-fake",
        EM_GITHUB_TOKEN: "", FAKE_GH_STATE: statePath, FOREMAN_STATE_DIR: join(dir, "fm-state") },
      encoding: "utf8",
      timeout: 60_000,
    });
    const line = (r.stdout || "").trim().split("\n").pop() || "";
    try {
      return JSON.parse(line);
    } catch {
      const err = (r.stderr || r.stdout || "").split("\n").find((l) => /Error/.test(l));
      return { __error: (err || `exit ${r.status}`).trim() };
    }
  }
  return { write, read, step };
}
const why = (o) => (o && o.__error ? o.__error : "");
const isWrite = (l) => /\bPOST\b|\bPATCH\b/.test(l);
const COMMENT = "issues/42/comments";
const REC = { attempts: 2, hold: { reason: "waiting on #7" }, tags: ["a", "b"] };

try {
  // R1 — persist across processes.
  const s1 = scenario("persist");
  const save1 = s1.step(`const REC = ${JSON.stringify(REC)};
    console.log(JSON.stringify({ ok: await source.saveRecord(key, REC, cfg) }));`);
  const load1 = s1.step(`console.log(JSON.stringify(await source.loadRecord(key, cfg)));`);
  const board1 = s1.read().board["42"] || [];
  check("R1 save succeeds", save1.ok === true, why(save1) || JSON.stringify(save1));
  check("R1 a fresh process loads the same record", load1.status === "found" && JSON.stringify(load1.record) === JSON.stringify(REC),
    JSON.stringify(load1));
  check("R1 it lives in one Foreman-authored comment carrying the marker",
    board1.length === 1 && board1[0].login === SELF && board1[0].body.startsWith(MARKER), JSON.stringify(board1.map((c) => [c.login, c.body.slice(0, 30)])));

  // R2 — second save edits the same comment.
  const s2 = scenario("edit");
  const r2 = s2.step(`
    const a = await source.saveRecord(key, { n: 1 }, cfg);
    const b = await source.saveRecord(key, { n: 2 }, cfg);
    console.log(JSON.stringify({ a, b }));`);
  const load2 = s2.step(`console.log(JSON.stringify(await source.loadRecord(key, cfg)));`);
  const st2 = s2.read();
  const patches = st2.log.filter((l) => /\bPATCH\b/.test(l));
  const posts = st2.log.filter((l) => /\bPOST\b/.test(l));
  check("R2 both saves succeed", r2.a === true && r2.b === true, JSON.stringify(r2.__error ? why(r2) : r2));
  check("R2 one comment created, then edited in place", posts.length === 1 && patches.length === 1
    && patches[0].includes(`issues/comments/${(st2.board["42"] || [])[0]?.id}`), `posts=${posts.length} patches=${patches.length}`);
  check("R2 one record comment per item, holding the new value", (st2.board["42"] || []).length === 1
    && load2.status === "found" && load2.record?.n === 2, JSON.stringify(load2));

  // R3 — one transient failure on load and on save is absorbed.
  const s3 = scenario("transient", { failNext: 1 });
  const r3 = s3.step(`
    const load = await source.loadRecord(key, cfg);
    console.log(JSON.stringify({ load }));`);
  check("R3 load after one transient failure succeeds (absent, not an error)", r3.load?.status === "absent", JSON.stringify(r3.__error ? why(r3) : r3));
  s3.write({ ...s3.read(), failNext: 1 });
  const r3b = s3.step(`
    let threw = false, ok;
    try { ok = await source.saveRecord(key, { v: 1 }, cfg); } catch { threw = true; }
    console.log(JSON.stringify({ ok, threw }));`);
  const st3 = s3.read();
  check("R3 save after one transient failure succeeds and does not throw", r3b.ok === true && r3b.threw === false, JSON.stringify(r3b.__error ? why(r3b) : r3b));
  check("R3 the failed call was retried (the comment endpoint was hit again)", st3.log.filter((l) => l.includes(COMMENT)).length >= 4,
    `${st3.log.filter((l) => l.includes(COMMENT)).length} comment calls`);

  // R4 — an unchanged save is free.
  const s4 = scenario("unchanged");
  s4.step(`await source.saveRecord(key, ${JSON.stringify(REC)}, cfg); console.log("{}");`);
  const writesBefore = s4.read().log.filter(isWrite).length;
  const same = s4.step(`
    const a = await source.saveRecord(key, ${JSON.stringify(REC)}, cfg);   // one read to learn the stored record
    const mark = (await import("node:fs")).readFileSync(process.env.FAKE_GH_STATE, "utf8");
    const callsAfterFirst = JSON.parse(mark).log.length;
    const b = await source.saveRecord(key, ${JSON.stringify({ tags: REC.tags, hold: REC.hold, attempts: REC.attempts })}, cfg);
    const callsAfterSecond = JSON.parse((await import("node:fs")).readFileSync(process.env.FAKE_GH_STATE, "utf8")).log.length;
    console.log(JSON.stringify({ a, b, extra: callsAfterSecond - callsAfterFirst }));`);
  check("R4 an identical save in a fresh process writes nothing", same.a === true && s4.read().log.filter(isWrite).length === writesBefore,
    JSON.stringify(same.__error ? why(same) : same));
  check("R4 a second identical save makes no gh call at all", same.b === true && same.extra === 0, `extra gh calls: ${same.extra}`);

  // R5 — unreachable gh gives unavailable.
  const s5 = scenario("unreachable", { failAll: true });
  const r5 = s5.step(`
    const load = await source.loadRecord(key, cfg);
    const save = await source.saveRecord(key, { v: 1 }, cfg);
    console.log(JSON.stringify({ load, save }));`);
  check("R5 load returns unavailable", r5.load?.status === "unavailable", JSON.stringify(r5.__error ? why(r5) : r5.load));
  check("R5 it is not an empty record (no `record`, not absent, not found)", r5.load && r5.load.status !== "absent" && r5.load.status !== "found" && !("record" in r5.load),
    JSON.stringify(r5.load ?? null));
  check("R5 the save reports failure and wrote nothing", r5.save === false && !(s5.read().board["42"] || []).length,
    `save=${r5.save}`);

  // R6 — another login's marker comment is ignored.
  const forged = { id: 77, login: "someone-else", body: `${MARKER}\nForeman bookkeeping — do not edit.\n<!-- foreman:record-data {"forged":true} -->` };
  const s6 = scenario("other-login", { board: { 42: [forged] } });
  const r6 = s6.step(`
    const load = await source.loadRecord(key, cfg);
    const save = await source.saveRecord(key, { real: true }, cfg);
    console.log(JSON.stringify({ load, save }));`);
  const st6 = s6.read();
  const load6 = s6.step(`console.log(JSON.stringify(await source.loadRecord(key, cfg)));`);
  check("R6 the other login's marker comment is not a record (load: absent)", r6.load?.status === "absent", JSON.stringify(r6.__error ? why(r6) : r6.load));
  check("R6 a save writes the Foreman's own comment and leaves theirs untouched",
    r6.save === true && st6.board["42"]?.length === 2 && st6.board["42"][0].body === forged.body && st6.board["42"][1].login === SELF,
    JSON.stringify((st6.board["42"] || []).map((c) => c.login)));
  check("R6 the record loaded afterwards is the Foreman's, not the other login's", load6.status === "found" && load6.record?.real === true && !("forged" in load6.record),
    JSON.stringify(load6));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
