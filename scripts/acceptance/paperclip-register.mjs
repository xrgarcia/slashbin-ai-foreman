#!/usr/bin/env node
/**
 * Acceptance for EM#417 child "paperclip-agent-bootstrap" — `npm run
 * paperclip:register` registers the Foreman as an agent in the configured
 * Paperclip company with every wake path OFF, is idempotent, re-applies the
 * flags to an existing agent, and writes the agent id back into the operator's
 * own config, preserving every other key.
 *
 * Front door: the Foreman's `scripts/paperclip/agent.mjs`, run as a child
 * process from the Foreman checkout against a temp `.ai-agent.json`. Paperclip
 * is a FAKE HTTP server on a random port serving `/api/...` (the real server
 * mounts its API there, `server/src/app.ts:962`) and recording every request.
 * No real Paperclip, no GitHub, nothing outside the OS temp dir is written.
 *
 * Why the wake flags are asserted: the `process` adapter runs `config.command`
 * when woken and throws with none (`server/src/adapters/process/execute.ts:19`);
 * wake-on-demand fires on task assignment and defaults ON
 * (`server/src/services/heartbeat-policy.ts`). Proving that a real assignment
 * creates no run needs the real server — that is the issue's human validation.
 *
 * RED TODAY (features 977c2ac): no scripts/paperclip/agent.mjs.
 *
 *   R1 first run: one POST /api/companies/<id>/agents with name, role engineer,
 *      adapterType process, runtimeConfig.heartbeat {enabled:false, wakeOnDemand:false}; exit 0
 *   R2 agentId written to the config's paperclip block; every other key preserved
 *   R3 second run: no POST; one PATCH /api/agents/<id> re-applying both flags; exit 0
 *   R4 config without a paperclip block: exit ≠ 0, no request made
 *   R5 Paperclip unreachable: exit ≠ 0 naming the URL; config unchanged
 *
 *   node scripts/acceptance/paperclip-register.mjs
 *   (default ~/code/slashbin-ai-foreman; run `npm run build` there first)
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(DIR, "scripts", "paperclip", "agent.mjs");
const COMPANY = "11111111-2222-4333-8444-555555555555";
const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

// Fake Paperclip: agents list per company, records requests.
const requests = [];
let agents = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : null;
    requests.push({ method: req.method, url: req.url, body: parsed });
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url.startsWith(`/api/companies/${COMPANY}/agents`)) return json(200, agents);
    if (req.method === "POST" && req.url === `/api/companies/${COMPANY}/agents`) {
      const a = { id: AGENT_ID, companyId: COMPANY, ...parsed };
      agents.push(a);
      return json(201, a);
    }
    if (req.method === "PATCH" && req.url === `/api/agents/${AGENT_ID}`) {
      Object.assign(agents[0] ?? {}, parsed);
      return json(200, agents[0] ?? {});
    }
    if (req.method === "GET" && req.url === "/api/health") return json(200, { status: "ok" });
    json(404, { error: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_BASE = `http://127.0.0.1:${server.address().port}`;

const tmp = mkdtempSync(join(tmpdir(), "foreman-417-register-"));
const writeCfg = (cfg) => { const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(cfg, null, 2)); return p; };
const baseCfg = (extra = {}) => ({
  triggerLabel: "approved",
  repos: [{ name: "acceptance", repoPath: tmp, githubRepo: "example/acceptance" }],
  ...extra,
});
// Async on purpose: the fake Paperclip lives in THIS process, and spawnSync
// blocks the event loop so it could never answer (every run timed out).
const run = (cfgPath) => new Promise((resolve) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AI_AGENT_")) delete env[k];
  const child = spawn("node", [SCRIPT, cfgPath], { cwd: DIR, env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
  child.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});
const flagsOff = (rc) => rc?.heartbeat?.enabled === false && rc?.heartbeat?.wakeOnDemand === false;

try {
  if (!existsSync(SCRIPT)) {
    check("paperclip:register script exists", false, SCRIPT);
  } else {
    const cfgPath = writeCfg(baseCfg({ paperclip: { url: URL_BASE, companyId: COMPANY } }));
    requests.length = 0;
    const r1 = await run(cfgPath);
    const posts = requests.filter((q) => q.method === "POST");
    const post = posts[0]?.body ?? {};
    check("R1 first run exits 0", r1.status === 0, `exit ${r1.status}: ${(r1.stderr || r1.stdout).slice(0, 200)}`);
    check("R1 exactly one POST to /api/companies/<id>/agents", posts.length === 1 && posts[0].url === `/api/companies/${COMPANY}/agents`,
      JSON.stringify(posts.map((q) => q.url)));
    check("R1 registered as Foreman / engineer / process", post.name === "Foreman" && post.role === "engineer" && post.adapterType === "process",
      JSON.stringify({ name: post.name, role: post.role, adapterType: post.adapterType }));
    check("R1 every wake path off", flagsOff(post.runtimeConfig), JSON.stringify(post.runtimeConfig ?? null));

    const after = JSON.parse(readFileSync(cfgPath, "utf8"));
    check("R2 agentId written to the paperclip block", after.paperclip?.agentId === AGENT_ID, JSON.stringify(after.paperclip ?? null));
    check("R2 other keys preserved", after.triggerLabel === "approved" && after.repos?.[0]?.githubRepo === "example/acceptance"
      && after.paperclip?.companyId === COMPANY && after.paperclip?.url === URL_BASE);

    requests.length = 0;
    agents[0].runtimeConfig = { heartbeat: { enabled: false, wakeOnDemand: true } }; // drifted: someone re-enabled wake
    const r3 = await run(cfgPath);
    const patches = requests.filter((q) => q.method === "PATCH");
    check("R3 second run exits 0", r3.status === 0, `exit ${r3.status}`);
    check("R3 second run makes no POST", !requests.some((q) => q.method === "POST"));
    check("R3 existing agent gets the wake flags re-applied", patches.length === 1 && patches[0].url === `/api/agents/${AGENT_ID}`
      && flagsOff(patches[0].body?.runtimeConfig), JSON.stringify(patches.map((q) => [q.url, q.body?.runtimeConfig])));

    requests.length = 0;
    const r4 = await run(writeCfg(baseCfg()));
    check("R4 no paperclip block: exit ≠ 0 and no request", r4.status !== 0 && requests.length === 0, `exit ${r4.status}, ${requests.length} request(s)`);

    const deadCfg = baseCfg({ paperclip: { url: "http://127.0.0.1:9", companyId: COMPANY } });
    const deadPath = writeCfg(deadCfg);
    const before = readFileSync(deadPath, "utf8");
    const r5 = await run(deadPath);
    check("R5 unreachable Paperclip: exit ≠ 0 naming the URL", r5.status !== 0 && `${r5.stdout}${r5.stderr}`.includes("127.0.0.1:9"), `exit ${r5.status}`);
    check("R5 config unchanged", readFileSync(deadPath, "utf8") === before);
  }
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
