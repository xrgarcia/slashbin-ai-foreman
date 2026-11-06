#!/usr/bin/env node
/**
 * Acceptance for "a blocked card has an owner" (EM#417 follow-on, 2026-10-03).
 *
 * Live verification found the 8 blocked cards unassigned: the board mapping
 * had no blocked step, so a card blocked on GitHub (the `blocked` label) or by
 * the Foreman (an agent declining the issue, revision retries exhausted) sat in
 * nobody's queue. `paperclip.board.blocked` names its owner, status and stage
 * label like every other stage; the open-source default owner is the Foreman,
 * ours is the Engineering Manager. (The EM sync's per-row rule is the EM repo's own
 * acceptance: scripts/slashbin-ai/em-paperclip-board-blocked-acceptance.mjs.)
 *
 * A Foreman "waiting" hold (an occupied branch, a back-off) is not this step:
 * it stays the Foreman's, transient, and is resumed when the wait ends.
 *
 * Front doors: the BUILT Foreman (config loader, PaperclipMirror + client on a
 * FAKE Paperclip, dist/paperclip/board.js), docs:check. No real Paperclip, no GitHub.
 *
 * RED TODAY (features ae09a38): no board.blocked, no "Blocked" stage label,
 * onBlocked is a note only, the sync leaves a GitHub-blocked card unassigned.
 *
 *   K1 config: board.blocked defaults to owner foreman, status blocked, label "Blocked"; an owner role resolves
 *   K2 mirror onBlocked → blocked, configured owner, "Blocked" label, reason in the unblock descriptor, one note
 *   K3 default config: onBlocked → blocked, the Foreman holds it
 *   K4 a Foreman-held onBlocked card is not mistaken for a waiting hold: an empty waiting set leaves it blocked
 *   K5 a restarted mirror reads an onBlocked card as blocked, not waiting
 *   K6 waiting still holds with the Foreman (not the blocked owner) and resumes when the wait ends
 *   D1 docs:check green; docs/paperclip.md documents the blocked stage and "Blocked"
 *
 *   node scripts/acceptance/paperclip-blocked-owner.mjs
 */
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CID = "11111111-2222-4333-8444-555555555555";
const FOREMAN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TL = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
const EM = "aaaaaaaa-bbbb-4ccc-8ddd-000000000002";
const OTHER_LABEL = "99999999-0000-4000-8000-000000000000";
const STAGE_NAMES = ["Blocked", "In code review", "Changes requested", "Pending verification", "Awaiting release"];

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

// Fake Paperclip: issues (comment-reopen rule, one-assignee 422, labelIds replace
// the set), company labels (unique name), projects, agents (records PATCH bodies).
let rows = [], comments = {}, seq = 0, labels = [], labelPosts = 0, agentPatches = [], agents = [], agentMeta = {};
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : null;
    const u = new URL(req.url, "http://x");
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && u.pathname === `/api/companies/${CID}/issues`) {
      const off = Number(u.searchParams.get("offset") || 0), lim = Number(u.searchParams.get("limit") || 1000);
      return json(200, rows.slice(off, off + lim));
    }
    if (u.pathname === `/api/companies/${CID}/projects`) return json(req.method === "GET" ? 200 : 201, req.method === "GET" ? [] : { id: `proj-${++seq}`, ...parsed });
    if (req.method === "GET" && u.pathname === `/api/companies/${CID}/labels`) return json(200, labels);
    if (req.method === "POST" && u.pathname === `/api/companies/${CID}/labels`) {
      labelPosts++;
      if (labels.some((l) => l.name === parsed?.name)) return json(409, { error: "Label already exists" });
      const l = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, companyId: CID, ...parsed }; labels.push(l); return json(201, l);
    }
    if (req.method === "GET" && u.pathname === `/api/companies/${CID}/agents`) return json(200, agents);
    if (req.method === "POST" && u.pathname === `/api/companies/${CID}/issues`) {
      const r = { id: `row-${++seq}`, unblockDescriptor: null, labelIds: [], ...parsed }; rows.push(r); return json(201, r);
    }
    let m = u.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (m) {
      const a = (agentMeta[m[1]] ||= { id: m[1], metadata: {} });
      if (req.method === "PATCH") { agentPatches.push({ id: m[1], body: parsed, at: Date.now() }); Object.assign(a, parsed); }
      return json(200, a);
    }
    const reopens = (r) => ["blocked", "done", "cancelled"].includes(r.status) && r.assigneeAgentId;
    m = u.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (m && req.method === "GET") { const r = rows.find((x) => x.id === m[1]); return r ? json(200, r) : json(404, {}); }
    if (m && req.method === "PATCH") {
      const r = rows.find((x) => x.id === m[1]); if (!r) return json(404, {});
      const { comment, ...fields } = parsed || {};
      if (fields.labelIds && fields.labelIds.some((id) => id !== OTHER_LABEL && !labels.some((l) => l.id === id))) return json(422, { error: "Unknown label" });
      if (comment !== undefined) {
        (comments[m[1]] ||= []).push(comment);
        if (!("status" in fields) && reopens(r)) r.status = "todo";
      }
      const next = { ...r, ...fields };
      if (next.assigneeAgentId && next.assigneeUserId) return json(422, { error: "Issue can only have one assignee" });
      Object.assign(r, next); return json(200, r);
    }
    m = u.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (m && req.method === "POST") {
      (comments[m[1]] ||= []).push(parsed?.body);
      const r = rows.find((x) => x.id === m[1]);
      if (r && reopens(r)) r.status = "todo";
      return json(201, { id: `c${++seq}`, body: parsed?.body });
    }
    json(404, { error: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const REPO = "example/acceptance";
const item = (n) => ({ issueNumber: n, repo: REPO });
const rc = { name: "acceptance", githubRepo: REPO };
const row = (n) => rows.find((r) => String(r.description || "").startsWith(`source: ${REPO}#${n}\n`));
const notes = (n) => (comments[row(n)?.id] || []).join(" | ");
const stageIdOf = (name) => labels.find((l) => l.name === name)?.id;
const stagesOn = (r) => (r?.labelIds || []).map((id) => labels.find((l) => l.id === id)?.name).filter((n) => STAGE_NAMES.includes(n));
const shows = (n, status, agent, stage) => {
  const r = row(n);
  const st = stagesOn(r);
  const ok = r?.status === status && r?.assigneeAgentId === agent && !r?.assigneeUserId
    && (stage === null ? st.length === 0 : stage === undefined ? true : st.length === 1 && st[0] === stage);
  return [ok, JSON.stringify({ status: r?.status, agent: r?.assigneeAgentId === FOREMAN ? "Foreman" : r?.assigneeAgentId === TL ? "TechLead" : r?.assigneeAgentId === EM ? "EM" : r?.assigneeAgentId, stages: st })];
};
const seedRow = (n, status, agent, stageName) => rows.push({
  id: `seed-${n}`, title: `acceptance#${n}`, status, assigneeAgentId: agent, assigneeUserId: null, unblockDescriptor: null,
  labelIds: [OTHER_LABEL, ...(stageName && stageIdOf(stageName) ? [stageIdOf(stageName)] : [])],
  description: `source: ${REPO}#${n}\n\nhttps://example.test/${n}`,
});
const lastLease = () => [...agentPatches].reverse().find((p) => p.id === FOREMAN && p.body?.metadata?.foremanLive)?.body.metadata.foremanLive;

const pcfgBase = { enabled: true, url: BASE, companyId: CID, agentId: FOREMAN, agentName: "Foreman",
  identityKeyFormat: "source: {repo}#{N}", agentStatus: true, projects: false, projectNameFormat: "{name}" };

const mirrorPath = join(DIR, "dist", "paperclip", "mirror.js");
const clientPath = join(DIR, "dist", "paperclip", "client.js");
const configPath = join(DIR, "dist", "config.js");
const fBoardPath = join(DIR, "dist", "paperclip", "board.js");
const TEAM = {
  roles: {
    techLead: { name: "Tech Lead", reportsTo: "engineeringManager", id: TL },
    engineeringManager: { name: "Engineering Manager", role: "general", id: EM },
  },
  board: {
    inReview: { owner: "techLead" }, reviewing: { owner: "techLead" },
    pendingVerification: { owner: "engineeringManager", status: "todo" }, awaitingRelease: { owner: "engineeringManager" },
    blocked: { owner: "engineeringManager" },
  },
};

const { PaperclipMirror } = await import(pathToFileURL(mirrorPath).href);
const { PaperclipClient } = await import(pathToFileURL(clientPath).href);
const { loadConfig, defaultLifecycleLabels } = await import(pathToFileURL(configPath).href);
const tmp = mkdtempSync(join(tmpdir(), "blocked-owner-"));
const cfgFile = join(tmp, "cfg.json");
const load = (pc) => {
  writeFileSync(cfgFile, JSON.stringify({ repos: [{ name: "acceptance", repoPath: tmp, githubRepo: REPO }], paperclip: { companyId: CID, agentId: FOREMAN, ...pc } }));
  return loadConfig(cfgFile).paperclip;
};
for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];

let team = {}, solo = {};
try { team = load(TEAM); } catch (e) { check("K1 team config with board.blocked loads", false, e.message); }
try { solo = load({}); } catch (e) { check("K1 default config loads", false, e.message); }
rmSync(tmp, { recursive: true, force: true });
check("K1 board.blocked defaults: owner foreman, status blocked, label blocked → \"Blocked\"",
  solo.board?.blocked?.owner === "foreman" && solo.board?.blocked?.status === "blocked" && solo.board?.blocked?.label === "blocked"
  && solo.stageLabels?.blocked?.name === "Blocked", JSON.stringify({ b: solo.board?.blocked ?? null, l: solo.stageLabels?.blocked ?? null }));
check("K1 board.blocked owner from config", team.board?.blocked?.owner === "engineeringManager" && team.board?.blocked?.status === "blocked",
  JSON.stringify(team.board?.blocked ?? null));

const client = new PaperclipClient({ url: BASE, companyId: CID });
const teamCfg = { ...pcfgBase, board: team.board, roles: team.roles, stageLabels: team.stageLabels };
const soloCfg = { ...pcfgBase, board: solo.board, roles: solo.roles, stageLabels: solo.stageLabels };
const REASON = "Revision retries exhausted on PR #7: exit 1";

// --- Mirror
rows = []; comments = {};
seedRow(21, "todo", FOREMAN, null);
seedRow(22, "todo", FOREMAN, null);
seedRow(23, "todo", FOREMAN, null);
let mirror = new PaperclipMirror(client, teamCfg, [], logger);
await mirror.onBlocked(item(21), REASON, rc, logger);
let [ok, got] = shows(21, "blocked", EM, "Blocked");
check("K2 onBlocked → blocked, Engineering Manager, \"Blocked\"", ok, got);
check("K2 the reason is the unblock descriptor's action; one note", (row(21)?.unblockDescriptor?.action || "").includes("PR #7")
  && (comments[row(21)?.id] || []).length === 1, JSON.stringify({ d: row(21)?.unblockDescriptor ?? null, n: comments[row(21)?.id] ?? [] }));

const soloMirror = new PaperclipMirror(client, soloCfg, [], logger);
await soloMirror.onBlocked(item(22), REASON, rc, logger);
[ok, got] = shows(22, "blocked", FOREMAN, "Blocked");
check("K3 default config: onBlocked → blocked, the Foreman", ok, got);
await soloMirror.onWaiting(REPO, [], logger);
[ok, got] = shows(22, "blocked", FOREMAN, "Blocked");
check("K4 an empty waiting set leaves a Foreman-held blocked card blocked (not resumed)", ok, got);
const reborn = new PaperclipMirror(client, soloCfg, [], logger);
await reborn.onWaiting(REPO, [], logger);
[ok, got] = shows(22, "blocked", FOREMAN, "Blocked");
check("K5 a restarted mirror reads it as blocked, not waiting", ok, got);

await mirror.onWaiting(REPO, [{ item: item(23), reason: "features branch occupied by open PR #4" }], logger);
const w1 = row(23)?.status === "blocked" && row(23)?.assigneeAgentId === FOREMAN;
await mirror.onWaiting(REPO, [], logger);
check("K6 waiting holds with the Foreman, then resumes", w1 && row(23)?.status !== "blocked", JSON.stringify({ w1, now: row(23)?.status }));

// --- Docs
{
  const r = spawnSync("npm", ["run", "--silent", "docs:check"], { cwd: DIR, encoding: "utf8", timeout: 120_000 });
  check("D1 docs:check green", r.status === 0, (r.stderr || r.stdout || "").trim().slice(0, 200));
  const doc = existsSync(join(DIR, "docs", "paperclip.md")) ? readFileSync(join(DIR, "docs", "paperclip.md"), "utf8") : "";
  check("D1 docs/paperclip.md documents the blocked stage and its \"Blocked\" label", /\|\s*`blocked`\s*\|/.test(doc) && doc.includes("`Blocked`"));
}

server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
