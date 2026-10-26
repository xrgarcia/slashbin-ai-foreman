// PaperclipMirror: each Foreman step becomes a note on the issue's Paperclip
// task, status follows the step, and Paperclip failing never throws. The
// client gets an injected fake fetch — no Paperclip, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { PaperclipClient } from "../dist/paperclip/client.js";
import { PaperclipMirror } from "../dist/paperclip/mirror.js";
import { defaultLifecycleLabels } from "../dist/config.js";
import { paperclipBoardDefaults } from "../dist/paperclip/config.js";
import { issueStage } from "../dist/github-work-source.js";

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
  const comments = {};
  const agent = { id: AGENT, metadata: {} };
  // The board's agents, as `GET /companies/:id/agents` lists them; each may carry metadata.githubLogin.
  const boardAgents = [];
  // Who each comment was credited to (x-slashbin-comment-author), in posting order; null = the key's user.
  const credits = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
    if (method === "GET" && u.pathname === `/api/companies/${CID}/agents`) return new Response(JSON.stringify(boardAgents), { status: 200 });
    if (body && ((method === "POST" && u.pathname.endsWith("/comments")) || (method === "PATCH" && "comment" in body))) credits.push(init.headers?.["x-slashbin-comment-author"] ?? null);
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

function mirrorOn(fake, extra = {}) {
  const cfg = { enabled: true, url: "http://pc.test", companyId: CID, agentId: AGENT, agentName: "Foreman",
    // The one-line notes these tests were written against; the summaries have their own tests below.
    identityKeyFormat: "source: {repo}#{N}", comments: { enabled: false }, ...extra };
  const log = logger();
  const client = new PaperclipClient({ url: cfg.url, companyId: CID, fetch: fake.fetch });
  return { mirror: new PaperclipMirror(client, cfg, [SECRET], log), log };
}

const statusPatches = (fake) => fake.calls.filter((c) => c.method === "PATCH" && c.body && "status" in c.body);

test("claim with no row creates one keyed by the identity line, held by the agent", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0].description.split("\n")[0], "source: example/r#7");
  assert.equal(fake.rows[0].status, "in_progress");
  assert.equal(fake.rows[0].assigneeAgentId, AGENT);
  assert.deepEqual(fake.comments["row-1"], ["picked up by Foreman"]);
});

test("claim adopts the row another writer created; no duplicate", async () => {
  const fake = fakePaperclip([{ id: "synced", title: "t", status: "todo", description: "source: example/r#7\nGitHub: open" }]);
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0].assigneeAgentId, AGENT);
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues")).length, 0);
});

test("status per step; blocked needs a person, merged is a note, promoted writes nothing; secrets redacted", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onPrLink(item, `https://github.com/example/r/pull/9?t=${SECRET.value}`, repoConfig, logger());
  await mirror.onState(item, "new", "inReview", repoConfig, logger());
  assert.equal(fake.rows[0].status, "in_review");
  await mirror.onState(item, "inReview", "changesRequested", repoConfig, logger());
  assert.equal(fake.rows[0].status, "todo");
  await mirror.onState(item, "changesRequested", "queued", repoConfig, logger());
  assert.equal(fake.rows[0].status, "todo");
  await mirror.onState(item, "inReview", "approved", repoConfig, logger());
  assert.equal(fake.rows[0].status, "in_review");
  await mirror.onBlocked(item, `bad ${SECRET.value}`, repoConfig, logger());
  assert.equal(fake.rows[0].status, "blocked");
  assert.equal(fake.rows[0].assigneeAgentId, AGENT);
  assert.deepEqual(fake.rows[0].unblockDescriptor, { owner: { agentId: AGENT }, action: "blocked: bad [REDACTED:TEST_TOKEN]" });
  const before = statusPatches(fake).length;
  await mirror.onMerged(item, repoConfig, logger());
  await mirror.onEvent({ kind: "promoted", item }, logger());
  assert.equal(fake.rows[0].status, "blocked", "a note on a blocked card restates its status");
  assert.equal(statusPatches(fake).length, before + 1);
  assert.deepEqual(fake.comments["row-1"], [
    "picked up by Foreman",
    "PR opened: https://github.com/example/r/pull/9?t=[REDACTED:TEST_TOKEN]",
    "under review",
    "changes requested",
    "queued",
    "approved",
    "blocked: bad [REDACTED:TEST_TOKEN]",
    "merged",
  ]);
});

test("a step for an item this process never claimed finds the row; with none it writes nothing", async () => {
  const fake = fakePaperclip([{ id: "synced", title: "t", status: "in_review", description: "source: example/r#7" }]);
  const { mirror } = mirrorOn(fake);
  await mirror.onMerged(item, repoConfig, logger());
  assert.deepEqual(fake.comments.synced, ["merged"]);
  await mirror.onMerged({ issueNumber: 8, repo: "example/r" }, repoConfig, logger());
  assert.equal(fake.rows.length, 1);
});

test("statusMap renames the bucket written", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake, { statusMap: { in_progress: "doing" } });
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows[0].status, "doing");
});

test("back-off notes land on the item being built", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onBackoffPause("claude", "session limit", logger());
  await mirror.onBackoffResume("claude", logger());
  assert.deepEqual(fake.comments["row-1"].slice(1), ["paused: claude back-off: session limit", "resumed after back-off"]);
});

test("Paperclip down: nothing throws, the outage is logged once, a success ends it", async () => {
  let down = true;
  const fake = fakePaperclip();
  const flaky = { fetch: async (...a) => { if (down) throw new Error("ECONNREFUSED"); return fake.fetch(...a); } };
  const { mirror, log } = mirrorOn(flaky);
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onState(item, "new", "inReview", repoConfig, logger());
  await mirror.onMerged(item, repoConfig, logger());
  assert.equal(log.lines.filter(([lvl]) => lvl === "warn").length, 1);
  down = false;
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(log.lines.filter(([lvl, m]) => lvl === "info" && /reachable again/.test(m)).length, 1);
  down = true;
  await mirror.onMerged(item, repoConfig, logger());
  assert.equal(log.lines.filter(([lvl]) => lvl === "warn").length, 2);
});

test("a row the sync gave a board user: the claim takes it, clearing the user", async () => {
  const fake = fakePaperclip([{ id: "synced", title: "t", status: "in_progress", assigneeUserId: "local-board", description: "source: example/r#7" }]);
  const { mirror, log } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows[0].assigneeAgentId, AGENT);
  assert.equal(fake.rows[0].assigneeUserId, null);
  assert.deepEqual(fake.comments.synced, ["picked up by Foreman"]);
  assert.equal(log.lines.length, 0);
});

test("a rejected update is logged once with Paperclip's reason, the note still posts, and it is not an outage", async () => {
  const fake = fakePaperclip([{ id: "synced", title: "t", status: "todo", description: "source: example/r#7" }]);
  const reject = { fetch: async (url, init = {}) => (init.method === "PATCH"
    ? new Response(JSON.stringify({ error: "nope" }), { status: 422 }) : fake.fetch(url, init)) };
  const { mirror, log } = mirrorOn(reject);
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onClaim(item, repoConfig, logger());
  const warns = log.lines.filter(([lvl]) => lvl === "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0][1], /rejected: .*422 — nope/);
  assert.doesNotMatch(warns[0][1], /down/);
  assert.equal(fake.comments.synced.length, 2);
});

test("a second claim before any state change is a retry, not a second pick-up", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onState(item, "new", "inReview", repoConfig, logger());
  await mirror.onClaim(item, repoConfig, logger());
  assert.deepEqual(fake.comments["row-1"], [
    "picked up by Foreman", "retrying: the previous attempt did not finish", "under review", "picked up by Foreman",
  ]);
});

// --- live activity: waits, sessions, the live task, the agent's status ---

const row = (id, n, extra = {}) => ({ id, status: "in_progress", assigneeAgentId: AGENT, assigneeUserId: null,
  unblockDescriptor: null, description: `source: example/r#${n}\nGitHub: open`, ...extra });
const writesTo = (fake, id) => fake.calls.filter((c) => c.method !== "GET" && c.path.startsWith(`/api/issues/${id}`));

test("waiting: blocked under its statusMap name with the reason as the unblock action, once per reason", async () => {
  const fake = fakePaperclip([row("r7", 7)]);
  const { mirror } = mirrorOn(fake, { statusMap: { blocked: "on_hold" } });
  await mirror.onWaiting("example/r", [{ item, reason: `occupied by PR #4\n token ${SECRET.value}` }], logger());
  const [patch] = statusPatches(fake);
  assert.equal(patch.body.status, "on_hold");
  assert.deepEqual(patch.body.unblockDescriptor, { owner: { agentId: AGENT }, action: "occupied by PR #4 token [REDACTED:TEST_TOKEN]" });
  assert.deepEqual(fake.comments.r7, ["waiting: occupied by PR #4 token [REDACTED:TEST_TOKEN]"]);
  const before = writesTo(fake, "r7").length;
  await mirror.onWaiting("example/r", [{ item, reason: `occupied by PR #4\n token ${SECRET.value}` }], logger());
  assert.equal(writesTo(fake, "r7").length, before, "same reason again writes nothing");
  await mirror.onWaiting("example/r", [{ item, reason: "occupied by PR #5" }], logger());
  assert.equal(fake.comments.r7.length, 2, "a new reason is a new note");
});

test("a skip in its back-off stays with the blocked owner, not the Foreman (EM #417)", async () => {
  // Live shape of slashbin-cli#142: declined, then the back-off re-blocked it as a Foreman-held wait.
  const fake = fakePaperclip([row("r7", 7, { status: "blocked", unblockDescriptor: { owner: { agentId: AGENT }, action: "declined: x" } })]);
  const { mirror } = mirrorOn(fake, { agentStatus: false, roles: { engineeringManager: { id: "em-agent" } }, board: { ...paperclipBoardDefaults().board, blocked: { ...paperclipBoardDefaults().board.blocked, owner: "engineeringManager" } } });
  await mirror.onWaiting("example/r", [{ item, reason: "declined: x", skipped: true }], logger());
  const r = fake.rows[0];
  assert.equal(r.status, "blocked");
  assert.equal(r.assigneeAgentId, "em-agent");
  assert.deepEqual(r.unblockDescriptor, { owner: { agentId: "em-agent" }, action: "blocked: declined: x" });
  const before = writesTo(fake, "r7").length;
  await mirror.onWaiting("example/r", [{ item, reason: "declined: x", skipped: true }], logger());
  assert.equal(writesTo(fake, "r7").length, before, "a later back-off cycle writes nothing");
  await mirror.onWaiting("example/r", [], logger());
  assert.equal(r.status, "blocked", "the back-off ending does not resume a card a person must clear");
});

test("a note never moves the row: blocked stays blocked, done stays done", async () => {
  const fake = fakePaperclip([row("r7", 7), row("r8", 8, { status: "done" })]);
  const { mirror } = mirrorOn(fake, { agentStatus: false });
  await mirror.onWaiting("example/r", [{ item, reason: "occupied by PR #4" }], logger());
  assert.equal(fake.rows[0].status, "blocked", "the waiting note reopened the row it had just blocked");
  assert.deepEqual(fake.comments.r7, ["waiting: occupied by PR #4"]);
  await mirror.onMerged({ issueNumber: 8, repo: "example/r" }, repoConfig, logger());
  assert.equal(fake.rows[1].status, "done", "the merged note reopened a done row");
  assert.deepEqual(fake.comments.r8, ["merged"]);
});

test("resume touches only rows this agent blocked in this repo", async () => {
  const blocked = (id, n, extra) => row(id, n, { status: "blocked", unblockDescriptor: { action: "x" }, ...extra });
  const fake = fakePaperclip([
    blocked("mine", 7),
    blocked("other-repo", 7, { description: "source: example/q#7" }),
    blocked("someone-else", 8, { assigneeAgentId: null, assigneeUserId: "user-1" }),
  ]);
  const { mirror } = mirrorOn(fake);
  await mirror.onWaiting("example/r", [], logger());
  assert.deepEqual(statusPatches(fake).map((c) => [c.path, c.body.status]), [["/api/issues/mine", "todo"]]);
  assert.deepEqual(fake.comments.mine, ["resumed: no longer waiting"]);
});

test("agentStatus off: sessions write notes and the lease only, and no summary task", async () => {
  const fake = fakePaperclip([row("r7", 7)]);
  const { mirror } = mirrorOn(fake, { agentStatus: false });
  await mirror.onSession({ phase: "revise", status: "started", repo: "example/r", items: [item], pr: 3 }, logger());
  assert.deepEqual(fake.comments.r7, ["revising PR #3"]);
  assert.equal(fake.rows.length, 1, "no live task");
  assert.ok(!fake.calls.some((c) => c.path.startsWith("/api/agents/") && c.body && "status" in c.body), "no agent status");
});

test("an implement session drives the agent status; start has no per-issue note; no summary task", async () => {
  const fake = fakePaperclip([row("r7", 7)]);
  const { mirror } = mirrorOn(fake, { agentStatus: true });
  await mirror.onSession({ phase: "implement", status: "started", repo: "example/r", items: [item] }, logger());
  await mirror.onSession({ phase: "implement", status: "failed", repo: "example/r", items: [item], detail: "exit 1" }, logger());
  assert.deepEqual(fake.comments.r7, ["implement session failed: exit 1"]);
  const agentCalls = fake.calls.filter((c) => c.path === `/api/agents/${AGENT}` && c.body && "status" in c.body).map((c) => c.body.status);
  assert.deepEqual(agentCalls, ["running", "idle"]);
  assert.equal(fake.rows.length, 1);
});

// --- release: waiting on the release PR, then done ---

const release = (state, pr, ns) => ({ repo: "example/r", state, pr, productionBranch: "main",
  issues: ns.map((issueNumber) => ({ issueNumber, repo: "example/r" })) });

test("release open → in_review held by the agent; merged → done and stays done", async () => {
  const fake = fakePaperclip([row("r7", 7, { assigneeAgentId: null, assigneeUserId: "user-1" })]);
  const { mirror } = mirrorOn(fake);
  await mirror.onRelease(release("open", 12, [7]), logger());
  assert.equal(fake.rows[0].status, "in_review");
  assert.equal(fake.rows[0].assigneeAgentId, AGENT);
  assert.equal(fake.rows[0].assigneeUserId, null);
  await mirror.onRelease(release("merged", 12, [7]), logger());
  assert.equal(fake.rows[0].status, "done");
  assert.deepEqual(fake.comments.r7, ["waiting on release PR #12 to merge to main", "release PR #12 merged to main"]);
});

test("release closed unmerged is a note; already in production with no PR is done", async () => {
  const fake = fakePaperclip([row("r7", 7, { status: "in_review" }), row("r8", 8)]);
  const { mirror } = mirrorOn(fake);
  await mirror.onRelease(release("closed", 12, [7]), logger());
  assert.equal(fake.rows[0].status, "in_review");
  assert.deepEqual(fake.comments.r7, ["release PR #12 closed without merging; waiting for the next release"]);
  await mirror.onRelease(release("merged", undefined, [8]), logger());
  assert.equal(fake.rows[1].status, "done");
  assert.deepEqual(fake.comments.r8, ["in production (main)"]);
});

// --- projects: new tasks enter Unplaced; the sync places them (EM #513) ---

const UNPLACED = { id: "p-un", name: "Unplaced", description: "roadmap-position: unplaced\nIssues whose epic serves no position." };

test("a created row is filed in the Unplaced project, found by description line 1; no project is created", async () => {
  const fake = fakePaperclip([], [{ id: "p-r", name: "r" }, { id: "p-7", name: "Unplaced", description: "roadmap-position: 7" }, UNPLACED]);
  const { mirror } = mirrorOn(fake, { projects: true });
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onClaim({ issueNumber: 9, repo: "example/r" }, repoConfig, logger());
  assert.deepEqual(fake.rows.map((r) => r.projectId), ["p-un", "p-un"]);
  assert.ok(!fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/projects")));
});

test("no Unplaced project, or two: no task is created, one warn per count, and a later claim looks again", async () => {
  const fake = fakePaperclip([], [{ id: "p-r", name: "r" }]);
  const { mirror, log } = mirrorOn(fake, { projects: true });
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows.length, 0);
  assert.equal(log.lines.filter(([lvl, m]) => lvl === "warn" && /Unplaced project not found: found 0 /.test(m)).length, 1);
  fake.projects.push(UNPLACED, { ...UNPLACED, id: "p-un2" });
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows.length, 0);
  assert.equal(log.lines.filter(([lvl, m]) => lvl === "warn" && /found 2 /.test(m)).length, 1);
  fake.projects.pop();
  await mirror.onClaim(item, repoConfig, logger());
  assert.deepEqual(fake.rows.map((r) => r.projectId), ["p-un"]);
  assert.ok(!fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/projects")));
});

test("housekeep and status moves never write projectId; housekeep cancels the old live task once", async () => {
  const live = { id: "live", status: "in_progress", assigneeAgentId: AGENT, description: `foreman-live: ${AGENT}\n\nbody` };
  const fake = fakePaperclip([row("r7", 7, { projectId: "p-7" }), row("q1", 1, { description: "source: example/q#1" }), live],
    [{ id: "p-7", name: "seven", description: "roadmap-position: 7" }, { id: "p-q", name: "q" }, UNPLACED]);
  const { mirror } = mirrorOn(fake, { projects: true });
  await mirror.housekeep();
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(live.status, "cancelled");
  assert.equal(fake.rows[0].projectId, "p-7", "a placed row stays where the sync put it");
  assert.ok(!fake.calls.some((c) => c.method === "PATCH" && c.body && "projectId" in c.body), "no PATCH carries projectId");
  const before = fake.calls.filter((c) => c.method !== "GET").length;
  await mirror.housekeep();
  assert.equal(fake.calls.filter((c) => c.method !== "GET").length, before, "a second pass writes nothing");
});

test("projects off: no project call, no projectId", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake, { projects: false });
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.housekeep();
  assert.ok(!fake.calls.some((c) => c.path.endsWith("/projects")));
  assert.equal(fake.rows[0].projectId, undefined);
});

test("projectId: every new task goes there, with no Unplaced lookup, and wins over projects", async () => {
  const fake = fakePaperclip([], [UNPLACED]);
  const { mirror } = mirrorOn(fake, { projects: true, projectId: "p-mine" });
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows[0].projectId, "p-mine");
  assert.ok(!fake.calls.some((c) => c.path.endsWith("/projects")));
});

test("projects unset (the parsed default is off): a task is still created, with no project", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0].projectId, undefined);
});

test("taskTitleFormat titles a new task from {repo}, {owner}, {name} and {N}", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake, { taskTitleFormat: "{name} #{N} ({owner}, {repo})" });
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows[0].title, "r #7 (example, example/r)");
  const plain = fakePaperclip();
  await mirrorOn(plain).mirror.onClaim(item, repoConfig, logger());
  assert.equal(plain.rows[0].title, "example/r#7", "unset keeps the old title");
});

test("repos: a repo left out gets no card and no write; a listed one and daemon-wide events still do", async () => {
  const fake = fakePaperclip([row("q1", 1, { description: "source: example/q#1" })]);
  const { mirror } = mirrorOn(fake, { repos: ["example/r"] });
  const other = { issueNumber: 1, repo: "example/q" };
  const writes = () => fake.calls.filter((c) => c.method !== "GET").length;
  await mirror.onEvent({ kind: "claim", item: other }, logger());
  await mirror.onEvent({ kind: "blocked", item: other, reason: "x" }, logger());
  await mirror.onEvent({ kind: "session", session: { phase: "implement", status: "started", repo: "example/q", items: [other] } }, logger());
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/q", items: [] }, logger());
  assert.equal(writes(), 0, "nothing written for the repo left out");
  assert.equal(fake.rows.length, 1);
  await mirror.onEvent({ kind: "claim", item }, logger());
  assert.equal(fake.rows.length, 2, "the listed repo gets its card");
});

// --- board stages: holder, status and one stage label per step ---

const TEAM = {
  roles: { reviewer: { name: "Reviewer", id: "agent-rev" }, lead: { name: "Lead", id: "agent-lead" } },
  board: {
    approved: { owner: "foreman", status: "todo", label: null },
    implementing: { owner: "foreman", status: "in_progress", label: null },
    inReview: { owner: "reviewer", status: "in_review", label: "inReview" },
    reviewing: { owner: "reviewer", status: "in_progress", label: "inReview" },
    changesRequested: { owner: "foreman", status: "todo", label: "changesRequested" },
    revising: { owner: "foreman", status: "in_progress", label: "changesRequested" },
    pendingVerification: { owner: "lead", status: "todo", label: "pendingVerification" },
    awaitingRelease: { owner: "lead", status: "in_review", label: "awaitingRelease" },
  },
};
const labelName = (fake, r) => (r.labelIds ?? []).map((id) => fake.labels.find((l) => l.id === id)?.name).filter((n) => n !== "issue");
const hasIssue = (fake, r) => (r.labelIds ?? []).some((id) => fake.labels.find((l) => l.id === id)?.name === "issue");

test("each step hands the card to its configured agent with exactly one stage label; other labels kept", async () => {
  const fake = fakePaperclip([row("r7", 7, { status: "todo", labelIds: ["keep-me"] })], [], [{ id: "keep-me", name: "bug" }]);
  const { mirror } = mirrorOn(fake, TEAM);
  const r = fake.rows[0];
  const at = () => [r.status, r.assigneeAgentId, labelName(fake, r)];
  await mirror.onState(item, "new", "inReview", repoConfig, logger());
  assert.deepEqual(at(), ["in_review", "agent-rev", ["bug", "In code review"]]);
  await mirror.onState(item, "inReview", "changesRequested", repoConfig, logger());
  assert.deepEqual(at(), ["todo", AGENT, ["bug", "Changes requested"]]);
  await mirror.onState(item, "changesRequested", "approved", repoConfig, logger());
  assert.deepEqual(at(), ["todo", "agent-lead", ["bug", "Awaiting EM verification"]]);
  await mirror.onRelease(release("open", 12, [7]), logger());
  assert.deepEqual(at(), ["in_review", "agent-lead", ["bug", "Awaiting release"]]);
  await mirror.onRelease(release("merged", 12, [7]), logger());
  assert.deepEqual(at(), ["done", "agent-lead", ["bug"]], "done keeps the last holder and drops the stage label");
  assert.equal(fake.labels.length, 12, "the ten stage labels and the issue label created once");
  assert.equal(hasIssue(fake, r), true, "the issue label stays through done");
  assert.equal(r.labelIds.filter((id) => fake.labels.find((l) => l.id === id)?.name === "issue").length, 1, "never twice");
});

test("a review session holds the card in progress under the reviewer, noted by name, and returns it when it ends", async () => {
  const fake = fakePaperclip([row("r7", 7, { status: "in_review", assigneeAgentId: "agent-rev" })]);
  const { mirror } = mirrorOn(fake, TEAM);
  const r = fake.rows[0];
  await mirror.onSession({ phase: "review", status: "started", repo: "example/r", items: [item], pr: 9, reviewer: "Tech Lead" }, logger());
  assert.equal(r.status, "in_progress");
  assert.equal(r.assigneeAgentId, "agent-rev");
  assert.deepEqual(fake.agent.metadata.foremanLive.rows, [{ id: "r7", phase: "review" }]);
  // The verdict lands while the session still runs: kept, applied at the end.
  await mirror.onState(item, "inReview", "approved", repoConfig, logger());
  assert.equal(r.status, "in_progress", "a live session keeps its card in progress");
  await mirror.onSession({ phase: "review", status: "finished", repo: "example/r", items: [item], pr: 9 }, logger());
  assert.equal(r.status, "todo");
  assert.equal(r.assigneeAgentId, "agent-lead");
  assert.deepEqual(labelName(fake, r), ["Awaiting EM verification"]);
  assert.deepEqual(fake.agent.metadata.foremanLive.rows, []);
  assert.ok(fake.comments.r7.includes("Tech Lead reviewing PR #9"));
});

test("a session that starts while Paperclip is down puts its card in progress on the next snapshot", async () => {
  // jerky_service #131, 2026-10-14: the verify session's move failed in a
  // 30-second outage, the hold kept every later writer off the card, and it
  // sat in To Do on the SRE's seat for the whole verification.
  let down = true;
  const fake = fakePaperclip([row("r7", 7, { status: "todo", assigneeAgentId: "agent-rev" })]);
  const flaky = { ...fake, fetch: async (...a) => { if (down) throw new Error("ECONNREFUSED"); return fake.fetch(...a); } };
  const { mirror } = mirrorOn(flaky, { ...TEAM, board: { ...TEAM.board,
    merged: { owner: "reviewer", status: "todo", label: null }, verifying: { owner: "reviewer", status: "in_progress", label: null } } });
  down = false;
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  down = true;
  await mirror.onSession({ phase: "verify", status: "started", repo: "example/r", items: [item], pr: 9, reviewer: "SRE" }, logger());
  assert.equal(fake.rows[0].status, "todo");
  down = false;
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  assert.equal(fake.rows[0].status, "in_progress", "the held card takes its session's column once Paperclip answers");
  assert.equal(fake.rows[0].assigneeAgentId, "agent-rev");
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  assert.equal(fake.rows[0].status, "in_progress", "and the snapshot still leaves a held card alone");
  await mirror.onSession({ phase: "verify", status: "finished", repo: "example/r", items: [item], pr: 9 }, logger());
  assert.equal(fake.rows[0].status, "todo", "the session's end still returns it");
});

test("a session that ends with no verdict returns the card to the stage it came from", async () => {
  const fake = fakePaperclip([row("r7", 7, { status: "todo" })]);
  const { mirror } = mirrorOn(fake, TEAM);
  await mirror.onSession({ phase: "revise", status: "started", repo: "example/r", items: [item], pr: 9 }, logger());
  assert.equal(fake.rows[0].status, "in_progress");
  await mirror.onSession({ phase: "revise", status: "failed", repo: "example/r", items: [item], pr: 9, detail: "exit 1" }, logger());
  assert.equal(fake.rows[0].status, "todo");
  assert.deepEqual(labelName(fake, fake.rows[0]), ["Changes requested"]);
});

test("a restart returns the cards a dead session left in progress, and keeps the agent's other metadata", async () => {
  const fake = fakePaperclip([row("r7", 7), row("r8", 8, { status: "in_review" })]);
  fake.agent.metadata = { other: 1, foremanLive: { leaseAt: new Date().toISOString(), rows: [{ id: "r7", phase: "review" }, { id: "r8", phase: "implement" }] } };
  const { mirror } = mirrorOn(fake, TEAM);
  await mirror.recoverLease();
  assert.equal(fake.rows[0].status, "in_review", "r7 back to in review");
  assert.equal(fake.rows[0].assigneeAgentId, "agent-rev");
  assert.equal(fake.rows[1].status, "in_review", "a card no longer in progress is left alone");
  assert.equal(fake.agent.metadata.other, 1);
  assert.deepEqual(fake.agent.metadata.foremanLive.rows, []);
});

test("a key set on the agent while the Foreman runs survives its next lease write", async () => {
  const fake = fakePaperclip([row("r7", 7, { status: "in_review", assigneeAgentId: "agent-rev" })]);
  const { mirror } = mirrorOn(fake, TEAM);
  await mirror.recoverLease();
  fake.agent.metadata = { ...fake.agent.metadata, githubLogin: "slashbin-foreman" };
  await mirror.onSession({ phase: "review", status: "started", repo: "example/r", items: [item], pr: 9, reviewer: "Tech Lead" }, logger());
  assert.equal(fake.agent.metadata.githubLogin, "slashbin-foreman");
  assert.deepEqual(fake.agent.metadata.foremanLive.rows, [{ id: "r7", phase: "review" }]);
});

test("no labels endpoint: the status still moves, and the failure is logged once", async () => {
  const base = fakePaperclip([row("r7", 7, { status: "todo" })]);
  const fake = { ...base, fetch: async (url, init) => (new URL(url).pathname.endsWith("/labels")
    ? new Response(JSON.stringify({ error: "no labels" }), { status: 404 }) : base.fetch(url, init)) };
  const { mirror, log } = mirrorOn(fake, TEAM);
  await mirror.onState(item, "new", "inReview", repoConfig, logger());
  await mirror.onState(item, "inReview", "changesRequested", repoConfig, logger());
  assert.equal(base.rows[0].status, "todo");
  assert.equal(log.lines.filter(([lvl]) => lvl === "warn").length, 1);
});

// --- Summaries on the card's thread (Foreman issue 74) ---

const rich = (extra = {}) => ({ comments: { enabled: true, events: {}, maxLength: 3000, includeDiffStat: true, ...extra } });
const implSession = (status, extra = {}) => ({ phase: "implement", status, repo: "example/r", items: [item], ...extra });

test("summaries: implement start names the goal, implement end carries PR, diff stat and the agent's summary, notes held meanwhile follow it", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake, rich());
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onSession(implSession("started", { report: { goals: { 7: "Add the widget endpoint" } } }), logger());
  await mirror.onPrLink(item, "https://github.com/example/r/pull/9", repoConfig, logger());
  await mirror.onState(item, "new", "inReview", repoConfig, logger());
  await mirror.onSession(implSession("finished", {
    detail: "PR https://github.com/example/r/pull/9",
    report: {
      text: "Added GET /widgets.\n\nTests: 12 passed.\nFOREMAN_IMPL issue=#7",
      pr: { number: 9, url: "https://github.com/example/r/pull/9", title: "feat: widgets", additions: 40, deletions: 3, changedFiles: 2 },
    },
  }), logger());
  assert.deepEqual(fake.comments["row-1"], [
    "**Foreman started implementing**\n\nGoal: Add the widget endpoint",
    "**Implementation finished** — [PR #9](https://github.com/example/r/pull/9): feat: widgets\n\nDiff: 2 files, +40 −3\n\nAdded GET /widgets.\n\nTests: 12 passed.",
    "under review",
  ]);
  assert.equal(fake.rows[0].status, "in_review", "the state reported during the session applies when it ends");
});

test("summaries: review end gives the verdict, merge/deploy and findings; the merged note it covers is dropped", async () => {
  const fake = fakePaperclip([{ id: "r7", status: "in_review", description: "source: example/r#7" }]);
  const { mirror } = mirrorOn(fake, rich());
  const ev = (status, extra = {}) => ({ phase: "review", status, repo: "example/r", pr: 9, items: [item], reviewer: "Tech Lead", ...extra });
  await mirror.onSession(ev("started"), logger());
  await mirror.onState(item, "inReview", "approved", repoConfig, logger());
  await mirror.onMerged(item, repoConfig, logger());
  await mirror.onSession(ev("finished", { report: { review: {
    verdict: "APPROVE", merged: true, deploy: "NA", summary: "Meets the acceptance matrix.",
    findings: [{ severity: "S4", title: "Fixture uses names", where: "tests/a.test.ts:12" }],
  } } }), logger());
  assert.deepEqual(fake.comments.r7, [
    "**Tech Lead reviewing PR #9**",
    "**Tech Lead review: APPROVE** — PR #9 merged · no deploy\n\nMeets the acceptance matrix.\n\n- **S4** · Fixture uses names — `tests/a.test.ts:12`",
    "approved",
  ]);
});

test("summaries: a revision end says what was addressed; a no-commit one says why", async () => {
  const fake = fakePaperclip([{ id: "r7", status: "todo", description: "source: example/r#7" }]);
  const { mirror } = mirrorOn(fake, rich());
  const ev = (status, extra = {}) => ({ phase: "revise", status, repo: "example/r", pr: 9, items: [item], ...extra });
  await mirror.onSession(ev("started"), logger());
  await mirror.onSession(ev("finished", { detail: "changes pushed, back to review", report: { text: "Addressed S2: rows now show dataStreamId." } }), logger());
  await mirror.onSession(ev("started"), logger());
  await mirror.onSession(ev("finished", { detail: "no commit: branch already correct" }), logger());
  assert.deepEqual(fake.comments.r7, [
    "**Revising PR #9** after review feedback",
    "**Revision pushed** — PR #9, back to review\n\nAddressed S2: rows now show dataStreamId.",
    "**Revising PR #9** after review feedback",
    "**Revision: no change made** — PR #9\n\nbranch already correct",
  ]);
});

test("no note twice in a row: a repeated release note is dropped, across a restart too", async () => {
  const fake = fakePaperclip([{ id: "r7", status: "in_review", description: "source: example/r#7" }]);
  const open = { repo: "example/r", state: "open", pr: 371, issues: [item], productionBranch: "main" };
  for (let i = 0; i < 3; i++) await mirrorOn(fake, rich()).mirror.onRelease(open, logger());
  const { mirror } = mirrorOn(fake, rich());
  await mirror.onRelease(open, logger());
  await mirror.onRelease(open, logger());
  assert.deepEqual(fake.comments.r7, ["waiting on release PR #371 to merge to main"]);
});

test("summaries are capped and redacted (known secrets and token shapes)", async () => {
  const fake = fakePaperclip([{ id: "r7", status: "todo", description: "source: example/r#7" }]);
  const { mirror } = mirrorOn(fake, rich({ maxLength: 300 }));
  const text = `Used ghp_${"a".repeat(36)} and ${SECRET.value}; API_TOKEN=abcdef123456789 ok.\n\n${"x ".repeat(400)}`;
  await mirror.onSession(implSession("finished", { detail: "commits added to the open PR", report: { text } }), logger());
  const [c] = fake.comments.r7;
  assert.ok(c.length <= 300, `capped: ${c.length}`);
  assert.ok(c.endsWith("… (truncated)"));
  assert.ok(!c.includes("ghp_aaa") && !c.includes(SECRET.value) && !c.includes("abcdef123456789"), c);
});

test("comment toggles: an event turned off posts nothing; enabled false gives the one-line notes", async () => {
  const fake = fakePaperclip([{ id: "r7", status: "in_review", description: "source: example/r#7" }]);
  const { mirror } = mirrorOn(fake, rich({ events: { reviewStart: false, progress: false } }));
  const ev = (status, extra = {}) => ({ phase: "review", status, repo: "example/r", pr: 9, items: [item], reviewer: "Tech Lead", ...extra });
  await mirror.onSession(ev("started"), logger());
  await mirror.onState(item, "inReview", "approved", repoConfig, logger());
  await mirror.onSession(ev("finished", { detail: "#9 APPROVE · merged" }), logger());
  assert.deepEqual(fake.comments.r7, ["**Review finished** — PR #9\n\n#9 APPROVE · merged"]);
  assert.equal(fake.rows[0].status, "in_review", "the card still moves (approved → pending verification bucket)");

  const fake2 = fakePaperclip();
  const legacy = mirrorOn(fake2, { comments: { enabled: false } }).mirror;
  await legacy.onClaim(item, repoConfig, logger());
  await legacy.onSession(implSession("started", { report: { goals: { 7: "g" } } }), logger());
  assert.deepEqual(fake2.comments["row-1"], ["picked up by Foreman"]);
});

// --- Snapshot: the board follows GitHub's labels (jerky_service #73, 2026-10-05) ---

const ghRepo = { ...repoConfig, lifecycleLabels: defaultLifecycleLabels(), triggerLabel: "approved" };
// What the GitHub connector's snapshot() hands the mirror for these labels: the
// stage each issue is in, the labels as the note's detail; unlabeled issues dropped.
const snap = (issues, held = []) => issues.flatMap(({ number, labels }) => {
  const stage = issueStage(labels, false, ghRepo.lifecycleLabels, ghRepo.triggerLabel);
  return stage === null ? [] : [{ item: { issueNumber: number, repo: "example/r" }, stage, detail: labels.join(", ") || "none",
    ...(held.includes(number) ? { verifyHeld: true } : {}) }];
});
const row7 = (status, extra = {}) => ({ id: "r7", title: "t", status, assigneeAgentId: AGENT, description: "source: example/r#7", ...extra });

test("snapshot: a card in the wrong column moves to the one its labels call for, with a note", async () => {
  const fake = fakePaperclip([row7("todo")]);
  const { mirror } = mirrorOn(fake);
  const log = logger();
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved", "pr under review"] }]), log);
  assert.equal(fake.rows[0].status, "in_review");
  assert.deepEqual(fake.comments.r7, ["moved to match GitHub: approved, pr under review"]);
  assert.ok(log.lines.some(([, m]) => /todo → in_review to match GitHub/.test(m)));
});

test("snapshot: a card already in its column is not written", async () => {
  const fake = fakePaperclip([row7("in_review")]);
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr approved"] }]), logger());
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  assert.equal(statusPatches(fake).length, 0);
});

test("snapshot: an old Foreman block is released once GitHub moved past approved, kept while it has not", async () => {
  const fake = fakePaperclip([
    row7("blocked", { unblockDescriptor: { action: "blocked: dev verification did not pass" } }),
    { id: "r8", title: "t", status: "blocked", assigneeAgentId: AGENT, description: "source: example/r#8", unblockDescriptor: { action: "blocked: open feature PR" } },
  ]);
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }, { number: 8, labels: ["approved"] }]), logger());
  assert.equal(fake.rows[0].status, "in_review");
  assert.equal(fake.rows[1].status, "blocked");
});

test("snapshot: a block GitHub's blocked label made is released when the label goes (jerky_service #132/#133)", async () => {
  const fake = fakePaperclip([row7("todo")]);
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved", "blocked"] }]), logger());
  assert.equal(fake.rows[0].status, "blocked", "the label blocks it");
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved"] }]), logger());
  assert.equal(fake.rows[0].status, "todo", "the label is gone: back to the queue");
});

test("snapshot: after a restart, a label-made block (its last note the sync note) is released; a Foreman block is kept", async () => {
  const fake = fakePaperclip([
    row7("blocked", { unblockDescriptor: { action: "blocked: needs attention" } }),
    { id: "r8", title: "t", status: "blocked", assigneeAgentId: AGENT, description: "source: example/r#8", unblockDescriptor: { action: "blocked: skipped: waiting on #5" } },
  ]);
  fake.comments.r7 = ["queued", "moved to match GitHub: feature, blocked, approved"];
  fake.comments.r8 = ["blocked: skipped: waiting on #5"];
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved"] }, { number: 8, labels: ["approved"] }]), logger());
  assert.equal(fake.rows[0].status, "todo");
  assert.equal(fake.rows[1].status, "blocked");
});

test("snapshot: after a restart, a label-made block is released though a later run note buried the sync note (jerky_service #132/#133)", async () => {
  const fake = fakePaperclip([
    row7("blocked", { unblockDescriptor: { action: "blocked: needs attention" } }),
    { id: "r8", title: "t", status: "blocked", assigneeAgentId: AGENT, description: "source: example/r#8", unblockDescriptor: { action: "blocked: skipped: waiting on #5" } },
  ]);
  fake.comments.r7 = ["moved to match GitHub: feature, blocked, approved", "**Foreman started implementing**\n\nHanded this run with #8 — a run builds one of them."];
  fake.comments.r8 = ["blocked: skipped: waiting on #5", "**Foreman started implementing**"];
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved"] }, { number: 8, labels: ["approved"] }]), logger());
  assert.equal(fake.rows[0].status, "todo", "the label is gone: back to the queue");
  assert.equal(fake.rows[1].status, "blocked", "a Foreman block names its reason and stays");
});

test("snapshot: a seat's escalation hop holds the card across cycles, then GitHub moving on releases it (Foreman #98, SLA-1873)", async () => {
  const PO = "agent-po";
  const hop = { owner: { agentId: PO }, action: "Escalation in progress (process.escalate hand_up): Product Owner holds this card until it is resolved or returned down the chain." };
  const fake = fakePaperclip([row7("blocked", { assigneeAgentId: PO, unblockDescriptor: hop })]);
  fake.comments.r7 = ["<!-- process.escalate:eyJ9 -->"];
  const { mirror } = mirrorOn(fake);
  for (let i = 0; i < 3; i++) {
    await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr approved"] }]), logger());
    assert.equal(fake.rows[0].status, "blocked", `cycle ${i + 1}: the hop was undone`);
    assert.equal(fake.rows[0].assigneeAgentId, PO, `cycle ${i + 1}: the resolver lost the card`);
  }
  assert.equal(statusPatches(fake).length, 0);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  assert.notEqual(fake.rows[0].status, "blocked", "GitHub moved to another stage: the card follows it");
});

test("snapshot: a card blocked at pr merged stays Blocked while its dev verification is held", async () => {
  const fake = fakePaperclip([row7("blocked", { unblockDescriptor: { action: "blocked: dev verification did not pass" } })]);
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }], [7]), logger());
  assert.equal(fake.rows[0].status, "blocked", "a held verify is still waiting on a person");
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr approved"] }]), logger());
  assert.equal(fake.rows[0].status, "in_review", "released once GitHub moves on");
});

test("snapshot: a block made this run stands until the issue moves on, then is released", async () => {
  const fake = fakePaperclip([row7("in_review")]);
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  await mirror.onBlocked(item, "dev verification did not pass; retrying in 60 min", ghRepo, logger());
  assert.equal(fake.rows[0].status, "blocked");
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  assert.equal(fake.rows[0].status, "blocked", "the snapshot undid a block the Foreman just made");
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr approved"] }]), logger());
  assert.equal(fake.rows[0].status, "in_review");
});

test("snapshot: leaves a session-held card, a waiting hold, a cancelled card and an unlabeled issue alone", async () => {
  const fake = fakePaperclip([
    row7("todo"),
    { id: "r8", title: "t", status: "blocked", assigneeAgentId: AGENT, description: "source: example/r#8", unblockDescriptor: { action: "occupied by PR #4" } },
    { id: "r9", title: "t", status: "cancelled", assigneeAgentId: AGENT, description: "source: example/r#9" },
    { id: "r10", title: "t", status: "todo", assigneeAgentId: AGENT, description: "source: example/r#10" },
  ]);
  const { mirror } = mirrorOn(fake);
  await mirror.onSession({ phase: "implement", status: "started", repo: "example/r", items: [item] }, logger());
  const before = statusPatches(fake).length;
  await onSnap(mirror, "example/r", snap([
    { number: 7, labels: ["pr under review"] },
    { number: 8, labels: ["pr under review"] },
    { number: 9, labels: ["approved", "pr under review"] },
    { number: 10, labels: ["bug"] },
  ]), logger());
  assert.equal(statusPatches(fake).length, before);
});

test("snapshot: an issue with no card gets none", async () => {
  const fake = fakePaperclip([]);
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved"] }]), logger());
  assert.equal(fake.rows.length, 0);
});


test("unblock: a Foreman block resolved by a check returns the card to its GitHub column at once", async () => {
  const fake = fakePaperclip([row7("in_review")]);
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  await mirror.onBlocked(item, "dev verification did not pass; no more retries", ghRepo, logger());
  assert.equal(fake.rows[0].status, "blocked");
  await mirror.onUnblocked(item, "unblocked: new commits landed on the base branch", ghRepo, logger());
  assert.equal(fake.rows[0].status, "in_review");
});

test("unblock: leaves a card that is not Blocked alone", async () => {
  const fake = fakePaperclip([row7("in_review")]);
  const { mirror } = mirrorOn(fake);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  const before = statusPatches(fake).length;
  await mirror.onUnblocked(item, "unblocked: x", ghRepo, logger());
  assert.equal(statusPatches(fake).length, before);
});

test("a 401 that echoes the Paperclip key is logged with the key redacted (EM#512)", async () => {
  const KEY = "pcak_test_0123456789";
  const fake = fakePaperclip([{ id: "synced", title: "t", status: "todo", description: "source: example/r#7" }]);
  const refuse = async (url, init = {}) => (init.method === "PATCH"
    ? new Response(JSON.stringify({ error: `key ${KEY} is not valid` }), { status: 401 }) : fake.fetch(url, init));
  const cfg = { enabled: true, url: "http://pc.test", companyId: CID, agentId: AGENT, agentName: "Foreman",
    identityKeyFormat: "source: {repo}#{N}", comments: { enabled: false }, apiKey: KEY };
  const log = logger();
  const client = new PaperclipClient({ url: cfg.url, companyId: CID, apiKey: KEY, fetch: refuse });
  const mirror = new PaperclipMirror(client, cfg, [SECRET, { name: "AI_AGENT_PAPERCLIP_API_KEY", value: KEY }], log);
  await mirror.onClaim(item, repoConfig, logger());
  const warns = log.lines.filter(([lvl]) => lvl === "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0][1], /401/);
  assert.ok(!warns[0][1].includes(KEY), warns[0][1]);
  assert.match(warns[0][1], /\[REDACTED:AI_AGENT_PAPERCLIP_API_KEY\]/);
});

// A run handed two issues builds one. The other was never touched, and telling
// it "Implementation failed" sent a reader to debug work that was never tried
// (slashbin_mcp_services #237, 2026-10-09).
test("summaries: an implement end tells its outcome only to the item it worked; the other is told it was not built", async () => {
  const item8 = { ...item, issueNumber: 8 };
  const fake = fakePaperclip([row("r7", 7, { status: "todo" }), row("r8", 8, { status: "todo" })]);
  const { mirror } = mirrorOn(fake, rich());
  const ev = (status, extra = {}) => ({ phase: "implement", status, repo: "example/r", items: [item, item8], ...extra });
  await mirror.onSession(ev("started"), logger());
  await mirror.onSession(ev("failed", { detail: "PR exists but has no file changes", worked: [7] }), logger());
  await mirror.onSession(ev("started"), logger());
  await mirror.onSession(ev("finished", { detail: "PR https://github.com/example/r/pull/9", worked: [7] }), logger());
  assert.deepEqual(fake.comments.r7, [
    "**Foreman started implementing**\n\nHanded this run with #8 — a run builds one of them.",
    "**Implementation failed** — PR exists but has no file changes",
    "**Foreman started implementing**\n\nHanded this run with #8 — a run builds one of them.",
    "**Implementation finished** — PR https://github.com/example/r/pull/9",
  ]);
  assert.deepEqual(fake.comments.r8.filter((c) => !c.startsWith("**Foreman started")), [
    "**Not built this run** — the run failed on #7; this issue waits for a later run",
    "**Not built this run** — the run built #7; this issue waits for a later run",
  ]);
});

test("step notes: an untouched item gets no implement-end note", async () => {
  const item8 = { ...item, issueNumber: 8 };
  const fake = fakePaperclip([row("r7", 7, { status: "todo" }), row("r8", 8, { status: "todo" })]);
  const { mirror } = mirrorOn(fake, TEAM);
  const ev = (status, extra = {}) => ({ phase: "implement", status, repo: "example/r", items: [item, item8], ...extra });
  await mirror.onSession(ev("started"), logger());
  await mirror.onSession(ev("failed", { detail: "exit 1", worked: [7] }), logger());
  assert.equal((fake.comments.r7 ?? []).length - (fake.comments.r8 ?? []).length, 1, "only the worked item carries the failure note");
});

test("escalated: the card parks Blocked in the EM's hands until revision resumes", async () => {
  const fake = fakePaperclip([row7("todo")]);
  const board = { ...paperclipBoardDefaults().board, needsRuling: { ...paperclipBoardDefaults().board.needsRuling, owner: "em" } };
  const { mirror } = mirrorOn(fake, { agentStatus: false, roles: { em: { id: "em-agent" } }, board });
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved", "pr pending actions"] }]), logger());
  await mirror.onEvent({ kind: "escalated", item, reason: "PR #3 has been sent back 4 times. EM: run /rule-on-scope" }, logger());
  const r = fake.rows[0];
  assert.equal(r.status, "blocked", "blocked, so a board sync leaves it alone and the EM's inbox lists it");
  assert.equal(r.assigneeAgentId, "em-agent");
  assert.equal(r.unblockDescriptor.owner.agentId, "em-agent");
  assert.match(r.unblockDescriptor.action, /^blocked: needs an EM scope ruling: PR #3/);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved", "pr pending actions"] }]), logger());
  assert.equal(r.status, "blocked", "the snapshot undid the escalation");
  await mirror.onSession({ phase: "revise", status: "started", repo: "example/r", pr: 3, items: [item] }, logger());
  assert.equal(r.status, "in_progress", "the revision after the ruling takes the card back");
  assert.equal(r.assigneeAgentId, AGENT);
});

test("escalated: a snapshot taken before the review that tipped it does not release the hold", async () => {
  const fake = fakePaperclip([row7("todo")]);
  const board = { ...paperclipBoardDefaults().board, needsRuling: { ...paperclipBoardDefaults().board.needsRuling, owner: "em" } };
  const { mirror } = mirrorOn(fake, { agentStatus: false, roles: { em: { id: "em-agent" } }, board });
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved", "pr under review"] }]), logger());
  await mirror.onEvent({ kind: "escalated", item, reason: "PR #3 has been sent back 4 times. EM: run /rule-on-scope" }, logger());
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved", "pr pending actions"] }]), logger());
  const r = fake.rows[0];
  assert.equal(r.status, "blocked", "the review's own label move read as the issue moving on");
  assert.equal(r.assigneeAgentId, "em-agent");
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["pr merged"] }]), logger());
  assert.notEqual(r.status, "blocked", "an issue that really moves on still releases the hold");
});

test("escalated: the EM's wake checking the card out does not release the hold", async () => {
  const fake = fakePaperclip([row7("todo")]);
  const board = { ...paperclipBoardDefaults().board, needsRuling: { ...paperclipBoardDefaults().board.needsRuling, owner: "em" } };
  const { mirror } = mirrorOn(fake, { agentStatus: false, roles: { em: { id: "em-agent" } }, board });
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved", "pr pending actions"] }]), logger());
  await mirror.onEvent({ kind: "escalated", item, reason: "PR #3 has been sent back 4 times. EM: run /rule-on-scope" }, logger());
  const r = fake.rows[0];
  r.status = "in_progress";
  await mirror.ensureIndex(true);
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved", "pr pending actions"] }]), logger());
  assert.equal(r.status, "in_progress", "the snapshot moved a card the EM is working");
  assert.equal(r.assigneeAgentId, "em-agent", "the snapshot took the card off the EM");
  await mirror.onSession({ phase: "revise", status: "started", repo: "example/r", pr: 3, items: [item] }, logger());
  assert.equal(r.assigneeAgentId, AGENT, "the revision after the ruling takes the card back");
});

test("escalated with no roles configured stays with the Foreman", async () => {
  const fake = fakePaperclip([row7("todo")]);
  const { mirror } = mirrorOn(fake, { agentStatus: false });
  await mirror.onEvent({ kind: "escalated", item, reason: "x" }, logger());
  assert.equal(fake.rows[0].status, "blocked");
  assert.equal(fake.rows[0].assigneeAgentId, AGENT);
});

test("escalated at approved (a skip out of attempts): the issue still at approved keeps the hold", async () => {
  const fake = fakePaperclip([row7("todo")]);
  const board = { ...paperclipBoardDefaults().board, needsRuling: { ...paperclipBoardDefaults().board.needsRuling, owner: "em" } };
  const { mirror } = mirrorOn(fake, { agentStatus: false, roles: { em: { id: "em-agent" } }, board });
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved"] }]), logger());
  await mirror.onEvent({ kind: "escalated", item, reason: "x — skipped 3 times in a row; held for the EM until this issue changes", at: "approved" }, logger());
  await onSnap(mirror, "example/r", snap([{ number: 7, labels: ["approved"] }]), logger());
  const r = fake.rows[0];
  assert.equal(r.status, "blocked", "anchored at changesRequested, the approved issue read as moved on");
  assert.equal(r.assigneeAgentId, "em-agent");
});

test("an owned release PR's open keeps its items releasing on the deployer's seat (jerky_service PR #146)", async () => {
  const team = { roles: { ...TEAM.roles, sre: { name: "SRE", id: "agent-sre" } },
    board: { ...TEAM.board, releasing: { owner: "sre", status: "in_progress", label: "releasing" } } };
  const fake = fakePaperclip([row("r7", 7, { status: "in_progress", assigneeAgentId: "agent-sre" })]);
  const { mirror } = mirrorOn(fake, team);
  const r = fake.rows[0];
  await mirror.onRelease({ ...release("open", 12, [7]), owned: true }, logger());
  assert.deepEqual([r.status, r.assigneeAgentId, labelName(fake, r)], ["in_progress", "agent-sre", ["Releasing"]]);
  await mirror.onRelease(release("open", 12, [7]), logger());
  assert.deepEqual([r.status, r.assigneeAgentId], ["in_review", "agent-lead"], "a release PR the stage does not own still waits");
});

// --- the published config: one source for anything else that places the same cards ---

test("the loaded config is published on the agent, less its trailing newline, beside the lease and other keys", async () => {
  const { createHash } = await import("node:crypto");
  const fake = fakePaperclip();
  fake.agent.metadata = { other: 1 };
  const { mirror, log } = mirrorOn(fake);
  const text = JSON.stringify({ repos: [], paperclip: { board: { inReview: { owner: "em" } } } }, null, 2) + "\n";
  await mirror.publishConfig(text);
  const pub = fake.agent.metadata.foremanConfig;
  assert.equal(pub.text, text.trimEnd());
  assert.equal(pub.sha256, createHash("sha256").update(text.trimEnd()).digest("hex"));
  assert.equal(fake.agent.metadata.other, 1);
  assert.deepEqual(fake.agent.metadata.foremanLive.rows, []);
  assert.ok(log.lines.some(([, m]) => m.startsWith("paperclip: published config sha256=")));
  const writes = () => fake.calls.filter((c) => c.method === "PATCH" && c.path === `/api/agents/${AGENT}`).length;
  const before = writes();
  await mirror.publishConfig(text);
  assert.equal(writes(), before, "unchanged text writes nothing");
  // A lease renewal keeps the published config.
  await mirror.onSession({ phase: "review", status: "started", repo: "example/r", items: [item], pr: 9 }, logger());
  assert.equal(fake.agent.metadata.foremanConfig.sha256, pub.sha256);
});

test("a config holding a secret is never published", async () => {
  for (const text of [
    JSON.stringify({ paperclip: { apiKey: "pk_live_abc" } }),
    JSON.stringify({ note: `x ${SECRET.value} y` }),
  ]) {
    const fake = fakePaperclip();
    const { mirror, log } = mirrorOn(fake);
    await mirror.publishConfig(text);
    assert.equal(fake.agent.metadata.foremanConfig, undefined);
    const warn = log.lines.find(([lvl]) => lvl === "warn")?.[1] ?? "";
    assert.match(warn, /^paperclip: config not published: /);
    assert.ok(!warn.includes(SECRET.value) && !warn.includes("pk_live_abc"), "the warning names the key, never the value");
  }
});

test("publishConfig: false publishes nothing", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake, { publishConfig: false });
  await mirror.publishConfig("{}");
  assert.equal(fake.calls.length, 0);
});

test("a reload moves the board mapping; one that renames the agent is refused until a restart", async () => {
  const fake = fakePaperclip([row("r7", 7, { status: "todo" })]);
  const base = { enabled: true, url: "http://pc.test", companyId: CID, agentId: AGENT, agentName: "Foreman",
    identityKeyFormat: "source: {repo}#{N}", comments: { enabled: false } };
  const { mirror, log } = mirrorOn(fake, TEAM);
  const leadReviews = { ...base, ...TEAM, board: { ...TEAM.board, inReview: { owner: "lead", status: "in_review", label: "inReview" } } };
  assert.equal(mirror.reconfigure(leadReviews), true);
  await mirror.onState(item, "new", "inReview", repoConfig, logger());
  assert.equal(fake.rows[0].assigneeAgentId, "agent-lead");
  assert.equal(mirror.reconfigure({ ...leadReviews, agentId: "agent-2" }), false);
  assert.match(log.lines.find(([lvl]) => lvl === "warn")[1], /changes agentId; restart the Foreman/);
});

// --- One writer per card: `ownsCards` (jerky_ops#11, 2026-10-15) -------------------

const OWNED = { ownsCards: true };
const URL7 = "https://github.com/example/r/issues/7";
const card = (n, extra = {}) => ({ item: { issueNumber: n, repo: "example/r" }, title: `issue ${n}`, url: `https://github.com/example/r/issues/${n}`, state: "open", stage: null, ...extra });
const ownedRow = (status, extra = {}) => row7(status, { title: "r#7 issue 7", description: `source: example/r#7\nGitHub: open · not approved\n\n${URL7}`, ...extra });

test("adoption: of two rows for one issue the card is the oldest open one, whatever order they list in", async () => {
  const fake = fakePaperclip([
    { id: "late", title: "t", status: "todo", description: "source: example/r#7", createdAt: "2026-10-15T10:00:05Z" },
    { id: "early-cancelled", title: "t", status: "cancelled", description: "source: example/r#7", createdAt: "2026-10-15T10:00:00Z" },
    { id: "early", title: "t", status: "backlog", description: "source: example/r#7", createdAt: "2026-10-15T10:00:01Z" },
  ]);
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  assert.equal(fake.rows.find((r) => r.id === "early").status, "in_progress");
  assert.equal(fake.rows.find((r) => r.id === "late").status, "todo");
});

test("ownsCards off: the snapshot's cards are not asked for and nothing is created", async () => {
  const fake = fakePaperclip([]);
  const { mirror } = mirrorOn(fake);
  assert.equal(mirror.wantsCards(), false);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7)] }, logger());
  assert.equal(fake.rows.length, 0);
});

test("ownsCards: an open issue with no card gets one — not approved: backlog, nobody's, titled and described from GitHub", async () => {
  const fake = fakePaperclip([]);
  const { mirror } = mirrorOn(fake, OWNED);
  assert.equal(mirror.wantsCards(), true);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7)] }, logger());
  assert.equal(fake.rows.length, 1);
  const r = fake.rows[0];
  assert.equal(r.status, "backlog");
  assert.equal(r.title, "r#7 issue 7");
  assert.equal(r.description, `source: example/r#7\nGitHub: open · not approved\n\n${URL7}`);
  assert.equal(r.assigneeAgentId, undefined);
  // The next cycle finds it as it should be and writes nothing.
  const writes = fake.calls.filter((c) => c.method !== "GET").length;
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7)] }, logger());
  assert.equal(fake.calls.filter((c) => c.method !== "GET").length, writes);
});

test("ownsCards: an approved issue's new card is placed by the lifecycle pass in the same cycle", async () => {
  const fake = fakePaperclip([]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: snap([{ number: 7, labels: ["approved", "pr under review"] }]),
    cards: [card(7, { stage: "inReview" })] }, logger());
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0].status, "in_review");
  assert.equal(fake.rows[0].description.split("\n")[1], "GitHub: open · stage inReview");
});

test("ownsCards: the issue label backfills onto cards whose content and stage did not change, once, keeping other labels", async () => {
  const fake = fakePaperclip([
    ownedRow("backlog", { labelIds: ["keep-me"] }),
    { id: "r8", title: "r#8 issue 8", status: "done", assigneeAgentId: AGENT, description: "source: example/r#8\nGitHub: closed completed\n\nhttps://github.com/example/r/issues/8" },
  ], [], [{ id: "keep-me", name: "bug" }]);
  const { mirror } = mirrorOn(fake, OWNED);
  const cards = [card(7), card(8, { state: "completed" })];
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards }, logger());
  assert.deepEqual(fake.rows.map((r) => labelName(fake, r)), [["bug"], []]);
  assert.deepEqual(fake.rows.map((r) => hasIssue(fake, r)), [true, true]);
  assert.equal(fake.rows[0].status, "backlog", "nothing else changed");
  const writes = fake.calls.filter((c) => c.method !== "GET").length;
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards }, logger());
  assert.equal(fake.calls.filter((c) => c.method !== "GET").length, writes, "written once, never again");
  assert.equal(fake.rows[0].labelIds.filter((id) => fake.labels.find((l) => l.id === id)?.name === "issue").length, 1);
});

test("ownsCards: housekeeping labels cards the snapshot no longer carries (old closed) and those past its write cap; unserved repos' cards untouched", async () => {
  const old = { id: "old", title: "r#99 old", status: "done", assigneeAgentId: AGENT, description: "source: example/r#99\nGitHub: closed completed\n\nhttps://github.com/example/r/issues/99" };
  const other = { id: "other", title: "x#1", status: "todo", description: "source: example/other#1\n\nhttps://github.com/example/other/issues/1" };
  const fake = fakePaperclip([ownedRow("backlog"), old, other]);
  const { mirror } = mirrorOn(fake, OWNED);
  // example/r is served (a snapshot named it); example/other never is.
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [] }, logger());
  await mirror.housekeep();
  assert.equal(hasIssue(fake, fake.rows.find((r) => r.id === "old")), true, "older closed card labelled by housekeeping");
  assert.equal(hasIssue(fake, fake.rows.find((r) => r.id === "other")), false, "an unserved repo's card is not ours");
  assert.equal(fake.rows.find((r) => r.id === "old").status, "done", "status kept");
  const writes = fake.calls.filter((c) => c.method !== "GET").length;
  await mirror.housekeep();
  assert.equal(fake.calls.filter((c) => c.method !== "GET").length, writes, "once");
});

test("ownsCards off: no issue label is created or written", async () => {
  const fake = fakePaperclip([ownedRow("backlog")]);
  const { mirror } = mirrorOn(fake);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7)] }, logger());
  assert.equal(fake.labels.some((l) => l.name === "issue"), false);
});

test("ownsCards: title and description follow the issue; an unapproved card held by an agent goes to backlog, nobody's", async () => {
  const fake = fakePaperclip([row7("todo", { title: "example/r#7", description: `source: example/r#7\n\n${URL7}` })]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7)] }, logger());
  const r = fake.rows[0];
  assert.equal(r.title, "r#7 issue 7");
  assert.equal(r.description, `source: example/r#7\nGitHub: open · not approved\n\n${URL7}`);
  assert.equal(r.status, "backlog");
  assert.equal(r.assigneeAgentId, null);
  assert.equal(r.assigneeUserId, null);
});

test("ownsCards: a closed issue's card is done, or cancelled when not planned; its holder kept", async () => {
  const fake = fakePaperclip([
    ownedRow("in_review"),
    { id: "r8", title: "r#8 issue 8", status: "todo", assigneeAgentId: AGENT, description: "source: example/r#8\nGitHub: closed not_planned\n\nhttps://github.com/example/r/issues/8" },
  ]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7, { state: "completed" }), card(8, { state: "not_planned" })] }, logger());
  assert.equal(fake.rows[0].status, "done");
  assert.equal(fake.rows[0].assigneeAgentId, AGENT);
  assert.equal(fake.rows[0].description.split("\n")[1], "GitHub: closed completed");
  assert.equal(fake.rows[1].status, "cancelled");
});

test("ownsCards: a closed issue with no card gets none; a cancelled card of an open issue is left alone", async () => {
  const fake = fakePaperclip([{ id: "r8", title: "t", status: "cancelled", description: "source: example/r#8" }]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7, { state: "completed" }), card(8)] }, logger());
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0].status, "cancelled");
});

const HOLD = {
  action: "blocked: on GitHub — waiting on legal (ray, 2026-10-14) https://github.com/example/r/issues/7#c2",
  comment: "Held on GitHub by ray, 2026-10-14:\n\nwaiting on legal\n\nhttps://github.com/example/r/issues/7#c2",
  commentUrl: "https://github.com/example/r/issues/7#c2",
};

test("ownsCards: a held issue's card enters Blocked with the holder's reason, and their comment is copied once", async () => {
  const fake = fakePaperclip([ownedRow("todo", { description: `source: example/r#7\nGitHub: open · stage blocked\n\n${URL7}` })]);
  const { mirror } = mirrorOn(fake, OWNED);
  const ev = { kind: "snapshot", states: allOpen, repo: "example/r", items: snap([{ number: 7, labels: ["approved", "blocked"] }]), cards: [card(7, { stage: "blocked", hold: HOLD })] };
  await mirror.onEvent(ev, logger());
  assert.equal(fake.rows[0].status, "blocked");
  assert.equal(fake.rows[0].unblockDescriptor.action, HOLD.action);
  assert.equal(fake.comments.r7.filter((c) => c === HOLD.comment).length, 1);
  await mirror.onEvent(ev, logger());
  assert.equal(fake.comments.r7.filter((c) => c === HOLD.comment).length, 1, "never twice");
  assert.equal(fake.rows[0].status, "blocked");
});

test("ownsCards: a generic hold is rewritten to the holder's reason; a Foreman reason is kept", async () => {
  const blockedRow = (id, n, action) => ({ id, title: `r#${n} issue ${n}`, status: "blocked", assigneeAgentId: AGENT,
    description: `source: example/r#${n}\nGitHub: open · stage blocked\n\nhttps://github.com/example/r/issues/${n}`, unblockDescriptor: { owner: "board", action } });
  const fake = fakePaperclip([
    blockedRow("r7", 7, "blocked: needs attention"),
    blockedRow("r8", 8, "GitHub issue is labelled blocked"),
    blockedRow("r9", 9, "blocked: dev verification did not pass"),
  ]);
  const { mirror } = mirrorOn(fake, OWNED);
  const hold = (n) => ({ ...HOLD, action: `${HOLD.action} #${n}` });
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: snap([7, 8, 9].map((number) => ({ number, labels: ["blocked"] }))),
    cards: [7, 8, 9].map((n) => card(n, { stage: "blocked", hold: hold(n) })) }, logger());
  assert.equal(fake.rows[0].unblockDescriptor.action, hold(7).action);
  assert.equal(fake.rows[1].unblockDescriptor.action, hold(8).action);
  assert.equal(fake.rows[2].unblockDescriptor.action, "blocked: dev verification did not pass");
  assert.ok(fake.rows.every((r) => r.status === "blocked"));
});

test("ownsCards: the holder's comment is credited to the agent whose githubLogin it is; a person's stays the key's user", async () => {
  const EM = "agent-em";
  const held = (by) => ({ ...HOLD, author: by, comment: HOLD.comment.replace("ray", by), action: `${HOLD.action} ${by}` });
  for (const [by, want] of [["Slashbin-Engineering-Manager", `agent:${EM}`], ["xrgarcia", null]]) {
    const fake = fakePaperclip([ownedRow("todo", { description: `source: example/r#7\nGitHub: open · stage blocked\n\n${URL7}` })]);
    fake.boardAgents.push({ id: EM, name: "EM", metadata: { githubLogin: "slashbin-engineering-manager" } }, { id: "gone", name: "Old", status: "terminated", metadata: { githubLogin: "xrgarcia" } });
    const { mirror } = mirrorOn(fake, OWNED);
    await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: snap([{ number: 7, labels: ["approved", "blocked"] }]), cards: [card(7, { stage: "blocked", hold: held(by) })] }, logger());
    const at = fake.comments.r7.indexOf(held(by).comment);
    assert.ok(at >= 0);
    assert.equal(fake.credits[at], want, `${by}: a login no live agent carries is no credit`);
    assert.ok(fake.credits.every((c, i) => i === at || c === `agent:${AGENT}`), "the Foreman's own notes are its agent's");
  }
});

test("the Foreman's own notes are credited to its agent", async () => {
  const fake = fakePaperclip([row("r7", 7), row("r8", 8, { status: "done" })]);
  const { mirror } = mirrorOn(fake, { agentStatus: false });
  await mirror.onWaiting("example/r", [{ item, reason: "occupied by PR #4" }], logger());
  await mirror.onMerged({ issueNumber: 8, repo: "example/r" }, repoConfig, logger());
  assert.deepEqual(fake.credits, [`agent:${AGENT}`, `agent:${AGENT}`]);
});

test("ownsCards: the holder's comment is never posted on another agent's card", async () => {
  const fake = fakePaperclip([ownedRow("blocked", { assigneeAgentId: "agent-tech-lead", description: `source: example/r#7\nGitHub: open · stage blocked\n\n${URL7}`,
    unblockDescriptor: { owner: "board", action: HOLD.action } })]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: snap([{ number: 7, labels: ["blocked"] }]), cards: [card(7, { stage: "blocked", hold: HOLD })] }, logger());
  assert.equal(fake.comments.r7, undefined);
});

test("ownsCards: a card the holder released from GitHub's hold follows GitHub on", async () => {
  const fake = fakePaperclip([ownedRow("blocked", { description: `source: example/r#7\nGitHub: open · stage inReview\n\n${URL7}`, unblockDescriptor: { owner: "board", action: HOLD.action } })]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: snap([{ number: 7, labels: ["approved", "pr under review"] }]), cards: [card(7, { stage: "inReview" })] }, logger());
  assert.equal(fake.rows[0].status, "in_review");
});

test("ownsCards: at most 20 card writes a cycle; the rest follow", async () => {
  const fake = fakePaperclip([]);
  const { mirror } = mirrorOn(fake, OWNED);
  const cards = Array.from({ length: 30 }, (_, i) => card(i + 1));
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards }, logger());
  assert.equal(fake.rows.length, 20);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards }, logger());
  assert.equal(fake.rows.length, 30);
});

test("ownsCards: housekeeping retires a second card for an issue; nothing adopts it again", async () => {
  const fake = fakePaperclip([
    ownedRow("todo", { identifier: "SLA-1", createdAt: "2026-10-15T10:00:00Z" }),
    { id: "r7b", identifier: "SLA-2", title: "example/r#7", status: "in_progress", assigneeAgentId: AGENT, description: "source: example/r#7\n\nx", createdAt: "2026-10-15T10:00:03Z" },
  ]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.housekeep();
  const b = fake.rows[1];
  assert.equal(b.status, "cancelled");
  assert.equal(b.assigneeAgentId, null);
  assert.equal(b.title, "[duplicate of SLA-1] example/r#7");
  assert.equal(b.description, "duplicate of SLA-1 (source: example/r#7)");
  assert.deepEqual(fake.comments.r7b, ["retired: a second card for source: example/r#7; SLA-1 is the card for this issue"]);
  assert.equal(fake.rows[0].status, "todo");
  await mirror.housekeep();
  assert.equal(fake.comments.r7b.length, 1, "retired once");
});

test("ownsCards off: housekeeping leaves a second card alone", async () => {
  const fake = fakePaperclip([ownedRow("todo"), { id: "r7b", title: "t", status: "in_progress", description: "source: example/r#7" }]);
  const { mirror } = mirrorOn(fake);
  await mirror.housekeep();
  assert.equal(fake.rows[1].status, "in_progress");
});

// --- Handoffs: a card moved to another seat says who acts, what, why, links, done ---
// SLA-1550 (2026-10-15): Slashbin-console#1283 reached the EM at
// pendingVerification saying only "Dev verification passed" and "approved"; the
// EM read it as a status ping and the release gate sat.

const SEATS = {
  roles: { em: { name: "Engineering Manager", id: "agent-em" }, sre: { name: "SRE", id: "agent-sre" } },
  board: {
    merged: { owner: "sre", status: "in_review", label: "merged" },
    verifying: { owner: "sre", status: "in_progress", label: "merged" },
    pendingVerification: { owner: "em", status: "todo", label: "pendingVerification" },
  },
};
const console1283 = { issueNumber: 1283, repo: "xrgarcia/Slashbin-console" };
const verifySession = (status, extra = {}) => ({ phase: "verify", status, repo: console1283.repo, items: [console1283], pr: 1291, reviewer: "SRE", ...extra });

test("handoff: dev verification passing hands the card to the EM with the release gate to run, why, links and done", async () => {
  const fake = fakePaperclip([{ id: "r1283", status: "in_review", assigneeAgentId: "agent-sre", description: "source: xrgarcia/Slashbin-console#1283" }]);
  const { mirror } = mirrorOn(fake, { ...SEATS, ...rich() });
  await mirror.onSession(verifySession("started"), logger());
  await mirror.onState(console1283, "merged", "approved", repoConfig, logger());
  await mirror.onSession(verifySession("finished", { detail: "PR #1291 verified in dev (deploy SUCCESS)" }), logger());
  assert.equal(fake.rows[0].assigneeAgentId, "agent-em");
  const notes = fake.comments.r1283;
  const handoff = notes.at(-1);
  assert.match(handoff, /^approved\n\n\*\*Next: Engineering Manager — action needed\*\*/);
  assert.ok(handoff.includes("- **Do:** Run the EM release gate (`/deliver-to-prod` step 3a) for xrgarcia/Slashbin-console#1283 and, if it passes, apply `ready for prod release` to the issue. The prod release does not start until you do."));
  assert.match(handoff, /- \*\*Why:\*\* dev verification passed \(`pr approved`\) — PR #1291 verified in dev \(deploy SUCCESS\) \(\d{4}-\d\d-\d\d \d\d:\d\dZ\)/);
  assert.ok(handoff.includes("[xrgarcia/Slashbin-console#1283](https://github.com/xrgarcia/Slashbin-console/issues/1283)"));
  assert.ok(handoff.includes("[PR #1291](https://github.com/xrgarcia/Slashbin-console/pull/1291)"));
  assert.ok(handoff.includes("- **Done when:** `ready for prod release` is on xrgarcia/Slashbin-console#1283"));
  assert.equal(notes.filter((n) => n.includes("**Next:")).length, 1, "one handoff, in the step's own note");
});

test("handoff: a move to a seat the Foreman drives says so; a Foreman-held stage and a session start carry none", async () => {
  const fake = fakePaperclip([row("r7", 7, { status: "todo" })]);
  const { mirror } = mirrorOn(fake, TEAM);
  await mirror.onState(item, "changesRequested", "inReview", repoConfig, logger());
  const toReviewer = fake.comments.r7.at(-1);
  assert.match(toReviewer, /\*\*Next: Reviewer — no action needed from this card\*\*/);
  assert.ok(toReviewer.includes("- **Done when:** the review's verdict is on the PR"));
  await mirror.onSession({ phase: "review", status: "started", repo: "example/r", items: [item], pr: 9, reviewer: "Tech Lead" }, logger());
  assert.equal(fake.comments.r7.at(-1), "Tech Lead reviewing PR #9", "a session runs on the seat already told");
  await mirror.onSession({ phase: "review", status: "finished", repo: "example/r", items: [item], pr: 9 }, logger());
  await mirror.onState(item, "inReview", "changesRequested", repoConfig, logger());
  assert.ok(!fake.comments.r7.at(-1).includes("**Next:"), "the Foreman holds changesRequested: no handoff");
});

test("handoff: with no roles every stage is the Foreman's and no note grows a handoff", async () => {
  const fake = fakePaperclip([row("r7", 7)]);
  const { mirror } = mirrorOn(fake);
  await mirror.onState(item, "merged", "approved", repoConfig, logger());
  assert.deepEqual(fake.comments.r7, ["approved"]);
});

test("handoff: an owned card at another seat's stage says the next action under its stage line", async () => {
  const fake = fakePaperclip([]);
  const { mirror } = mirrorOn(fake, { ...OWNED, ...SEATS });
  const c = { item: { issueNumber: 7, repo: "example/r" }, title: "issue 7", url: URL7, state: "open", stage: "pendingVerification" };
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: snap([{ number: 7, labels: ["approved", "pr approved"] }]), cards: [c] }, logger());
  const lines = fake.rows[0].description.split("\n");
  assert.equal(lines[1], "GitHub: open · stage pendingVerification");
  assert.equal(lines[2], "Next: Engineering Manager — run the EM release gate (/deliver-to-prod 3a) for example/r#7, then apply `ready for prod release`");
});

test("a dev-verification wait stays in review, never Blocked; the same reason twice writes nothing (jerky_ops#18)", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onState(item, "inReview", "approved", repoConfig, logger());
  const why = "waiting until 2026-10-15T18:42Z: the SRE says PR #19 is not observable before then (wait-until-20261015T1842Z)";
  await mirror.onEvent({ kind: "verifyWaiting", item, reason: why }, logger());
  assert.equal(fake.rows[0].status, "in_review");
  assert.notEqual(fake.rows[0].status, "blocked");
  const notes = fake.comments["row-1"].length;
  await mirror.onEvent({ kind: "verifyWaiting", item, reason: why }, logger());
  assert.equal(fake.comments["row-1"].length, notes, "a repeated wait adds no note");
  assert.equal(fake.comments["row-1"].at(-1), `merged; dev verification waiting: ${why}`);
});

test("a card a wait finds in Blocked comes back to review", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onBlocked(item, "earlier wait", repoConfig, logger());
  assert.equal(fake.rows[0].status, "blocked");
  await mirror.onEvent({ kind: "verifyWaiting", item, reason: "deploy building" }, logger());
  assert.equal(fake.rows[0].status, "in_review");
});

test("a blocked event owned by the sre goes to the SRE seat with the deploy-failed handoff; unowned keeps the stage owner", async () => {
  const roles = { sre: { name: "SRE", id: "sre-agent" }, em: { name: "Engineering Manager", id: "em-agent" } };
  const board = { ...paperclipBoardDefaults().board, blocked: { ...paperclipBoardDefaults().board.blocked, owner: "em" } };
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake, { agentStatus: false, roles, board, comments: { enabled: true } });
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onEvent({ kind: "blocked", item, reason: "dev verification of PR #98 did not pass (dev-verify-failed) — attempt 3/3", owner: "sre" }, logger());
  assert.equal(fake.rows[0].status, "blocked");
  assert.equal(fake.rows[0].assigneeAgentId, "sre-agent");
  assert.deepEqual(fake.rows[0].unblockDescriptor.owner, { agentId: "sre-agent" });
  const last = fake.comments["row-1"].at(-1);
  assert.match(last, /Next: SRE — action needed/);
  assert.match(last, /The deploy to dev failed \(infrastructure, not the code\)/);
  // Any other block goes back to the stage's owner, the EM.
  await mirror.onEvent({ kind: "blocked", item, reason: "no merged PR closes it" }, logger());
  assert.equal(fake.rows[0].assigneeAgentId, "em-agent");
  assert.match(fake.comments["row-1"].at(-1), /Next: Engineering Manager/);
  // An sre role with no agent id leaves the hold with the stage owner.
  const fake2 = fakePaperclip();
  const m2 = mirrorOn(fake2, { agentStatus: false, roles: { em: roles.em }, board, comments: { enabled: true } }).mirror;
  await m2.onClaim(item, repoConfig, logger());
  await m2.onEvent({ kind: "blocked", item, reason: "x", owner: "sre" }, logger());
  assert.equal(fake2.rows[0].assigneeAgentId, "em-agent");
});

// --- A closed issue closes its card, held or not (2026-10-26) -----------------------

const heldRow = (n, action, extra = {}) => ({ id: `r${n}`, title: `r#${n} issue ${n}`, status: "blocked", assigneeAgentId: AGENT,
  description: `source: example/r#${n}\nGitHub: open · stage inReview\n\nhttps://github.com/example/r/issues/${n}`, unblockDescriptor: { owner: { agentId: AGENT }, action }, ...extra });

test("ownsCards: a closed issue's Blocked card goes to done or cancelled, whatever hold it shows", async () => {
  const fake = fakePaperclip([
    heldRow(7, "blocked: review of PR #8 failed 4× — paused 1 h"),
    heldRow(8, "waiting on branch features to free up"),
    heldRow(9, "blocked: on GitHub — waiting on legal (ray, 2026-10-14) https://github.com/example/r/issues/9#c2"),
  ]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7, { state: "completed" }), card(8, { state: "not_planned" }), card(9, { state: "completed" })] }, logger());
  assert.deepEqual(fake.rows.map((r) => r.status), ["done", "cancelled", "done"]);
  assert.equal(fake.rows[0].description.split("\n")[1], "GitHub: closed completed");
});

test("ownsCards off: a closed issue's held card still goes to done", async () => {
  const fake = fakePaperclip([heldRow(7, "waiting on branch features to free up")]);
  const { mirror } = mirrorOn(fake);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], closed: [{ item: { issueNumber: 7, repo: "example/r" }, state: "completed" }] }, logger());
  assert.equal(fake.rows[0].status, "done");
});

test("a card the closed read missed is closed from a live read of the issue behind it", async () => {
  const fake = fakePaperclip([heldRow(7, "blocked: review of PR #8 failed 4× — paused 1 h"), heldRow(8, "blocked: x"), heldRow(9, "blocked: y")]);
  const { mirror } = mirrorOn(fake, OWNED);
  const asked = [];
  const states = async (ns) => { asked.push(...ns); return new Map([[7, "completed"], [8, "not_planned"], [9, "open"], [10, "completed"]]); };
  // #9 is open and has its card in this snapshot; #7 and #8 appear nowhere, and the closed read did not name them.
  await mirror.onEvent({ kind: "snapshot", states, repo: "example/r", items: [], cards: [card(9, { stage: "approved" })] }, logger());
  assert.deepEqual(fake.rows.map((r) => r.status).slice(0, 2), ["done", "cancelled"]);
  assert.ok(!asked.includes(9), "an open issue's card is not asked about");
  assert.notEqual(fake.rows[2].status, "done");
});

test("a stale card whose close failed is retried on the next snapshot, not after the 10-minute check interval", async () => {
  const fake = fakePaperclip([heldRow(7, "blocked: review of PR #8 failed 4× — paused 1 h")]);
  let outage = true;
  const realFetch = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    if (outage && init.method === "PATCH" && init.body?.includes('"status"')) throw new TypeError("fetch failed");
    return realFetch(url, init);
  };
  const { mirror } = mirrorOn(fake, OWNED);
  const states = async () => new Map([[7, "not_planned"]]);
  const snap = () => mirror.onEvent({ kind: "snapshot", states, repo: "example/r", items: [], cards: [] }, logger());
  await snap();
  assert.equal(fake.rows[0].status, "blocked", "the write failed, so the card is still blocked");
  outage = false;
  await snap();
  assert.equal(fake.rows[0].status, "cancelled", "the next snapshot retries; the failed attempt did not rate-limit it");
});

test("a closed issue's card is not put back in Blocked by the Foreman's lagging hold", async () => {
  const fake = fakePaperclip([heldRow(7, "x")]);
  const { mirror } = mirrorOn(fake, OWNED);
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7, { state: "completed" })] }, logger());
  assert.equal(fake.rows[0].status, "done");
  await mirror.onWaiting("example/r", [{ item, reason: "held until this issue changes", skipped: true }], logger());
  await mirror.onBlocked(item, "review failed 4×", repoConfig, logger());
  assert.equal(fake.rows[0].status, "done");
  // Reopened: the snapshot reads it open, and the Foreman's holds apply again.
  await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [], cards: [card(7, { stage: "approved" })] }, logger());
  await mirror.onBlocked(item, "review failed 4×", repoConfig, logger());
  assert.equal(fake.rows[0].status, "blocked");
});

test("a Blocked card that predates this process is released once the Foreman's state holds nothing; held, it stands", async () => {
  for (const [foremanHeld, want] of [[false, "todo"], [true, "blocked"], [undefined, "blocked"]]) {
    const fake = fakePaperclip([heldRow(7, "blocked: on GitHub — Release stopped: needs a person")]);
    fake.rows[0].unblockDescriptor.action = "blocked: all bumps already landed";
    const { mirror } = mirrorOn(fake, OWNED);
    const it = { item, stage: "approved", detail: "approved, release pending", ...(foremanHeld === undefined ? {} : { foremanHeld }) };
    await mirror.onEvent({ kind: "snapshot", states: allOpen, repo: "example/r", items: [it], cards: [card(7, { stage: "approved" })] }, logger());
    assert.equal(fake.rows[0].status, want, `foremanHeld ${foremanHeld}`);
  }
});
