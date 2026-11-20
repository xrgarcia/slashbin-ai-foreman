// CheckDefect (slashbin-ai-foreman#366): one check deferring two different PRs becomes one raised `check-defect`.
// Dark behind FOREMAN_CHECK_DEFECT. A fake gh plays GitHub; the EM is never called (the outbox is the only raise).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { githubCodeHost } from "../dist/plugins/github.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { dropIssueSnapshot } from "../dist/github/cache.js";
import { dropCanonicalRepo } from "../dist/github/repo-identity.js";
import { bodyNamesCheck } from "../dist/github/check-defect.js";
import { recordCheckFailure, clearCheckPass, syncCheckDefects, defectReason, defectDedupeKey, releasedByDefect, releasedIssues } from "../dist/phases/check-defect.js";
import { devVerifyHolding } from "../dist/phases/verify.js";
import { EmHandoffs, HandoffNotSaved, UNSTICK_KINDS, EVENT_KINDS } from "../dist/unstick.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const AT = "2026-11-20T10:00:00.000Z";

function fakeGh(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-cd-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "gh"), `#!/bin/sh
d="${dir}"
args="$*"
n=$(echo "$args" | sed -n 's#.*/issues/\\([0-9][0-9]*\\).*#\\1#p')
case "$args" in
  *"/dependencies/blocked_by"*) cat "$d/blocked_by_$n.json" 2>/dev/null || echo "[]" ;;
  *"--jq .full_name"*) echo o/r ;;
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
  dropCanonicalRepo();
  try {
    return await fn({ ...loadConfig(), name: "r", githubRepo: "o/r", repoPath: dir, baseBranch: "develop" });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.T === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = saved.T;
  }
}

function harness({ failRaise = false } = {}) {
  const docs = new Map();
  const records = {
    async updateIssueRecord(_c, n, change) { if (failRaise) return false; const d = docs.get(n) ?? {}; change(d); docs.set(n, d); return true; },
    async updateRepoRecord(_c, change) { const d = docs.get(0) ?? {}; change(d); docs.set(0, d); return true; },
    async loadRepoRecord() { return docs.get(0) ?? {}; },
  };
  setCodeHost(githubCodeHost());
  const rt = { handoffs: new EmHandoffs(records), records };
  const raised = () => [...docs].filter(([n]) => n > 0).flatMap(([n, d]) => Object.values(d.unstick ?? {}).map((e) => ({ n, ...e })));
  return { rt, docs, raised, table: () => docs.get(0)?.checkDefects ?? {} };
}

const fail = (rt, cfg, issue, pr, check = "codex-unavailable") => recordCheckFailure(rt, cfg, { repo: "o/r", check, issue, pr, at: AT });

async function flag(on, fn) {
  const was = process.env.FOREMAN_CHECK_DEFECT;
  if (on) process.env.FOREMAN_CHECK_DEFECT = "1"; else delete process.env.FOREMAN_CHECK_DEFECT;
  try { return await fn(); } finally { setCodeHost(null); if (was === undefined) delete process.env.FOREMAN_CHECK_DEFECT; else process.env.FOREMAN_CHECK_DEFECT = was; }
}

test("the kind is the EM's, and an event kind that is not a card block", () => {
  assert.ok(UNSTICK_KINDS.includes("check-defect"));
  assert.ok(EVENT_KINDS.has("check-defect"));
});

test("two different PRs failing the same check raise exactly one check-defect, with the seam's reason", () => flag(true, async () => {
  const h = harness();
  await withGh(fakeGh(), async (cfg) => {
    const a = await fail(h.rt, cfg, 12, 90);
    assert.deepEqual([a.defect.state, a.filedNow], ["suspected", false]);
    assert.equal(h.raised().length, 0, "one PR is that PR's problem");
    const b = await fail(h.rt, cfg, 10, 91);
    assert.equal(b.filedNow, true);
    assert.equal(b.defect.state, "filed");
    assert.equal(b.defect.defect, null, "the EM files it later");
    const rows = h.raised();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].n, 10, "subject: the lowest affected issue");
    assert.equal(rows[0].kind, "check-defect");
    assert.deepEqual(JSON.parse(rows[0].reason), {
      checkId: "o/r:codex-unavailable", canonicalRepo: "o/r", check: "codex-unavailable",
      affected: [{ repo: "o/r", issue: 10, pr: 91 }, { repo: "o/r", issue: 12, pr: 90 }],
      firstFailure: { issue: 10, pr: 91 },
    });
    assert.doesNotMatch(rows[0].reason, /20\d\d-\d\d-\d\dT/, "no timestamp: it would change the question");
  });
}));

test("a repeat on the same PR raises nothing", () => flag(true, async () => {
  const h = harness();
  await withGh(fakeGh(), async (cfg) => {
    await fail(h.rt, cfg, 12, 90);
    const again = await fail(h.rt, cfg, 12, 90);
    assert.deepEqual([again.defect.state, again.filedNow], ["suspected", false]);
    assert.equal(h.raised().length, 0);
    assert.equal(h.table()["o/r:codex-unavailable"].affected.length, 1);
  });
}));

test("a different check on a second PR is a different record: nothing raised", () => flag(true, async () => {
  const h = harness();
  await withGh(fakeGh(), async (cfg) => {
    await fail(h.rt, cfg, 12, 90, "codex-unavailable");
    await fail(h.rt, cfg, 13, 91, "registry-unavailable");
    assert.equal(h.raised().length, 0);
  });
}));

test("a filed check: a repeat raises nothing more, a newly affected issue changes the key and raises again", () => flag(true, async () => {
  const h = harness();
  await withGh(fakeGh(), async (cfg) => {
    await fail(h.rt, cfg, 12, 90);
    await fail(h.rt, cfg, 10, 91);
    const repeat = await fail(h.rt, cfg, 10, 91);
    assert.equal(repeat.filedNow, false);
    assert.equal(h.raised().length, 1);
    const third = await fail(h.rt, cfg, 14, 92);
    assert.equal(third.filedNow, false, "already filed: no second defect");
    assert.equal(third.defect.state, "filed");
    const rows = h.raised();
    assert.equal(rows.length, 2, "a new affected list is a new question");
    assert.notEqual(rows[0].tag, rows[1].tag);
    assert.deepEqual(JSON.parse(rows[1].reason).affected.map((a) => a.issue), [10, 12, 14]);
  });
}));

test("a throw from the outbox leaves it suspected; the next failure retries and files", () => flag(true, async () => {
  const h = harness({ failRaise: true });
  await withGh(fakeGh(), async (cfg) => {
    await fail(h.rt, cfg, 12, 90);
    const r = await fail(h.rt, cfg, 10, 91);
    assert.deepEqual([r.defect.state, r.filedNow], ["suspected", false]);
    assert.equal(h.table()["o/r:codex-unavailable"].state, "suspected");
    // The outbox write works again.
    h.rt.records.updateIssueRecord = async (_c, n, change) => { const d = h.docs.get(n) ?? {}; change(d); h.docs.set(n, d); return true; };
    const again = await fail(h.rt, cfg, 10, 91);
    assert.deepEqual([again.defect.state, again.filedNow], ["filed", true]);
    assert.equal(h.raised().length, 1);
  });
  assert.ok(new HandoffNotSaved("check-defect", "o/r") instanceof Error);
}));

test("flag unset: no record written, nothing raised", () => flag(false, async () => {
  const h = harness();
  await withGh(fakeGh(), async (cfg) => {
    assert.deepEqual(await fail(h.rt, cfg, 12, 90), { defect: null, filedNow: false });
    assert.deepEqual(await fail(h.rt, cfg, 10, 91), { defect: null, filedNow: false });
    assert.equal(await clearCheckPass(h.rt, cfg, 90), false);
    assert.deepEqual(await syncCheckDefects(h.rt, cfg, quiet), {});
  });
  assert.equal(h.docs.size, 0);
}));

test("a passing verdict removes its PR from a suspected record; an emptied record is deleted; a filed one is kept", () => flag(true, async () => {
  const h = harness();
  await withGh(fakeGh(), async (cfg) => {
    await fail(h.rt, cfg, 12, 90);
    assert.equal(await clearCheckPass(h.rt, cfg, 90), true);
    assert.deepEqual(h.table(), {});
    await fail(h.rt, cfg, 12, 90);
    await fail(h.rt, cfg, 10, 91);
    await clearCheckPass(h.rt, cfg, 90);
    assert.equal(h.table()["o/r:codex-unavailable"].affected.length, 2, "filed: affected stays");
  });
}));

test("devVerifyHolding skips an issue a filed check lists and is held on; every other issue still holds", () => {
  const filed = { "o/r:codex-unavailable": { checkId: "o/r:codex-unavailable", check: "codex-unavailable", state: "filed", affected: [{ repo: "o/r", issue: 10, pr: 91 }, { repo: "o/r", issue: 12, pr: 90 }] } };
  const tooling = (reason) => ({ prNumber: 90, reason, firstHeldAt: AT });
  const held = {};
  assert.equal(devVerifyHolding([10, 12], held, 3, { 10: tooling("codex-unavailable"), 12: tooling("codex-unavailable") }), 10, "no defect: holds");
  assert.equal(devVerifyHolding([10, 12], held, 3, { 10: tooling("codex-unavailable"), 12: tooling("codex-unavailable") }, filed), null, "listed issues released");
  assert.equal(devVerifyHolding([10, 15], held, 3, { 10: tooling("codex-unavailable"), 15: tooling("codex-unavailable") }, filed), 15, "an unlisted issue still holds");
  assert.equal(devVerifyHolding([10], held, 3, { 10: tooling("registry-unavailable") }, filed), 10, "a different hold on a listed issue stands");
  assert.equal(devVerifyHolding([10], { 10: { attempts: 1, prNumber: 90, reason: "x", heldAt: AT } }, 3, {}, filed), 10, "a defer is never a pass: no tooling row, still holds");
  assert.equal(releasedByDefect(releasedIssues({ k: { ...filed["o/r:codex-unavailable"], state: "closed" } }), 10, "codex-unavailable"), false);
  assert.equal(devVerifyHolding([10], { 10: { attempts: 1, prNumber: 90, reason: "x", heldAt: AT } }, 3, { 10: tooling("codex-unavailable") }, filed), 10, "a charged verification hold stands over the defect");
});

test("the defect is found by its checkId body line; closing sets closedAt; unreadable leaves it as it was", () => flag(true, async () => {
  const h = harness();
  const files = {
    "blocked_by_10.json": JSON.stringify([{ number: 50, state: "open", labels: [], repository_url: "https://api.github.com/repos/o/r" }, { number: 51, state: "open", labels: [], repository_url: "https://api.github.com/repos/o/r" }]),
    "body_50.txt": "unrelated",
    "body_51.txt": "## Defect\ncheckId: o/r:codex-unavailable\n",
  };
  const dir = fakeGh(files);
  await withGh(dir, async (cfg) => {
    await fail(h.rt, cfg, 12, 90);
    await fail(h.rt, cfg, 10, 91);
    let t = await syncCheckDefects(h.rt, cfg, quiet, "2026-11-20T11:00:00.000Z");
    let d = t["o/r:codex-unavailable"];
    assert.deepEqual([d.state, d.defect, d.closedAt], ["filed", { repo: "o/r", issue: 51 }, null]);
    writeFileSync(join(dir, "blocked_by_10.json"), JSON.stringify([{ number: 51, state: "closed", labels: [], repository_url: "https://api.github.com/repos/o/r" }]));
    t = await syncCheckDefects(h.rt, cfg, quiet, "2026-11-20T12:00:00.000Z");
    d = t["o/r:codex-unavailable"];
    assert.deepEqual([d.state, d.closedAt], ["closed", "2026-11-20T12:00:00.000Z"]);
    assert.equal(releasedByDefect(releasedIssues(t), 10, "codex-unavailable"), false, "closed: the issue is re-asked by the verify pass");
  });
}));

test("bodyNamesCheck is a whole-token match", () => {
  assert.equal(bodyNamesCheck("x\n- checkId: o/r:a\n", "o/r:a"), true);
  assert.equal(bodyNamesCheck("checkId: o/r:a-b", "o/r:a"), false);
  assert.equal(bodyNamesCheck("", "o/r:a"), false);
});

test("reason and key are stable under affected order", () => {
  const d = { checkId: "o/r:a", canonicalRepo: "o/r", check: "a", affected: [{ repo: "o/r", issue: 2, pr: 8 }, { repo: "o/r", issue: 1, pr: 7 }] };
  assert.equal(defectReason(d), defectReason({ ...d, affected: [...d.affected].reverse() }));
  assert.equal(defectDedupeKey(d.checkId, d.affected), defectDedupeKey(d.checkId, [...d.affected].reverse()));
});

test("a closed defect ends its generation's standing question; a new affected issue whose raise was not saved is retried", () => flag(true, async () => {
  const h = harness();
  const files = {
    "blocked_by_10.json": JSON.stringify([{ number: 51, state: "closed", labels: [], repository_url: "https://api.github.com/repos/o/r" }]),
    "body_51.txt": "checkId: o/r:codex-unavailable\n",
  };
  await withGh(fakeGh(files), async (cfg) => {
    await fail(h.rt, cfg, 12, 90);
    await fail(h.rt, cfg, 10, 91);
    assert.equal(h.raised().length, 1);
    const t = await syncCheckDefects(h.rt, cfg, quiet, "2026-11-20T12:00:00.000Z");
    assert.equal(t["o/r:codex-unavailable"].state, "closed");
    assert.equal(h.raised().length, 0, "no stale question left to deliver");
  });
}));

test("a filed check whose extended-list raise is not saved goes back to suspected, then files on the next failure", () => flag(true, async () => {
  const h = harness();
  await withGh(fakeGh(), async (cfg) => {
    await fail(h.rt, cfg, 12, 90);
    await fail(h.rt, cfg, 10, 91);
    const good = h.rt.records.updateIssueRecord;
    h.rt.records.updateIssueRecord = async () => false;
    const r = await fail(h.rt, cfg, 14, 92);
    assert.equal(r.defect.state, "suspected");
    h.rt.records.updateIssueRecord = good;
    const again = await fail(h.rt, cfg, 14, 92);
    assert.equal(again.filedNow, true);
    assert.equal(h.raised().length, 2);
  });
}));
