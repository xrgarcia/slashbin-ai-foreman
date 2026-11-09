// The board mirror is derived, never remembered (foreman#199 #183 #198): a card is recomputed from GitHub every pass.
// Card placement is a pure function of the issue's current state; card creation is find-or-create by issue identity;
// duplicate retirement persists until done. The same GitHub state placed by a long-lived mirror and by a restarted one
// (different first-seen history) must give the same board.
import test from "node:test";
import assert from "node:assert/strict";
import { PaperclipClient } from "../dist/paperclip/client.js";
import { PaperclipMirror } from "../dist/paperclip/mirror.js";
import { createRepoIdentity, REPO_KEY_TTL_MS } from "../dist/paperclip/repo-identity.js";
import { configureBackoff, DEFAULT_BACKOFF } from "../dist/backoff.js";
import { defaultLifecycleLabels } from "../dist/config.js";
import { paperclipBoardDefaults } from "../dist/paperclip/config.js";
import { issueStage } from "../dist/github-work-source.js";
import { slashbinProfile } from "../dist/profiles/slashbin.js";

// Tiny retry waits so the clients' retries run at once; the real windows are backoff.paperclip / backoff.registry.
configureBackoff({ ...DEFAULT_BACKOFF, paperclip: { ...DEFAULT_BACKOFF.paperclip, baseMs: 1, capMs: 2 }, registry: { ...DEFAULT_BACKOFF.registry, baseMs: 1, capMs: 2 } });

/** The credit header Slashbin's Paperclip fork reads (`paperclip.commentAuthorHeader`, from its profile). */
const HEADER = slashbinProfile.paperclip.commentAuthorHeader;

// GitHub reads every issue the existing tests snapshot as open: a card moves
// only on a confirmed state (the closed-issue cases are in paperclip-closed-cards).
async function allOpen(ns) { return new Map(ns.map((n) => [n, "open"])); }
function onSnap(mirror, repo, items, log) { return mirror.onSnapshot(repo, items, log, { states: allOpen }); }

const CID = "company-1";
const AGENT = "agent-1";
const SECRET = { name: "TEST_TOKEN", value: "secret-value-0123456789" };
const item = { issueNumber: 7, repo: "example/r" };
const repoConfig = { name: "r", githubRepo: "example/r" };

function fakePaperclip(rows = [], projects = [], labels = []) {
  const calls = [];
  // Every issue-list request's status filter and `q`: the plugin never lists without a status filter or reads a terminal status.
  const lists = [];
  const comments = {};
  const agent = { id: AGENT, metadata: {} };
  // The board's agents, as `GET /companies/:id/agents` lists them; each may carry metadata.githubLogin.
  const boardAgents = [];
  // Who each comment was credited to (the HEADER), in posting order; null = the key's user.
  const credits = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
    if (method === "GET" && u.pathname === `/api/companies/${CID}/agents`) return new Response(JSON.stringify(boardAgents), { status: 200 });
    if (body && ((method === "POST" && u.pathname.endsWith("/comments")) || (method === "PATCH" && "comment" in body))) credits.push(init.headers?.[HEADER] ?? null);
    const ok = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
    if (method === "GET" && u.pathname === `/api/companies/${CID}/issues`) {
      const off = Number(u.searchParams.get("offset") ?? 0);
      // The server's status filter: a terminal card is never returned to a caller that does not ask for it.
      const want = u.searchParams.get("status")?.split(",");
      const q = u.searchParams.get("q")?.toLowerCase();
      lists.push({ status: want, q });
      let hit = want ? rows.filter((r) => want.includes(r.status)) : rows;
      if (q) hit = hit.filter((r) => `${r.title ?? ""}\n${r.description ?? ""}\n${r.identifier ?? ""}`.toLowerCase().includes(q));
      return ok(hit.slice(off, off + Number(u.searchParams.get("limit"))));
    }
    if (method === "GET" && u.pathname === `/api/companies/${CID}/projects`) return ok(projects);
    if (method === "POST" && u.pathname === `/api/companies/${CID}/projects`) {
      const p = { id: `proj-${projects.length + 1}`, ...body };
      projects.push(p);
      return ok(p, 201);
    }
    if (method === "POST" && u.pathname === `/api/companies/${CID}/issues`) {
      const r = { id: `row-${rows.length + 1}`, ...body };
      rows.push(r);
      return ok(r, 201);
    }
    // Paperclip's rule: a board user's comment on an agent-held blocked, done
    // or cancelled row moves it to todo, unless the same PATCH restates a status.
    const reopens = (r) => ["blocked", "done", "cancelled"].includes(r.status) && r.assigneeAgentId;
    let m = u.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (m && method === "GET") {
      const r = rows.find((x) => x.id === m[1]);
      return r ? ok(r) : ok({ error: "not found" }, 404);
    }
    if (m && method === "PATCH") {
      const r = rows.find((x) => x.id === m[1]);
      if ("comment" in body) {
        const { comment, ...rest } = body;
        (comments[m[1]] ??= []).push(comment);
        if (!("status" in rest) && reopens(r)) r.status = "todo";
        Object.assign(r, rest);
        return ok(r);
      }
      // Paperclip's rule: one assignee, an agent or a user, never both.
      const agent = "assigneeAgentId" in body ? body.assigneeAgentId : r.assigneeAgentId;
      const user = "assigneeUserId" in body ? body.assigneeUserId : r.assigneeUserId;
      if (agent && user) return ok({ error: "Issue can only have one assignee" }, 422);
      Object.assign(r, body);
      return ok(r);
    }
    if (method === "GET" && u.pathname === `/api/agents/${AGENT}`) return ok(agent);
    if (method === "PATCH" && u.pathname === `/api/agents/${AGENT}`) return ok(Object.assign(agent, body));
    if (method === "GET" && u.pathname === `/api/companies/${CID}/labels`) return ok(labels);
    if (method === "POST" && u.pathname === `/api/companies/${CID}/labels`) {
      if (labels.some((l) => l.name === body.name)) return ok({ error: "exists" }, 409);
      const l = { id: `label-${labels.length + 1}`, ...body };
      labels.push(l);
      return ok(l, 201);
    }
    m = u.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (m && method === "GET") {
      return ok((comments[m[1]] ?? []).map((b, i) => ({ id: `c${i}`, body: b, createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString() })));
    }
    if (m && method === "POST") {
      (comments[m[1]] ??= []).push(body.body);
      const r = rows.find((x) => x.id === m[1]);
      if (r && reopens(r)) r.status = "todo";
      return ok({ id: "c", body: body.body }, 201);
    }
    return ok({}, 404);
  };
  return { rows, projects, labels, agent, boardAgents, credits, calls, lists, comments, fetch };
}

function logger() {
  const lines = [];
  const l = {
    lines,
    debug() {},
    info: (m) => lines.push(["info", m]),
    warn: (m) => lines.push(["warn", m]),
    error: (m) => lines.push(["error", m]),
    child: () => l,
  };
  return l;
}

function mirrorOn(fake, extra = {}, identity = undefined) {
  const cfg = { enabled: true, url: "http://pc.test", companyId: CID, agentId: AGENT, agentName: "Foreman",
    // The one-line notes these tests were written against; the summaries have their own tests below.
    identityKeyFormat: "source: {repo}#{N}", comments: { enabled: false }, ...extra };
  const log = logger();
  const client = new PaperclipClient({ url: cfg.url, companyId: CID, fetch: fake.fetch, commentAuthorHeader: HEADER });
  return { mirror: new PaperclipMirror(client, cfg, [SECRET], log, {}, undefined, identity), log };
}

const ghRepo = { ...repoConfig, lifecycleLabels: defaultLifecycleLabels(), triggerLabel: "approved" };
// What the GitHub connector's snapshot() hands the mirror for these labels: the
// stage each issue is in, the labels as the note's detail; unlabeled issues dropped.
const snap = (issues, held = []) => issues.flatMap(({ number, labels }) => {
  const stage = issueStage(labels, false, ghRepo.lifecycleLabels, ghRepo.triggerLabel);
  return stage === null ? [] : [{ item: { issueNumber: number, repo: "example/r" }, stage, detail: labels.join(", ") || "none",
    ...(held.includes(number) ? { verifyHeld: true } : {}) }];
});
const row7 = (status, extra = {}) => ({ id: "r7", title: "t", status, assigneeAgentId: AGENT, description: "source: example/r#7", ...extra });
const statusPatches = (fake) => fake.calls.filter((c) => c.method === "PATCH" && c.body && "status" in c.body);
const OWNED = { ownsCards: true };
const URL7 = "https://github.com/example/r/issues/7";
const card = (n, extra = {}) => ({ item: { issueNumber: n, repo: "example/r" }, title: `issue ${n}`, url: `https://github.com/example/r/issues/${n}`, state: "open", stage: null, ...extra });
const ownedRow = (status, extra = {}) => row7(status, { title: "r#7 issue 7", description: `source: example/r#7\nGitHub: open · not approved\n\n${URL7}`, ...extra });

const PO = "agent-po";
const HOP = { owner: { agentId: PO }, action: "Escalation in progress (process.escalate hand_up): Product Owner holds this card until it is resolved or returned down the chain." };
// The stage labels the Foreman wrote when it placed each card: the card's own durable record of its stage.
const STAGE_LABELS = [{ id: "L-pv", name: "Awaiting EM verification" }, { id: "L-merged", name: "Dev verification" }, { id: "L-rev", name: "In code review" }];
const place = (fake) => fake.rows.map((r) => ({ id: r.id, status: r.status, assignee: r.assigneeAgentId ?? null, labels: [...(r.labelIds ?? [])].sort() }));
const writes = (fake) => fake.calls.filter((c) => c.method !== "GET").length;

/** The board as the Foreman left it: 7 held by a seat at `pr approved`, 8 in review, 9 at dev verification. */
const board = () => [
  row7("blocked", { assigneeAgentId: PO, unblockDescriptor: HOP, labelIds: ["L-pv"] }),
  { id: "r8", title: "t", status: "in_review", assigneeAgentId: AGENT, description: "source: example/r#8", labelIds: ["L-rev"] },
  { id: "r9", title: "t", status: "in_review", assigneeAgentId: AGENT, description: "source: example/r#9", labelIds: ["L-pv"] },
];
const NOW = [{ number: 7, labels: ["pr merged"] }, { number: 8, labels: ["pr under review"] }, { number: 9, labels: ["pr merged"] }];
const BEFORE = [{ number: 7, labels: ["pr approved"] }, { number: 8, labels: ["pr under review"] }, { number: 9, labels: ["pr approved"] }];

test("the same GitHub state gives the same board from a long-lived mirror and a restarted one (different first-seen history)", async () => {
  // A: has watched the cards at their earlier stage, so it remembers where each hold was first seen.
  const a = fakePaperclip(board(), [], structuredClone(STAGE_LABELS));
  const mirrorA = mirrorOn(a).mirror;
  await onSnap(mirrorA, "example/r", snap(BEFORE), logger());
  assert.equal(a.rows[0].status, "blocked", "the hold stands while GitHub is still at its stage");
  await onSnap(mirrorA, "example/r", snap(NOW), logger());
  // B: a restart over the same board; it has seen only the final state.
  const b = fakePaperclip(board(), [], structuredClone(STAGE_LABELS));
  const mirrorB = mirrorOn(b).mirror;
  await onSnap(mirrorB, "example/r", snap(NOW), logger());
  assert.deepEqual(place(b), place(a), "placement is a function of GitHub's state, not of what this process saw first");
  assert.notEqual(b.rows[0].status, "blocked", "GitHub moved past the hold's stage: it is released");
  // And a second run from the same state changes nothing, for either.
  const [wa, wb] = [writes(a), writes(b)];
  await onSnap(mirrorA, "example/r", snap(NOW), logger());
  await onSnap(mirrorB, "example/r", snap(NOW), logger());
  assert.equal(writes(a), wa);
  assert.equal(writes(b), wb);
});

test("foreman#183: a restarted mirror leaves a seat's hold while GitHub is still at its stage, and releases it once GitHub moves on", async () => {
  const fake = fakePaperclip(board(), [], structuredClone(STAGE_LABELS));
  const { mirror } = mirrorOn(fake); // a restart: no memory of when the hold began
  await onSnap(mirror, "example/r", snap(BEFORE), logger());
  assert.equal(fake.rows[0].status, "blocked");
  assert.equal(fake.rows[0].assigneeAgentId, PO);
  const restarted = mirrorOn(fake).mirror;
  await onSnap(restarted, "example/r", snap(NOW), logger());
  assert.notEqual(fake.rows[0].status, "blocked", "GitHub is past the stage the card was held at; a restart must not make the hold stand again");
});

test("no restart-order dependence: a hold on a card with no stage label falls back to the stage first seen", async () => {
  const fake = fakePaperclip([row7("blocked", { assigneeAgentId: PO, unblockDescriptor: HOP })], [], structuredClone(STAGE_LABELS));
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap(BEFORE.slice(0, 1)), logger());
  await onSnap(mirror, "example/r", snap(BEFORE.slice(0, 1)), logger());
  assert.equal(fake.rows[0].status, "blocked");
  await onSnap(mirror, "example/r", snap(NOW.slice(0, 1)), logger());
  assert.notEqual(fake.rows[0].status, "blocked");
});

test("find-or-create: a fresh mirror creates a card once; a restarted one over the same board and GitHub state creates none", async () => {
  const fake = fakePaperclip([]);
  const cards = [card(7), card(8, { stage: "approved" })];
  const first = mirrorOn(fake, OWNED).mirror;
  await first.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards }, logger());
  assert.equal(fake.rows.length, 2);
  const before = place(fake);
  const restarted = mirrorOn(fake, OWNED).mirror; // different first-seen history: empty memory
  await restarted.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards }, logger());
  await restarted.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards }, logger());
  assert.equal(fake.rows.length, 2, "no duplicate creation");
  assert.deepEqual(place(fake), before);
});

test("foreman#199: createTask is find-or-create by issue identity, checked against the index before creating", async () => {
  const fake = fakePaperclip([]);
  const { mirror } = mirrorOn(fake, OWNED);
  const index = mirror.cardIndex;
  const content = index.defaultContent(item);
  const one = await index.createTask(item, content);
  const two = await index.createTask(item, content);
  assert.ok(one);
  assert.equal(two, one, "the second ask finds the card the first made");
  assert.equal(fake.rows.length, 1);
  // A card another writer made is the card, too: found by a fresh read, not created over.
  const other = fakePaperclip([{ id: "made-elsewhere", title: "t", status: "todo", description: "source: example/r#7" }]);
  const m2 = mirrorOn(other, OWNED).mirror;
  assert.equal(await m2.cardIndex.createTask(item, m2.cardIndex.defaultContent(item)), "made-elsewhere");
  assert.equal(other.rows.length, 1);
});

test("foreman#199: a second card is retired in the pass that finds it, not left for housekeeping", async () => {
  const fake = fakePaperclip([
    ownedRow("todo", { identifier: "SLA-1", createdAt: "2026-10-15T10:00:00Z" }),
    { id: "r7b", identifier: "SLA-2", title: "example/r#7", status: "in_progress", assigneeAgentId: AGENT, description: "source: example/r#7\n\nx", createdAt: "2026-10-15T10:00:03Z" },
  ]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7)] }, logger());
  assert.equal(fake.rows[1].status, "cancelled", "retired by the snapshot pass itself");
  assert.equal(fake.rows[0].status, "backlog", "the card that stays is the one placed");
});

test("foreman#199: a retirement that fails persists until it lands", async () => {
  const fake = fakePaperclip([
    ownedRow("todo", { identifier: "SLA-1", createdAt: "2026-10-15T10:00:00Z" }),
    { id: "r7b", identifier: "SLA-2", title: "example/r#7", status: "in_progress", assigneeAgentId: AGENT, description: "source: example/r#7\n\nx", createdAt: "2026-10-15T10:00:03Z" },
  ]);
  const real = fake.fetch;
  let failing = true;
  fake.fetch = async (url, init = {}) => {
    if (failing && init.method === "PATCH" && new URL(url).pathname === "/api/issues/r7b") return new Response(JSON.stringify({ error: "nope" }), { status: 422 });
    return real(url, init);
  };
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7)] }, logger());
  assert.equal(fake.rows[1].status, "in_progress", "the write failed");
  assert.equal(mirror.duplicates.length, 1, "and the duplicate is still listed, not forgotten");
  failing = false;
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7)] }, logger());
  assert.equal(fake.rows[1].status, "cancelled", "retired on the next pass");
  assert.equal(mirror.duplicates.length, 0);
});

test("foreman#198: a releasing issue whose release PR fails the EM sign-off is its own stage, a card on the EM", () => {
  const labels = defaultLifecycleLabels();
  assert.equal(issueStage([labels.releasePending], false, labels, "approved"), "releasing");
  assert.equal(issueStage([labels.releasePending], false, labels, "approved", undefined, true), "awaitingSignoff");
  assert.equal(issueStage([labels.prodVerifyHeld, labels.releasePending], false, labels, "approved", undefined, true), "prodVerifyHeld", "a held prod verification still outranks it");
});

test("foreman#198: the awaitingSignoff card sits in review under its own label, with an action-needed handoff", async () => {
  const fake = fakePaperclip([row7("in_progress")]);
  const { mirror } = mirrorOn(fake);
  const stage = issueStage(["release pending"], false, ghRepo.lifecycleLabels, ghRepo.triggerLabel, undefined, true);
  await onSnap(mirror, "example/r", [{ item, stage, detail: "release pending" }], logger());
  assert.equal(fake.rows[0].status, "in_review");
  assert.deepEqual(labelsOf(fake, fake.rows[0]), ["Awaiting EM sign-off"]);
  const { handoffComment } = await import("../dist/paperclip/handoff.js");
  const text = handoffComment("awaitingSignoff", { repo: "example/r", issueNumber: 7, seat: "Foreman" });
  assert.match(text, /action needed/);
  assert.match(text, /ready for prod release/);
});

const labelsOf = (fake, r) => (r.labelIds ?? []).map((id) => fake.labels.find((l) => l.id === id)?.name).filter((n) => n && n !== "issue");
