// A closed issue's card is done, or cancelled when not planned, whatever
// lifecycle labels it still carries, and the mirror never moves it out again.
// cmneb_data_receiver#218 went done → in_review at 14:52 on 2026-10-15: GitHub
// had closed it at ~14:39 (its promotion PR merged), but a full read of the
// open-issue view carried it again with its old `ready for prod release`
// label, and the snapshot placed the card from those labels.
//
// The case table, one test per row: GitHub's state × the labels the open view
// still shows × the column the card is in, with `ownsCards` off and on.
// GitHub's state is one of
//   open           the issue is open, and the live read says so
//   completed      closed as completed; only the stale open view carries it (the incident)
//   not_planned    closed as not planned; likewise
//   completed+read closed as completed, and this cycle's closed read has it
//   not_planned+read
//   unreadable     the live read fails: nothing is guessed, the card stays
import test from "node:test";
import assert from "node:assert/strict";
import { PaperclipClient } from "../dist/paperclip/client.js";
import { PaperclipMirror } from "../dist/paperclip/mirror.js";
import { defaultLifecycleLabels } from "../dist/config.js";
import { closedWins, issueStage } from "../dist/github-work-source.js";
import { issueStates } from "../dist/github/cards.js";
import { addObserver, drainObservers, publishSnapshot, registerWorkSource } from "../dist/work-source.js";
import { setStatePath } from "../dist/state.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CID = "company-1";
const AGENT = "agent-1";
const REPO = "example/r";
const URL7 = `https://github.com/${REPO}/issues/7`;

function fakePaperclip(rows) {
  const labels = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const ok = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
    if (method === "GET" && u.pathname === `/api/companies/${CID}/issues`) {
      const off = Number(u.searchParams.get("offset") ?? 0);
      return ok(rows.slice(off, off + Number(u.searchParams.get("limit"))));
    }
    if (method === "GET" && u.pathname === `/api/companies/${CID}/projects`) return ok([]);
    if (method === "POST" && u.pathname === `/api/companies/${CID}/projects`) return ok({ id: "proj-1", ...body }, 201);
    if (method === "POST" && u.pathname === `/api/companies/${CID}/issues`) {
      const r = { id: `row-${rows.length + 1}`, ...body };
      rows.push(r);
      return ok(r, 201);
    }
    const m = u.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (m && method === "GET") {
      const r = rows.find((x) => x.id === m[1]);
      return r ? ok(r) : ok({ error: "not found" }, 404);
    }
    if (m && method === "PATCH") {
      const r = rows.find((x) => x.id === m[1]);
      const { comment: _c, ...rest } = body;
      Object.assign(r, rest);
      return ok(r);
    }
    if (u.pathname.endsWith("/comments")) return method === "GET" ? ok([]) : ok({ id: "c" }, 201);
    if (method === "GET" && u.pathname === `/api/agents/${AGENT}`) return ok({ id: AGENT, metadata: {} });
    if (method === "GET" && u.pathname === `/api/companies/${CID}/labels`) return ok(labels);
    if (method === "POST" && u.pathname === `/api/companies/${CID}/labels`) {
      const l = { id: `label-${labels.length + 1}`, ...body };
      labels.push(l);
      return ok(l, 201);
    }
    return ok({}, 404);
  };
  return { rows, fetch };
}

function logger() {
  const lines = [];
  const l = { lines, debug() {}, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), child: () => l };
  return l;
}

function mirrorOn(fake, extra = {}) {
  const cfg = { enabled: true, url: "http://pc.test", companyId: CID, agentId: AGENT, agentName: "Foreman",
    identityKeyFormat: "source: {repo}#{N}", comments: { enabled: false }, ...extra };
  const client = new PaperclipClient({ url: cfg.url, companyId: CID, fetch: fake.fetch });
  return new PaperclipMirror(client, cfg, [], logger());
}

// The labels the open view still shows, and the column each calls for on the default board.
const LABELS = {
  "none": { labels: [], bucket: null },
  "approved": { labels: ["approved"], bucket: "todo" },
  "pr under review": { labels: ["approved", "pr under review"], bucket: "in_review" },
  "pr pending actions": { labels: ["approved", "pr pending actions"], bucket: "todo" },
  "pr merged": { labels: ["pr merged"], bucket: "in_review" },
  "pr approved": { labels: ["pr approved"], bucket: "in_review" },
  "ready for prod release": { labels: ["ready for prod release"], bucket: "in_review" },
  "release pending": { labels: ["release pending"], bucket: "in_progress" },
  "prod verification held": { labels: ["prod verification held"], bucket: "in_review" },
  "ready to close": { labels: ["ready to close"], bucket: "done" },
  "blocked": { labels: ["approved", "blocked"], bucket: "blocked" },
};
const GITHUB = ["open", "completed", "not_planned", "completed+read", "not_planned+read", "unreadable"];
const CARDS = ["done", "in_review", "cancelled"];

/**
 * The table: the column the card ends in.
 *   - open: the labels' column (none: unchanged with ownsCards off, which has
 *     no card for an unapproved issue; backlog with it on); a cancelled card
 *     of an open issue is a person's call and stays.
 *   - closed, in this cycle's closed read: done, or cancelled when not planned.
 *   - closed, only the stale open view carries it: never out of done or
 *     cancelled; a card the labels would move goes to done (cancelled when
 *     not planned) instead; one they would leave stays until the closed read.
 *   - closed, in no view at all: the closed sweep reads it live and closes it.
 *   - unreadable: unchanged.
 */
function expected(owns, gh, label, card) {
  const { bucket } = LABELS[label];
  if (gh === "completed+read") return "done";
  if (gh === "not_planned+read") return "cancelled";
  if (gh === "unreadable" || card === "cancelled") return card;
  if (gh === "open") return bucket ?? (owns ? "backlog" : card);
  // Closed, carried by the stale view alone: does anything ask GitHub about it?
  // An issue in no view (labels none, ownsCards off) is a card with no open issue
  // behind it: the closed sweep asks about it unless it is done or cancelled already.
  const asks = bucket === null ? (owns ? card !== "backlog" : card !== "done") : bucket !== card;
  return asks ? (gh === "completed" ? "done" : "cancelled") : card;
}

async function run(owns, gh, label, card) {
  const { labels } = LABELS[label];
  const description = `source: ${REPO}#7\nGitHub: open · not approved\n\n${URL7}`;
  const fake = fakePaperclip([{ id: "r7", title: "r#7 issue 7", status: card, assigneeAgentId: AGENT, description }]);
  const mirror = mirrorOn(fake, owns ? { ownsCards: true } : {});
  const item = { issueNumber: 7, repo: REPO };
  const ll = defaultLifecycleLabels();
  const stage = issueStage(labels, false, ll, "approved");
  // The stale (or current) open view: the items, and with ownsCards its open card.
  const items = stage === null ? [] : [{ item, stage, detail: labels.join(", ") || "none" }];
  const closedHow = gh.startsWith("completed") ? "completed" : gh.startsWith("not_planned") ? "not_planned" : null;
  const read = gh.endsWith("+read");
  const live = gh === "open" ? "open" : gh === "unreadable" ? undefined : closedHow;
  const states = async (ns) => new Map(live ? ns.map((n) => [n, live]) : []);
  const event = { kind: "snapshot", repo: REPO, items, states };
  if (owns) {
    const open = [{ item, title: "issue 7", url: URL7, state: "open", stage }];
    const closed = read ? [{ item, title: "issue 7", url: URL7, state: closedHow, stage: null }] : [];
    event.cards = closedWins(open, closed);
  } else if (read) {
    event.closed = [{ item, state: closedHow }];
  }
  await mirror.onEvent(event, logger());
  return fake.rows[0].status;
}

for (const owns of [false, true]) {
  for (const gh of GITHUB) {
    for (const label of Object.keys(LABELS)) {
      for (const card of CARDS) {
        const want = expected(owns, gh, label, card);
        test(`ownsCards ${owns ? "on" : "off"} | GitHub ${gh} | labels ${label} | card ${card} → ${want}`, async () => {
          assert.equal(await run(owns, gh, label, card), want);
        });
      }
    }
  }
}

// --- The incident, and the paths around the table ---

test("cmneb_data_receiver#218: a done card stays done when the open view carries the closed issue at ready for prod release", async () => {
  for (const live of [new Map([[7, "completed"]]), new Map()]) {
    const fake = fakePaperclip([{ id: "r7", title: "t", status: "done", assigneeAgentId: AGENT, description: `source: ${REPO}#7` }]);
    const mirror = mirrorOn(fake);
    const log = logger();
    const items = [{ item: { issueNumber: 7, repo: REPO }, stage: "releaseAuthorized", detail: "ready for prod release" }];
    await mirror.onEvent({ kind: "snapshot", repo: REPO, items, states: async () => live }, log);
    assert.equal(fake.rows[0].status, "done");
    assert.ok(!log.lines.some((m) => /done → in_review/.test(m)));
  }
});

test("no state reader, or one that throws: nothing moves", async () => {
  for (const states of [undefined, async () => { throw new Error("rate limited"); }]) {
    const fake = fakePaperclip([{ id: "r7", title: "t", status: "done", assigneeAgentId: AGENT, description: `source: ${REPO}#7` }]);
    const mirror = mirrorOn(fake);
    const log = logger();
    const items = [{ item: { issueNumber: 7, repo: REPO }, stage: "releasing", detail: "release pending" }];
    await mirror.onEvent({ kind: "snapshot", repo: REPO, items, ...(states ? { states } : {}) }, log);
    assert.equal(fake.rows[0].status, "done");
    assert.ok(log.lines.some((m) => /left #7 where they are: GitHub state not read/.test(m)));
  }
});

test("one live read per snapshot, for the cards a label would move only", async () => {
  const rows = [7, 8, 9].map((n) => ({ id: `r${n}`, title: "t", status: n === 9 ? "in_review" : "done", assigneeAgentId: AGENT, description: `source: ${REPO}#${n}` }));
  const fake = fakePaperclip(rows);
  const mirror = mirrorOn(fake);
  const asked = [];
  const items = [7, 8, 9].map((n) => ({ item: { issueNumber: n, repo: REPO }, stage: "inReview", detail: "pr under review" }));
  await mirror.onEvent({ kind: "snapshot", repo: REPO, items, states: async (ns) => { asked.push([...ns]); return new Map([[7, "open"], [8, "completed"]]); } }, logger());
  assert.deepEqual(asked, [[7, 8]], "#9 is already in its column: not asked");
  assert.deepEqual(fake.rows.map((r) => r.status), ["in_review", "done", "in_review"]);
});

test("an open release PR naming a closed issue does not pull its card out of done or cancelled", async () => {
  for (const status of ["done", "cancelled"]) {
    const fake = fakePaperclip([{ id: "r7", title: "t", status, assigneeAgentId: AGENT, description: `source: ${REPO}#7` }]);
    const mirror = mirrorOn(fake);
    for (const owned of [false, true]) {
      await mirror.onEvent({ kind: "release", release: { repo: REPO, state: "open", pr: 222, productionBranch: "main", owned, issues: [{ issueNumber: 7, repo: REPO }] } }, logger());
    }
    assert.equal(fake.rows[0].status, status);
  }
  const fake = fakePaperclip([{ id: "r7", title: "t", status: "in_review", assigneeAgentId: AGENT, description: `source: ${REPO}#7` }]);
  await mirrorOn(fake).onEvent({ kind: "release", release: { repo: REPO, state: "open", pr: 222, productionBranch: "main", owned: true, issues: [{ issueNumber: 7, repo: REPO }] } }, logger());
  assert.equal(fake.rows[0].status, "in_progress", "an open card still follows its release");
});

test("closedWins: an issue in both the open list and the closed read is closed", () => {
  const c = (n, state) => ({ item: { issueNumber: n, repo: REPO }, title: `i${n}`, url: "u", state, stage: state === "open" ? "releasing" : null });
  const out = closedWins([c(7, "open"), c(8, "open")], [c(7, "completed"), c(9, "not_planned")]);
  assert.deepEqual(out.map((x) => [x.item.issueNumber, x.state]), [[8, "open"], [7, "completed"], [9, "not_planned"]]);
});

test("issueStates: open, completed, not planned; a missing issue or a failed request is left out", () => {
  const queries = [];
  const numbers = Array.from({ length: 27 }, (_, i) => i + 1);
  const query = (q) => {
    queries.push(q);
    if (queries.length === 2) throw new Error("HTTP 502");
    return { repository: { s0: { state: "OPEN" }, s1: { state: "CLOSED", stateReason: "COMPLETED" }, s2: { state: "CLOSED", stateReason: "NOT_PLANNED" }, s3: null } };
  };
  const log = logger();
  const got = issueStates(REPO, "/tmp", numbers, log, query);
  assert.equal(queries.length, 4, "25 to a request; the failed batch of 2 is re-read one number per request");
  assert.match(queries[0], /s0: issue\(number: 1\) \{ state stateReason \}/);
  assert.deepEqual([...got], [[1, "open"], [2, "completed"], [3, "not_planned"], [26, "open"], [27, "open"]]);
  assert.ok(log.lines.some((m) => /issue states not read: HTTP 502/.test(m)));
});

test("issueStates: 0, a negative number and a non-integer never appear in any query", () => {
  const queries = [];
  const query = (q) => { queries.push(q); return { repository: { s0: { state: "OPEN" }, s1: { state: "OPEN" } } }; };
  const got = issueStates(REPO, "/tmp", [0, -3, 1.5, NaN, 5, 6], logger(), query);
  assert.equal(queries.length, 1);
  assert.ok(!/number: (0|-3|1\.5|NaN)\b/.test(queries[0]), queries[0]);
  assert.deepEqual([...got], [[5, "open"], [6, "open"]]);
});

test("issueStates: a batch with one unresolvable number still returns the others", () => {
  const queries = [];
  const query = (q) => {
    queries.push(q);
    if (/number: 99\b/.test(q)) throw new Error("Could not resolve to an Issue with the number of 99.");
    return { repository: { s0: { state: "OPEN" } } };
  };
  const log = logger();
  const got = issueStates(REPO, "/tmp", [4, 99, 7], log, query);
  assert.deepEqual([...got], [[4, "open"], [7, "open"]]);
  assert.equal(queries.length, 4, "one batch, then one read per number");
  assert.ok(log.lines.some((m) => /issue state #99 not read: Could not resolve/.test(m)));
  assert.ok(!log.lines.some((m) => /issue state #(4|7) not read/.test(m)));
});

test("issueStates: a healthy batch of 25 is one request", () => {
  let calls = 0;
  const query = () => { calls++; return { repository: {} }; };
  issueStates(REPO, "/tmp", Array.from({ length: 25 }, (_, i) => i + 1), logger(), query);
  assert.equal(calls, 1);
});

test("publishSnapshot: carries the state reader, and the closed items when the cards are not read", async () => {
  setStatePath(mkdtempSync(join(tmpdir(), "closed-cards-")));
  const asked = [];
  registerWorkSource({
    snapshot: async () => [],
    closed: async () => [{ item: { issueNumber: 7, repo: REPO }, state: "completed" }],
    states: async (_rc, ns) => { asked.push([...ns]); return new Map(ns.map((n) => [n, "open"])); },
  });
  const seen = [];
  addObserver({ onEvent: async (e) => { seen.push(e); }, wantsSnapshot: () => true });
  try {
    await publishSnapshot({ name: "r", githubRepo: REPO }, logger());
    await drainObservers();
    const e = seen.at(-1);
    assert.deepEqual(e.closed, [{ item: { issueNumber: 7, repo: REPO }, state: "completed" }]);
    assert.deepEqual([...(await e.states([4, 5]))], [[4, "open"], [5, "open"]]);
    assert.deepEqual(asked, [[4, 5]]);
  } finally {
    registerWorkSource(null);
  }
});
