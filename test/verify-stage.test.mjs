// The verify stage (EM#440): after the Tech Lead approves and merges, the issue
// carries `pr merged`; the SRE verifies the merge in dev and only a pass moves it
// to `pr approved`. These pin the pure decisions the stage is built from.
import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewTrailerRecords, verifyVerdict } from "../dist/agent.js";
import { labelFromTrailer, workStateOf, pickVerifyTarget, verifyHoldPlan, devVerifyHolding, followUpsOf, followUpsToBuild } from "../dist/orchestrator.js";
import { TOOLING_HOLDS, SRE_TOOLING_HOLDS } from "../dist/phases/verify.js";
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

test("followUpsOf: the fix a held verification asks for builds instead of queueing behind it", () => {
  // Slashbin-console#1340 waited 32 min behind #1338's verification, which needed it.
  const titles = new Map([
    [1340, "Follow-up to #1338: fix the pick view"],
    [1341, "Unrelated work"],
    [1342, "follow-up to #13380: a different issue"],
  ]);
  assert.deepEqual(followUpsOf(1338, [1340, 1341, 1342], titles), [1340]);
  assert.deepEqual(followUpsOf(1338, [1341], titles), [], "no follow-up, the hold stands");
  assert.deepEqual(followUpsOf(1338, [9999], titles), [], "an issue with no cached title is not a follow-up");
});

test("followUpsToBuild: a follow-up outside the trimmed batch still builds", () => {
  // Slashbin-console #1440 behind #1431, 2026-10-27: the batch (size 1) was #1432,
  // so the rework issue #1440 stayed queued and #1431 could never pass.
  const titles = new Map([
    [1432, "Unrelated work"],
    [1433, "More unrelated work"],
    [1440, reworkIssueTitle(1, 1431)],
  ]);
  assert.deepEqual(followUpsToBuild(1431, [1432], [1432, 1433, 1440], titles), [1440]);
  assert.deepEqual(followUpsToBuild(1431, [1440], [1432, 1440], titles), [1440], "in the batch too: listed once");
  assert.deepEqual(followUpsToBuild(1431, [1432], [1432, 1433], titles), [], "no follow-up, the hold stands");
});

test("a failed dev deploy is the SRE's hold: dev-verify-failed and deploy=<state> reasons, nothing else", async () => {
  const { isDeployFailureHold } = await import("../dist/phases/verify.js");
  assert.equal(isDeployFailureHold("dev-verify-failed"), true);
  assert.equal(isDeployFailureHold("deploy=CRASHED"), true);
  assert.equal(isDeployFailureHold("no-merged-pr"), false);
  assert.equal(isDeployFailureHold("unexpected trailer verdict=REJECT merged=false"), false);
  // The charged-hold emit carries the owner (jerky_ops#97, 2026-10-21).
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/phases/verify.ts", import.meta.url), "utf8");
  assert.match(src.slice(src.indexOf("let attempts = 0;")), /isDeployFailureHold\(reason\) \? \{ owner: "sre" as const \}/);
  // verifyVerdict yields exactly those reasons for a failed deploy.
  assert.equal(isDeployFailureHold(verifyVerdict({ verdict: "APPROVE", merged: "yes", deploy: "FAILURE" }).reason), true);
});

// EM#485 (PO, 2026-10-24): a visual QA FAIL goes back to the Foreman as a rework issue.
const reworkIssueTitle = (round, n) => `Visual QA rework ${round} for #${n} — follow-up to #${n}`; // an EM corrective is titled like this too

test("verifyHoldPlan: visual-qa-failed is the EM's decision; infrastructure and sign-in holds still charge", () => {
  assert.deepEqual(verifyHoldPlan("visual-qa-failed"), { kind: "decide" });
  for (const r of ["sign-in-failed", "dev-unreachable", "dev-verify-failed", "visual-qa-unsafe-host", "acceptance-failed"]) assert.deepEqual(verifyHoldPlan(r), { kind: "charge" });
});

test("pickVerifyTarget: a legacy rework hold waits for its fix, then re-verifies at once", () => {
  const refs = [{ issueNumber: 5, prNumber: 50 }];
  const heldAt = "2026-10-24T00:00:00.000Z";
  const t0 = Date.parse(heldAt);
  const hold = (rework, attempts = 1) => ({ 5: { heldAt, prNumber: 50, reason: "visual-qa-failed", attempts, rework } });
  const retry = DEFAULT_BACKOFF.verifyRetry;
  assert.equal(pickVerifyTarget(refs, hold({ issue: 9, landed: false }), t0 + 365 * 86_400_000, retry), null);
  assert.equal(pickVerifyTarget(refs, hold({ issue: 9, landed: true }), t0 + 1, retry)?.prNumber, 50);
  assert.equal(pickVerifyTarget(refs, hold({ issue: 9, landed: true }, VERIFY_MAX_ATTEMPTS), t0 + 1, retry), null);
});

test("devVerifyHolding: a rework hold below max keeps the repo held", () => {
  const h = { 5: { heldAt: "2026-10-24T00:00:00.000Z", prNumber: 50, reason: "visual-qa-failed", attempts: 1, rework: { issue: 9, landed: false } } };
  assert.equal(devVerifyHolding([5, 6], h, VERIFY_MAX_ATTEMPTS), 5);
});

test("followUpsOf matches a follow-up title for its parent only", () => {
  const titles = new Map([[20, reworkIssueTitle(1, 12)], [21, reworkIssueTitle(1, 123)]]);
  assert.deepEqual(followUpsOf(12, [20, 21], titles), [20]);
  assert.deepEqual(followUpsOf(123, [20, 21], titles), [21]);
});


test("verifyHoldPlan: every SRE tooling hold defers; verdict holds do not", () => {
  for (const r of TOOLING_HOLDS) assert.deepEqual(verifyHoldPlan(r), { kind: "defer" }, r);
  for (const r of ["registry-unavailable", "evidence-check-failed"]) assert.ok(TOOLING_HOLDS.includes(r), r);
  assert.deepEqual(verifyHoldPlan("visual-qa-failed"), { kind: "decide" });
  assert.deepEqual(verifyHoldPlan("acceptance-failed"), { kind: "charge" });
});

test("SRE_TOOLING_HOLDS matches the SRE RERUN_HOLDS (skipped when the SRE checkout is absent)", async (t) => {
  let src;
  try { src = (await import("node:fs")).readFileSync(`${process.env.HOME}/code/slashbin_ai_sre/lib/reuse.mjs`, "utf8"); } catch { return t.skip("no SRE checkout"); }
  const m = /RERUN_HOLDS = \/\^\((.*?)\)\$\//.exec(src);
  assert.ok(m, "RERUN_HOLDS found");
  const sre = m[1].split("|").filter((x) => !x.startsWith("wait-until"));
  assert.deepEqual([...SRE_TOOLING_HOLDS].sort(), sre.sort());
  assert.ok(TOOLING_HOLDS.includes("qa-errored"), "the Foreman QA gate's own tooling hold (#137)");
  for (const r of ["qa-held-dev-unreachable", "qa-held-sign-in-failed", "qa-held-review-unavailable"]) assert.ok(TOOLING_HOLDS.includes(r), r);
  for (const r of ["qa-held-unsafe-host", "qa-held-browser-crashed", "qa-held-nothing-captured"]) assert.ok(!TOOLING_HOLDS.includes(r), r);
});

// Ray, 2026-10-31 (Slashbin-console#1538): every post-merge fix is the EM's decision; the Foreman files nothing.
import { evidenceLinks } from "../dist/phases/verify.js";
import { derivedCandidates, needsCall, openEntry, unstickKey, reworkDecisionReason } from "../dist/unstick.js";

const dopts = { verifyMaxAttempts: VERIFY_MAX_ATTEMPTS, isDeployFailureHold: (r) => r === "dev-verify-failed" || r.startsWith("deploy="), divergenceReason: () => "d" };
const decision = { files: ["src/JourneyBar.tsx"], evidence: ["https://github.com/o/r/issues/1538#issuecomment-1", "https://img.example/phone.png"], verdict: "FAIL header row clips at 390px" };
const vqaHold = { 1538: { heldAt: "t", prNumber: 1537, reason: "visual-qa-failed", attempts: VERIFY_MAX_ATTEMPTS, decision } };

test("evidenceLinks: distinct URLs from the verdict output, punctuation trimmed", () => {
  const out = "FAIL https://github.com/o/r/issues/1#issuecomment-9, ![x](https://img.example/a.png) https://github.com/o/r/issues/1#issuecomment-9.";
  assert.deepEqual(evidenceLinks(out), ["https://github.com/o/r/issues/1#issuecomment-9", "https://img.example/a.png"]);
  assert.deepEqual(evidenceLinks("no links"), []);
});

test("the first visual QA FAIL raises exactly one rework-decision candidate with the PR, files, verdict and evidence", () => {
  const c = derivedCandidates({ verifyHeld: vqaHold }, dopts);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].issue, c[0].kind], [1538, "rework-decision"]);
  for (const part of [...decision.evidence, "PR #1537", "src/JourneyBar.tsx", "header row clips at 390px"]) assert.ok(c[0].reason.includes(part), part);
});

test("a repeat poll on the same evidence makes no second call; new evidence is a new question", () => {
  const first = derivedCandidates({ verifyHeld: vqaHold }, dopts)[0];
  const entry = { ...openEntry(undefined, first, "t0"), status: "invoked", attempts: 1 };
  const again = derivedCandidates({ verifyHeld: vqaHold }, dopts)[0];
  assert.equal(unstickKey(again.issue, again.kind), "1538:rework-decision");
  assert.equal(needsCall(entry, again), false);
  const next = derivedCandidates({ verifyHeld: { 1538: { ...vqaHold[1538], decision: { ...decision, evidence: ["https://x/y"] } } } }, dopts)[0];
  assert.equal(needsCall(entry, next), true);
});

test("a charged failure calls the EM on its first failure, not after the retries; at its cap it is verify-exhausted; deploy failures are not rework", () => {
  const h = (reason, attempts) => ({ 10: { heldAt: "t", prNumber: 4, reason, attempts, decision } });
  assert.deepEqual(derivedCandidates({ verifyHeld: h("acceptance-not-verified", 1) }, dopts).map((c) => c.kind), ["rework-decision"]);
  assert.equal(derivedCandidates({ verifyHeld: h("acceptance-not-verified", 1) }, dopts)[0].reason, reworkDecisionReason(h("acceptance-not-verified", 2)[10]), "the retry does not change the question");
  assert.deepEqual(derivedCandidates({ verifyHeld: h("acceptance-not-verified", VERIFY_MAX_ATTEMPTS) }, dopts).map((c) => c.kind), ["verify-exhausted"]);
  assert.deepEqual(derivedCandidates({ verifyHeld: h("dev-verify-failed", 1) }, dopts), [], "an SRE deploy hold waits its retries, then deploy-failed");
  // no decision recorded (an SRE error with no verdict): nothing to show the EM until the retries are spent
  assert.deepEqual(derivedCandidates({ verifyHeld: { 10: { heldAt: "t", prNumber: 4, reason: "SRE launch threw", attempts: 1 } } }, dopts), []);
});

test("the Foreman files no rework issue: the filing helpers are gone", async () => {
  const v = await import("../dist/phases/verify.js");
  for (const name of ["reworkIssueTitle", "reworkIssueBody", "reworkIssueArgs"]) assert.equal(v[name], undefined, name);
});

test("a follow-up corrective releases the hold: it builds, its merge advances base, and a spec edit also releases", async () => {
  const { reopensOnBaseAdvance } = await import("../dist/phases/verify.js");
  assert.deepEqual(followUpsOf(1538, [1543, 1544], new Map([[1543, "Header row: fix phone layout — follow-up to #1538"], [1544, "Other"]])), [1543]);
  assert.equal(reopensOnBaseAdvance("visual-qa-failed"), true, "the corrective merging into base reopens the held verification");
  const { UNBLOCK_CHECKS } = await import("../dist/unblock.js");
  assert.ok(UNBLOCK_CHECKS["verify-exhausted"].includes("specEdited") && UNBLOCK_CHECKS["verify-exhausted"].includes("baseAdvanced"));
  assert.equal(devVerifyHolding([1538, 1543], vqaHold, VERIFY_MAX_ATTEMPTS), 1543, "the cap frees the repo");
  // ... and the corrective still builds before unrelated queued work (Tech Lead R1): implement looks up the follow-up of the FAIL.
  const { visualDecisionHolder } = await import("../dist/phases/verify.js");
  assert.equal(visualDecisionHolder([1538, 1539], vqaHold, VERIFY_MAX_ATTEMPTS), 1538);
  assert.equal(visualDecisionHolder([1538], { 1538: { ...vqaHold[1538], reason: "acceptance-not-verified" } }, VERIFY_MAX_ATTEMPTS), null);
  const titles = new Map([[1539, "Older unrelated"], [1543, "Header row: fix phone layout — follow-up to #1538"]]);
  assert.deepEqual(followUpsToBuild(1538, [1539], [1539, 1543], titles), [1543]);
});
