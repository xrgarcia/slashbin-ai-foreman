// Foreman #100 (SLA-3778, xrgarcia/jerky_skuvault_service#599, 2026-11-05): after a
// daemon restart the card was never placed again. The first scan after a restart reads
// every row of a ~3,500-row board, four pages; Paperclip was timing out through the
// retries of one page, the scan threw away the pages it had, and the next scan started
// at row 0 and failed the same way. No index, so no snapshot placed anything: the card
// stayed where it was from changesRequested through merged, approved, release and close,
// and was never handed to the EM seat at pendingVerification.
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
const item = { issueNumber: 599, repo: REPO };

const closedFiller = (i) => ({ id: `old${i}`, title: "t", status: "done", description: `source: ${REPO}#${10_000 + i}\n\nx`, updatedAt: "2026-10-01T00:00:00.000Z" });

/** A board of 3,003 finished cards plus the card for #599, whose whole-list pages time out in bursts of three attempts (one page's retries) after three that succeed. */
function slowBoard() {
  const rows = Array.from({ length: 3003 }, (_, i) => closedFiller(i));
  rows.push({ id: "r599", identifier: "SLA-3778", title: "t", status: "todo", assigneeAgentId: FOREMAN, description: `source: ${REPO}#599\n\nx`, updatedAt: "2026-11-05T19:04:40.000Z" });
  const calls = [];
  let attempts = 0;
  const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
    if (method === "GET" && u.pathname === `/api/companies/${CID}/issues`) {
      attempts++;
      if (Math.floor((attempts - 1) / 3) % 2 === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      const since = u.searchParams.get("updatedSince");
      const off = Number(u.searchParams.get("offset")), lim = Number(u.searchParams.get("limit"));
      return ok(rows.filter((r) => !since || r.updatedAt >= since).slice(off, off + lim));
    }
    const m = u.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (m && method === "PATCH") {
      const r = rows.find((x) => x.id === m[1]);
      const { comment: _c, ...rest } = body;
      Object.assign(r, rest);
      return ok(r);
    }
    if (m && method === "GET") return ok(rows.find((x) => x.id === m[1]));
    if (u.pathname.endsWith("/comments")) return ok(method === "GET" ? [] : { id: "c" });
    if (u.pathname.endsWith("/agents") || u.pathname.endsWith("/labels") || u.pathname.endsWith("/projects")) return ok([]);
    if (u.pathname === `/api/agents/${FOREMAN}`) return ok({ id: FOREMAN, metadata: {} });
    return new Response("{}", { status: 404 });
  };
  return { rows, calls, fetch, card: () => rows.find((r) => r.id === "r599") };
}

const logger = () => {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l };
  return l;
};

/** A new mirror over the board: a daemon restart. */
function restarted(board) {
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
  const client = new PaperclipClient({ url: cfg.url, companyId: CID, fetch: board.fetch });
  return new PaperclipMirror(client, cfg, [], logger(), {});
}

const open = (stage) => ({ item, stage, detail: stage, foremanHeld: false });
const cardOf = (stage, state = "open") => ({ item, title: "issue 599", url: `https://github.com/${REPO}/issues/599`, state, stage });
async function cycle(mirror, stage, state = "open") {
  const live = async (ns) => new Map(ns.map((n) => [n, state === "open" ? "open" : "closed"]));
  await mirror.onEvent({ kind: "snapshot", states: live, repo: REPO, items: state === "open" ? [open(stage)] : [], cards: [cardOf(stage, state)] }, logger());
}

test("a restart on a board whose list times out keeps the card following GitHub, and hands pendingVerification to the EM", async () => {
  const board = slowBoard();
  const mirror = restarted(board); // the 20:15Z restart
  const steps = [
    ["changesRequested", { status: "todo", holder: FOREMAN }],
    ["merged", { status: "in_review", holder: SRE }],
    ["pendingVerification", { status: "todo", holder: EM }],
    ["releaseAuthorized", { status: "in_review" }],
    ["releasing", { status: "in_progress" }],
  ];
  for (const [stage, want] of steps) {
    // The Foreman's cycles repeat the snapshot; the board may fail the scan on some of them.
    for (let i = 0; i < 3; i++) await cycle(mirror, stage);
    assert.equal(board.card().status, want.status, `at ${stage} the card is ${want.status}`);
    if (want.holder) assert.equal(board.card().assigneeAgentId, want.holder, `at ${stage} the holder is ${want.holder}`);
  }
  for (let i = 0; i < 3; i++) await cycle(mirror, "releasing", "completed");
  assert.equal(board.card().status, "done", "closed on GitHub, done on the board");
});

test("a whole-list read that failed part way resumes at the page it stopped on, not at row 0", async () => {
  const board = slowBoard();
  const mirror = restarted(board);
  assert.equal(await mirror.ensureIndex(true), false, "the first scan fails on its fourth page");
  const pages = () => board.calls.filter((c) => c.path.endsWith("/issues"));
  const before = pages().length;
  assert.equal(await mirror.ensureIndex(true), true, "the second scan finishes the list");
  assert.equal(mirror.index.size, 3004);
  assert.equal(mirror.rowState.get("r599"), "status:todo");
  assert.ok(pages().length - before <= 3, "it did not read the first three pages again");
});
