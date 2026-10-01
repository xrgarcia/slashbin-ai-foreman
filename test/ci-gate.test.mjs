// The CI gate in front of review: a PR with red CI goes back to revise without
// a review session; running CI waits; no CI at all reviews exactly as before.
// Run with `npm test` (node:test, no dependencies) after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCheckRollup, ciBounceComment, CI_GATE_MARKER } from "../dist/github.js";

const run = (name, status, conclusion, detailsUrl) => ({ __typename: "CheckRun", name, status, conclusion, detailsUrl });
const ctx = (context, state) => ({ __typename: "StatusContext", context, state });

test("a repo with no CI reviews as before", () => {
  assert.equal(summarizeCheckRollup([]).state, "none");
});

test("all green passes; skipped and neutral jobs are not failures", () => {
  const v = summarizeCheckRollup([
    run("build", "COMPLETED", "SUCCESS"),
    run("develop-first", "COMPLETED", "SKIPPED"),
    run("lint", "COMPLETED", "NEUTRAL"),
  ]);
  assert.equal(v.state, "passing");
});

test("a failed check is failing and named with its link", () => {
  const v = summarizeCheckRollup([
    run("build", "COMPLETED", "SUCCESS"),
    run("Typecheck", "COMPLETED", "FAILURE", "https://example/run/1"),
  ]);
  assert.equal(v.state, "failing");
  assert.deepEqual(v.failing, [{ name: "Typecheck", url: "https://example/run/1" }]);
});

test("a re-run that went green clears the earlier red run of the same name", () => {
  const v = summarizeCheckRollup([
    run("guards", "COMPLETED", "FAILURE"),
    run("guards", "COMPLETED", "SUCCESS"),
  ]);
  assert.equal(v.state, "passing");
});

test("a cancelled (superseded) run is not a failure", () => {
  assert.equal(summarizeCheckRollup([run("tests", "COMPLETED", "CANCELLED")]).state, "passing");
});

test("anything still running makes the verdict pending, even beside a red check", () => {
  const v = summarizeCheckRollup([
    run("tests", "IN_PROGRESS", ""),
    run("build", "COMPLETED", "FAILURE"),
  ]);
  assert.equal(v.state, "pending");
  assert.deepEqual(v.pending, ["tests"]);
});

test("commit statuses (StatusContext) count too", () => {
  assert.equal(summarizeCheckRollup([ctx("ci/legacy", "ERROR")]).state, "failing");
  assert.equal(summarizeCheckRollup([ctx("ci/legacy", "PENDING")]).state, "pending");
  assert.equal(summarizeCheckRollup([ctx("ci/legacy", "SUCCESS")]).state, "passing");
});

test("the bounce comment carries the marker the bounce cap counts", () => {
  const body = ciBounceComment({ state: "failing", failing: [{ name: "tests" }], pending: [] });
  assert.ok(body.startsWith(CI_GATE_MARKER));
  assert.match(body, /\*\*tests\*\*/);
});
