// `npm run paperclip:register`: registers the Foreman agent with every wake
// path off, re-applies the flags on every run, and writes only
// `paperclip.agentId` into the config, only after every request succeeded.
//
// registerPaperclipAgent runs against an injected fake fetch. The script runs as
// a child process against a fake Paperclip HTTP server in this process, so the
// child is spawned asynchronously (a sync spawn would block the server it
// calls). Nothing reaches a real Paperclip.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createPaperclipClient } from "../dist/paperclip/client.js";
import { registerPaperclipAgent, withWakePathsOff } from "../dist/paperclip/agent.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "paperclip", "agent.mjs");
const CID = "company-1";
const BASE = "http://paperclip.test";

const tmp = mkdtempSync(join(tmpdir(), "foreman-paperclip-register-test-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeFetch(agents) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", path: `${u.pathname}${u.search}`, body });
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (init.method === "POST") { const a = { id: "new-id", ...body }; agents.push(a); return json(201, a); }
    if (init.method === "PATCH") {
      const a = agents.find((x) => `/api/agents/${x.id}` === u.pathname);
      Object.assign(a, body);
      return json(200, a);
    }
    return json(200, agents);
  };
  return { fn, calls };
}

test("withWakePathsOff turns both flags off and keeps every other runtime setting", () => {
  assert.deepEqual(withWakePathsOff(undefined), { heartbeat: { enabled: false, wakeOnDemand: false } });
  assert.deepEqual(
    withWakePathsOff({ maxTurns: 5, heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 60 } }),
    { maxTurns: 5, heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 60 } },
  );
});

test("no agent by that name: POST it with wake paths off, then PATCH the flags", async () => {
  const agents = [{ id: "other", name: "Someone else" }];
  const { fn, calls } = fakeFetch(agents);
  const r = await registerPaperclipAgent(createPaperclipClient({ url: BASE, companyId: CID, fetch: fn }), "Foreman");
  assert.equal(r.created, true);
  assert.equal(r.agent.id, "new-id");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    `GET /api/companies/${CID}/agents`, `POST /api/companies/${CID}/agents`, "PATCH /api/agents/new-id",
  ]);
  assert.deepEqual(calls[1].body, {
    name: "Foreman", role: "engineer", adapterType: "process",
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  });
  assert.deepEqual(calls[2].body, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
});

test("existing agent: no POST; the PATCH re-applies the flags over its other runtime settings", async () => {
  const agents = [{ id: "fm", name: "Foreman", runtimeConfig: { maxTurns: 5, heartbeat: { enabled: true, wakeOnDemand: true } } }];
  const { fn, calls } = fakeFetch(agents);
  const r = await registerPaperclipAgent(createPaperclipClient({ url: BASE, companyId: CID, fetch: fn }), "Foreman");
  assert.equal(r.created, false);
  assert.equal(r.agent.id, "fm");
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PATCH"]);
  assert.deepEqual(calls[1].body.runtimeConfig, { maxTurns: 5, heartbeat: { enabled: false, wakeOnDemand: false } });
});

test("two agents with the name: refuses rather than guess, and changes nothing", async () => {
  const { fn, calls } = fakeFetch([{ id: "a", name: "Foreman" }, { id: "b", name: "Foreman" }]);
  await assert.rejects(
    registerPaperclipAgent(createPaperclipClient({ url: BASE, companyId: CID, fetch: fn }), "Foreman"),
    /2 Paperclip agents are named "Foreman" \(a, b\)/,
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
});

// --- the script, end to end ---

const requests = [];
let agents = [];
let failPatch = false;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, body: parsed });
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url === `/api/companies/${CID}/agents`) return json(200, agents);
    if (req.method === "POST" && req.url === `/api/companies/${CID}/agents`) {
      const a = { id: `agent-${agents.length + 1}`, ...parsed };
      agents.push(a);
      return json(201, a);
    }
    const a = agents.find((x) => req.method === "PATCH" && req.url === `/api/agents/${x.id}`);
    if (a && !failPatch) { Object.assign(a, parsed); return json(200, a); }
    json(failPatch ? 500 : 404, { error: "no" });
  });
});
// Started in a hook, not with a top-level await: the runner would otherwise
// finish the tests above and run its after hooks before the ones below exist.
let URL_BASE;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  URL_BASE = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

let n = 0;
function writeCfg(cfg, raw) {
  const p = join(tmp, `cfg-${n++}.json`);
  writeFileSync(p, raw ?? JSON.stringify(cfg, null, 2) + "\n");
  return p;
}
const baseCfg = (extra = {}) => ({ triggerLabel: "approved", repos: [{ name: "r", repoPath: tmp, githubRepo: "example/r" }], ...extra });

function run(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of Object.keys(env)) if (k.startsWith("AI_AGENT_") && !(k in extraEnv)) delete env[k];
  return new Promise((resolve) => {
    const c = spawn("node", [SCRIPT, ...args], { cwd: tmp, env });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("script: registers, writes only agentId (indent kept), prints the diff; a re-run rewrites nothing", async () => {
  agents = []; requests.length = 0; failPatch = false;
  const cfg = baseCfg({ paperclip: { url: URL_BASE, companyId: CID, statusMap: { done: "closed" } }, zLast: [1, 2] });
  const p = writeCfg(cfg, JSON.stringify(cfg, null, 4) + "\n");
  const r1 = await run([p]);
  assert.equal(r1.status, 0, r1.stderr);
  const after = readFileSync(p, "utf8");
  assert.equal(after, JSON.stringify({ ...cfg, paperclip: { ...cfg.paperclip, agentId: "agent-1" } }, null, 4) + "\n");
  assert.match(r1.stdout, /Registered Paperclip agent "Foreman" \(agent-1\)/);
  assert.match(r1.stdout, /^\+\s+"agentId": "agent-1"$/m);
  assert.deepEqual(requests.map((q) => q.method), ["GET", "POST", "PATCH"]);

  requests.length = 0;
  agents[0].runtimeConfig = { heartbeat: { enabled: true, wakeOnDemand: true } };
  const r2 = await run([p]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(requests.map((q) => q.method), ["GET", "PATCH"]);
  assert.deepEqual(agents[0].runtimeConfig, { heartbeat: { enabled: false, wakeOnDemand: false } });
  assert.match(r2.stdout, /already records paperclip\.agentId; unchanged/);
  assert.equal(readFileSync(p, "utf8"), after);
});

test("script: no path argument reads .ai-agent.json from the working directory", async () => {
  agents = [{ id: "fm", name: "Foreman" }]; requests.length = 0; failPatch = false;
  const p = join(tmp, ".ai-agent.json");
  writeFileSync(p, JSON.stringify(baseCfg({ paperclip: { url: URL_BASE, companyId: CID } }), null, 2));
  try {
    const r = await run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).paperclip.agentId, "fm");
  } finally {
    rmSync(p, { force: true });
  }
});

test("script: AI_AGENT_PAPERCLIP_AGENT_NAME overrides the name, as it does for the daemon", async () => {
  agents = []; requests.length = 0; failPatch = false;
  const p = writeCfg(baseCfg({ paperclip: { url: URL_BASE, companyId: CID } }));
  const r = await run([p], { AI_AGENT_PAPERCLIP_AGENT_NAME: "Builder" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(requests.find((q) => q.method === "POST").body.name, "Builder");
});

test("script: no paperclip block, or no companyId: exit 1, no request, file untouched", async () => {
  for (const cfg of [baseCfg(), baseCfg({ paperclip: { url: URL_BASE } })]) {
    requests.length = 0;
    const p = writeCfg(cfg);
    const before = readFileSync(p, "utf8");
    const r = await run([p]);
    assert.equal(r.status, 1);
    assert.equal(requests.length, 0);
    assert.equal(readFileSync(p, "utf8"), before);
  }
});

test("script: a failed PATCH after a successful POST writes nothing", async () => {
  agents = []; requests.length = 0; failPatch = true;
  const p = writeCfg(baseCfg({ paperclip: { url: URL_BASE, companyId: CID } }));
  const before = readFileSync(p, "utf8");
  const r = await run([p]);
  failPatch = false;
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`Registration against ${URL_BASE} failed: Paperclip PATCH /api/agents/agent-1 returned 500`));
  assert.equal(readFileSync(p, "utf8"), before);
});

test("script: unreachable Paperclip: exit 1 naming the URL, file untouched", async () => {
  const p = writeCfg(baseCfg({ paperclip: { url: "http://127.0.0.1:9", companyId: CID } }));
  const before = readFileSync(p, "utf8");
  const r = await run([p]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /127\.0\.0\.1:9/);
  assert.equal(readFileSync(p, "utf8"), before);
});
