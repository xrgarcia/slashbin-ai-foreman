// The branch-drift compare ran ~216 times/hr on 2026-11-14 (sync lane + promote stall check): the lane
// gate wakes on ANY webhook (~450/hr), but a drift answer depends only on two branch heads (~12 pushes/hr).
// With a branch-move gate a compare re-reads only when main/develop moved, the signal cannot tell, or
// the forced check is due.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { checkBranchDrift, configureDriftGate } from "../dist/github/branch.js";
import { ChangeGate } from "../dist/change-gate.js";

const dir = mkTmp("fake-gh-drift-");
const log = join(dir, "calls");
const behind = join(dir, "behind");
const fail = join(dir, "fail");
writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$1 $2" >> "${log}"
if [ -s "${fail}" ]; then echo "HTTP 502" >&2; exit 1; fi
printf '{"ahead":1,"behind":%s,"files":0,"paths":[]}\\n' "$(cat "${behind}")"
`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "t-test-token";
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
let moved = false;
const reset = () => { writeFileSync(log, ""); writeFileSync(behind, "0"); writeFileSync(fail, ""); moved = false; configureDriftGate(async () => moved); };
const drift = () => checkBranchDrift("o/r", "main", "develop", tmpdir(), logger);

test("unmoved branches reuse the last drift: no compare", async () => {
  reset();
  assert.equal((await drift()).developBehindMain, 0);
  for (let i = 0; i < 3; i++) await drift();
  assert.equal(calls(), 1);
});

test("a branch move re-reads and sees the new drift", async () => {
  reset();
  await drift();
  writeFileSync(behind, "2");
  moved = true;
  assert.equal((await drift()).developBehindMain, 2);
  assert.equal(calls(), 2);
});

test("a failed compare after a move drops the stale answer: the next quiet pass reads", async () => {
  reset();
  await drift();
  writeFileSync(behind, "3");
  writeFileSync(fail, "1");
  moved = true;
  assert.equal(await drift(), null);
  writeFileSync(fail, "");
  moved = false;
  assert.equal((await drift()).developBehindMain, 3);
});

test("no gate: every check reads", async () => {
  reset();
  configureDriftGate(null);
  await drift(); await drift();
  assert.equal(calls(), 2);
});

function gate(reports) {
  let clock = 0;
  const signal = { changedSince: async () => reports.shift() ?? { changed: [], cursor: "c", moved: [] } };
  const g = new ChangeGate({ signal: () => signal, repos: () => ["o/r"], forceMs: () => 1_000, logger, now: () => clock, pollTtlMs: 0 });
  return { g, tick: (ms) => { clock += ms; } };
}
const B = ["main", "develop"];

test("branchesDue: traffic on other branches does not wake it; a push to a watched branch does", async () => {
  const { g } = gate([
    { changed: "all", cursor: "1" },
    { changed: ["o/r"], cursor: "2", moved: [{ repo: "o/r", branch: "foreman/9-x" }] },
    { changed: ["o/r"], cursor: "3", moved: [{ repo: "o/r", branch: "develop" }] },
  ]);
  assert.equal(await g.branchesDue("drift", "o/r", B), true);   // first
  assert.equal(await g.branchesDue("drift", "o/r", B), false);  // a feature-branch push
  assert.equal(await g.branchesDue("drift", "o/r", B), true);   // develop moved
  assert.equal(await g.branchesDue("drift", "o/r", B), false);
});

test("branchesDue: a signal without `moved` counts every change as a move; the forced check still runs", async () => {
  const { g, tick } = gate([
    { changed: "all", cursor: "1" },
    { changed: ["o/r"], cursor: "2" },
  ]);
  assert.equal(await g.branchesDue("drift", "o/r", B), true);
  assert.equal(await g.branchesDue("drift", "o/r", B), true);   // no moved field: fail toward reading
  assert.equal(await g.branchesDue("drift", "o/r", B), false);
  tick(1_000);
  assert.equal(await g.branchesDue("drift", "o/r", B), true);   // forced
});

test("branchesDue: branch `*` (a repo the signal cannot see) moves every branch", async () => {
  const { g } = gate([
    { changed: "all", cursor: "1" },
    { changed: ["o/r"], cursor: "2", moved: [{ repo: "o/r", branch: "*" }] },
  ]);
  assert.equal(await g.branchesDue("drift", "o/r", B), true);
  assert.equal(await g.branchesDue("drift", "o/r", B), true);
  assert.equal(await g.branchesDue("drift", "o/r", B), false);
});

test("branchesDue: a failing signal makes it due", async () => {
  let n = 0;
  const signal = { changedSince: async () => { if (n++ > 0) throw new Error("down"); return { changed: "all", cursor: "1" }; } };
  const g = new ChangeGate({ signal: () => signal, repos: () => ["o/r"], forceMs: () => 1e9, logger, now: () => 0, pollTtlMs: 0 });
  assert.equal(await g.branchesDue("drift", "o/r", B), true);
  assert.equal(await g.branchesDue("drift", "o/r", B), true);
});
