// The verify stage (EM#440): after the Tech Lead approves and merges, the issue
// carries `pr merged`; the SRE verifies the merge in dev and only a pass moves it
// to `pr approved`. These pin the pure decisions the stage is built from.
import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewTrailerRecords, verifyVerdict } from "../dist/agent.js";
import { labelFromTrailer, workStateOf, pickVerifyTarget, verifyHoldPlan, devVerifyHolding } from "../dist/orchestrator.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";

const { baseMs: VERIFY_RETRY_MS, maxAttempts: VERIFY_MAX_ATTEMPTS } = DEFAULT_BACKOFF.verifyRetry;
import { issueStage } from "../dist/github-work-source.js";
import { BUILTIN_STAGES } from "../dist/stages.js";

const trailer = (s) => parseReviewTrailerRecords(`FOREMAN_REVIEW pr=#7 ${s}`)[0];
const L = {
  prUnderReview: "pr under review", prPendingActions: "pr pending actions", prMerged: "pr merged",
  prApproved: "pr approved", readyForProd: "ready for prod release", readyToClose: "ready to close",
};

test("with a verify stage, an approved merge is `pr merged`, never `pr approved`", () => {
  const t = trailer("verdict=APPROVE merged=yes deploy=NA");
  assert.equal(labelFromTrailer(t, true), "prMerged");
  assert.equal(labelFromTrailer(t), "prApproved", "no verify stage: unchanged");
  assert.equal(labelFromTrailer(trailer("verdict=APPROVE merged=yes deploy=FAILURE"), true), "prPendingActions");
  assert.equal(labelFromTrailer(trailer("verdict=APPROVE merged=no deploy=NA"), true), null);
});

test("workStateOf maps each outcome to the state the board reports", () => {
  assert.equal(workStateOf("prApproved"), "approved");
  assert.equal(workStateOf("prMerged"), "merged");
  assert.equal(workStateOf("prPendingActions"), "changesRequested");
});

test("verifyVerdict: only an unheld APPROVE+merged with a good deploy passes", () => {
  assert.deepEqual(verifyVerdict(trailer("verdict=APPROVE merged=yes deploy=SUCCESS")), { pass: true });
  assert.deepEqual(verifyVerdict(trailer("verdict=APPROVE merged=yes deploy=NA")), { pass: true });
  assert.deepEqual(verifyVerdict(trailer("verdict=APPROVE merged=yes deploy=FAILURE")), { pass: false, reason: "dev-verify-failed" });
  assert.deepEqual(verifyVerdict(trailer("verdict=APPROVE merged=yes deploy=SUCCESS hold=healthcheck-red")), { pass: false, reason: "healthcheck-red" });
  assert.equal(verifyVerdict(trailer("verdict=REQUEST_CHANGES merged=no deploy=NA")).pass, false);
});

test("pickVerifyTarget: oldest PR first, one PR's issues together, held PRs skipped", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const refs = [{ issueNumber: 9, prNumber: 50 }, { issueNumber: 3, prNumber: 40 }, { issueNumber: 4, prNumber: 40 }];
  assert.deepEqual(pickVerifyTarget(refs, {}, now), { prNumber: 40, issueNumbers: [3, 4] });

  const fresh = { heldAt: new Date(now - 60_000).toISOString(), prNumber: 40, reason: "x", attempts: 1 };
  assert.deepEqual(pickVerifyTarget(refs, { 4: fresh }, now), { prNumber: 50, issueNumbers: [9] }, "one issue in back-off holds its PR");

  const due = { ...fresh, heldAt: new Date(now - VERIFY_RETRY_MS).toISOString() };
  assert.deepEqual(pickVerifyTarget(refs, { 4: due }, now), { prNumber: 40, issueNumbers: [3, 4] }, "retry once the window passes");

  const second = { ...fresh, attempts: 2, heldAt: new Date(now - VERIFY_RETRY_MS).toISOString() };
  assert.deepEqual(pickVerifyTarget(refs, { 4: second }, now), { prNumber: 50, issueNumbers: [9] }, "the second wait is twice the first");
  const secondDue = { ...second, heldAt: new Date(now - 2 * VERIFY_RETRY_MS).toISOString() };
  assert.deepEqual(pickVerifyTarget(refs, { 4: secondDue }, now), { prNumber: 40, issueNumbers: [3, 4] });
  const tuned = { baseMs: 1_000, capMs: 1_000, factor: 2, maxAttempts: 9 };
  assert.deepEqual(pickVerifyTarget(refs, { 4: { ...second, heldAt: new Date(now - 2_000).toISOString() } }, now, tuned), { prNumber: 40, issueNumbers: [3, 4] }, "the configured window is the one used");

  const capped = { ...due, attempts: VERIFY_MAX_ATTEMPTS };
  assert.equal(pickVerifyTarget([refs[1]], { 3: capped }, now), null, "capped waits for a person");
});

test("verifyHoldPlan: a run that could not happen, or a named wait, costs no attempt", () => {
  assert.deepEqual(verifyHoldPlan("codex-unavailable"), { kind: "defer" });
  assert.deepEqual(verifyHoldPlan("em-mirror-unavailable"), { kind: "defer" });
  assert.deepEqual(verifyHoldPlan("wait-until-20261010T1215Z"), { kind: "wait", retryAt: "2026-10-10T12:15:00.000Z" });
  assert.deepEqual(verifyHoldPlan("wait-until-soon"), { kind: "charge" });
  assert.deepEqual(verifyHoldPlan("healthcheck-red"), { kind: "charge" });
});

test("pickVerifyTarget: a wait-until hold is skipped until its time, then picked", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const refs = [{ issueNumber: 3, prNumber: 40 }];
  const waiting = { heldAt: new Date(now - 2 * VERIFY_RETRY_MS).toISOString(), prNumber: 40, reason: "wait-until-20261010T1215Z", attempts: 0, retryAt: "2026-10-10T12:15:00.000Z" };
  assert.equal(pickVerifyTarget(refs, { 3: waiting }, now), null, "before its time, even past the hourly window");
  assert.deepEqual(pickVerifyTarget(refs, { 3: waiting }, Date.parse("2026-10-10T12:15:00Z")), { prNumber: 40, issueNumbers: [3] });
});

test("board: `pr merged` is the merged stage; `pr approved` still wins over it", () => {
  assert.equal(issueStage(["pr merged"], false, L, "approved"), "merged");
  assert.equal(issueStage(["pr merged", "pr approved"], false, L, "approved"), "pendingVerification");
  assert.equal(issueStage(["pr merged", "blocked"], false, L, "approved"), "blocked");
});

test("verify runs right after review in the default stages", () => {
  const ids = BUILTIN_STAGES.map((s) => s.type ?? s.id ?? s);
  assert.equal(ids[ids.indexOf("review") + 1], "verify");
});

test("devVerifyHolding: an unverified merge holds the next build until it passes or needs a person", () => {
  const at = "2026-10-14T21:00:00.000Z";
  assert.equal(devVerifyHolding([], {}, 3), null, "nothing merged, nothing holds");
  assert.equal(devVerifyHolding([131], {}, 3), 131, "merged, not yet verified — holds");
  assert.equal(devVerifyHolding([131], { 131: { heldAt: at, prNumber: 148, reason: "held", attempts: 1 } }, 3), 131,
    "held and still retrying — holds: the fix it asks for comes first");
  assert.equal(devVerifyHolding([131], { 131: { heldAt: at, prNumber: 148, reason: "held", attempts: 3 } }, 3), null,
    "attempts spent — it waits on a person, so it frees the repo");
  assert.equal(devVerifyHolding([131], { 131: { heldAt: at, prNumber: 148, reason: "wait-until-20261016T1400Z", attempts: 0, retryAt: "2026-10-16T14:00:00.000Z" } }, 3), null,
    "waiting on a named time frees the repo");
  assert.equal(devVerifyHolding([140, 131], { 131: { heldAt: at, prNumber: 148, reason: "no-merged-pr", attempts: 3 } }, 3), 140,
    "the first merge still with the SRE is the one named");
});

test("verify: a wait and a deferred SRE run report verifyWaiting, only a charged hold reports blocked", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/phases/verify.ts", import.meta.url), "utf8");
  const d = src.indexOf('if (plan.kind === "defer")');
  const defer = src.slice(d, src.indexOf("verifyDefer.clear(repoName)", d));
  const wait = src.slice(src.indexOf('if (plan.kind === "wait")'), src.indexOf("let attempts = 0;"));
  const charge = src.slice(src.indexOf("let attempts = 0;"));
  for (const [name, b] of [["defer", defer], ["wait", wait]]) {
    assert.match(b, /kind: "verifyWaiting"/, name);
    assert.doesNotMatch(b, /kind: "blocked"/, name);
  }
  assert.match(charge, /kind: "blocked"/);
});
