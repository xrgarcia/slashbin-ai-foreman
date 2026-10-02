// `paperclip:doctor`: six named read-only checks, all of them always run, one
// PASS/FAIL line each, non-zero exit on any FAIL.
//
// diagnosePaperclip runs against an injected fake fetch; the CLI runs as a
// child process (spawned asynchronously, so this process can answer it) against
// a fake Paperclip HTTP server, with every GitHub token removed from its env.
// Nothing reaches a real Paperclip.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { DOCTOR_CHECKS, diagnosePaperclip, readOnlyFetch, runDoctor } from "../dist/paperclip/doctor.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(root, "dist", "cli.js");
const CID = "company-1";
const AGENT = "agent-1";
const BASE = "http://paperclip.test";

const tmp = mkdtempSync(join(tmpdir(), "foreman-paperclip-doctor-test-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const cfg = (over = {}) => ({ enabled: true, url: BASE, companyId: CID, agentId: AGENT, ...over });

/** A fake Paperclip. `shape` decides the answers; every request is recorded. */
function fakeFetch(shape = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? "GET"} ${u.pathname}`);
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (shape.down) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (u.pathname === "/api/health") return json(200, { status: "ok" });
    if (u.pathname === `/api/companies/${CID}`) return shape.companyRoute === false || shape.company === false ? json(404, {}) : json(200, { id: CID });
    if (u.pathname === `/api/companies/${CID}/agents`) {
      if (shape.company === false) return json(404, {});
      if (shape.agent === false) return json(200, [{ id: "someone-else", name: "Other" }]);
      const heartbeat = shape.heartbeat ?? { enabled: false, wakeOnDemand: false };
      return json(200, [{ id: AGENT, name: "Foreman", runtimeConfig: { heartbeat } }]);
    }
    return json(404, {});
  };
  return { fn, calls };
}

const byName = (results) => Object.fromEntries(results.map((r) => [r.name, r]));

test("all good: six checks, in order, all PASS, GETs only", async () => {
  const { fn, calls } = fakeFetch();
  const results = await diagnosePaperclip(cfg(), { fetch: fn });
  assert.deepEqual(results.map((r) => r.name), [...DOCTOR_CHECKS]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.ok(calls.every((c) => c.startsWith("GET ")), calls.join(", "));
});

test("unreachable: every network check FAILs, config-complete still judged on its own", async () => {
  const { fn } = fakeFetch({ down: true });
  const r = byName(await diagnosePaperclip(cfg(), { fetch: fn }));
  assert.equal(r.health.ok, false);
  assert.match(r.health.detail, /ECONNREFUSED/);
  assert.equal(r.company.ok, false);
  assert.equal(r["agent-registered"].ok, false);
  assert.equal(r["wake-on-demand"].detail, "agent not found");
  assert.equal(r["config-complete"].ok, true);
});

test("a server that never answers fails on the timeout instead of hanging", async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const r = byName(await diagnosePaperclip(cfg(), { fetch: hang, timeoutMs: 50 }));
  assert.equal(r.health.ok, false);
  assert.match(r.health.detail, /no answer within 50 ms/);
});

test("unknown company: FAIL company and agent-registered, health PASS", async () => {
  const { fn } = fakeFetch({ company: false });
  const r = byName(await diagnosePaperclip(cfg(), { fetch: fn }));
  assert.equal(r.health.ok, true);
  assert.equal(r.company.ok, false);
  assert.match(r.company.detail, /404/);
  assert.equal(r["agent-registered"].ok, false);
});

test("no company route but the agents list answers: company PASSes on the fallback", async () => {
  const { fn } = fakeFetch({ companyRoute: false });
  const r = byName(await diagnosePaperclip(cfg(), { fetch: fn }));
  assert.equal(r.company.ok, true);
  assert.equal(r["agent-registered"].ok, true);
});

test("agentId not in the list: FAIL agent-registered and both flag checks", async () => {
  const { fn } = fakeFetch({ agent: false });
  const r = byName(await diagnosePaperclip(cfg(), { fetch: fn }));
  assert.equal(r["agent-registered"].ok, false);
  assert.match(r["agent-registered"].detail, /agent-1 not in agents list/);
  assert.equal(r["wake-on-demand"].ok, false);
  assert.equal(r["heartbeat-enabled"].ok, false);
});

test("each wake flag is its own check, and unset counts as on", async () => {
  let r = byName(await diagnosePaperclip(cfg(), { fetch: fakeFetch({ heartbeat: { enabled: false, wakeOnDemand: true } }).fn }));
  assert.equal(r["wake-on-demand"].ok, false);
  assert.match(r["wake-on-demand"].detail, /runtimeConfig\.heartbeat\.wakeOnDemand is true/);
  assert.equal(r["heartbeat-enabled"].ok, true);

  r = byName(await diagnosePaperclip(cfg(), { fetch: fakeFetch({ heartbeat: { enabled: true, wakeOnDemand: false } }).fn }));
  assert.equal(r["wake-on-demand"].ok, true);
  assert.match(r["heartbeat-enabled"].detail, /runtimeConfig\.heartbeat\.enabled is true/);

  r = byName(await diagnosePaperclip(cfg(), { fetch: fakeFetch({ heartbeat: {} }).fn }));
  assert.equal(r["wake-on-demand"].ok, false);
  assert.match(r["wake-on-demand"].detail, /unset/);
});

test("config-complete names each missing condition", async () => {
  const { fn } = fakeFetch();
  const r = byName(await diagnosePaperclip(cfg({ enabled: false, companyId: undefined, agentId: undefined }), { fetch: fn }));
  assert.equal(r["config-complete"].ok, false);
  assert.match(r["config-complete"].detail, /enabled/);
  assert.match(r["config-complete"].detail, /companyId/);
  assert.match(r["config-complete"].detail, /agentId/);
});

test("the doctor's fetch refuses anything but GET before it reaches the network", async () => {
  const { fn, calls } = fakeFetch();
  const guarded = readOnlyFetch(fn, 1000);
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    await assert.rejects(guarded(`${BASE}/api/health`, { method }), /read-only; refused/);
  }
  assert.deepEqual(calls, []);
  assert.equal((await guarded(`${BASE}/api/health`)).status, 200);
});

test("runDoctor prints one PASS/FAIL line per check and returns whether all passed", async () => {
  const lines = [];
  const ok = await runDoctor({ paperclip: cfg() }, { fetch: fakeFetch().fn, print: (l) => lines.push(l) });
  assert.equal(ok, true);
  assert.deepEqual(lines.map((l) => l.split(" ")[1]), [...DOCTOR_CHECKS]);
  assert.ok(lines.every((l) => l.startsWith("PASS: ")));

  lines.length = 0;
  assert.equal(await runDoctor({ paperclip: cfg({ enabled: false }) }, { fetch: fakeFetch().fn, print: (l) => lines.push(l) }), false);
  assert.ok(lines.at(-1).startsWith("FAIL: config-complete — "));
});

// --- the CLI, end to end, with no GitHub token ---

async function withServer(shape, fn) {
  const writes = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "GET") writes.push(`${req.method} ${req.url}`);
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/api/health") return json(200, { status: "ok" });
      if (req.url === `/api/companies/${CID}`) return json(200, { id: CID });
      if (req.url === `/api/companies/${CID}/agents`) {
        return json(200, [{ id: AGENT, name: "Foreman", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: shape.wakeOnDemand ?? false } } }]);
      }
      json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, writes);
  } finally {
    server.close();
  }
}

function runCli(args, paperclip) {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ repos: [{ name: "t", repoPath: tmp, githubRepo: "example/t" }], paperclip }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AI_AGENT_") || /GITHUB_TOKEN|^GH_TOKEN$/.test(k)) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, "--config", p], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("CLI: all good → six PASS lines, exit 0, no writes, no GitHub token needed", async () => {
  await withServer({}, async (url, writes) => {
    const r = await runCli(["paperclip:doctor"], cfg({ url }));
    assert.equal(r.code, 0, r.out);
    const lines = r.out.trim().split("\n");
    assert.deepEqual(lines.map((l) => l.slice(0, 5)), Array(6).fill("PASS:"));
    assert.deepEqual(writes, []);
  });
});

test("CLI: one FAIL → exit 1, every check still printed", async () => {
  await withServer({ wakeOnDemand: true }, async (url) => {
    const r = await runCli(["paperclip:doctor"], cfg({ url }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL: wake-on-demand — runtimeConfig\.heartbeat\.wakeOnDemand is true/);
    assert.equal(r.out.trim().split("\n").length, 6);
  });
});

test("CLI: a config that does not load is a FAIL line and exit 1", async () => {
  const r = await runCli(["paperclip:doctor"], { enabled: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: config-complete — .*companyId/);
});

test("CLI: --help lists paperclip:doctor", async () => {
  const r = await runCli(["--help"], {});
  assert.equal(r.code, 0);
  assert.match(r.out, /paperclip:doctor/);
});
