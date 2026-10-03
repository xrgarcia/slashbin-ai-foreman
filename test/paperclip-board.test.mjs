// The board mapping every Paperclip writer shares: lifecycle labels → stage,
// stage → holder/status/label, the live-session lease, one stage label per card.
import test from "node:test";
import assert from "node:assert/strict";
import { issueStage, stageTarget, liveRows, withStage, ensureStageLabels } from "../dist/paperclip/board.js";

const L = { prUnderReview: "pr under review", prPendingActions: "pr pending actions", prApproved: "pr approved",
  readyForProd: "ready for prod release", readyToClose: "ready to close" };

test("issueStage: the latest lifecycle label wins; an open release PR is awaiting release", () => {
  assert.equal(issueStage(["approved"], false, L, "approved"), "approved");
  assert.equal(issueStage(["approved", "pr under review"], false, L, "approved"), "inReview");
  assert.equal(issueStage(["pr pending actions"], false, L, "approved"), "changesRequested");
  assert.equal(issueStage(["pr approved", "pr under review"], false, L, "approved"), "pendingVerification");
  assert.equal(issueStage(["pr approved"], true, L, "approved"), "awaitingRelease");
  assert.equal(issueStage(["ready for prod release"], false, L, "approved"), "awaitingRelease");
  assert.equal(issueStage(["ready to close"], true, L, "approved"), "done");
  assert.equal(issueStage(["bug"], false, L, "approved"), null);
});

test("stageTarget: defaults hand every card to the Foreman; a role takes its stages", () => {
  assert.deepEqual(stageTarget({ agentId: "fm" }, "pendingVerification"), { bucket: "in_review", agentId: "fm", label: "pendingVerification" });
  const cfg = { agentId: "fm", roles: { lead: { name: "Lead", id: "lead-1" } },
    board: { ...Object.fromEntries(["approved", "implementing", "inReview", "reviewing", "changesRequested", "revising", "awaitingRelease"]
      .map((s) => [s, stageTarget({ agentId: "fm" }, s)]).map(([s, t]) => [s, { owner: "foreman", status: t.bucket, label: t.label }])),
      pendingVerification: { owner: "lead", status: "todo", label: "pendingVerification" } } };
  assert.deepEqual(stageTarget(cfg, "pendingVerification"), { bucket: "todo", agentId: "lead-1", label: "pendingVerification" });
});

test("liveRows: a fresh lease holds its rows; a lapsed or missing one holds none", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const meta = (at) => ({ foremanLive: { leaseAt: at, rows: [{ id: "a", phase: "review" }, "b"] } });
  assert.deepEqual([...liveRows(meta("2026-10-02T11:50:00Z"), now)], ["a", "b"]);
  assert.equal(liveRows(meta("2026-10-02T11:40:00Z"), now).size, 0);
  assert.equal(liveRows({}, now).size, 0);
  assert.equal(liveRows(null, now).size, 0);
});

test("withStage: exactly one stage label, every other label kept", () => {
  const ids = new Map([["inReview", "L1"], ["changesRequested", "L2"]]);
  assert.deepEqual(withStage(["x", "L1"], ids, "changesRequested"), ["x", "L2"]);
  assert.deepEqual(withStage(["L1", "L2", "x"], ids, null), ["x"]);
  assert.deepEqual(withStage([], ids, "inReview"), ["L1"]);
});

test("ensureStageLabels: creates only the missing labels; a lost race (409) re-lists", async () => {
  const labels = [{ id: "e1", name: "In code review" }];
  const created = [];
  const client = {
    listLabels: async () => labels,
    createLabel: async (l) => {
      if (l.name === "Changes requested") { labels.push({ id: "race", name: l.name }); throw Object.assign(new Error("409"), { status: 409 }); }
      const made = { id: `n${created.length}`, ...l };
      created.push(made); labels.push(made);
      return made;
    },
  };
  const m = await ensureStageLabels(client, { agentId: "fm" });
  assert.equal(m.get("inReview"), "e1");
  assert.equal(m.get("changesRequested"), "race");
  assert.equal(created.length, 3);
  assert.equal(m.size, 5);
});
