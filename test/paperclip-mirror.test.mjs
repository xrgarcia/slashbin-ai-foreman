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
    let m = u.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (m && method === "PATCH") {
      const r = rows.find((x) => x.id === m[1]);
      Object.assign(r, body);
      return ok(r);
    }
    m = u.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (m && method === "POST") {
      (comments[m[1]] ??= []).push(body.body);
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
