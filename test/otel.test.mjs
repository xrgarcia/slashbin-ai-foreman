import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OtelPlugin } from "../dist/plugins/otel.js";
import { MetricsRecorder, openMetricsDb, readRows } from "../dist/metrics/recorder.js";

const R = "o/r";
const item = (n) => ({ issueNumber: n, repo: R });
const mkLogger = (warns) => { const l = { info() {}, debug() {}, error() {}, warn: (m) => warns.push(m), child() { return l; } }; return l; };
const cfg = (enabled = true) => ({ otel: { enabled, serviceName: "foreman" } });
const VARS = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"];

function sink() {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push({ url: req.url, auth: req.headers.authorization, text: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ bodies, port: srv.address().port, close: () => srv.close() })));
}
const spansOf = (bodies) => bodies.flatMap((b) => JSON.parse(b.text).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
const attr = (span, k) => {
  const a = span.attributes.find((x) => x.key === k);
  if (!a) return undefined;
  const v = a.value;
  if (v.arrayValue) return v.arrayValue.values.map((e) => Number(e.intValue));
  return v.intValue !== undefined ? Number(v.intValue) : v.stringValue ?? v.boolValue;
};

function withEnv(env) {
  const saved = {};
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  return () => { for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
}

async function run(env, events, warns = []) {
  const restore = withEnv(env);
  const p = new OtelPlugin();
  const logger = mkLogger(warns);
  p.start(cfg(), { logger, configText: () => null });
  try {
    for (const e of events) await p.observer.onEvent(e, logger);
    await p.provider.forceFlush();
  } finally { p.stop(); restore(); }
}

test("a started-then-finished implement session is one span; outcome only on the worked subset", async () => {
  const s = await sink();
  const sess = (status, extra = {}) => ({ kind: "session", session: { phase: "implement", status, repo: R, items: [item(1), item(2), item(3)], pr: 7, ...extra } });
  await run({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${s.port}` }, [sess("started"), sess("finished", { worked: [2] })]);
  s.close();
  const spans = spansOf(s.bodies);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "foreman.session.implement");
  assert.equal(attr(spans[0], "foreman.phase"), "implement");
  assert.equal(attr(spans[0], "foreman.status"), "finished");
  assert.equal(attr(spans[0], "foreman.repo"), R);
  assert.equal(attr(spans[0], "foreman.pr"), 7);
  assert.deepEqual(attr(spans[0], "foreman.items.worked"), [2]);
  assert.deepEqual(attr(spans[0], "foreman.items"), [1, 2, 3]);
  assert.equal(attr(spans[0], "foreman.start_missing"), undefined);
});

test("a failed session is an ERROR; a handoff is a span event; no started seen is flagged", async () => {
  const s = await sink();
  const url = { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${s.port}` };
  const sess = (status, extra = {}) => ({ kind: "session", session: { phase: "review", status, repo: R, items: [item(1)], pr: 9, ...extra } });
  await run(url, [sess("started"), sess("handoff", { reviewer: "claude" }), sess("failed")]);
  await run(url, [sess("finished")]);
  s.close();
  const spans = spansOf(s.bodies);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].status.code, 2);
  assert.equal(spans[0].events.length, 1);
  assert.equal(attr(spans[1], "foreman.start_missing"), true);
});

test("a lifecycle event is its own trace; report text, detail, titles and header values are never sent", async () => {
  const s = await sink();
  await run(
    { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${s.port}`, OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer SECRETVALUE" },
    [
      { kind: "claim", item: { ...item(5), title: "SECRET TITLE" } },
      { kind: "session", session: { phase: "implement", status: "finished", repo: R, items: [item(5)], detail: "SECRET DETAIL", report: { text: "SECRET REPORT" } } },
    ],
  );
  s.close();
  const spans = spansOf(s.bodies);
  const point = spans.find((x) => x.name === "foreman.item.claim");
  assert.ok(point);
  assert.equal(attr(point, "foreman.item"), 5);
  assert.ok(BigInt(point.endTimeUnixNano) - BigInt(point.startTimeUnixNano) < 50_000_000n);
  const all = s.bodies.map((b) => b.text).join("");
  for (const secret of ["SECRET TITLE", "SECRET DETAIL", "SECRET REPORT", "SECRETVALUE"]) assert.equal(all.includes(secret), false, secret);
  assert.equal(s.bodies[0].auth, "Bearer SECRETVALUE");
});

test("a refused destination does not stall: one warning per outage, the metrics row is still written", async () => {
  const s = await sink();
  const port = s.port;
  s.close();
  const warns = [];
  const restore = withEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` });
  const p = new OtelPlugin();
  const logger = mkLogger(warns);
  p.start(cfg(), { logger, configText: () => null });
  const db = openMetricsDb(join(mkdtempSync(join(tmpdir(), "otel-")), "m.db"));
  const rec = new MetricsRecorder(db, 90, () => Date.now());
  let slowest = 0;
  for (let i = 0; i < 3; i++) {
    const ev = { kind: "claim", item: item(i + 1) };
    const t0 = Date.now();
    await p.observer.onEvent(ev, logger);
    slowest = Math.max(slowest, Date.now() - t0);
    rec.record(ev, logger);
  }
  assert.ok(slowest < 500, `onEvent took ${slowest}ms`);
  void p.provider.forceFlush().catch(() => undefined);
  for (let i = 0; i < 300 && !warns.some((w) => w.startsWith("otel: export failed")); i++) await new Promise((r) => setTimeout(r, 100));
  p.stop();
  restore();
  assert.equal(warns.filter((w) => w.startsWith("otel: export failed")).length, 1);
  assert.equal(readRows(db, { sinceIso: "2000-01-01T00:00:00Z" }).length, 3);
});

test("disabled: no observer; enabled with no endpoint warns once and exports nothing", () => {
  const p = new OtelPlugin();
  assert.equal(p.enabled(cfg(false)), false);
  assert.equal(p.observer, undefined);
  const warns = [];
  const restore = withEnv({});
  p.start(cfg(), { logger: mkLogger(warns), configText: () => null });
  restore();
  assert.equal(warns.length, 1);
  assert.equal(p.observer, undefined);
});
