// The agent result contract v1: one typed line decides, prose decides nothing,
// and a malformed line fails closed with the field named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readResultV1, formatResultV1, roleJsonSchemas, waitUntilSlug, ROLES } from "../dist/contract/result-v1.js";
import { readContractUsage, recordContractPath } from "../dist/contract/usage.js";
import { BackoffTracker } from "../dist/backoff.js";

const SHA = "a".repeat(40);
const deployHeld = {
  role: "deployer", outcome: "held", pr: 12, merged: false, verify: "hold",
  hold: "predeploy-stop", hold_class: "time", eligible_at: "2026-11-10T14:00:00Z",
  reason_text: "Deploy window opens at 8 am Central.",
};

test("absent: no v1 line reads as absent, so the caller falls back to the legacy trailer", () => {
  assert.deepEqual(readResultV1("SRE_DEPLOY pr=#12 merged=no verify=hold", "deployer", 12), { status: "absent" });
});

test("ok: a valid line parses, and the last line for the role and PR wins", () => {
  const text = [
    "chatter",
    formatResultV1({ ...deployHeld, pr: 11 }),
    formatResultV1({ ...deployHeld, hold_class: "person", eligible_at: null }),
    formatResultV1(deployHeld),
    "more chatter after the line",
  ].join("\n");
  const r = readResultV1(text, "deployer", 12);
  assert.equal(r.status, "ok");
  assert.equal(r.result.hold_class, "time");
  assert.equal(r.result.eligible_at, "2026-11-10T14:00:00Z");
  assert.equal(readResultV1(text, "deployer", 11).result.pr, 11);
});

test("prose decides nothing: rewriting reason_text leaves every other field identical (C4)", () => {
  const a = readResultV1(formatResultV1(deployHeld), "deployer", 12).result;
  const b = readResultV1(formatResultV1({ ...deployHeld, reason_text: "STOP. Do not deploy. Blocked forever." }), "deployer", 12).result;
  const strip = ({ reason_text, ...rest }) => rest;
  assert.deepEqual(strip(a), strip(b));
});

test("fail closed: a hold without hold_class, or a time hold without eligible_at, names the field", () => {
  const r1 = readResultV1(formatResultV1({ ...deployHeld, hold_class: undefined }), "deployer", 12);
  assert.equal(r1.status, "invalid");
  assert.match(r1.problem, /hold_class/);
  const r2 = readResultV1(formatResultV1({ ...deployHeld, eligible_at: undefined }), "deployer", 12);
  assert.equal(r2.status, "invalid");
  assert.match(r2.problem, /eligible_at/);
});

test("fail closed: unparsable JSON, a wrong enum, and a newer schema major are all invalid", () => {
  assert.equal(readResultV1("FOREMAN_RESULT_V1 {not json", "deployer", 12).status, "invalid");
  const bad = readResultV1(formatResultV1({ ...deployHeld, verify: "maybe" }), "deployer", 12);
  assert.equal(bad.status, "invalid");
  assert.match(bad.problem, /verify/);
  const newer = readResultV1(`FOREMAN_RESULT_V1 ${JSON.stringify({ ...deployHeld, schema: 2 })}`, "deployer", 12);
  assert.equal(newer.status, "invalid");
  assert.match(newer.problem, /contract-version-unsupported/);
});

test("additive fields are ignored, never an error", () => {
  const r = readResultV1(formatResultV1({ ...deployHeld, future_field: { x: 1 } }), "deployer", 12);
  assert.equal(r.status, "ok");
});

test("implementer: pr-opened needs pr and issues_named; a skip can name the PR blocking it", () => {
  assert.equal(readResultV1(formatResultV1({ role: "implementer", outcome: "pr-opened", pr: 5 }), "implementer").status, "invalid");
  assert.equal(readResultV1(formatResultV1({ role: "implementer", outcome: "pr-opened", pr: 5, issues_named: [239] }), "implementer").status, "ok");
  const s = readResultV1(formatResultV1({ role: "implementer", outcome: "skipped", skipped_issue: 9, waiting_on: "#41" }), "implementer");
  assert.equal(s.result.waiting_on, "#41");
});

test("verifier: wait-until needs eligible_at, and maps to the legacy wait slug", () => {
  assert.equal(readResultV1(formatResultV1({ role: "verifier", outcome: "hold", pr: 3, hold: "wait-until" }), "verifier", 3).status, "invalid");
  assert.equal(waitUntilSlug("2026-11-10T14:05:00Z"), "wait-until-20261110T1405Z");
});

test("reviewer: a valid approve line with head_sha", () => {
  const r = readResultV1(formatResultV1({ role: "reviewer", outcome: "approve", pr: 7, merged: true, head_sha: SHA, deploy: "na" }), "reviewer", 7);
  assert.equal(r.status, "ok");
});

test("published schemas match the code: schemas/<role>.v1.json is regenerated, never hand-edited", () => {
  const live = roleJsonSchemas();
  for (const role of ROLES) {
    const file = new URL(`../schemas/${role}.v1.json`, import.meta.url);
    assert.ok(existsSync(file), `schemas/${role}.v1.json is missing: run npm run schemas`);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), JSON.parse(JSON.stringify(live[role])), `schemas/${role}.v1.json is stale: run npm run schemas`);
  }
});

test("usage metric counts each path per agent and role, and logs the first legacy answer once", () => {
  // Its own agent name: the suite's test files share one state dir and the readers record "sre" too.
  const agent = `usage-test-${process.pid}`;
  const logs = [];
  recordContractPath(agent, "deployer", "legacy", (m) => logs.push(m));
  recordContractPath(agent, "deployer", "legacy", (m) => logs.push(m));
  recordContractPath(agent, "deployer", "v1", (m) => logs.push(m));
  const u = readContractUsage()[`${agent}:deployer`];
  assert.equal(u.legacy.count, 2);
  assert.equal(u.v1.count, 1);
  assert.equal(logs.length, 1);
});

test("BackoffTracker.waitUntil waits to the named time and keeps the count", () => {
  const t = new BackoffTracker();
  t.start("k", { baseMs: 1000, capMs: 1000, factor: 1 }, 0);
  assert.equal(t.waitUntil("k", 50_000, 10), 49_990);
  assert.equal(t.count("k"), 1);
  assert.ok(t.waiting("k", 49_999));
  assert.ok(!t.waiting("k", 50_001));
});
