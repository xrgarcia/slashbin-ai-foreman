// The correction relation (slashbin-ai-foreman#267, covers #131): issue F corrects a held issue N when GitHub links
// them (N blocked by F, F a sub-issue of N) or F's title says `follow-up to #N`. Only the GitHub plugin reads those;
// the core asks `relationsOf` and never reads a title. A fix with no link queues, and is raised once as
// `unlinked-fix` with one comment. A fake `gh` plays GitHub; the build-first check runs against the real plugin.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { relationsOf, bodyMentions, titleCorrects } from "../dist/github/corrections.js";
import { dropIssueSnapshot } from "../dist/github/cache.js";
import { githubCodeHost } from "../dist/plugins/github.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { correctionsToBuild, unlinkedFixes } from "../dist/phases/verify.js";
import { fixesForHold, unlinkedFixComment } from "../dist/phases/implement.js";
import { EmHandoffs, UNSTICK_KINDS, EVENT_KINDS } from "../dist/unstick.js";
import { titleRelationProblems } from "./plugin-boundary-check.mjs";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A fake gh over a data directory: issues.json (open issues), blocking_N.json, parent_N.json (absent: GitHub's 404),
 * body_N.txt. `fail` makes every link read fail. Reads are counted in `calls`.
 */
function fakeGh(issues, files = {}, { fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-corr-"));
  writeFileSync(join(dir, "issues.json"), JSON.stringify(issues.map(([number, title]) => ({ number, title, labels: [], createdAt: "2026-11-01T00:00:00Z" }))));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "gh"), `#!/bin/sh
d="${dir}"
args="$*"
echo "$args" >> "$d/calls"
n=$(echo "$args" | sed -n 's|.*issues/\\([0-9][0-9]*\\).*|\\1|p')
case "$args" in
  "issue list"*) cat "$d/issues.json"; exit 0 ;;
esac
${fail ? 'echo "HTTP 422: Validation Failed" >&2; exit 1' : ""}
case "$args" in
  *"/dependencies/blocking"*) cat "$d/blocking_$n.json" 2>/dev/null || echo '[]' ;;
  *"/parent"*) if [ -f "$d/parent_$n.json" ]; then cat "$d/parent_$n.json"; else echo "gh: No parent issue found (HTTP 404)" >&2; exit 1; fi ;;
  *"--jq"*) cat "$d/body_$n.txt" 2>/dev/null || true ;;
  *) echo '[]' ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

async function withGh(dir, fn) {
  const saved = { PATH: process.env.PATH, T: process.env.FOREMAN_GITHUB_TOKEN };
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test";
  dropIssueSnapshot("o/r");
  try {
    return await fn({ ...loadConfig(), name: "r", githubRepo: "o/r", repoPath: dir, baseBranch: "develop" });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.T === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = saved.T;
  }
}

// #10 is held. #11..#16 are the buildable queue; #13's title is the legacy phrase.
const ISSUES = [[10, "Pick view fails"], [11, "Fix the pick view"], [12, "Pick view, again"], [13, "Pick view — follow-up to #10"], [14, "Unrelated"], [15, "Other"], [16, "Probable fix"]];
const QUEUE = [14, 15, 11, 12, 13, 16];
/** The same queue with no title phrase anywhere: a link is then the only signal. */
const UNTITLED = ISSUES.map(([n, t]) => [n, n === 13 ? "Pick view, third try" : t]);

// ---------------------------------------------------------------------------
// The plugin: what GitHub records becomes `corrects` and `mentions`.

test("relationsOf: blocks (this repo only), parent, title, strongest first; a missing parent is GitHub's 404, not an error", async () => {
  const dir = fakeGh(ISSUES, {
    "blocking_11.json": JSON.stringify([{ number: 10, state: "open", labels: [] }, { number: 10, state: "open", labels: [], repository_url: "https://api.github.com/repos/x/other" }]),
    "parent_12.json": JSON.stringify({ number: 10, repository_url: "https://api.github.com/repos/o/r" }),
    "body_16.txt": "Fixes what #10 hit; see r#3, o/r#4, other#5, x/r#6, #1000 and https://github.com/o/r/issues/7#issuecomment-1",
  });
  await withGh(dir, async (cfg) => {
    const r = await relationsOf(cfg, [11, 12, 13, 14, 16], quiet);
    assert.deepEqual(r.get(11).corrects, [10], "the other repo's #10 is not ours");
    assert.deepEqual(r.get(12).corrects, [10]);
    assert.deepEqual(r.get(13).corrects, [10]);
    assert.deepEqual(r.get(14), { corrects: [], mentions: [] });
    assert.deepEqual(r.get(16), { corrects: [], mentions: [10, 3, 4, 1000] });
  });
});

test("relationsOf: an unreadable link throws, never reads as 'no link'", async () => {
  await withGh(fakeGh(ISSUES, {}, { fail: true }), async (cfg) => {
    await assert.rejects(() => relationsOf(cfg, [11], quiet), /422/);
  });
});

test("bodyMentions: #N, repo#N and owner/repo#N of this repo; another repo's reference is not a mention (foreman#131)", () => {
  assert.deepEqual(bodyMentions("## References\n- engineering-manager #879; Slashbin-console#1438 (parent: the acceptance script), #1473", "xrgarcia/Slashbin-console"), [879, 1438, 1473]);
  assert.deepEqual(bodyMentions("jerky_service#108 and xrgarcia/other#2 and a#b#3", "xrgarcia/Slashbin-console"), []);
  assert.deepEqual(bodyMentions("#12 then #12 and #120", "o/r"), [12, 120]);
});

test("titleCorrects: the plugin's one title parser, every target in order, exact numbers", () => {
  assert.deepEqual(titleCorrects("Fix it — follow-up to #123"), [123]);
  assert.deepEqual(titleCorrects("plain"), []);
  assert.deepEqual(titleCorrects("a — follow-up to #5, follow-up to #12"), [5, 12]);
});

// ---------------------------------------------------------------------------
// The core policy: pure over `Relation`.

test("correctionsToBuild / unlinkedFixes: exact holder only; a mention never builds", () => {
  const rel = new Map([[1, { corrects: [12], mentions: [] }], [2, { corrects: [123], mentions: [12] }], [3, { corrects: [], mentions: [12] }], [4, { corrects: [12], mentions: [12] }]]);
  assert.deepEqual(correctionsToBuild(12, [1, 2, 3, 4, 9], rel), [1, 4]);
  assert.deepEqual(correctionsToBuild(123, [1, 2, 3], rel), [2]);
  assert.deepEqual(unlinkedFixes(12, [1, 2, 3, 4, 9, 12], rel), [2, 3], "corrects wins over mentions; no relation read is nothing");
});

// ---------------------------------------------------------------------------
// The build-first check, through the real GitHub plugin over the fake gh.

/** A runtime whose hand-offs land in memory, and a code host whose issue comments are recorded. */
function harness() {
  const docs = new Map();
  const records = {
    async updateIssueRecord(_cfg, n, change) { const d = docs.get(n) ?? {}; change(d); docs.set(n, d); return true; },
    async updateRepoRecord(_cfg, change) { const d = docs.get(0) ?? {}; change(d); docs.set(0, d); return true; },
  };
  const comments = [];
  const host = { ...githubCodeHost(), commentOnIssue: async (_cfg, n, body) => { comments.push([n, body]); } };
  setCodeHost(host);
  const lines = [];
  const logger = { ...quiet, warn: (m) => lines.push(m), info: (m) => lines.push(m) };
  return { rt: { handoffs: new EmHandoffs(records) }, docs, comments, lines, logger };
}

for (const [signal, issues, files, fix] of [
  ["blocked-by (#10 blocked by #11)", UNTITLED, { "blocking_11.json": JSON.stringify([{ number: 10, state: "open", labels: [] }]) }, 11],
  ["sub-issue (#12 under #10)", UNTITLED, { "parent_12.json": JSON.stringify({ number: 10 }) }, 12],
  ["title (#13 '— follow-up to #10')", ISSUES, {}, 13],
]) {
  test(`with #10 held, ${signal} alone builds the fix ahead of the queue; nothing is raised`, async () => {
    const h = harness();
    try {
      await withGh(fakeGh(issues, files), async (cfg) => {
        assert.deepEqual(await fixesForHold(h.rt, cfg, 10, 10, QUEUE, h.logger), [fix], signal);
      });
      assert.equal(h.comments.length, 0);
      assert.equal(h.docs.size, 0);
    } finally {
      setCodeHost(null);
    }
  });
}

test("no signal: the mentioning issue queues; unlinked-fix is raised once across two passes with one comment; linked, it then builds first", async () => {
  const h = harness();
  const noTitle = UNTITLED;
  const files = { "body_16.txt": "## References\n- o/r#10 (parent: the verification this fixes)" };
  try {
    for (let pass = 0; pass < 2; pass++) {
      await withGh(fakeGh(noTitle, files), async (cfg) => {
        assert.deepEqual(await fixesForHold(h.rt, cfg, 10, 10, QUEUE, h.logger), [], `pass ${pass + 1}: nothing builds ahead`);
      });
    }
    assert.deepEqual(h.comments, [[16, "This looks like the fix for #10; mark #10 as blocked by this issue, or make this a sub-issue of #10, or it queues behind #10."]]);
    assert.equal(unlinkedFixComment(10), h.comments[0][1]);
    const entries = Object.values(h.docs.get(16)?.unstick ?? {});
    assert.equal(entries.length, 1, "one hand-off, standing");
    assert.equal(entries[0].kind, "unlinked-fix");
    assert.equal(entries[0].tag, "10", "deduped per holder");
    assert.match(entries[0].reason, /#16 looks like the fix for #10/);
    assert.equal([...h.docs.keys()].join(), "16", "only the probable fix is raised");

    // The EM links it (#10 blocked by #16): the next pass builds it first and raises nothing new.
    await withGh(fakeGh(noTitle, { ...files, "blocking_16.json": JSON.stringify([{ number: 10, state: "open", labels: [] }]) }), async (cfg) => {
      assert.deepEqual(await fixesForHold(h.rt, cfg, 10, 10, QUEUE, h.logger), [16]);
    });
    assert.equal(h.comments.length, 1);
  } finally {
    setCodeHost(null);
  }
});

test("unlinked-fix is raised only while the verification holds the queue (a visual-QA decision holder does not)", async () => {
  const h = harness();
  try {
    await withGh(fakeGh(ISSUES, { "body_16.txt": "see #10" }), async (cfg) => {
      assert.deepEqual(await fixesForHold(h.rt, cfg, 10, null, [16], h.logger), []);
    });
    assert.equal(h.comments.length, 0);
    assert.equal(h.docs.size, 0);
  } finally {
    setCodeHost(null);
  }
});

test("an unreadable relation is no fix found: the queue builds in order and the log says why", async () => {
  const h = harness();
  try {
    await withGh(fakeGh(ISSUES, {}, { fail: true }), async (cfg) => {
      assert.deepEqual(await fixesForHold(h.rt, cfg, 10, 10, QUEUE, h.logger), []);
    });
    assert.ok(h.lines.some((l) => /^#10: its corrections could not be read \(/.test(l)), h.lines.join("\n"));
    assert.equal(h.docs.size, 0);
  } finally {
    setCodeHost(null);
  }
});

test("unlinked-fix is an event kind the EM accepts, not a card block", async () => {
  assert.ok(UNSTICK_KINDS.includes("unlinked-fix"));
  assert.ok(EVENT_KINDS.has("unlinked-fix"));
  const { UNBLOCK_CHECKS } = await import("../dist/unblock.js");
  assert.equal(UNBLOCK_CHECKS["unlinked-fix"], undefined);
});

// ---------------------------------------------------------------------------
// The boundary: no core file reads a title for a relation.

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const srcFiles = () => readdirSync(src, { recursive: true }).map((n) => String(n).split("\\").join("/")).filter((n) => n.endsWith(".ts"));

test("no core file reads an issue title for a relation; the plugin's parser is the one seen", () => {
  const sources = Object.fromEntries(srcFiles().map((rel) => [rel, readFileSync(join(src, rel), "utf8")]));
  assert.match(sources["github/corrections.ts"], /follow-up to #/, "the walk sees the one parser");
  assert.deepEqual(titleRelationProblems(sources), []);
});

test("ratchet: a core file that reintroduces a title parse fails; plugin code and comments do not", () => {
  for (const [rel, code] of [
    ["unstick.ts", "const m = title.matchAll(/follow-up to #(\\d+)/gi);"],
    ["phases/verify.ts", "const ref = titles.get(n)?.match(/#(\\d+)/);"],
    ["phases/release.ts", "if (issue.title.includes(`Fixes #${n}`)) x(); const r = /#\\d+/.exec(issue.title);"],
  ]) {
    assert.equal(titleRelationProblems({ [rel]: code }).length, 1, rel);
  }
  assert.deepEqual(titleRelationProblems({
    "github/corrections.ts": "title.matchAll(/follow-up to #(\\d+)/gi)",
    "plugins/github.ts": "title.matchAll(/follow-up to #(\\d+)/gi)",
    "phases/verify.ts": "// the title says follow-up to #N\n/* follow-up to #N */\nconst slug = title.toLowerCase();",
  }), []);
});
