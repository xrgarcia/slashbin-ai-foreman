// Foreman #100 (SLA-3778, xrgarcia/jerky_skuvault_service#599, 2026-11-05): after a daemon
// restart the card was never placed again. The first company-wide scan read ~3,450 rows (four
// pages); Paperclip timed out on a page, the scan threw its pages away and restarted at row 0,
// and one failed company read stopped every repo. The plugin now reads one repo's in-play cards
// (statuses todo, in_progress, in_review, blocked, backlog; filtered by repo name) and never
// asks for a done or cancelled card, so a slow board costs one repo at most.
import test from "node:test";
import assert from "node:assert/strict";
import { PaperclipClient } from "../dist/paperclip/client.js";
import { PaperclipMirror } from "../dist/paperclip/mirror.js";
import { paperclipBoardDefaults } from "../dist/paperclip/config.js";
import { configureBackoff, DEFAULT_BACKOFF } from "../dist/backoff.js";

configureBackoff({ ...DEFAULT_BACKOFF, paperclip: { ...DEFAULT_BACKOFF.paperclip, baseMs: 1, capMs: 2 } });

const CID = "company-1";
const FOREMAN = "agent-foreman";
const EM = "agent-em";
const SRE = "agent-sre";
const REPO = "xrgarcia/jerky_skuvault_service";
const SLOW = "xrgarcia/jerky_labor_forecaster";
const item = { issueNumber: 599, repo: REPO };

const IN_PLAY = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

/**
 * A 3,000-card finished board plus the card for #599 and one for the slow repo. The server
 * filters by status and q as the live API does. A read that does not name in-play statuses only
 * (the old company-wide read) times out, as does every read for the slow repo.
 */
function board() {
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: `old${i}`, title: "t", status: i % 2 ? "done" : "cancelled", description: `source: ${REPO}#${10_000 + i}\n\nx` }));
  rows.push({ id: "r599", identifier: "SLA-3778", title: "t", status: "todo", assigneeAgentId: FOREMAN, description: `source: ${REPO}#599\n\nx` });
  rows.push({ id: "slow1", title: "t", status: "todo", assigneeAgentId: FOREMAN, description: `source: ${SLOW}#64\n\nx` });
  const lists = [];
  const calls = [];
  const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
    if (method === "GET" && u.pathname === `/api/companies/${CID}/issues`) {
      const status = u.searchParams.get("status");
      const q = u.searchParams.get("q");
      lists.push({ status, q });
      const wanted = status ? status.split(",") : null;
      if (!wanted || wanted.some((s) => !IN_PLAY.has(s)) || q === "jerky_labor_forecaster") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      const off = Number(u.searchParams.get("offset")), lim = Number(u.searchParams.get("limit"));
      const hit = rows.filter((r) => wanted.includes(r.status) && (!q || r.description.includes(q)));
      return ok(hit.slice(off, off + lim));
    }
    const m = u.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (m && method === "PATCH") {
      const r = rows.find((x) => x.id === m[1]);
      const { comment: _c, ...rest } = body;
      Object.assign(r, rest);
      return ok(r);
    }
    if (m && method === "GET") return ok(rows.find((x) => x.id === m[1]));
    if (method === "POST" && u.pathname === `/api/companies/${CID}/issues`) {
      const r = { id: `new${rows.length}`, ...body };
      rows.push(r);
      return ok(r);
    }
    if (u.pathname.endsWith("/comments")) return ok(method === "GET" ? [] : { id: "c" });
    if (u.pathname.endsWith("/agents") || u.pathname.endsWith("/labels") || u.pathname.endsWith("/projects")) return ok([]);
    if (u.pathname === `/api/agents/${FOREMAN}`) return ok({ id: FOREMAN, metadata: {} });
    return new Response("{}", { status: 404 });
  };
  return { rows, lists, calls, fetch, card: () => rows.find((r) => r.id === "r599") };
}

const logger = () => {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l };
  return l;
};

/** A new mirror over the board: a daemon restart. */
function restarted(b) {
  const cfg = {
    enabled: true, url: "http://pc.test", companyId: CID, agentId: FOREMAN, agentName: "Foreman", ownsCards: true, agentStatus: false,
    identityKeyFormat: "source: {repo}#{N}", comments: { enabled: false },
    roles: { em: { name: "Engineering Manager", id: EM }, sre: { name: "SRE", id: SRE } },
    board: {
      ...paperclipBoardDefaults().board,
      merged: { owner: "sre", status: "in_review", label: "merged" },
      pendingVerification: { owner: "em", status: "todo", label: "pendingVerification" },
    },
  };
  const client = new PaperclipClient({ url: cfg.url, companyId: CID, fetch: b.fetch });
  return new PaperclipMirror(client, cfg, [], logger(), {});
}

const open = (stage) => ({ item, stage, detail: stage, foremanHeld: false });
const cardOf = (stage, state = "open") => ({ item, title: "issue 599", url: `https://github.com/${REPO}/issues/599`, state, stage });
async function cycle(mirror, stage, state = "open", repo = REPO) {
  const live = async (ns) => new Map(ns.map((n) => [n, state === "open" ? "open" : "closed"]));
  await mirror.onEvent({ kind: "snapshot", states: live, repo, items: state === "open" ? [open(stage)] : [], cards: [cardOf(stage, state)] }, logger());
}
/** The slow repo's own snapshot, which fails to read every time. */
const slowCycle = (mirror) => mirror.onEvent({
  kind: "snapshot", states: async (ns) => new Map(ns.map((n) => [n, "open"])), repo: SLOW,
  items: [], cards: [{ item: { issueNumber: 64, repo: SLOW }, title: "issue 64", url: `https://github.com/${SLOW}/issues/64`, state: "open", stage: null }],
}, logger());

test("SLA-3778 replay: after a restart, with another repo's read timing out, the card follows GitHub and the EM gets pendingVerification", async () => {
  const b = board();
  const mirror = restarted(b);
  const steps = [
    ["changesRequested", { status: "todo", holder: FOREMAN }],
    ["merged", { status: "in_review", holder: SRE }],
    ["pendingVerification", { status: "todo", holder: EM }],
    ["releaseAuthorized", { status: "in_review" }],
    ["releasing", { status: "in_progress" }],
  ];
  for (const [stage, want] of steps) {
    await slowCycle(mirror); // the failing repo is polled between every step
    for (let i = 0; i < 2; i++) await cycle(mirror, stage);
    assert.equal(b.card().status, want.status, `at ${stage} the card is ${want.status}`);
    if (want.holder) assert.equal(b.card().assigneeAgentId, want.holder, `at ${stage} the holder is ${want.holder}`);
  }
  await cycle(mirror, "releasing", "completed");
  assert.equal(b.card().status, "done", "closed on GitHub, done on the board");
  assert.equal(b.rows.filter((r) => r.description.includes("#599")).length, 1, "no second card was made");
});

test("one repo's failing read places nothing for that repo and does not stop another", async () => {
  const b = board();
  const mirror = restarted(b);
  const before = b.calls.length;
  await slowCycle(mirror);
  assert.equal(b.calls.slice(before).filter((c) => c.method !== "GET").length, 0, "nothing is written for the repo that could not be read");
  assert.equal(b.rows.filter((r) => r.description.includes(`${SLOW}#64`)).length, 1, "and no duplicate card is made");
  await cycle(mirror, "merged");
  assert.equal(b.card().status, "in_review");
});

test("no list request is made without a status filter or with a done or cancelled status", async () => {
  const b = board();
  const mirror = restarted(b);
  await cycle(mirror, "merged");
  await cycle(mirror, "releasing", "completed");
  await slowCycle(mirror);
  await mirror.housekeep();
  assert.ok(b.lists.length > 0);
  for (const l of b.lists) {
    assert.ok(l.status, "every list request names statuses");
    assert.ok(l.status.split(",").every((s) => IN_PLAY.has(s)), `only in-play statuses: ${l.status}`);
    assert.ok(l.q, "and a repo name");
  }
});

test("a reopened issue gets a fresh card; the finished one is left alone", async () => {
  const b = board();
  const mirror = restarted(b);
  await cycle(mirror, "releasing", "completed");
  assert.equal(b.card().status, "done");
  await cycle(mirror, "changesRequested");
  const mine = b.rows.filter((r) => r.description.includes(`${REPO}#599`));
  assert.equal(mine.length, 2, "a new card for the reopened issue");
  assert.equal(b.card().status, "done", "the old card stays done");
});

// Ray, 2026-11-05: the Foreman is a product; with Paperclip on, the plugin alone closes, reopens and
// places its cards. Nothing here plays another writer: the fake board changes only by the plugin's own writes.
test("no other writer: a GitHub close reaches done or cancelled, and a reopen gets a new card", async () => {
  for (const [how, want] of [["completed", "done"], ["not_planned", "cancelled"]]) {
    const b = board();
    const mirror = restarted(b);
    await cycle(mirror, "merged");
    assert.equal(b.card().status, "in_review", "open card follows GitHub");
    // GitHub closes the issue; the card is still open in the repo's read, and the next snapshot closes it.
    await cycle(mirror, "merged", how);
    assert.equal(b.card().status, want, `closed ${how} on GitHub: ${want} on the board`);
    // A later restart reads only in-play cards: the finished one is not read, not touched, not duplicated.
    const again = restarted(b);
    await cycle(again, "merged", how);
    assert.equal(b.card().status, want);
    assert.equal(b.rows.filter((r) => r.description.includes(`${REPO}#599`)).length, 1);
    // GitHub reopens it: a new card, placed at the stage GitHub shows.
    await cycle(again, "changesRequested");
    const mine = b.rows.filter((r) => r.description.includes(`${REPO}#599`));
    assert.equal(mine.length, 2, "the reopen got a new card");
    assert.equal(b.card().status, want, "the finished card stays finished");
    assert.equal(mine[1].status, "todo");
    assert.equal(mine[1].assigneeAgentId, FOREMAN);
  }
});

test("a failed refresh does not leave the earlier read valid: the next snapshot reads again", async () => {
  const b = board();
  const mirror = restarted(b);
  assert.equal(await mirror.ensureRepo(REPO), true);
  const n = () => b.lists.length;
  assert.equal(await mirror.ensureRepo(REPO), true, "inside the TTL, no read");
  const quiet = n();
  assert.equal(await mirror.ensureRepo(SLOW, true), false);
  b.fetch.failOnce = true;
  const failing = restarted(b);
  assert.equal(await failing.ensureRepo(SLOW, true), false);
  assert.equal(await failing.ensureRepo(SLOW), false, "a failed read is read again, not served from the TTL");
  assert.ok(n() > quiet);
});

test("closing cards touches only their own entries: forget leaves other repos' cards and keys alone", async () => {
  const b = board();
  const mirror = restarted(b);
  await mirror.ensureRepo(REPO, true);
  const before = mirror.index.size;
  await cycle(mirror, "releasing", "completed");
  assert.equal(mirror.index.size, before - 1);
  assert.equal(mirror.rowState.get("r599"), undefined);
});
