#!/usr/bin/env node
/**
 * Acceptance for EM#417 child "paperclip-doctor-command" — a read-only
 * `paperclip:doctor` that prints PASS/FAIL per named check and exits non-zero
 * on any failure, so the setup skill and an operator can trust one command.
 *
 * Front door: the BUILT CLI, `node dist/cli.js paperclip:doctor --config <path>`,
 * run as a child process against a FAKE Paperclip HTTP server on a random port
 * whose responses each case shapes. GitHub tokens are UNSET for every run: the
 * doctor must not need them. No real Paperclip or GitHub is touched.
 *
 * Checks, in order: health · company · agent-registered · wake-on-demand ·
 * heartbeat-enabled · config-complete.
 *
 * RED TODAY (features 977c2ac): the CLI has no paperclip:doctor.
 *
 *   node scripts/acceptance/paperclip-doctor.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(DIR, "dist", "cli.js");
const CID = "11111111-2222-4333-8444-555555555555";
const AGENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

// The fake's behaviour per case.
let shape = {};
const writes = [];
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.method !== "GET") writes.push(`${req.method} ${req.url}`);
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/health") return json(200, { status: "ok", version: "2026.916.1" });
    if (u.pathname === `/api/companies/${CID}`) return shape.company === false ? json(404, {}) : json(200, { id: CID, name: "Acme" });
    if (u.pathname === `/api/companies/${CID}/agents`) {
      if (shape.company === false) return json(404, {});
      if (shape.agent === false) return json(200, []);
      return json(200, [{ id: AGENT, name: "Foreman", adapterType: "process",
        runtimeConfig: { heartbeat: { enabled: shape.heartbeatEnabled ?? false, wakeOnDemand: shape.wakeOnDemand ?? false } } }]);
    }
    json(404, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const LIVE = `http://127.0.0.1:${server.address().port}`;

const tmp = mkdtempSync(join(tmpdir(), "foreman-417-doctor-"));
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("AI_AGENT_") || /GITHUB_TOKEN|^GH_TOKEN$/.test(k)) delete env[k];

const run = (paperclip) => new Promise((resolve) => {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ repos: [{ name: "acceptance", repoPath: tmp, githubRepo: "example/acceptance" }], paperclip }));
  const child = spawn("node", [CLI, "paperclip:doctor", "--config", p], { cwd: DIR, env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const t = setTimeout(() => child.kill("SIGKILL"), 30_000);
  child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
});
const full = (over = {}) => ({ enabled: true, url: LIVE, companyId: CID, agentId: AGENT, ...over });
const passes = (out, names) => names.every((n) => new RegExp(`PASS:?\\s*${n}`, "i").test(out));
const fails = (out, name, also = "") => new RegExp(`FAIL:?\\s*${name}`, "i").test(out) && (!also || out.includes(also));

try {
  if (!existsSync(CLI)) { console.error(`no build at ${CLI}`); process.exit(2); }

  shape = {};
  let r = await run(full({ url: "http://127.0.0.1:9" }));
  check("D1 unreachable → FAIL health, exit≠0", r.code !== 0 && fails(r.out, "health"), r.out.slice(0, 200));

  shape = { company: false };
  r = await run(full());
  check("D2 unknown company → PASS health, FAIL company", r.code !== 0 && passes(r.out, ["health"]) && fails(r.out, "company"), r.out.slice(0, 300));

  shape = { agent: false };
  r = await run(full());
  check("D3 agent missing → FAIL agent-registered", r.code !== 0 && passes(r.out, ["health", "company"]) && fails(r.out, "agent-registered"), r.out.slice(0, 300));

  shape = { wakeOnDemand: true };
  r = await run(full());
  check("D4 wake-on-demand on → FAIL wake-on-demand", r.code !== 0 && passes(r.out, ["health", "company", "agent-registered"]) && fails(r.out, "wake-on-demand"), r.out.slice(0, 300));

  shape = { heartbeatEnabled: true };
  r = await run(full());
  check("D5 heartbeat on → FAIL heartbeat-enabled", r.code !== 0 && fails(r.out, "heartbeat-enabled"), r.out.slice(0, 300));

  shape = {};
  r = await run(full({ enabled: false }));
  check("D6 enabled false → FAIL config-complete naming enabled", r.code !== 0 && fails(r.out, "config-complete", "enabled"), r.out.slice(0, 300));

  r = await run(full({ agentId: undefined }));
  check("D7 no agentId → FAIL naming agentId", r.code !== 0 && /agentId/.test(r.out), r.out.slice(0, 300));

  r = await run(full());
  const passCount = (r.out.match(/PASS/gi) || []).length;
  check("D8 all good → six PASS, exit 0", r.code === 0 && passCount >= 6 && !/FAIL/i.test(r.out), `exit ${r.code}, ${passCount} PASS`);

  check("D9 read-only: no POST/PATCH/PUT/DELETE across all runs", writes.length === 0, writes.join(", "));
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
