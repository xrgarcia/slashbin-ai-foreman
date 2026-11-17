// An approved epic with no child wakes the EM once, one at a time (the `epic-decompose` kind).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { tryUnstick, resetDecomposeThrottle } from "../dist/phases/unstick.js";
import { UNSTICK_KINDS, EVENT_KINDS, epicDecomposeAlert, nextDecompose, decomposeInFlight, decomposeTag } from "../dist/unstick.js";
import { emUnstickMaxDurationMs } from "../dist/plugins/em.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords } from "./issue-records.mjs";
import { ForemanRuntime } from "../dist/runtime.js";

const LABEL = "engineering-manager";
await startAgentPlugins();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";

const A = { epic: 11, approvedAt: "2026-11-01T00:00:00Z" };
const B = { epic: 12, approvedAt: "2026-11-02T00:00:00Z" };
const entry = (c, status, attempts = 0) => ({ issue: 0, kind: "epic-decompose", reason: "r", status, attempts, since: "x", tag: `${c.epic}-${c.approvedAt}` });
const table = (...es) => Object.fromEntries(es.map((e) => [`0:epic-decompose:${e.tag}`, e]));

test("epic-decompose is an unstick and event kind, with a 70-minute call", () => {
  assert.ok(UNSTICK_KINDS.includes("epic-decompose"));
  assert.ok(EVENT_KINDS.has("epic-decompose"));
  assert.equal(emUnstickMaxDurationMs("epic-decompose"), 70 * 60_000);
});

test("the alert is repo-level, names the epic and the approval, and is keyed by both", () => {
  const a = epicDecomposeAlert(LABEL, A);
  assert.equal(a.subject, 0);
  assert.equal(a.dedupeKey, "11-2026-11-01T00:00:00Z");
  assert.match(a.reason, /engineering-manager #11 was approved at 2026-11-01T00:00:00Z and has no child/);
  assert.notEqual(epicDecomposeAlert(LABEL, { ...A, approvedAt: "2026-11-09T00:00:00Z" }).reason, a.reason, "a re-approval is a new question");
});

test("one at a time: nothing while a call is open, then the oldest epic with no entry", () => {
  assert.equal(nextDecompose([A, B], {}, LABEL).dedupeKey, "11-2026-11-01T00:00:00Z");
  for (const open of [entry(A, "pending"), entry(A, "refused"), entry(A, "failed", 1)]) {
    assert.equal(decomposeInFlight(table(open)), true);
    assert.equal(nextDecompose([A, B], table(open), LABEL), null);
  }
  for (const done of [entry(A, "invoked", 1), entry(A, "escalated", 1), entry(A, "declined", 1), entry(A, "failed", 3)]) {
    assert.equal(decomposeInFlight(table(done)), false);
    assert.equal(nextDecompose([A, B], table(done), LABEL).dedupeKey, "12-2026-11-02T00:00:00Z", "A is never asked twice for one approval");
  }
  assert.equal(nextDecompose([A], table(entry(A, "invoked", 1)), LABEL), null);
});

test("the stage asks the EM which epics are due, calls it once per approval, and one epic at a time", async () => {
  setStatePath(mkTmp("edc-state-"));
  const rt = new ForemanRuntime();
  memoryRecords();
  const em = mkTmp("edc-em-");
  const log = join(em, "calls.jsonl");
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "due.json"), JSON.stringify([B, A]));
  writeFileSync(join(em, "bin/em.mjs"), `import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "decompose-candidates") console.log(fs.readFileSync(${JSON.stringify(join(em, "due.json"))}, "utf8"));
else console.log("acted");`);
  const host = { name: "host", githubRepo: "o/host", repoPath: join(em, "no-such-clone"), lifecycleLabels: {}, epicRefLabel: LABEL, epicRepo: "o/epics" };
  const config = { emRepoPath: em, sessionEnv: [], repos: [{ name: "sync", syncOnly: true }, host], epicRepo: "o/epics", backoff: { verifyRetry: { maxAttempts: 3 } } };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const unsticks = () => calls().filter((a) => a[0] === "unstick");

  resetDecomposeThrottle();
  assert.equal(await tryUnstick(rt, host, config, logger, 1, {}), 1, "the oldest approval is called");
  assert.equal(unsticks().length, 1);
  const first = unsticks()[0];
  assert.equal(first[first.indexOf("--kind") + 1], "epic-decompose");
  assert.equal(first[first.indexOf("--issue") + 1], "0");
  assert.equal(first[first.indexOf("--repo") + 1], "o/host");
  assert.match(first[first.indexOf("--reason") + 1], /engineering-manager #11 was approved at 2026-11-01/);

  resetDecomposeThrottle();
  assert.equal(await tryUnstick(rt, host, config, logger, 2, {}), 1, "once answered, the next epic is called");
  assert.match(unsticks()[1][unsticks()[1].indexOf("--reason") + 1], /#12 was approved at 2026-11-02/);
  resetDecomposeThrottle();
  assert.equal(await tryUnstick(rt, host, config, logger, 3, {}), 0, "no epic is asked twice for one approval");

  // Throttled: no second scan inside the window, and a repo that is not the host never asks.
  const asks = () => calls().filter((a) => a[0] === "decompose-candidates").length;
  const before = asks();
  await tryUnstick(rt, host, config, logger, 4, {});
  assert.equal(asks(), before, "throttled");
  resetDecomposeThrottle();
  await tryUnstick(rt, { ...host, name: "other", githubRepo: "o/other" }, config, logger, 5, {});
  assert.equal(asks(), before, "only the host repo asks");
});

test("a feature boundary is its own question, keyed by the last-filed child, and still one at a time", () => {
  const A2 = { ...A, after: "o/svc#7" };
  const a = epicDecomposeAlert(LABEL, A2);
  assert.equal(a.dedupeKey, "11-2026-11-01T00:00:00Z-o/svc#7");
  assert.match(a.reason, /engineering-manager #11 was approved at .*last filed child: o\/svc#7\) and its plan lists features not filed yet/);
  assert.notEqual(a.dedupeKey, epicDecomposeAlert(LABEL, A).dedupeKey, "the no-child question and the boundary are different questions");
  const tagged = (c, status) => ({ ...entry(c, status), tag: decomposeTag(c) });
  const t = (...es) => Object.fromEntries(es.map((e) => [`0:epic-decompose:${e.tag}`, e]));
  // two eligible epics: the second waits for the first's verdict, whatever the boundary
  assert.equal(nextDecompose([A2, B], t(tagged(A2, "pending")), LABEL), null);
  assert.equal(nextDecompose([A2, B], t(tagged(A2, "invoked")), LABEL).dedupeKey, "12-2026-11-02T00:00:00Z");
  // the same epic at its next boundary is a new question once the previous one is answered
  const A3 = { ...A, after: "o/svc#9" };
  assert.equal(nextDecompose([A3], t(tagged(A2, "invoked")), LABEL).dedupeKey, "11-2026-11-01T00:00:00Z-o/svc#9");
  assert.equal(nextDecompose([A2], t(tagged(A2, "invoked")), LABEL), null, "a boundary is asked once");
});

test("an escalated epic whose card was cleared is a new question (requeue), never a timer", () => {
  const tagged = (c, status) => ({ ...entry(c, status), tag: decomposeTag(c) });
  const t = (...es) => Object.fromEntries(es.map((e) => [`0:epic-decompose:${e.tag}`, e]));
  const R = { ...A, requeue: 1 };
  assert.equal(decomposeTag(R), "11-2026-11-01T00:00:00Z-r1");
  assert.match(epicDecomposeAlert(LABEL, R).reason, /escalated this once before and its card was cleared \(requeue 1\)/);
  // the epic is absent from the EM's list while its card is blocked: nothing is dispatched, whatever the table holds
  assert.equal(nextDecompose([], t(tagged(A, "escalated")), LABEL), null);
  // the card left blocked: the EM lists it with requeue 1, and it is dispatched once
  assert.equal(nextDecompose([R], t(tagged(A, "escalated")), LABEL).dedupeKey, decomposeTag(R));
  assert.equal(nextDecompose([R], t(tagged(A, "escalated"), tagged(R, "invoked")), LABEL), null);
});
