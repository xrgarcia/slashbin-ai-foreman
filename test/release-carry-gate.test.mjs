// Release carry lists every carried merge each pass: 2026-11-14 that was ~360 gh calls/hr. With a change
// gate, a quiet repo reuses its last complete listing; a change (a PR edit is a webhook) re-reads (#90).
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { listCarriedMerges, configureCarryGate } from "../dist/github/release-carry.js";

const dir = mkTmp("fake-gh-carry-");
const log = join(dir, "calls");
const body = join(dir, "body");
const fail = join(dir, "fail");
const cmpFail = join(dir, "cmpfail");
writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$1 $2 $3" >> "${log}"
case "$1 $2 $3" in
  "api repos/o/r/compare"*) if [ -s "${cmpFail}" ]; then echo "HTTP 422" >&2; exit 1; fi; printf '%s\\n' '{"sha":"a1","headline":"Merge pull request #5 from o/x"}' '{"sha":"a2","headline":"fix (#6)"}' ;;
  "pr view 5") if [ -s "${fail}" ]; then echo "HTTP 502" >&2; exit 1; fi; printf '{"state":"MERGED","title":"x","body":"%s","headRefName":"x","commits":[]}\\n' "$(cat "${body}")" ;;
  "pr view 6") echo "GraphQL: Could not resolve to a PullRequest with the number of 6." >&2; exit 1 ;;
esac
`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "t-test-token";
const cfg = { githubRepo: "o/r", repoPath: tmpdir(), productionBranch: "main", baseBranch: "develop", github: { dependencyBranchPrefixes: [] } };
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
let changed = false;
const reset = () => { writeFileSync(log, ""); writeFileSync(body, "Closes #40"); writeFileSync(fail, ""); writeFileSync(cmpFail, ""); changed = false; configureCarryGate(async () => changed); };
const issues = async (u) => (await listCarriedMerges(cfg, logger, u)).map((m) => [m.pr, m.issues]);

test("a quiet repo reuses its listing: no compare, no PR reads", async () => {
  reset();
  assert.deepEqual(await issues(), [[5, [40]]]);
  const first = calls().length;
  for (let i = 0; i < 3; i++) assert.deepEqual(await issues(), [[5, [40]]]);
  assert.equal(calls().length, first, `quiet passes made ${calls().length - first} gh calls`);
});

test("a change re-reads, so a corrected PR body is seen on the next pass (#90)", async () => {
  reset();
  await issues();
  writeFileSync(body, "Closes #40 Closes #41");
  changed = true;
  assert.deepEqual(await issues(), [[5, [40, 41]]]);
});

test("an incomplete listing is never reused", async () => {
  reset();
  writeFileSync(fail, "1");
  assert.deepEqual(await issues(), []);
  writeFileSync(fail, "");
  assert.deepEqual(await issues(), [[5, [40]]], "the failed read is retried though the repo was quiet");
});

test("a caller collecting unresolved reads now and does not disturb the reuse", async () => {
  reset();
  await issues();
  const before = calls().length;
  const unresolved = [];
  await issues(unresolved);
  assert.ok(calls().length > before, "the unresolved caller reads");
  assert.deepEqual(unresolved, []);
  const mid = calls().length;
  await issues();
  assert.equal(calls().length, mid, "the plain listing is still reused");
});

test("no gate configured: every call reads, as before", async () => {
  reset();
  configureCarryGate(null);
  await issues();
  const one = calls().length;
  await issues();
  assert.equal(calls().length, one * 2);
});

test("a failed compare after a change drops the stale listing, so the next quiet pass reads", async () => {
  reset();
  await issues();
  writeFileSync(body, "Closes #40 Closes #42");
  changed = true;
  writeFileSync(cmpFail, "1");
  assert.equal(await listCarriedMerges(cfg, logger), null);
  writeFileSync(cmpFail, "");
  changed = false;
  assert.deepEqual(await issues(), [[5, [40, 42]]], "the change the failed read consumed is not lost");
});
