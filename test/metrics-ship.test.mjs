import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";
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

test("a live owner's lock is never taken, however old; a dead owner's lock is recovered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-")), s = await stub();
  try {
    const p = shipPaths(dir);
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.lock, String(process.pid)); // this process is alive
    const old = new Date(NOW - 16 * 60_000);
    utimesSync(p.lock, old, old);
    const rows = run(1, "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z");
    assert.equal(await ship(opts(dir, rows, s)), true);
    assert.equal(s.reqs.length, 0);
    assert.equal(existsSync(p.lock), true);
    assert.equal(existsSync(p.outbox), false);
    writeFileSync(p.lock, "2147483646"); // no such pid
    assert.equal(await ship(opts(dir, rows, s)), true);
    assert.equal(s.reqs.length >= 1, true);
  } finally { await s.close(); }
});

test("a run that finishes during a shipment is shipped by the owner without another trigger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-")), s = await stub();
  try {
    const a = run(1, "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z");
    const both = [...a, ...run(2, "2026-11-09T12:00:00.000Z", "2026-11-09T13:00:00.000Z")];
    let second;
    const s2 = await stub((rec) => {
      if (rec.id === "r1" && !second) second = ship(opts(dir, both, s2)); // B arrives while A awaits its POST
      return null;
    });
    const first = ship(opts(dir, a, s2, { reloadRows: () => both }));
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(s2.reqs.filter((r) => r.source !== "watermark").map((r) => r.id), ["r1", "r2"]);
    assert.equal(existsSync(shipPaths(dir).lock), false);
    await s2.close();
  } finally { await s.close(); }
});

test("an outbox record cut off before its newline is completed or dropped, never skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-")), s = await stub();
  try {
    const p = shipPaths(dir);
    mkdirSync(p.dir, { recursive: true });
    const rows = run(1, "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z");
    await ship({ dir, rows, nowMs: NOW }); // outbox only
    writeFileSync(p.outbox, readFileSync(p.outbox, "utf8").trimEnd()); // intact JSON, newline lost
    assert.equal(await ship(opts(dir, rows, s)), true);
    assert.equal(s.reqs.filter((r) => r.source !== "watermark").map((r) => r.id).join(), "r1");
  } finally { await s.close(); }
});

test("a worked card with issue number 0 is never billed or shipped (jerky_shipping#0)", async () => {
  const rows = [
    row(1, "2026-11-09T10:00:00.000Z", { phase: "unstick", status: "started", runId: "z1" }),
    row(2, "2026-11-09T10:10:00.000Z", { phase: "unstick", status: "finished", outcome: "completed", runId: "z1", workedItems: [{ repo: "o/jerky_shipping", issueNumber: 0 }, { repo: R, issueNumber: 7 }] }),
  ];
  const [r] = shippableRuns(rows, NOW);
  assert.deepEqual(r.shares.map((s) => `${s.repo}#${s.issueNumber}`), [`${R}#7`]);
  assert.equal(r.shares[0].ms, r.durationMs);
  const { parseEmResult } = await import("../dist/plugins/em.js");
  const out = parseEmResult(`EM unstick-result ${JSON.stringify({ verdict: "acted", readable: true, worked: [{ repo: "o/jerky_shipping", issueNumber: 0 }, { repo: R, issueNumber: 7 }] })}`);
  assert.deepEqual(out.worked, [{ repo: R, issueNumber: 7 }]);
});

test("a past day acknowledged short of its end is re-sent after the cursor has moved on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-")), s = await stub();
  try {
    const rows = [...run(1, "2026-11-08T10:00:00.000Z", "2026-11-08T11:00:00.000Z")];
    assert.equal(await ship(opts(dir, rows, s)), true);
    const st = state(dir);
    // a day acked short: 11-09 acknowledged at 11-10T03:35Z, before the Chicago day ended at 06:00Z
    writeFileSync(shipPaths(dir).state, JSON.stringify({ ...st, watermark_acked_period_end: "2026-11-09", day_acks: { ...st.day_acks, "2026-11-09": "2026-11-10T03:35:00.000Z" } }));
    s.reqs.length = 0;
    assert.equal(await ship(opts(dir, rows, s)), true);
    const wm = s.reqs.find((r) => r.source === "watermark");
    assert.equal(wm.json.period_start, "2026-11-09");
    assert.equal(wm.json.period_end, "2026-11-09");
    assert.ok(Date.parse(wm.json.acknowledged_through) >= Date.parse("2026-11-10T06:00:00.000Z"));
    s.reqs.length = 0;
    await ship(opts(dir, rows, s));
    assert.equal(s.reqs.filter((r) => r.source === "watermark").length, 0, "full-day ack: nothing re-sent");
  } finally { await s.close(); }
});
