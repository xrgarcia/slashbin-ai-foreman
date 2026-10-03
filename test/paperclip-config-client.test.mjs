// The `paperclip` config block and the Paperclip HTTP client.
//
// Config: a config without the block runs exactly as before (mirror off), each
// leaf has its default, each AI_AGENT_PAPERCLIP_* var overrides its leaf.
// Client: an injected fake fetch records every call — no Paperclip, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { PaperclipClient, PaperclipClientError, createPaperclipClient } from "../dist/paperclip/client.js";

const tmp = mkdtempSync(join(tmpdir(), "foreman-paperclip-test-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const ENV_KEYS = [
  "AI_AGENT_PAPERCLIP_ENABLED", "AI_AGENT_PAPERCLIP_URL", "AI_AGENT_PAPERCLIP_COMPANY_ID",
  "AI_AGENT_PAPERCLIP_AGENT_NAME", "AI_AGENT_PAPERCLIP_AGENT_ID", "AI_AGENT_PAPERCLIP_IDENTITY_KEY_FORMAT",
];
for (const k of ENV_KEYS) delete process.env[k];

let n = 0;
function cfg(extra) {
  const p = join(tmp, `cfg-${n++}.json`);
  writeFileSync(p, JSON.stringify({ repos: [{ name: "r", repoPath: tmp, githubRepo: "example/r" }], ...extra }));
  return p;
}
function withEnv(vars, fn) {
  Object.assign(process.env, vars);
  try { return fn(); } finally { for (const k of Object.keys(vars)) delete process.env[k]; }
}

const CID = "company-1";

test("no paperclip block: mirror off, every default applied", () => {
  const { paperclip } = loadConfig(cfg({}));
  const { board, stageLabels, roles, ...rest } = paperclip;
  assert.deepEqual(roles, {}, "no roles: the Foreman holds every card");
  assert.ok(Object.values(board).every((s) => s.owner === "foreman"));
  assert.deepEqual(Object.keys(stageLabels).sort(), ["awaitingRelease", "changesRequested", "inReview", "pendingVerification"]);
  assert.deepEqual({ ...rest }, {
    liveLeaseMinutes: 15,
    enabled: false,
    url: "http://127.0.0.1:3100",
    agentName: "Foreman",
    identityKeyFormat: "source: {repo}#{N}",
    projects: true,
    projectNameFormat: "{name}",
    agentStatus: true,
  });
  assert.equal(paperclip.statusMap, undefined);
  assert.equal(paperclip.companyId, undefined);
  assert.equal(paperclip.agentId, undefined);
});

test("block with only companyId keeps the other defaults", () => {
  const { paperclip } = loadConfig(cfg({ paperclip: { companyId: CID } }));
  assert.equal(paperclip.companyId, CID);
  assert.equal(paperclip.enabled, false);
  assert.equal(paperclip.url, "http://127.0.0.1:3100");
  assert.equal(paperclip.agentName, "Foreman");
  assert.equal(paperclip.identityKeyFormat, "source: {repo}#{N}");
  assert.equal(paperclip.statusMap, undefined);
});

test("each AI_AGENT_PAPERCLIP_* var overrides its own leaf over the file", () => {
  const file = { paperclip: { companyId: "file-co", url: "http://file.test", agentName: "FileBot", agentId: "file-agent", identityKeyFormat: "f {repo} {N}" } };
  const cases = [
    ["AI_AGENT_PAPERCLIP_URL", "http://env.test:9", "url", "http://env.test:9"],
    ["AI_AGENT_PAPERCLIP_COMPANY_ID", "env-co", "companyId", "env-co"],
    ["AI_AGENT_PAPERCLIP_AGENT_NAME", "EnvBot", "agentName", "EnvBot"],
    ["AI_AGENT_PAPERCLIP_AGENT_ID", "env-agent", "agentId", "env-agent"],
    ["AI_AGENT_PAPERCLIP_IDENTITY_KEY_FORMAT", "gh: {repo}#{N}", "identityKeyFormat", "gh: {repo}#{N}"],
  ];
  for (const [key, value, field, expected] of cases) {
    const { paperclip } = withEnv({ [key]: value }, () => loadConfig(cfg(file)));
    assert.equal(paperclip[field], expected, key);
    // The others still come from the file.
    if (field !== "companyId") assert.equal(paperclip.companyId, "file-co", key);
  }
});

test("env overrides apply with no block in the file", () => {
  const { paperclip } = withEnv(
    { AI_AGENT_PAPERCLIP_ENABLED: "true", AI_AGENT_PAPERCLIP_COMPANY_ID: CID },
    () => loadConfig(cfg({})),
  );
  assert.equal(paperclip.enabled, true);
  assert.equal(paperclip.companyId, CID);
  assert.equal(paperclip.agentName, "Foreman");
});

test("AI_AGENT_PAPERCLIP_ENABLED parses yes/no words, and rejects anything else", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE"]) {
    const { paperclip } = withEnv({ AI_AGENT_PAPERCLIP_ENABLED: v }, () => loadConfig(cfg({ paperclip: { companyId: CID } })));
    assert.equal(paperclip.enabled, true, v);
  }
  for (const v of ["false", "0", "no", "off", " False "]) {
    const { paperclip } = withEnv({ AI_AGENT_PAPERCLIP_ENABLED: v }, () => loadConfig(cfg({ paperclip: { companyId: CID, enabled: true } })));
    assert.equal(paperclip.enabled, false, v);
  }
  assert.throws(() => withEnv({ AI_AGENT_PAPERCLIP_ENABLED: "maybe" }, () => loadConfig(cfg({ paperclip: { companyId: CID } }))));
});

test("enabled without a companyId fails to load", () => {
  assert.throws(() => loadConfig(cfg({ paperclip: { enabled: true } })), /companyId/);
});

test("identityKeyFormat must name both {repo} and {N}", () => {
  assert.throws(() => loadConfig(cfg({ paperclip: { identityKeyFormat: "source: {repo}" } })), /identityKeyFormat/);
});

test("statusMap overrides only the buckets it names; unknown buckets are rejected", () => {
  const { paperclip } = loadConfig(cfg({ paperclip: { statusMap: { in_review: "review", blocked: "on_hold" } } }));
  assert.deepEqual({ ...paperclip.statusMap }, { in_review: "review", blocked: "on_hold" });
  assert.throws(() => loadConfig(cfg({ paperclip: { statusMap: { paused: "x" } } })));
});

// --- client ---

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method ?? "GET", path: u.pathname, search: u.searchParams, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const [status, payload] = handler(call);
    return new Response(payload === undefined ? "" : JSON.stringify(payload), { status });
  };
  return { fn, calls };
}

const BASE = "http://paperclip.test/";
const make = (fetch) => new PaperclipClient({ url: BASE, companyId: CID, fetch });

test("listIssues fetches the next page only after a full 1000-row page", async () => {
  const { fn, calls } = fakeFetch(({ search }) => {
    const offset = Number(search.get("offset"));
    return [200, Array.from({ length: offset === 0 ? 1000 : 2 }, (_, i) => ({ id: `i${offset + i}`, title: "t", status: "todo" }))];
  });
  const ids = [];
  for await (const i of make(fn).listIssues()) ids.push(i.id);
  assert.equal(ids.length, 1002);
  assert.equal(ids[1001], "i1001");
  assert.deepEqual(calls.map((c) => [c.path, c.search.get("limit"), c.search.get("offset")]), [
    [`/api/companies/${CID}/issues`, "1000", "0"],
    [`/api/companies/${CID}/issues`, "1000", "1000"],
  ]);
});

test("listIssues stops after one request when the first page is short", async () => {
  const { fn, calls } = fakeFetch(() => [200, [{ id: "a", title: "t", status: "todo" }]]);
  const ids = [];
  for await (const i of make(fn).listIssues()) ids.push(i.id);
  assert.deepEqual(ids, ["a"]);
  assert.equal(calls.length, 1);
});

test("each method hits its documented method, path and body", async () => {
  const { fn, calls } = fakeFetch(({ body }) => [200, { id: "x", ...(body ?? {}) }]);
  const c = createPaperclipClient({ url: BASE, companyId: CID, fetch: fn });
  await c.createIssue({ title: "t", status: "todo", description: "source: o/r#1" });
  await c.updateIssue("iss", { status: "in_progress" });
  await c.getIssueComments("iss");
  await c.createComment("iss", "note");
  await c.listAgents();
  await c.createAgent({ name: "Foreman", role: "engineer" });
  await c.updateAgent("ag", { name: "Foreman 2" });
  assert.deepEqual(calls.map((q) => `${q.method} ${q.path}${q.search.size ? `?${q.search}` : ""}`), [
    `POST /api/companies/${CID}/issues`,
    "PATCH /api/issues/iss",
    "GET /api/issues/iss/comments",
    "POST /api/issues/iss/comments",
    `GET /api/companies/${CID}/agents`,
    `POST /api/companies/${CID}/agents`,
    "PATCH /api/agents/ag",
  ]);
  assert.deepEqual(calls[0].body, { title: "t", status: "todo", description: "source: o/r#1" });
  assert.deepEqual(calls[3].body, { body: "note" });
  assert.equal(calls[2].body, undefined);
});

test("returns the parsed body", async () => {
  const { fn } = fakeFetch(() => [201, { id: "c2", body: "note", authorAgentId: null }]);
  assert.deepEqual(await make(fn).createComment("iss", "note"), { id: "c2", body: "note", authorAgentId: null });
});

for (const status of [404, 500]) {
  test(`a ${status} throws PaperclipClientError with that status and the body`, async () => {
    const { fn } = fakeFetch(() => [status, { error: "nope" }]);
    await assert.rejects(make(fn).updateIssue("iss", {}), (err) => {
      assert.ok(err instanceof PaperclipClientError);
      assert.equal(err.name, "PaperclipClientError");
      assert.equal(err.status, status);
      assert.equal(err.body, JSON.stringify({ error: "nope" }));
      return true;
    });
  });
}

test("a network failure throws PaperclipClientError with status 0, no retry", async () => {
  let calls = 0;
  const fn = async () => { calls++; throw new TypeError("fetch failed"); };
  await assert.rejects(make(fn).listAgents(), (err) => err instanceof PaperclipClientError && err.status === 0);
  assert.equal(calls, 1);
});

test("a 2xx body that is not JSON throws PaperclipClientError", async () => {
  const fn = async () => new Response("<html>", { status: 200 });
  await assert.rejects(make(fn).listAgents(), PaperclipClientError);
});

test("board: a partial stage keeps its defaults; an unknown owner, label or reportsTo is refused", () => {
  const { paperclip } = loadConfig(cfg({ paperclip: {
    roles: { reviewer: { name: "Reviewer" } },
    board: { inReview: { owner: "reviewer" } },
  } }));
  assert.deepEqual({ ...paperclip.board.inReview }, { owner: "reviewer", status: "in_review", label: "inReview" });
  assert.equal(paperclip.board.approved.owner, "foreman");
  assert.equal(paperclip.roles.reviewer.role, "engineer");
  assert.throws(() => loadConfig(cfg({ paperclip: { board: { inReview: { owner: "nobody" } } } })), /nobody/);
  assert.throws(() => loadConfig(cfg({ paperclip: { board: { inReview: { label: "nope" } } } })), /nope/);
  assert.throws(() => loadConfig(cfg({ paperclip: { agentReportsTo: "ghost" } })), /ghost/);
});
