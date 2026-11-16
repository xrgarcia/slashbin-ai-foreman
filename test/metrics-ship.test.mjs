import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ship, shippableRuns, openRunStartMs, shipPaths } from "../dist/metrics/ship.js";

const R = "o/r";
const NOW = Date.parse("2026-11-10T18:00:00.123Z");
const row = (id, at, d) => ({ id, at, repo: R, issue: 1, kind: "session", stage: null, detail: d });
const run = (n, start, end, extra = {}) => [
  row(n * 2, start, { phase: "build", status: "started", runId: `r${n}`, ...(extra.parent ? { parentRunId: extra.parent } : {}) }),
  ...(end ? [row(n * 2 + 1, end, { phase: "build", status: "finished", outcome: extra.outcome ?? "completed", runId: `r${n}`, workedItems: [{ repo: R, issueNumber: n }] })] : []),
];
const KEY = "k".repeat(16), WKEY = "w".repeat(16);

async function stub(behave = () => null) {
  const reqs = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const source = /\/slashbin\/([a-z-]+)\/events/.exec(req.url)[1];
      const key = source === "watermark" ? WKEY : KEY;
      const rec = { source, id: req.headers["x-slashbin-job-id"], json: JSON.parse(raw), sigOk: req.headers["x-slashbin-signature"] === `sha256=${createHmac("sha256", key).update(raw).digest("hex")}` };
      reqs.push(rec);
      const o = behave(rec, reqs.length - 1) ?? { status: 202 };
      res.writeHead(o.status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { reqs, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}
const state = (dir) => JSON.parse(readFileSync(shipPaths(dir).state, "utf8"));
const opts = (dir, rows, s, extra = {}) => ({ dir, rows, nowMs: NOW, baseUrl: s.url, key: KEY, watermarkKey: WKEY, ...extra });

test("only completed and failed top-level runs ship, ascending by end", () => {
  const rows = [
    ...run(1, "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z"),
    ...run(2, "2026-11-09T09:00:00.000Z", "2026-11-09T10:30:00.000Z", { outcome: "failed" }),
    ...run(3, "2026-11-09T12:00:00.000Z", "2026-11-09T12:10:00.000Z", { outcome: "noWork" }),
    ...run(4, "2026-11-09T12:00:00.000Z", "2026-11-09T12:10:00.000Z", { parent: "r1" }),
    ...run(5, "2026-11-09T12:00:00.000Z", null),
    ...run(6, "2026-11-10T17:00:00.000Z", "2026-11-10T19:00:00.000Z"), // ends after the clock
  ];
  assert.deepEqual(shippableRuns(rows, NOW).map((r) => r.runId), ["r2", "r1"]);
  assert.equal(openRunStartMs(rows), Date.parse("2026-11-09T12:00:00.000Z"));
});

test("a 202 advances; the watermark follows the records and moves the cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-")), s = await stub();
  try {
    const rows = [...run(1, "2026-11-08T10:00:00.000Z", "2026-11-08T11:00:00.000Z"), ...run(2, "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z")];
    assert.equal(await ship(opts(dir, rows, s)), true);
    assert.deepEqual(s.reqs.map((r) => r.id).slice(0, 2), ["r1", "r2"]);
    assert.ok(s.reqs.every((r) => r.sigOk));
    assert.equal(s.reqs[0].json.run.runId, "r1");
    const w = s.reqs.at(-1);
    assert.equal(w.source, "watermark");
    assert.equal(w.json.period_start, "2026-11-08");
    assert.equal(w.json.period_end, "2026-11-09");
    assert.equal(w.json.acknowledged_through, "2026-11-10T18:00:00.123Z");
    assert.equal(state(dir).watermark_acked_period_end, "2026-11-09");
    const n = s.reqs.length;
    assert.equal(await ship(opts(dir, rows, s)), true); // nothing new: nothing sent
    assert.equal(s.reqs.length, n);
  } finally { await s.close(); }
});

test("a non-202 stops, advances nothing past the last 202, sends no watermark; the rerun resumes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-"));
  const rows = [...run(1, "2026-11-08T10:00:00.000Z", "2026-11-08T11:00:00.000Z"), ...run(2, "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z")];
  let s = await stub((_, n) => (n === 1 ? { status: 503 } : null));
  try {
    assert.equal(await ship(opts(dir, rows, s)), false);
    assert.deepEqual(s.reqs.map((r) => r.id), ["r1", "r2"]);
    assert.equal(state(dir).last_event_id, "r1");
  } finally { await s.close(); }
  s = await stub();
  try {
    assert.equal(await ship(opts(dir, rows, s)), true);
    assert.deepEqual(s.reqs.map((r) => r.source), ["foreman-session", "watermark"]);
    assert.equal(s.reqs[0].id, "r2");
  } finally { await s.close(); }
});

test("a rejected watermark leaves the cursor and is resent from the same period_start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-"));
  const rows = run(1, "2026-11-08T10:00:00.000Z", "2026-11-08T11:00:00.000Z");
  let s = await stub((r) => (r.source === "watermark" ? { status: 503 } : null));
  try { assert.equal(await ship(opts(dir, rows, s)), false); } finally { await s.close(); }
  assert.equal(state(dir).watermark_acked_period_end, "2026-11-07");
  s = await stub();
  try {
    assert.equal(await ship(opts(dir, rows, s)), true);
    assert.equal(s.reqs.length, 1);
    assert.equal(s.reqs[0].json.period_start, "2026-11-08");
  } finally { await s.close(); }
});

test("an open run holds acknowledged_through one millisecond before its start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-")), s = await stub();
  try {
    const rows = [...run(1, "2026-11-08T10:00:00.000Z", "2026-11-08T11:00:00.000Z"), ...run(2, "2026-11-10T12:00:00.000Z", null)];
    assert.equal(await ship(opts(dir, rows, s)), true);
    assert.equal(s.reqs.at(-1).json.acknowledged_through, "2026-11-10T11:59:59.999Z");
    assert.equal(s.reqs.filter((r) => r.source === "foreman-session").length, 1);
  } finally { await s.close(); }
});

test("with no base URL or key nothing is sent and the outbox holds the run once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-"));
  const rows = run(1, "2026-11-08T10:00:00.000Z", "2026-11-08T11:00:00.000Z");
  assert.equal(await ship({ dir, rows, nowMs: NOW }), true);
  assert.equal(await ship({ dir, rows, nowMs: NOW }), true);
  assert.equal(readFileSync(shipPaths(dir).outbox, "utf8").trim().split("\n").length, 1);
  assert.equal(existsSync(shipPaths(dir).state), false);
});
