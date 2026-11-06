// foreman slice 2 of the non-blocking GitHub work: every read behind the CodeHost
// goes through the async path. These pin the converted functions whose behavior
// could have changed (ordering, laziness, the event loop staying free).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { unsignedIssues } from "../dist/github/release-signoff.js";
import { unmetReadiness, parseReadiness } from "../dist/github/readiness.js";
import { featurePrUrlFallback } from "../dist/github/core-reads.js";
import { loadConfig } from "../dist/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const labels = { readyForProd: "ready for prod release", releasePending: "release pending", prodVerifyHeld: "prod verification held", readyToClose: "ready to close" };
const issue = (number, names = []) => ({ number, title: `#${number}`, state: "OPEN", updatedAt: "", labels: names.map((name) => ({ name })) });
const tick = () => new Promise((r) => setImmediate(r));

test("unsignedIssues: an unlabelled listed issue is unsigned; the Foreman-signed predicate is asked in order, only for labelled issues", async () => {
  const asked = [];
  const open = [issue(9), issue(7, ["release pending"]), issue(5, ["ready for prod release"]), issue(3), issue(1, ["release pending"])];
  const out = await unsignedIssues(open, new Set([1, 3, 5, 7, 9]), labels, async (n) => {
    asked.push(n);
    await tick(); // a real read yields; the loop must still be sequential
    return n === 7;
  });
  assert.deepEqual(out, [3, 7, 9]);
  assert.deepEqual(asked, [7, 5, 1], "asked in list order, one at a time, never for an unlabelled issue");
});

test("unsignedIssues: an issue the release does not list is never read", async () => {
  let asked = 0;
  const out = await unsignedIssues([issue(2, ["release pending"])], new Set(), labels, () => { asked++; return true; });
  assert.deepEqual(out, []);
  assert.equal(asked, 0);
});

test("unmetReadiness reads through an async reader without blocking the event loop", async () => {
  const parsed = parseReadiness(["## Pre-Flight", "```readiness", "file_at_ref: o/m dir/a.md release/1", "```", "", "## Acceptance", "- **Script:** `scripts/x/x-acceptance.mjs`"].join("\n"));
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  const unmet = await unmetReadiness(parsed, async () => { await new Promise((r) => setTimeout(r, 60)); return "abc"; });
  clearInterval(timer);
  assert.deepEqual(unmet, []);
  assert.ok(ticks >= 5, `the loop kept turning (${ticks} ticks)`);
});

test("featurePrUrlFallback is async: a slow gh does not freeze the loop, and the Foreman's PR is found", async () => {
  const bin = mkdtempSync(join(tmpdir(), "foreman-fakegh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nsleep 0.3\necho '[{"url":"https://x/pull/4","headRefName":"foreman/4-thing"},{"url":"https://x/pull/5","headRefName":"ray/fix"}]'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const cfg = { ...loadConfig(), name: "r", githubRepo: "o/r", repoPath: bin, baseBranch: "develop" };
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    const url = await featurePrUrlFallback(cfg, []);
    clearInterval(timer);
    assert.equal(url, "https://x/pull/4");
    assert.ok(ticks >= 5, `the loop kept turning while gh ran (${ticks} ticks)`);
  } finally {
    process.env.PATH = saved;
  }
});

test("featurePrUrlFallback: a failing gh answers nothing", async () => {
  const bin = mkdtempSync(join(tmpdir(), "foreman-fakegh-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const cfg = { ...loadConfig(), name: "r", githubRepo: "o/r", repoPath: bin, baseBranch: "develop" };
    assert.equal(await featurePrUrlFallback(cfg, []), undefined);
  } finally {
    process.env.PATH = saved;
  }
});

test("the GitHub layer holds no synchronous process call: no execFileSync, no sleepSync", () => {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(join(root, "src/github"));
  files.push(join(root, "src/github-work-source.ts"));
  for (const f of files) {
    const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, /execFileSync|spawnSync|sleepSync|Atomics\.wait/, f);
  }
});
