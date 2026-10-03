// PaperclipMirror: each Foreman step becomes a note on the issue's Paperclip
// task, status follows the step, and Paperclip failing never throws. The
// client gets an injected fake fetch — no Paperclip, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { PaperclipClient } from "../dist/paperclip/client.js";
import { PaperclipMirror } from "../dist/paperclip/mirror.js";

const CID = "company-1";
const AGENT = "agent-1";
const SECRET = { name: "TEST_TOKEN", value: "secret-value-0123456789" };
const item = { issueNumber: 7, repo: "example/r" };
const repoConfig = { name: "r", githubRepo: "example/r" };

function fakePaperclip(rows = []) {
  const calls = [];
  const comments = {};
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
    if (method === "PATCH" && u.pathname === `/api/agents/${AGENT}`) return ok({ id: AGENT, ...body });
    m = u.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (m && method === "POST") {
      (comments[m[1]] ??= []).push(body.body);
      const r = rows.find((x) => x.id === m[1]);
      if (r && reopens(r)) r.status = "todo";
      return ok({ id: "c", body: body.body }, 201);
    }
    return ok({}, 404);
  };
  return { rows, calls, comments, fetch };
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
    identityKeyFormat: "source: {repo}#{N}", ...extra };
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

test("status per step; merged, promoted and blocked are notes only; secrets redacted", async () => {
  const fake = fakePaperclip();
  const { mirror } = mirrorOn(fake);
  await mirror.onClaim(item, repoConfig, logger());
  await mirror.onPrLink(item, `https://github.com/example/r/pull/9?t=${SECRET.value}`, repoConfig, logger());
  await mirror.onState(item, "new", "inReview", repoConfig, logger());
  assert.equal(fake.rows[0].status, "in_review");
  await mirror.onState(item, "inReview", "changesRequested", repoConfig, logger());
  assert.equal(fake.rows[0].status, "in_review");
  await mirror.onState(item, "changesRequested", "queued", repoConfig, logger());
  assert.equal(fake.rows[0].status, "in_progress");
  await mirror.onState(item, "inReview", "approved", repoConfig, logger());
  assert.equal(fake.rows[0].status, "in_review");
  const before = statusPatches(fake).length;
  await mirror.onBlocked(item, `bad ${SECRET.value}`, repoConfig, logger());
  await mirror.onMerged(item, repoConfig, logger());
  await mirror.onPromoted(item, repoConfig, logger());
  assert.equal(statusPatches(fake).length, before);
  assert.deepEqual(fake.comments["row-1"], [
    "picked up by Foreman",
    "PR opened: https://github.com/example/r/pull/9?t=[REDACTED:TEST_TOKEN]",
    "under review",
    "changes requested",
    "queued",
    "approved",
    "blocked: bad [REDACTED:TEST_TOKEN]",
    "merged",
    "promoted to production",
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

test("a note never moves the row: blocked stays blocked, done stays done", async () => {
  const fake = fakePaperclip([row("r7", 7), row("r8", 8, { status: "done" })]);
  const { mirror } = mirrorOn(fake, { liveTask: false, agentStatus: false });
  await mirror.onWaiting("example/r", [{ item, reason: "occupied by PR #4" }], logger());
  assert.equal(fake.rows[0].status, "blocked", "the waiting note reopened the row it had just blocked");
  assert.deepEqual(fake.comments.r7, ["waiting: occupied by PR #4"]);
  await mirror.onPromoted({ issueNumber: 8, repo: "example/r" }, repoConfig, logger());
  assert.equal(fake.rows[1].status, "done", "the promoted note reopened a done row");
  assert.deepEqual(fake.comments.r8, ["promoted to production"]);
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
  assert.deepEqual(statusPatches(fake).map((c) => [c.path, c.body.status]), [["/api/issues/mine", "in_progress"]]);
  assert.deepEqual(fake.comments.mine, ["resumed: no longer waiting"]);
});

test("liveTask and agentStatus off: sessions write notes only", async () => {
  const fake = fakePaperclip([row("r7", 7)]);
  const { mirror } = mirrorOn(fake, { liveTask: false, agentStatus: false });
  await mirror.onSession({ phase: "revise", status: "started", repo: "example/r", items: [item], pr: 3 }, logger());
  await mirror.onPromotionStall("example/r", "stalled", logger());
  assert.deepEqual(fake.comments.r7, ["revision started: PR #3"]);
  assert.equal(fake.rows.length, 1, "no live task");
  assert.ok(!fake.calls.some((c) => c.path.startsWith("/api/agents/")), "no agent update");
});

test("an implement session drives the agent status and the live task; start has no per-issue note", async () => {
  const fake = fakePaperclip([row("r7", 7)]);
  const { mirror } = mirrorOn(fake, { liveTask: true, liveTaskTitle: "Live", agentStatus: true });
  await mirror.onSession({ phase: "implement", status: "started", repo: "example/r", items: [item] }, logger());
  const live = fake.rows.find((r) => r.description.startsWith(`foreman-live: ${AGENT}`));
  assert.equal(live.title, "Live");
  assert.equal(live.assigneeAgentId, AGENT);
  assert.match(live.description, /example\/r: implement #7/);
  await mirror.onSession({ phase: "implement", status: "failed", repo: "example/r", items: [item], detail: "exit 1" }, logger());
  assert.deepEqual(fake.comments.r7, ["implement session failed: exit 1"]);
  const agentCalls = fake.calls.filter((c) => c.path === `/api/agents/${AGENT}`).map((c) => c.body.status);
  assert.deepEqual(agentCalls, ["running", "idle"]);
  assert.match(live.description, /Running now \(0\)/);
});
