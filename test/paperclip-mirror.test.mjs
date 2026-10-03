// PaperclipMirror: each Foreman step becomes a note on the issue's Paperclip
// task, status follows the step, and Paperclip failing never throws. The
// client gets an injected fake fetch — no Paperclip, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { PaperclipClient } from "../dist/paperclip/client.js";
import { PaperclipMirror } from "../dist/paperclip/mirror.js";
import { paperclipBoardDefaults } from "../dist/config.js";

const CID = "company-1";
const AGENT = "agent-1";
const SECRET = { name: "TEST_TOKEN", value: "secret-value-0123456789" };
const item = { issueNumber: 7, repo: "example/r" };
const repoConfig = { name: "r", githubRepo: "example/r" };

function fakePaperclip(rows = [], projects = [], labels = []) {
  const calls = [];
  const comments = {};
  const agent = { id: AGENT, metadata: {} };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
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
  return { rows, projects, labels, agent, calls, comments, fetch };
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
  await mirror.onPromoted(item, repoConfig, logger());
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

// --- projects: one per repo, backfilled; the old summary task retired ---

test("a created row carries its repo's project, found by name or created once", async () => {
  const fake = fakePaperclip([], [{ id: "p-old", name: "other" }]);
  const { mirror } = mirrorOn(fake, { projects: true, projectNameFormat: "{name}" });
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onClaim({ issueNumber: 9, repo: "example/r" }, repoConfig, logger());
  assert.deepEqual(fake.projects.map((p) => p.name), ["other", "r"]);
  assert.equal(fake.rows[0].projectId, "proj-2");
  assert.equal(fake.rows[1].projectId, "proj-2");
});

test("a created project takes projectStatus, in_progress by default (EM #417)", async () => {
  const dflt = fakePaperclip();
  await mirrorOn(dflt, { projects: true, projectNameFormat: "{name}" }).mirror.onClaim(item, repoConfig, logger());
  assert.equal(dflt.projects[0].status, "in_progress");
  const planned = fakePaperclip([], [{ id: "p-old", name: "other", status: "backlog" }]);
  await mirrorOn(planned, { projects: true, projectNameFormat: "{name}", projectStatus: "planned" }).mirror.onClaim(item, repoConfig, logger());
  assert.deepEqual(planned.projects.map((p) => [p.name, p.status]), [["other", "backlog"], ["r", "planned"]]);
});

test("housekeep backfills the project on identity rows and cancels the old live task once", async () => {
  const live = { id: "live", status: "in_progress", assigneeAgentId: AGENT, description: `foreman-live: ${AGENT}\n\nbody` };
  const fake = fakePaperclip([row("r7", 7), row("q1", 1, { description: "source: example/q#1", projectId: "p-q" }), live],
    [{ id: "p-q", name: "q" }]);
  const { mirror } = mirrorOn(fake, { projects: true, projectNameFormat: "{name}" });
  await mirror.housekeep();
  assert.equal(fake.rows[0].projectId, "proj-2");
  assert.equal(fake.calls.filter((c) => c.method === "PATCH" && c.path === "/api/issues/q1").length, 0, "a row already filed is left alone");
  assert.equal(live.status, "cancelled");
  assert.equal(live.projectId, undefined, "the live task is not an issue row");
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
const labelName = (fake, r) => (r.labelIds ?? []).map((id) => fake.labels.find((l) => l.id === id)?.name);

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
  assert.deepEqual(at(), ["todo", "agent-lead", ["bug", "Pending verification"]]);
  await mirror.onRelease(release("open", 12, [7]), logger());
  assert.deepEqual(at(), ["in_review", "agent-lead", ["bug", "Awaiting release"]]);
  await mirror.onRelease(release("merged", 12, [7]), logger());
  assert.deepEqual(at(), ["done", "agent-lead", ["bug"]], "done keeps the last holder and drops the stage label");
  assert.equal(fake.labels.length, 7, "the six stage labels created once");
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
  assert.deepEqual(labelName(fake, r), ["Pending verification"]);
  assert.deepEqual(fake.agent.metadata.foremanLive.rows, []);
  assert.ok(fake.comments.r7.includes("Tech Lead reviewing PR #9"));
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
