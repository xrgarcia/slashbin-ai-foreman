// Agent contract v1 (foreman#268) step 1: the conformance kit, and every reader that now reads the
// v1 line first (deploy, verify-hold, review, implement/revise sessions, unrelated-error dedupe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatResultV1 } from "../dist/contract/result-v1.js";
import { checkSkillExamples, checkAgentOutput, checkDeterministic, usageRows } from "../dist/contract/conformance.js";
import { checkTitlesParse } from "../dist/github/title-check.js";
import { readDeploy, deployTrailerFromV1 } from "../dist/plugins/sre.js";
import { readReviewTrailers } from "../dist/plugins/tech-lead.js";
import { deployHoldPlan } from "../dist/phases/release.js";
import { detectDeclaredSkip } from "../dist/session/protocol.js";
import { declaredSkipV1, declaredLandedV1, declaredNoCommitV1 } from "../dist/session/result-v1.js";
import { unrelatedErrorAlert } from "../dist/unstick.js";
import { extractImplementedIssues } from "../dist/github/discovery.js";
import { githubConventionsSchema, fillTitle } from "../dist/config-schema/github.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SHA = "a".repeat(40);
const NOW = Date.parse("2026-11-09T15:00:00Z");

test("#239: the default reconcile title names its issue to the Foreman's own strict parser", () => {
  const title = fillTitle(githubConventionsSchema.parse({}).reconcileTitle, { N: 221 });
  assert.deepEqual(extractImplementedIssues({ title, body: "- Related to #221", strict: true }), [221]);
  // The old default is exactly what failed: nothing found, so the PR dead-ended at verify-no-pr.
  assert.deepEqual(extractImplementedIssues({ title: "feat: implement #221", body: "- Related to #221", strict: true }), []);
  assert.throws(() => githubConventionsSchema.parse({ reconcileTitle: "feat: implement #{N}" }), /#239/);
});

test("conformance F1 and F2 pass on this package, and F1 fails on the pre-#239 title", () => {
  assert.ok(checkTitlesParse().every((c) => c.ok));
  assert.equal(checkTitlesParse({ reconcileTitle: "feat: implement #{N}" })[0].ok, false);
  const f2 = checkSkillExamples(join(ROOT, "skills"));
  assert.ok(f2.length >= 5, `examples found: ${f2.length}`);
  assert.deepEqual(f2.filter((c) => !c.ok), []);
});

test("conformance C1 and C2: valid, absent, invalid; deciding fields must repeat, prose may not matter", () => {
  const line = formatResultV1({ schema: 1, role: "reviewer", pr: 4, outcome: "approve", merged: true, deploy: "na" });
  assert.equal(checkAgentOutput(`prose\n${line}`, "reviewer", 4).ok, true);
  assert.match(checkAgentOutput("prose only", "reviewer", 4).detail, /no FOREMAN_RESULT_V1/);
  const err = (sig, text) => formatResultV1({ schema: 1, role: "verifier", pr: 4, outcome: "pass", unrelated_errors: [{ signature: sig, text: text }] });
  assert.equal(checkDeterministic(err("db-timeout", "timed out at 10:01"), err("db-timeout", "timed out at 10:07"), "verifier", 4).ok, true);
  assert.equal(checkDeterministic(err("db-timeout-1001", "x"), err("db-timeout-1007", "x"), "verifier", 4).ok, false);
});

test("usage: legacy reads zero only once its last legacy answer is over 30 days old", () => {
  const rows = usageRows({
    "sre:deployer": { v1: { count: 4, last: "2026-11-09T00:00:00Z" }, legacy: { count: 9, last: "2026-10-01T00:00:00Z" } },
    "tech-lead:reviewer": { legacy: { count: 2, last: "2026-11-08T00:00:00Z" } },
  }, NOW);
  assert.deepEqual(rows.map((r) => [r.key, r.legacyZero]), [["sre:deployer", true], ["tech-lead:reviewer", false]]);
});

test("deploy v1: a time hold is read into the existing wait-until slug, and the release waits for it (#193)", () => {
  const out = `SRE_DEPLOY pr=#12 merged=no verify=hold hold=predeploy-stop\n` +
    formatResultV1({ schema: 1, role: "deployer", outcome: "held", pr: 12, merged: false, verify: "hold", hold: "predeploy-stop", hold_class: "time", eligible_at: "2026-11-10T14:00:00Z", reason_text: "soak window" });
  const { trailer } = readDeploy(out, 12);
  assert.equal(trailer.hold, "wait-until-20261110T1400Z");
  assert.equal(trailer.holdClass, "time");
  assert.equal(trailer.holdReason, "predeploy-stop: soak window");
  assert.deepEqual(deployHoldPlan(trailer, NOW), { kind: "wait", untilMs: Date.parse("2026-11-10T14:00:00Z") });
});

test("deploy hold plan: person stops, a far time is capped at a day, transient backs off, legacy keeps DEPLOY_STOPS", () => {
  assert.equal(deployHoldPlan({ hold: "needs-signoff", holdClass: "person", holdReason: "Ray signs off" }, NOW).kind, "stop");
  assert.deepEqual(deployHoldPlan({ hold: "wait-until-20261201T0000Z", holdClass: "time" }, NOW), { kind: "wait", untilMs: NOW + 86_400_000 });
  assert.equal(deployHoldPlan({ hold: "registry-timeout", holdClass: "transient" }, NOW).kind, "backoff");
  assert.equal(deployHoldPlan({ hold: "predeploy-stop" }, NOW).kind, "stop");
  assert.equal(deployHoldPlan({ hold: "merge-failed" }, NOW).kind, "backoff");
});

test("deploy v1 fails closed: an invalid line is a person hold naming the field, but a reported merge stays true", () => {
  const bad = formatResultV1({ schema: 1, role: "deployer", outcome: "held", pr: 12, merged: false, verify: "hold", hold: "x" });
  const held = readDeploy(bad, 12).trailer;
  assert.equal(held.merged, false);
  assert.equal(held.hold, "contract-invalid-result");
  assert.equal(held.holdClass, "person");
  assert.match(held.holdReason, /hold_class/);
  assert.equal(deployHoldPlan(held, NOW).kind, "stop");
  const merged = readDeploy(`SRE_DEPLOY pr=#12 merged=yes merge_sha=${SHA} verify=pass\n${bad}`, 12).trailer;
  assert.equal(merged.merged, true);
  assert.equal(merged.mergeSha, SHA);
});

test("deploy v1: unrelated errors carry the agent's signature", () => {
  const out = formatResultV1({ schema: 1, role: "deployer", outcome: "merged", pr: 12, merged: true, merge_sha: SHA, verify: "pass", unrelated_errors: [{ signature: "redis-econnreset", text: "ECONNRESET 10.0.0.4" }] });
  const { unrelated } = readDeploy(out, 12);
  assert.deepEqual(unrelated.signatures, ["redis-econnreset"]);
  assert.equal(deployTrailerFromV1({ schema: 1, role: "deployer", outcome: "merged", pr: 12, merged: true, merge_sha: SHA, verify: "pass" }).mergeSha, SHA);
});

test("#157: one signature, different wording, one alert; no signature keeps the legacy hash", () => {
  const a = unrelatedErrorAlert("Redis ECONNRESET at 10:01 on host-a", "PR #1", [], "redis-econnreset");
  const b = unrelatedErrorAlert("redis connection reset (host-b, 10:07)", "PR #2", [], "redis-econnreset");
  assert.equal(a.dedupeKey, b.dedupeKey);
  assert.notEqual(unrelatedErrorAlert("Redis ECONNRESET at 10:01 on host-a", "PR #1", []).dedupeKey, a.dedupeKey);
});

test("review v1 replaces the legacy trailer for its PR; invalid fails closed unless legacy reports the merge", () => {
  const legacy = "FOREMAN_REVIEW pr=#100 verdict=APPROVE merged=no deploy=NA";
  const v1 = formatResultV1({ schema: 1, role: "reviewer", pr: 100, outcome: "request-changes", merged: false, deploy: "na" });
  const ok = readReviewTrailers(`${legacy}\n${v1}`, 100);
  assert.deepEqual(ok.trailers.map((t) => [t.pr, t.verdict]), [[100, "REQUEST_CHANGES"]]);
  const bad = formatResultV1({ schema: 1, role: "reviewer", pr: 100, outcome: "maybe", merged: false, deploy: "na" });
  assert.match(readReviewTrailers(`${legacy}\n${bad}`, 100).error, /contract-invalid-result: .*outcome/);
  const mergedLegacy = "FOREMAN_REVIEW pr=#100 verdict=APPROVE merged=yes deploy=SUCCESS";
  assert.equal(readReviewTrailers(`${mergedLegacy}\n${bad}`, 100).trailers[0].merged, true);
  assert.deepEqual(readReviewTrailers(legacy, 100).trailers.map((t) => t.verdict), ["APPROVE"]);
});

test("sessions: a valid v1 line decides skip, landed and no-commit; waiting_on carries the wait", () => {
  const skip = formatResultV1({ schema: 1, role: "implementer", outcome: "skipped", skipped_issue: 127, waiting_on: "#88", reason_text: "branch occupied" });
  assert.deepEqual(declaredSkipV1(`FOREMAN_RESULT: skipped issue=1 reason="old"\n${skip}`), { skipped: true, reason: "branch occupied", issue: 127, waitingOn: "#88" });
  const landed = formatResultV1({ schema: 1, role: "implementer", outcome: "landed", landed_issue: 127, reason_text: "already on develop" });
  assert.deepEqual(declaredLandedV1(landed), { landed: true, issue: 127, reason: "already on develop" });
  assert.equal(declaredSkipV1(landed).skipped, false);
  assert.equal(declaredSkipV1('FOREMAN_RESULT: skipped issue=5 reason="x"'), null);
  const noCommit = formatResultV1({ schema: 1, role: "reviser", outcome: "no-commit", reason_text: "the reviewer's note is already addressed" });
  assert.equal(declaredNoCommitV1(noCommit), "the reviewer's note is already addressed");
  // Legacy only: unchanged.
  assert.equal(detectDeclaredSkip('FOREMAN_RESULT: skipped issue=5 reason="spec unusable"').issue, 5);
});
