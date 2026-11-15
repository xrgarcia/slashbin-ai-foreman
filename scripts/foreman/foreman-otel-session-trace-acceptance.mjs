#!/usr/bin/env node
/**
 * Acceptance for slashbin-ai-foreman#292: the built `otel` observer, fed Foreman events, exports
 * session traces to a LOCAL OTLP sink (never a real collector). Run after `npm run build`:
 *   node scripts/foreman/foreman-otel-session-trace-acceptance.mjs
 * Matrix: one span per session; repo/phase/status/PR present; outcome on the worked subset only;
 * no report text, title or header value; a failed session is an error; a lifecycle event is its own
 * trace; a refused destination does not stall and warns once.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { OtelPlugin } from "../../dist/plugins/otel.js";

const R = "o/r";
const item = (n) => ({ issueNumber: n, repo: R });
const VARS = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
for (const k of VARS) delete process.env[k];

const bodies = [];
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => { bodies.push({ auth: req.headers.authorization, text: Buffer.concat(chunks).toString() }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const port = srv.address().port;

const warns = [];
const logger = { info() {}, debug() {}, error() {}, warn: (m) => warns.push(m), child() { return logger; } };
const ctx = { logger, configText: () => null };
const cfg = { otel: { enabled: true, serviceName: "foreman" } };
const spans = () => bodies.flatMap((b) => JSON.parse(b.text).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
const attr = (sp, k) => { const a = sp.attributes.find((x) => x.key === k); const v = a?.value; return !v ? undefined : v.arrayValue ? v.arrayValue.values.map((e) => Number(e.intValue)) : v.intValue !== undefined ? Number(v.intValue) : v.stringValue ?? v.boolValue; };
const sess = (phase, status, extra = {}) => ({ kind: "session", session: { phase, status, repo: R, items: [item(1), item(2), item(3)], pr: 7, ...extra } });

let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}: ${e.message}`); } };

process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer SECRETVALUE";
const p = new OtelPlugin();
p.start(cfg, ctx);
for (const e of [
  sess("implement", "started"),
  sess("implement", "finished", { worked: [2], detail: "SECRET DETAIL", report: { text: "SECRET REPORT" } }),
  sess("review", "started"), sess("review", "handoff", { reviewer: "claude" }), sess("review", "failed"),
  { kind: "claim", item: { ...item(9), title: "SECRET TITLE" } },
]) await p.observer.onEvent(e, logger);
await p.provider.forceFlush();

const all = spans();
const impl = all.find((s) => s.name === "foreman.session.implement");
const rev = all.find((s) => s.name === "foreman.session.review");
check("one span per session", () => assert.equal(all.filter((s) => s.name.startsWith("foreman.session.")).length, 2));
check("repo, phase, status, PR present", () => { assert.equal(attr(impl, "foreman.repo"), R); assert.equal(attr(impl, "foreman.phase"), "implement"); assert.equal(attr(impl, "foreman.status"), "finished"); assert.equal(attr(impl, "foreman.pr"), 7); });
check("outcome on the worked subset only", () => assert.deepEqual(attr(impl, "foreman.items.worked"), [2]));
check("a failed session is an error; a handoff is a span event", () => { assert.equal(rev.status.code, 2); assert.equal(rev.events.length, 1); });
check("a lifecycle event is its own trace", () => assert.equal(attr(all.find((s) => s.name === "foreman.item.claim"), "foreman.item"), 9));
check("no report text, detail, title or header value is exported", () => {
  const text = bodies.map((b) => b.text).join("");
  for (const s of ["SECRET REPORT", "SECRET DETAIL", "SECRET TITLE", "SECRETVALUE"]) assert.equal(text.includes(s), false, s);
});
p.stop();
srv.close();

// A refused destination: onEvent returns at once, one warning, no throw.
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
const q = new OtelPlugin();
q.start(cfg, ctx);
const t0 = Date.now();
for (let i = 0; i < 3; i++) await q.observer.onEvent({ kind: "claim", item: item(i + 1) }, logger);
const took = Date.now() - t0;
void q.provider.forceFlush().catch(() => undefined);
for (let i = 0; i < 300 && !warns.some((w) => w.startsWith("otel: export failed")); i++) await new Promise((r) => setTimeout(r, 100));
q.stop();
check("a refused destination does not stall", () => assert.ok(took < 500, `${took}ms`));
check("one failure warning", () => assert.equal(warns.filter((w) => w.startsWith("otel: export failed")).length, 1));

for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
