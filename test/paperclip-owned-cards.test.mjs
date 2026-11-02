// One writer per card (jerky_ops#11, 2026-10-15: two cards for one issue, one
// from the receiver's sync and one from the Foreman). The pieces outside the
// mirror: the rule every writer evaluates, which of two rows is the card, the
// hold reason read from GitHub, and the snapshot carrying every card only when
// an observer owns them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { foremanOwnsCard, FOREMAN_BLOCKED_PREFIX, HOLD_PREFIX as PLUGIN_HOLD_PREFIX, isHoldComment } from "../dist/paperclip/board.js";
import { pickCard } from "../dist/paperclip/mirror.js";
import { HOLD_PREFIX, holdReason } from "../dist/github/cards.js";
import { addObserver, drainObservers, publishSnapshot, registerWorkSource, wantsCards } from "../dist/work-source.js";
import { setStatePath } from "../dist/state.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });

test("foremanOwnsCard: a served, mirrored repo's card with ownsCards on; everything else is another writer's", () => {
  const served = ["xrgarcia/jerky_ops", "xrgarcia/jerky_service"];
  assert.equal(foremanOwnsCard({ ownsCards: true }, served, "xrgarcia/jerky_ops"), true);
  assert.equal(foremanOwnsCard({ ownsCards: false }, served, "xrgarcia/jerky_ops"), false, "off: the Foreman owns nothing");
  assert.equal(foremanOwnsCard({}, served, "xrgarcia/jerky_ops"), false);
  assert.equal(foremanOwnsCard({ ownsCards: true }, served, "xrgarcia/slashbin-engineering-manager"), false, "the EM repo is not served");
  assert.equal(foremanOwnsCard({ ownsCards: true, repos: ["xrgarcia/jerky_service"] }, served, "xrgarcia/jerky_ops"), false, "served but not mirrored");
  assert.equal(foremanOwnsCard({ ownsCards: true, repos: ["xrgarcia/jerky_service"] }, served, "xrgarcia/jerky_service"), true);
});

test("foremanOwnsCard: with a registry a moved repo matches under either owner; without one it stays exact (#177)", () => {
  const served = ["xrgarcia/slashbin_data_receiver"];
  const reg = { ownsCards: true, registryUrl: "https://registry.example/registry/mcp" };
  assert.equal(foremanOwnsCard(reg, served, "slashbin-io/slashbin_data_receiver"), true, "moved owner, registry set");
  assert.equal(foremanOwnsCard(reg, served, "slashbin-io/Slashbin_Data_Receiver"), true, "case does not matter");
  assert.equal(foremanOwnsCard({ ownsCards: true }, served, "slashbin-io/slashbin_data_receiver"), false, "no registry: exact");
  assert.equal(foremanOwnsCard(reg, served, "slashbin-io/slashbin_mcp_services"), false, "a different name is not owned");
  assert.equal(foremanOwnsCard({ ...reg, repos: ["slashbin-io/slashbin_data_receiver"] }, served, "xrgarcia/slashbin_data_receiver"), true, "paperclip.repos under the other owner");
});

test("pickCard: the oldest row that is not cancelled, else the oldest; undated rows by list order, after dated ones", () => {
  const rows = [
    { id: "new-open", status: "todo", createdAt: "2026-10-15T10:00:05Z" },
    { id: "old-cancelled", status: "cancelled", createdAt: "2026-10-15T10:00:00Z" },
    { id: "old-open", status: "backlog", createdAt: "2026-10-15T10:00:01Z" },
  ];
  assert.equal(pickCard(rows, "cancelled").id, "old-open");
  assert.equal(pickCard([rows[1], { id: "c2", status: "cancelled", createdAt: "2026-10-16T00:00:00Z" }], "cancelled").id, "old-cancelled");
  assert.equal(pickCard([{ id: "a", status: "todo" }, { id: "b", status: "todo" }], "cancelled").id, "a");
  assert.equal(pickCard([{ id: "a", status: "todo" }, { id: "b", status: "todo", createdAt: "2026-01-01T00:00:00Z" }], "cancelled").id, "b");
  assert.equal(pickCard([], "cancelled"), undefined);
});

test("the core's hold prefix is the plugin's, and both read as a Foreman block", () => {
  assert.equal(HOLD_PREFIX, PLUGIN_HOLD_PREFIX);
  assert.ok(HOLD_PREFIX.startsWith(FOREMAN_BLOCKED_PREFIX));
});

test("holdReason: the labeller's newest comment from 15 minutes before the label on; none says so", () => {
  const events = [
    { createdAt: "2026-10-10T10:00:00Z", actor: { login: "old" }, label: { name: "blocked" } },
    { createdAt: "2026-10-14T12:00:00Z", actor: { login: "ray" }, label: { name: "blocked" } },
    { createdAt: "2026-10-14T13:00:00Z", actor: { login: "ray" }, label: { name: "bug" } },
  ];
  const comments = [
    { url: "https://github.com/o/r/issues/1#c1", createdAt: "2026-10-14T11:00:00Z", author: { login: "ray" }, body: "too early" },
    { url: "https://github.com/o/r/issues/1#c2", createdAt: "2026-10-14T11:50:00Z", author: { login: "ray" }, body: "**Hold**: waiting on `legal`\nmore" },
    { url: "https://github.com/o/r/issues/1#c3", createdAt: "2026-10-14T12:05:00Z", author: { login: "someone" }, body: "not the holder" },
  ];
  const h = holdReason("blocked", events, comments);
  assert.equal(h.action, `${HOLD_PREFIX}Hold: waiting on legal (ray, 2026-10-14) https://github.com/o/r/issues/1#c2`);
  assert.equal(h.commentUrl, "https://github.com/o/r/issues/1#c2");
  assert.ok(h.comment.startsWith("Held on GitHub by ray, 2026-10-14:\n\n**Hold**"));
  assert.ok(isHoldComment(h.comment, { comment: h.comment, url: h.commentUrl }));
  assert.ok(!isHoldComment(`see ${h.commentUrl}`, { comment: h.comment, url: h.commentUrl }), "a mere link is not the copy");

  const none = holdReason("blocked", events, []);
  assert.equal(none.action, `${HOLD_PREFIX}labelled blocked by ray on 2026-10-14; no reason posted on the issue`);
  assert.equal(none.comment, null);
  assert.equal(holdReason("blocked", [], []).action, `${HOLD_PREFIX}labelled blocked by unknown on unknown date; no reason posted on the issue`);
});

test("publishSnapshot: the cards are read and carried only while an observer owns them", async () => {
  setStatePath(mkdtempSync(join(tmpdir(), "owned-cards-")));
  let cardReads = 0;
  const card = { item: { issueNumber: 1, repo: "o/r" }, title: "t", url: "u", state: "open", stage: null };
  registerWorkSource({
    snapshot: async () => [],
    cards: async () => { cardReads++; return [card]; },
  });
  const seen = [];
  let owns = false;
  addObserver({ onEvent: async (e) => { seen.push(e); }, wantsSnapshot: () => true, wantsCards: () => owns });
  const repoConfig = { name: "r", githubRepo: "o/r" };
  try {
    assert.equal(wantsCards(), false);
    await publishSnapshot(repoConfig, logger);
    await drainObservers();
    assert.equal(cardReads, 0);
    assert.equal("cards" in seen.at(-1), false);
    owns = true;
    assert.equal(wantsCards(), true);
    await publishSnapshot(repoConfig, logger);
    await drainObservers();
    assert.equal(cardReads, 1);
    assert.deepEqual(seen.at(-1).cards, [card]);
  } finally {
    owns = false;
    registerWorkSource(null);
  }
});
