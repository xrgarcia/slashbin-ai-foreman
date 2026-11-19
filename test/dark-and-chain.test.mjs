// Dark issues and the corrective-chain breaker (slashbin-ai-foreman#353). Origin: a service repo's feature,
// whose nine correctives held its release out of production. A fake `gh` plays GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { darkFlag, darkIssues } from "../dist/github/dark-flag.js";
import { correctivesOf } from "../dist/github/corrections.js";
import { dropIssueSnapshot } from "../dist/github/cache.js";
import { dropCanonicalRepo } from "../dist/github/repo-identity.js";
import { githubCodeHost } from "../dist/plugins/github.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { chainBroken, chainReason, correctiveChainHold, CORRECTIVE_CHAIN_LIMIT } from "../dist/phases/corrective-chain.js";
import { EmHandoffs, UNSTICK_KINDS, EVENT_KINDS } from "../dist/unstick.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// darkFlag: pure.

test("darkFlag: the Pre-Flight's `Dark flag: NAME`, in its plain, bold, list and backtick forms", () => {
  for (const line of [
    "Dark flag: MCS_GIT_MIRROR_ENABLED",
    "- **Dark flag:** `MCS_GIT_MIRROR_ENABLED`",
    "* **Dark flag**: MCS_GIT_MIRROR_ENABLED — off unless set",
    "- Dark flag: `MCS_GIT_MIRROR_ENABLED` (off unless set).",
  ]) {
    assert.equal(darkFlag(`## Problem\nx\n\n## Pre-Flight\n**Strategic read:** y\n${line}\n\n## Acceptance\nz`), "MCS_GIT_MIRROR_ENABLED", line);
  }
});

test("darkFlag: none, n/a, outside the Pre-Flight, or inside a fence names no flag", () => {
  assert.equal(darkFlag("## Pre-Flight\n- **Dark flag:** none"), null);
  assert.equal(darkFlag("## Pre-Flight\n- Dark flag: n/a"), null);
  assert.equal(darkFlag("## Fix\nDark flag: X_ENABLED\n## Pre-Flight\n- Lane: foreman"), null);
  assert.equal(darkFlag("## Pre-Flight\n```\nDark flag: X_ENABLED\n```\n"), null);
  assert.equal(darkFlag(""), null);
  assert.equal(darkFlag("## Pre-Flight\n### Notes\nDark flag: X_ENABLED"), "X_ENABLED", "a sub-heading stays inside the Pre-Flight");
});

// ---------------------------------------------------------------------------
// The plugin over a fake gh: bodies, blocked_by and a PR's merge time.

/** A fake gh: body_N.txt, blocked_by_N.json, merged_N.txt (a PR's merged_at). `failBlockers` fails the blocked_by read. */
function fakeGh(files = {}, { failBlockers = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-dark-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "gh"), `#!/bin/sh
d="${dir}"
args="$*"
echo "$args" >> "$d/calls"
n=$(echo "$args" | sed -n 's#.*/\\(issues\\|pulls\\)/\\([0-9][0-9]*\\).*#\\2#p')
case "$args" in
  *"/dependencies/blocked_by"*) ${failBlockers ? 'echo "HTTP 502" >&2; exit 1' : 'cat "$d/blocked_by_$n.json" 2>/dev/null || echo "[]"'} ;;
  *"--jq .full_name"*) echo o/r ;;
  *"/pulls/"*) cat "$d/merged_$n.txt" 2>/dev/null || true ;;
  *"--jq"*) if [ -f "$d/body_$n.txt" ]; then cat "$d/body_$n.txt"; else echo "HTTP 404" >&2; exit 1; fi ;;
  *) echo '[]' ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

async function withGh(dir, fn, repoPath = dir) {
  const saved = { PATH: process.env.PATH, T: process.env.FOREMAN_GITHUB_TOKEN };
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test";
  dropIssueSnapshot("o/r");
  dropCanonicalRepo();
  try {
    return await fn({ ...loadConfig(), name: "r", githubRepo: "o/r", repoPath, baseBranch: "develop" });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.T === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = saved.T;
  }
}

test("darkIssues: only issues whose Pre-Flight names a flag; an unreadable body is not dark", async () => {
  const lines = [];
  const logger = { ...quiet, warn: (m) => lines.push(m) };
  await withGh(fakeGh({ "body_7.txt": "## Pre-Flight\n- **Dark flag:** `X_ENABLED`", "body_8.txt": "## Pre-Flight\n- Lane: foreman" }), async (cfg) => {
    const dark = await darkIssues(cfg, [7, 8, 9], logger);
    assert.deepEqual([...dark], [[7, "X_ENABLED"]]);
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /#9.*not treated as dark/);
});

test("darkIssues with a shipped head: dark only once that code names the flag; an unreadable tree is not dark", async () => {
  const repo = mkdtempSync(join(tmpdir(), "foreman-dark-git-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  g("init", "-q", "-b", "develop");
  writeFileSync(join(repo, "flags.ts"), "export const on = process.env.X_ENABLED === '1';\n");
  g("add", ".");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "flag");
  g("remote", "add", "origin", repo);
  const files = { "body_7.txt": "## Pre-Flight\n- Dark flag: X_ENABLED", "body_8.txt": "## Pre-Flight\n- Dark flag: Y_ENABLED" };
  await withGh(fakeGh(files), async (cfg) => {
    assert.deepEqual([...(await darkIssues(cfg, [7, 8], quiet, "develop"))], [[7, "X_ENABLED"]], "Y_ENABLED is not in the code yet");
    assert.deepEqual([...(await darkIssues(cfg, [7], quiet, "no-such-branch"))], [], "an unreadable head is not dark");
  }, repo);
});

// #10's PR #90 merged at 2026-11-18T01:00Z. #20 is a prerequisite filed before; #21..#23 are correctives filed after;
// #30 is another repo's issue filed after.
const MERGED = "2026-11-18T01:00:00Z";
const blocker = (number, created_at, repo) => ({ number, state: "open", created_at, ...(repo ? { repository_url: `https://api.github.com/repos/${repo}` } : {}) });
const chainFiles = (correctives) => ({
  "merged_90.txt": MERGED,
  "blocked_by_10.json": JSON.stringify([
    blocker(20, "2026-11-17T22:00:00Z"),
    ...correctives.map((n, i) => blocker(n, `2026-11-18T0${2 + i}:00:00Z`)),
    blocker(30, "2026-11-18T05:00:00Z", "x/other"),
  ]),
});

test("correctivesOf: same-repo blockers filed after the PR merged; prerequisites and other repos are not correctives", async () => {
  await withGh(fakeGh(chainFiles([23, 21, 22])), async (cfg) => {
    assert.deepEqual(await correctivesOf(cfg, 10, 90), [21, 22, 23]);
  });
});

test("correctivesOf: a PR with no merge time throws, never reads as 'no correctives'", async () => {
  await withGh(fakeGh({ "blocked_by_10.json": "[]" }), async (cfg) => {
    await assert.rejects(() => correctivesOf(cfg, 10, 91), /no merge time/);
  });
});

// ---------------------------------------------------------------------------
// The breaker: pure policy, then through the real plugin into the EM queue.

test("chainBroken / chainReason: the third corrective breaks the chain; the reason asks for a redesign or a switch-off", () => {
  assert.equal(CORRECTIVE_CHAIN_LIMIT, 3);
  assert.equal(chainBroken([1, 2]), false);
  assert.equal(chainBroken([1, 2, 3]), true);
  const r = chainReason(617, [626, 627, 629]);
  assert.match(r, /#617's dev verification has 3 correctives \(#626, #627, #629\)/);
  assert.match(r, /redesign or switch off/);
  assert.match(r, /builds no further corrective for #617/);
});

function harness() {
  const docs = new Map();
  const records = {
    async updateIssueRecord(_cfg, n, change) { const d = docs.get(n) ?? {}; change(d); docs.set(n, d); return true; },
    async updateRepoRecord(_cfg, change) { const d = docs.get(0) ?? {}; change(d); docs.set(0, d); return true; },
  };
  setCodeHost(githubCodeHost());
  const lines = [];
  const logger = { ...quiet, warn: (m) => lines.push(m), info: (m) => lines.push(m) };
  return { rt: { handoffs: new EmHandoffs(records) }, docs, lines, logger };
}

const HOLD = { prNumber: 90, attempts: 1 };

test("a third corrective on a held dev verification raises one corrective-chain row, across two passes, and stops the build", async () => {
  const h = harness();
  try {
    await withGh(fakeGh(chainFiles([21, 22, 23])), async (cfg) => {
      assert.equal(await correctiveChainHold(h.rt, cfg, 10, HOLD, h.logger), "stopped");
      assert.equal(await correctiveChainHold(h.rt, cfg, 10, HOLD, h.logger), "stopped", "still stopped on the next pass");
    });
    const entries = [...h.docs.values()].flatMap((d) => Object.values(d.unstick ?? {}));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "corrective-chain");
    assert.match(entries[0].reason, /#21, #22, #23.*redesign or switch off/);
    assert.equal(h.lines.filter((l) => /building no further corrective/.test(l)).length, 1, "warned once, when the row was fresh");
  } finally {
    setCodeHost(null);
  }
});

test("two correctives, no hold record, or an unreadable chain: the build goes on and nothing is raised", async () => {
  const h = harness();
  try {
    await withGh(fakeGh(chainFiles([21, 22])), async (cfg) => {
      assert.equal(await correctiveChainHold(h.rt, cfg, 10, HOLD, h.logger), "build");
      assert.equal(await correctiveChainHold(h.rt, cfg, 10, undefined, h.logger), "build");
    });
    await withGh(fakeGh(chainFiles([21, 22, 23]), { failBlockers: true }), async (cfg) => {
      assert.equal(await correctiveChainHold(h.rt, cfg, 10, HOLD, h.logger), "build");
    });
    assert.equal(h.docs.size, 0);
    assert.ok(h.lines.some((l) => /could not be counted/.test(l)));
  } finally {
    setCodeHost(null);
  }
});

test("switched off: once the EM names a Dark flag in its Pre-Flight, the broken chain releases the holder and asks nothing", async () => {
  const h = harness();
  try {
    await withGh(fakeGh({ ...chainFiles([21, 22, 23]), "body_10.txt": "## Pre-Flight\n- Dark flag: `X_ENABLED`" }), async (cfg) => {
      assert.equal(await correctiveChainHold(h.rt, cfg, 10, HOLD, h.logger), "released");
    });
    assert.equal(h.docs.size, 0, "no EM row once it is switched off");
    assert.ok(h.lines.some((l) => /switched off .*no longer holds the repo/.test(l)));
  } finally {
    setCodeHost(null);
  }
});

test("corrective-chain is an event kind the EM accepts, not a card block", async () => {
  assert.ok(UNSTICK_KINDS.includes("corrective-chain"));
  assert.ok(EVENT_KINDS.has("corrective-chain"));
  const { UNBLOCK_CHECKS } = await import("../dist/unblock.js");
  assert.equal(UNBLOCK_CHECKS["corrective-chain"], undefined);
});
