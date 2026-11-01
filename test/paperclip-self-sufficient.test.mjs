// The mirror rebuilds every card from GitHub on its own (EM #1150, feature 6):
// a hold outranks a stale update, the holder is re-derived as well as the
// column, a closed issue's card is terminal, a lifecycle issue gets a card on
// first sight, and a card's block survives a restart. Fake Paperclip, fake
// GitHub reads: no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperclipClient } from "../dist/paperclip/client.js";
import { PaperclipMirror } from "../dist/paperclip/mirror.js";
import { defaultLifecycleLabels } from "../dist/config.js";
import { paperclipBoardDefaults } from "../dist/paperclip/config.js";
import { issueStage } from "../dist/github-work-source.js";
import { loadCardBlocks, saveCardBlock, setStatePath } from "../dist/state.js";
import { slashbinProfile } from "../dist/profiles/slashbin.js";

/** The credit header Slashbin's Paperclip fork reads (`paperclip.commentAuthorHeader`, from its profile). */
const HEADER = slashbinProfile.paperclip.commentAuthorHeader;

async function allOpen(ns) { return new Map(ns.map((n) => [n, "open"])); }

const CID = "company-1";
const AGENT = "agent-1";
const item = { issueNumber: 7, repo: "example/r" };
const LL = defaultLifecycleLabels();

// The Paperclip fake of paperclip-mirror.test.mjs.
function fakePaperclip(rows = [], projects = [], labels = []) {
  const calls = [];
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
      return ok(rows.slice(off, off + Number(u.searchParams.get("limit"))));
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
  return { rows, projects, labels, agent, boardAgents, credits, calls, comments, fetch };
}

function logger() {
  const lines = [];
  const l = { lines, debug() {}, info: (m) => lines.push(["info", m]), warn: (m) => lines.push(["warn", m]), error: (m) => lines.push(["error", m]), child: () => l };
  return l;
}

// The live board's seats: review is the Tech Lead's, verification, rulings and blocks the EM's.
const ROLES = { em: { id: "em-agent" }, techLead: { id: "tl-agent" }, sre: { id: "sre-agent" } };
const D = paperclipBoardDefaults().board;
const BOARD = {
  ...D,
  inReview: { ...D.inReview, owner: "techLead" },
  pendingVerification: { ...D.pendingVerification, owner: "em" },
  needsRuling: { ...D.needsRuling, owner: "em" },
  blocked: { ...D.blocked, owner: "em" },
};

/** A mirror on `fake`; `fake.down` fails every PATCH (Paperclip down for writes). */
function mirrorOn(fake, extra = {}, store) {
  const cfg = { enabled: true, url: "http://pc.test", companyId: CID, agentId: AGENT, agentName: "Foreman",
    identityKeyFormat: "source: {repo}#{N}", comments: { enabled: false }, agentStatus: false, roles: ROLES, board: BOARD, ...extra };
  const fetch = (url, init = {}) => fake.down && init.method === "PATCH" ? Promise.resolve(new Response("{}", { status: 503 })) : fake.fetch(url, init);
  const client = new PaperclipClient({ url: cfg.url, companyId: CID, fetch, commentAuthorHeader: HEADER });
  return new PaperclipMirror(client, cfg, [], logger(), {}, store);
}

/** A store held in memory, as the plugin's is in the state file. */
function memoryStore() {
  const blocks = {};
  return { blocks, load: () => ({ ...blocks }), save: (id, b) => { if (b) blocks[id] = b; else delete blocks[id]; } };
}

const at = (labels, extra = {}) => ({ item, stage: issueStage(labels, false, LL, "approved"), detail: labels.join(", "), ...extra });
const snapshot = (mirror, labels, extra = {}, more = {}) =>
  mirror.onEvent({ kind: "snapshot", repo: "example/r", items: labels ? [at(labels, extra)] : [], states: allOpen, ...more }, logger());
const row7 = (status, extra = {}) => ({ id: "r7", title: "t", status, assigneeAgentId: AGENT, description: "source: example/r#7", ...extra });
const statusPatches = (fake) => fake.calls.filter((c) => c.method === "PATCH" && c.body && "status" in c.body);
const ruling = (m) => m.onEvent({ kind: "escalated", item, reason: "PR #3 has been sent back 4 times. EM: run /rule-on-scope" }, logger());
const transition = (m, to) => m.onEvent({ kind: "transition", item, from: "inReview", to }, logger());

// --- Foreman #98: a person's or a seat's hold is not undone by the reconcile -----------

test("#98: a person's hold on a Blocked card survives every cycle at its stage (SLA-2591)", async () => {
  const hold = { owner: "board", action: "Ray: deliver this to prod by hand, then close the issue" };
  const fake = fakePaperclip([row7("blocked", { assigneeAgentId: null, assigneeUserId: "ray", unblockDescriptor: hold })]);
  const mirror = mirrorOn(fake);
  for (let i = 0; i < 3; i++) {
    await snapshot(mirror, ["pr approved"]);
    assert.equal(fake.rows[0].status, "blocked", `cycle ${i + 1}: the hold was undone`);
    assert.equal(fake.rows[0].assigneeUserId, "ray", `cycle ${i + 1}: the card left the person holding it`);
  }
  assert.equal(statusPatches(fake).length, 0);
  await snapshot(mirror, ["ready for prod release"]);
  assert.notEqual(fake.rows[0].status, "blocked", "GitHub moved on: the card follows it");
});

test("#98: a stage update at the hold's stage leaves a seat's escalation hop in place", async () => {
  const hop = { owner: { agentId: "po-agent" }, action: "Escalation in progress (process.escalate hand_up): Product Owner holds this card." };
  const fake = fakePaperclip([row7("blocked", { assigneeAgentId: "po-agent", unblockDescriptor: hop })]);
  const mirror = mirrorOn(fake);
  await snapshot(mirror, ["pr approved"]);
  await transition(mirror, "approved");
  assert.equal(fake.rows[0].status, "blocked");
  assert.equal(fake.rows[0].assigneeAgentId, "po-agent");
});

// --- Foreman #100: a lost hand-off is re-derived from GitHub ---------------------------

test("#100: a pending-verification hand-off lost to an outage is retried by the next pass (SLA-2020)", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "tl-agent" })]);
  const mirror = mirrorOn(fake);
  await snapshot(mirror, ["approved", "pr under review"]);
  fake.down = true;
  await transition(mirror, "approved");
  assert.equal(fake.rows[0].assigneeAgentId, "tl-agent", "the outage lost the hand-off");
  fake.down = false;
  await snapshot(mirror, ["pr approved"]);
  assert.equal(fake.rows[0].status, "in_review");
  assert.equal(fake.rows[0].assigneeAgentId, "em-agent", "the status matched, so the EM never got the card");
  const before = statusPatches(fake).length;
  await snapshot(mirror, ["pr approved"]);
  assert.equal(statusPatches(fake).length, before, "a card with the right holder is not rewritten");
});

test("#100: a Blocked card's holder is the hold's, not the stage's", async () => {
  const fake = fakePaperclip([row7("blocked", { assigneeAgentId: "sre-agent", unblockDescriptor: { owner: { agentId: "sre-agent" }, action: "blocked: dev deploy failed" } })]);
  const mirror = mirrorOn(fake);
  await snapshot(mirror, ["approved", "blocked"]);
  assert.equal(fake.rows[0].assigneeAgentId, "sre-agent");
  assert.equal(statusPatches(fake).length, 0);
});

// --- Foreman #109: the needs-ruling hold wins until the ruling lands -------------------

for (const order of ["ruling first", "changes requested first"]) {
  test(`#109: a needs-ruling card stays Blocked on the EM whatever the order (${order}, SLA-366)`, async () => {
    const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "tl-agent" })]);
    const mirror = mirrorOn(fake);
    await snapshot(mirror, ["approved", "pr under review"]);
    if (order === "ruling first") { await ruling(mirror); await transition(mirror, "changesRequested"); }
    else { await transition(mirror, "changesRequested"); await ruling(mirror); }
    const r = fake.rows[0];
    assert.equal(r.status, "blocked");
    assert.equal(r.assigneeAgentId, "em-agent");
    await snapshot(mirror, ["approved", "pr pending actions"]);
    await transition(mirror, "changesRequested");
    assert.equal(r.status, "blocked", "a later update took the card back to the Foreman");
    assert.equal(r.assigneeAgentId, "em-agent");
    // The ruling lands: revise starts again and takes the card.
    await mirror.onSession({ phase: "revise", status: "started", repo: "example/r", pr: 3, items: [item] }, logger());
    assert.equal(r.status, "in_progress");
    assert.equal(r.assigneeAgentId, AGENT);
  });
}

// --- Foreman #112: a closed issue's card is terminal -----------------------------------

test("#112: a late stage update does not reopen a closed issue's card (SLA-2633)", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "tl-agent" })]);
  const mirror = mirrorOn(fake);
  await mirror.onEvent({ kind: "snapshot", repo: "example/r", items: [], states: allOpen, closed: [{ item, state: "completed" }] }, logger());
  assert.equal(fake.rows[0].status, "done");
  await transition(mirror, "approved");
  await mirror.onEvent({ kind: "blocked", item, reason: "late" }, logger());
  assert.equal(fake.rows[0].status, "done");
  assert.notEqual(fake.rows[0].assigneeAgentId, "em-agent", "the closed card was handed to the EM");
});

test("#112: a done card with no open issue behind it is terminal from the first pass, without a closed read", async () => {
  const fake = fakePaperclip([row7("done", { assigneeAgentId: "tl-agent" })]);
  const mirror = mirrorOn(fake);
  await snapshot(mirror, null);
  await transition(mirror, "approved");
  assert.equal(fake.rows[0].status, "done");
});

test("#112: the closed sweep closes an open card whose issue closed while nobody read it", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "tl-agent" })]);
  const mirror = mirrorOn(fake);
  await mirror.onEvent({ kind: "snapshot", repo: "example/r", items: [], states: async (ns) => new Map(ns.map((n) => [n, "not_planned"])) }, logger());
  assert.equal(fake.rows[0].status, "cancelled");
});

test("#112: a reopened issue's card follows GitHub again once it reads open live", async () => {
  const fake = fakePaperclip([row7("done", { assigneeAgentId: "tl-agent" })]);
  const mirror = mirrorOn(fake);
  await snapshot(mirror, null);
  await snapshot(mirror, ["approved", "pr under review"]);
  assert.equal(fake.rows[0].status, "in_review");
  assert.equal(fake.rows[0].assigneeAgentId, "tl-agent");
});

// --- Foreman #113: a card on first sight -----------------------------------------------

test("#113: a lifecycle issue with no card gets one at its stage, with its holder", async () => {
  const fake = fakePaperclip([]);
  const mirror = mirrorOn(fake);
  await snapshot(mirror, ["pr approved"]);
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0].status, "in_review");
  assert.equal(fake.rows[0].assigneeAgentId, "em-agent");
  await snapshot(mirror, ["pr approved"]);
  assert.equal(fake.rows.length, 1);
});

test("#113: with ownsCards a missed creation is made, at its stage", async () => {
  const fake = fakePaperclip([]);
  const mirror = mirrorOn(fake, { ownsCards: true });
  const card = { item, title: "issue 7", url: "https://github.com/example/r/issues/7", state: "open", stage: "inReview" };
  await snapshot(mirror, ["approved", "pr under review"], {}, { cards: [card] });
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0].status, "in_review");
  assert.equal(fake.rows[0].assigneeAgentId, "tl-agent");
});

// --- Persisted blocks: a card's block survives a restart --------------------------------

test("blocks: a failed deploy's block keeps the SRE across a restart", async () => {
  const store = memoryStore();
  const fake = fakePaperclip([row7("in_review")]);
  const first = mirrorOn(fake, {}, store);
  await snapshot(first, ["pr merged"]);
  await first.onEvent({ kind: "blocked", item, reason: "dev deploy failed", owner: "sre" }, logger());
  assert.equal(fake.rows[0].assigneeAgentId, "sre-agent");
  assert.deepEqual({ ...store.blocks.r7, reason: undefined }, { reason: undefined, owner: "sre", at: "merged" });
  // Restarted: the issue still at pr merged, no verify hold in play.
  const second = mirrorOn(fake, {}, store);
  await snapshot(second, ["pr merged"], { foremanHeld: true });
  assert.equal(fake.rows[0].status, "blocked", "the restart released the block");
  assert.equal(fake.rows[0].assigneeAgentId, "sre-agent");
  // And without the store, the same restart releases it: the store is what holds it.
  const fake2 = fakePaperclip([row7("blocked", { assigneeAgentId: "sre-agent", unblockDescriptor: { owner: { agentId: "sre-agent" }, action: "blocked: dev deploy failed" } })]);
  await snapshot(mirrorOn(fake2), ["pr merged"], { foremanHeld: true });
  assert.notEqual(fake2.rows[0].status, "blocked");
});

test("blocks: a needs-ruling hold survives a restart and still outranks a changes-requested update", async () => {
  const store = memoryStore();
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "tl-agent" })]);
  const first = mirrorOn(fake, {}, store);
  await snapshot(first, ["approved", "pr under review"]);
  await ruling(first);
  assert.deepEqual({ ...store.blocks.r7, reason: undefined }, { reason: undefined, at: "changesRequested", ruling: true });
  const second = mirrorOn(fake, {}, store);
  await snapshot(second, ["approved", "pr pending actions"], { foremanHeld: true });
  await transition(second, "changesRequested");
  assert.equal(fake.rows[0].status, "blocked");
  assert.equal(fake.rows[0].assigneeAgentId, "em-agent");
  // The ruling lands: the block is gone from the store as well.
  await second.onSession({ phase: "revise", status: "started", repo: "example/r", pr: 3, items: [item] }, logger());
  assert.equal(fake.rows[0].status, "in_progress");
  assert.equal(store.blocks.r7, undefined);
});

test("blocks: a restored block the Foreman's state no longer holds is released (jerky_security_testing#398)", async () => {
  const store = memoryStore();
  store.blocks.r7 = { reason: "blocked: all bumps already landed", at: "approved" };
  const fake = fakePaperclip([row7("blocked", { unblockDescriptor: { action: "blocked: all bumps already landed" } })]);
  await snapshot(mirrorOn(fake, {}, store), ["approved"], { foremanHeld: false });
  assert.equal(fake.rows[0].status, "todo");
  assert.equal(store.blocks.r7, undefined);
});

test("blocks: the state file keeps and forgets a card's block", () => {
  setStatePath(mkdtempSync(join(tmpdir(), "card-blocks-")));
  assert.deepEqual(loadCardBlocks(), {});
  saveCardBlock("r7", { reason: "blocked: x", owner: "sre", at: "merged" });
  saveCardBlock("r8", { at: null, ruling: true });
  assert.deepEqual(loadCardBlocks(), { r7: { reason: "blocked: x", owner: "sre", at: "merged" }, r8: { at: null, ruling: true } });
  saveCardBlock("r7", null);
  assert.deepEqual(loadCardBlocks(), { r8: { at: null, ruling: true } });
});

// --- PR #171 review: the Tech Lead's replay matrices ------------------------------------

const closedSnap = (mirror, how = "completed", more = {}) =>
  mirror.onEvent({ kind: "snapshot", repo: "example/r", items: [], states: async (ns) => new Map(ns.map((n) => [n, how])), closed: [{ item, state: how }], ...more }, logger());
const emWrites = (fake) => fake.calls.filter((c) => c.method === "PATCH" && c.body?.assigneeAgentId === "em-agent");
const unassigned = (r) => r.assigneeAgentId == null && r.assigneeUserId == null;

// Closed-issue write authorization.
test("review closed R1: a queued approved update before any closed snapshot leaves a Done card Done, no EM", async () => {
  const fake = fakePaperclip([row7("done", { assigneeAgentId: null })]);
  const mirror = mirrorOn(fake);
  await transition(mirror, "approved");
  assert.equal(fake.rows[0].status, "done");
  assert.equal(emWrites(fake).length, 0);
});

test("review closed R2: released, then a delayed approved, keeps the card Done with no EM hand-off", async () => {
  const fake = fakePaperclip([row7("in_progress", { assigneeAgentId: "sre-agent" })]);
  const mirror = mirrorOn(fake);
  await mirror.onRelease({ state: "merged", pr: 12, productionBranch: "main", issues: [item] }, logger());
  assert.equal(fake.rows[0].status, "done");
  await transition(mirror, "approved");
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
  assert.equal(emWrites(fake).length, 0);
});

test("review closed R3: a move deferred behind a Tech Lead run never lands on an issue the snapshot reads completed", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "tl-agent", executionRunId: "run-1", checkoutRunId: "run-1" })]);
  const mirror = mirrorOn(fake);
  await transition(mirror, "approved");
  assert.equal(fake.rows[0].assigneeAgentId, "tl-agent", "deferred while the run is in flight");
  Object.assign(fake.rows[0], { executionRunId: null, checkoutRunId: null });
  await closedSnap(mirror);
  assert.equal(emWrites(fake).length, 0, "an open-stage EM assignment was written first");
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
});

test("review closed R4: closure of an in_review card held by the Tech Lead is Done and nobody's", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "tl-agent" })]);
  const mirror = mirrorOn(fake);
  await closedSnap(mirror);
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
});

// Persisted ruling hand-off.
test("review ruling R1: a ruling block lost to an outage on a Foreman To-do card is delivered by the next snapshot", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "tl-agent" })]);
  const mirror = mirrorOn(fake, {}, memoryStore());
  await snapshot(mirror, ["approved", "pr under review"]);
  await transition(mirror, "changesRequested");
  assert.equal(fake.rows[0].status, "todo");
  fake.down = true;
  await ruling(mirror);
  assert.equal(fake.rows[0].status, "todo", "the outage lost the block");
  fake.down = false;
  await snapshot(mirror, ["approved", "pr pending actions"]);
  const r = fake.rows[0];
  assert.equal(r.status, "blocked");
  assert.equal(r.assigneeAgentId, "em-agent");
  assert.match(r.unblockDescriptor.action, /^blocked: needs an EM scope ruling: PR #3/);
  await transition(mirror, "changesRequested");
  assert.equal(r.status, "blocked");
  assert.equal(r.assigneeAgentId, "em-agent");
});

for (const restart of [false, true]) {
  test(`review ruling R2: a ruling block lost on a Tech Lead card is delivered on the first reachable snapshot${restart ? ", after a restart" : ""}`, async () => {
    const store = memoryStore();
    const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "tl-agent" })]);
    let mirror = mirrorOn(fake, {}, store);
    await snapshot(mirror, ["approved", "pr under review"]);
    fake.down = true;
    await ruling(mirror);
    assert.equal(fake.rows[0].status, "in_review");
    fake.down = false;
    if (restart) mirror = mirrorOn(fake, {}, store);
    for (let i = 0; i < 3; i++) {
      await snapshot(mirror, ["approved", "pr pending actions"], { foremanHeld: true });
      const r = fake.rows[0];
      assert.equal(r.status, "blocked", `snapshot ${i + 1}`);
      assert.equal(r.assigneeAgentId, "em-agent");
      assert.match(r.unblockDescriptor.action, /^blocked: needs an EM scope ruling/);
    }
  });
}

// External hold made after the cached scan.
const poHop = { owner: { agentId: "po-agent" }, action: "Escalation in progress (process.escalate hand_up): Product Owner holds this card until it is resolved." };
const escalateToPo = (r) => Object.assign(r, { status: "blocked", assigneeAgentId: "po-agent", assigneeUserId: null, unblockDescriptor: { ...poHop } });
const onPo = (r) => r.status === "blocked" && r.assigneeAgentId === "po-agent" && r.unblockDescriptor?.action === poHop.action;

test("review hold R1: an escalation made after the scan survives an approved update and three reconciliations", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "em-agent" })]);
  const mirror = mirrorOn(fake);
  await mirror.ensureIndex(true);
  escalateToPo(fake.rows[0]);
  await transition(mirror, "approved");
  assert.ok(onPo(fake.rows[0]), "the update took the card back from the PO");
  for (let i = 0; i < 3; i++) {
    await snapshot(mirror, ["pr approved"]);
    assert.ok(onPo(fake.rows[0]), `reconciliation ${i + 1}`);
  }
});

test("review hold R2: after a pendingVerification snapshot, a later escalation survives an approved update", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "em-agent" })]);
  const mirror = mirrorOn(fake);
  await snapshot(mirror, ["pr approved"]);
  escalateToPo(fake.rows[0]);
  await transition(mirror, "approved");
  assert.ok(onPo(fake.rows[0]));
  await snapshot(mirror, ["pr approved"]);
  assert.ok(onPo(fake.rows[0]));
});

test("review hold: a label-lifted stale block still returns to its stage", async () => {
  const fake = fakePaperclip([row7("blocked", { assigneeAgentId: "em-agent", unblockDescriptor: { owner: "board", action: "blocked: needs attention" } })]);
  const mirror = mirrorOn(fake);
  await snapshot(mirror, ["pr approved"]);
  assert.equal(fake.rows[0].status, "in_review");
  assert.equal(fake.rows[0].assigneeAgentId, "em-agent");
});

// Terminal ownership.
test("review owner R1: ownsCards off, closure clears the EM and a late approved keeps it Done and nobody's", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "em-agent" })]);
  const mirror = mirrorOn(fake);
  await closedSnap(mirror);
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
  await transition(mirror, "approved");
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
});

test("review owner R2: ownsCards on, closure clears the EM and a late approved keeps it Done and nobody's", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: "em-agent" })]);
  const mirror = mirrorOn(fake, { ownsCards: true });
  const card = { item, title: "issue 7", url: "https://github.com/example/r/issues/7", state: "completed", stage: null };
  await mirror.onEvent({ kind: "snapshot", repo: "example/r", items: [], states: async (ns) => new Map(ns.map((n) => [n, "completed"])), cards: [card] }, logger());
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
  await transition(mirror, "approved");
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
});

test("review owner R3: an already-Done card still held by the EM is unassigned on closure", async () => {
  const fake = fakePaperclip([row7("done", { assigneeAgentId: "em-agent" })]);
  const mirror = mirrorOn(fake);
  await closedSnap(mirror);
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
  await transition(mirror, "approved");
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
});

test("review owner R4: closure of a card held by a person clears the user too", async () => {
  const fake = fakePaperclip([row7("in_review", { assigneeAgentId: null, assigneeUserId: "ray" })]);
  const mirror = mirrorOn(fake);
  await closedSnap(mirror);
  assert.equal(fake.rows[0].status, "done");
  assert.ok(unassigned(fake.rows[0]));
});
