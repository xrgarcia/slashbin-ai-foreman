// The board mapping every Paperclip writer shares: lifecycle labels → stage,
// stage → holder/status/label, the live-session lease, one stage label per card.
import test from "node:test";
import assert from "node:assert/strict";
import { stageTarget, assigneeFor, liveRows, withStage, ensureStageLabels } from "../dist/paperclip/board.js";
import { PAPERCLIP_STAGES } from "../dist/paperclip/config.js";
import { issueStage } from "../dist/github-work-source.js";

const L = { prUnderReview: "pr under review", prPendingActions: "pr pending actions", prApproved: "pr approved",
  readyForProd: "ready for prod release", releasePending: "release pending", prodVerifyHeld: "prod verification held",
  readyToClose: "ready to close" };

test("issueStage: the latest lifecycle label wins; an open release PR is awaiting release", () => {
  assert.equal(issueStage(["approved"], false, L, "approved"), "approved");
  assert.equal(issueStage(["approved", "pr under review"], false, L, "approved"), "inReview");
  assert.equal(issueStage(["pr pending actions"], false, L, "approved"), "changesRequested");
  assert.equal(issueStage(["pr approved", "pr under review"], false, L, "approved"), "pendingVerification");
  assert.equal(issueStage(["pr approved"], true, L, "approved"), "awaitingRelease");
  // The release lifecycle (EM#578): the EM's authorization, the Foreman's release PR, a held prod verification.
  assert.equal(issueStage(["ready for prod release"], false, L, "approved"), "releaseAuthorized");
  assert.equal(issueStage(["ready for prod release"], true, L, "approved"), "releaseAuthorized");
  assert.equal(issueStage(["release pending"], true, L, "approved"), "releasing");
  assert.equal(issueStage(["release pending", "ready for prod release"], true, L, "approved"), "releasing");
  assert.equal(issueStage(["prod verification held", "release pending"], false, L, "approved"), "prodVerifyHeld");
  assert.equal(issueStage(["prod verification held", "blocked"], false, L, "approved"), "blocked");
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

test("stageTarget: no lifecycle stage is held by a user, so no result carries a userId key", () => {
  const cfg = { agentId: "fm", humanUserId: "ray", roles: { em: { name: "EM", id: "em-1" } } };
  for (const st of PAPERCLIP_STAGES) assert.equal("userId" in stageTarget(cfg, st), false, st);
});

test("assigneeFor: approved-for-human goes to the user; nothing else is assigned, an EM-repo item included", () => {
  const EM = "xrgarcia/slashbin-engineering-manager";
  const cfg = { agentId: "fm", humanUserId: "ray-user", roles: { em: { name: "Engineering Manager", id: "em-agent" } } };
  assert.deepEqual(assigneeFor(cfg, { labels: ["approved-for-human"], repo: "acme/svc" }), { assigneeAgentId: null, assigneeUserId: "ray-user" });
  assert.deepEqual(assigneeFor(cfg, { labels: ["approved-for-human"], repo: EM }), { assigneeAgentId: null, assigneeUserId: "ray-user" });
  // An agent is never assigned: the EM agent is bridged and would wake on every row.
  assert.equal(assigneeFor(cfg, { labels: ["approved"], repo: EM }), undefined);
  assert.equal(assigneeFor(cfg, { labels: ["approved"], repo: "acme/svc" }), undefined);
  assert.equal(assigneeFor(cfg, { labels: [], repo: "acme/svc" }), undefined);
});

test("assigneeFor: an unset humanUserId leaves both null, never the Foreman's agent, and never throws", () => {
  assert.deepEqual(assigneeFor({ agentId: "fm" }, { labels: ["approved-for-human"], repo: "acme/svc" }), { assigneeAgentId: null, assigneeUserId: null });
});

test("assigneeFor: two identical calls return equal results", () => {
  const cfg = { agentId: "fm", humanUserId: "ray-user" };
  for (const item of [{ labels: ["approved-for-human"], repo: "a/b" }, { labels: [], repo: "xrgarcia/slashbin-engineering-manager" }, { labels: [], repo: "a/b" }]) {
    assert.deepEqual(assigneeFor(cfg, item), assigneeFor(cfg, item));
  }
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
  assert.equal(created.length, 7);
  assert.equal(m.size, 9);
});
