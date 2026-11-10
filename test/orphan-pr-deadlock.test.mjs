// foreman#135: an open feature PR that names no issue holds the build lane. Once the Tech Lead has requested changes
// nothing revises it (revise is issue-driven), so the queued issues are blocked with the PR, its author and the
// verdict, handed to the EM as `needs-ruling`, once per head. Still under review, or linked to an issue: unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { githubCodeHost } from "../dist/plugins/github.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { addObserver, drainObservers } from "../dist/work-source.js";
import { EmHandoffs, UNSTICK_KINDS } from "../dist/unstick.js";
import { PhaseMemory } from "../dist/phase-memory.js";
import { surfaceOrphanPr, releaseOrphanBlocks, orphanPrBlockReason } from "../dist/phases/implement.js";
import { startAgentPlugins } from "./agent-plugins.mjs";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const HEAD = "5cc14685aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// A fake gh: every call is logged and answers an empty object, so a label write on the board cannot reach GitHub.
const dir = mkdtempSync(join(tmpdir(), "foreman-orphan-"));
writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$*" >> "${dir}/calls"\necho '{}'\n`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "test";
await startAgentPlugins();

const events = [];
addObserver({ id: "orphan-test", async onEvent(e) { events.push(e); } });
const cfg = { ...loadConfig(), name: "r", githubRepo: "o/r", repoPath: dir, baseBranch: "features", reviewerLogin: "tech-lead" };
const PR = { number: 19, headSha: HEAD };

function harness(standing) {
  const docs = new Map();
  const records = {
    async updateIssueRecord(_c, n, change) { const d = docs.get(n) ?? {}; change(d); docs.set(n, d); return true; },
    async updateRepoRecord(_c, change) { const d = docs.get(0) ?? {}; change(d); docs.set(0, d); return true; },
  };
  const reads = { n: 0, standing };
  setCodeHost({ ...githubCodeHost(), readPrStanding: async () => { reads.n++; if (reads.standing instanceof Error) throw reads.standing; return reads.standing; } });
  events.length = 0;
  const lines = [];
  const logger = { ...quiet, warn: (m) => lines.push(m) };
  return { rt: { handoffs: new EmHandoffs(records), memory: new PhaseMemory() }, docs, reads, lines, logger };
}
const blocked = async () => { await drainObservers(); return events.filter((e) => e.kind === "blocked"); };
const unblocked = async () => { await drainObservers(); return events.filter((e) => e.kind === "unblocked"); };

test("orphan + CHANGES_REQUESTED: every queued issue is blocked naming the PR, author and verdict, and handed to the EM as needs-ruling", async () => {
  const h = harness({ requestsChanges: true, author: "kenkellyjunior" });
  try {
    await surfaceOrphanPr(h.rt, cfg, PR, [23, 24], [23, 24], h.logger);
    const b = await blocked();
    assert.deepEqual(b.map((e) => e.item.issueNumber), [23, 24]);
    assert.ok(b.every((e) => e.stuck === "needs-ruling" && UNSTICK_KINDS.includes(e.stuck)), "an existing kind: the EM's list needs no change");
    assert.match(b[0].reason, /PR #19 \(kenkellyjunior\).*names no issue.*CHANGES_REQUESTED.*5cc1468/);
    assert.equal(b[0].reason, orphanPrBlockReason(19, "kenkellyjunior", HEAD));
    for (const n of [23, 24]) {
      const entry = Object.values(h.docs.get(n)?.unstick ?? {});
      assert.equal(entry.length, 1, `#${n}: one hand-off recorded`);
      assert.equal(entry[0].kind, "needs-ruling");
    }
  } finally { setCodeHost(null); }
});

test("once per head and issue: a repeat pass blocks nothing; a new head, or a newly queued issue, blocks again", async () => {
  const h = harness({ requestsChanges: true, author: "kenkellyjunior" });
  try {
    await surfaceOrphanPr(h.rt, cfg, PR, [23], [23], h.logger);
    await surfaceOrphanPr(h.rt, cfg, PR, [23], [], h.logger);
    assert.equal((await blocked()).length, 1);
    await surfaceOrphanPr(h.rt, cfg, PR, [23, 25], [25], h.logger);
    assert.deepEqual((await blocked()).map((e) => e.item.issueNumber), [23, 25]);
    await surfaceOrphanPr(h.rt, cfg, { number: 19, headSha: "b".repeat(40) }, [23], [], h.logger);
    assert.equal((await blocked()).length, 3, "a new head is a new verdict to surface");
  } finally { setCodeHost(null); }
});

test("orphan still under review (no CHANGES_REQUESTED): unchanged, one warning, nothing blocked or handed off", async () => {
  const h = harness({ requestsChanges: false, author: "kenkellyjunior" });
  try {
    await surfaceOrphanPr(h.rt, cfg, PR, [23], [23], h.logger);
    await drainObservers();
    assert.equal(events.length, 0);
    assert.equal(h.docs.size, 0);
    assert.equal(h.lines.length, 1);
    assert.match(h.lines[0], /names no issue and holds #23 — the Tech Lead reviews it/);
  } finally { setCodeHost(null); }
});

test("an unreadable verdict blocks nothing and is asked again next pass", async () => {
  const h = harness(new Error("TLS handshake timeout"));
  try {
    await surfaceOrphanPr(h.rt, cfg, PR, [23], [23], h.logger);
    await drainObservers();
    assert.equal(events.length, 0);
    h.reads.standing = { requestsChanges: true, author: "a" };
    await surfaceOrphanPr(h.rt, cfg, PR, [23], [], h.logger);
    assert.equal((await blocked()).length, 1);
  } finally { setCodeHost(null); }
});

test("the block lifts when the PR merges or closes, or its head moves; it stands while the same head holds", async () => {
  const h = harness({ requestsChanges: true, author: "kenkellyjunior" });
  try {
    await surfaceOrphanPr(h.rt, cfg, PR, [23], [23], h.logger);
    await releaseOrphanBlocks(h.rt, cfg, { ...PR, issueNumbers: [] }, h.logger);
    assert.equal((await unblocked()).length, 0, "same PR, same head: still held");
    await releaseOrphanBlocks(h.rt, cfg, null, h.logger);
    const un = await unblocked();
    assert.deepEqual(un.map((e) => e.item.issueNumber), [23]);
    assert.equal(Object.keys(h.docs.get(23)?.unstick ?? {}).length, 0, "the EM hand-off is cleared with it");
    await releaseOrphanBlocks(h.rt, cfg, null, h.logger);
    assert.equal((await unblocked()).length, 1, "released once");
  } finally { setCodeHost(null); }
});

test("the implement gate calls it only for a PR that names no issue, so a linked PR is untouched", () => {
  const src = readFileSync(new URL("../src/phases/implement.ts", import.meta.url), "utf8");
  assert.match(src, /if \(featurePr && featurePr\.issueNumbers\.length === 0\) \{\s*await surfaceOrphanPr\(/);
});
