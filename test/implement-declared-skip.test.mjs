// A declared skip must survive an unrelated open PR on the feature branch.
//
// Slashbin-console#841, 2026-09-02. The implement agent refused to commit a
// chore onto `features` because an unrelated billing PR (#843) was already open
// there and its skill forbids bundling the two. It emitted
// `FOREMAN_RESULT: skipped reason="..."` exactly as instructed. But
// implementApprovedIssues attributed the pre-existing PR to this run and
// returned success before ever reaching the skip check, so the orchestrator
// took the labeling path, matched no issues, warned, and returned. No skip was
// recorded, the back-off never armed, and #841 was re-queued every cycle — 41
// full Claude sessions in six hours, each reaching the same correct conclusion
// and having it thrown away.
//
// Same shape as the revision no-commit bug: an agent declared a deliberate
// no-op and a success heuristic overruled the declaration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agent = readFileSync(join(root, "src/agent.ts"), "utf-8");

const fn = agent.slice(
  agent.indexOf("export async function implementApprovedIssues"),
  agent.indexOf("export async function revisePRFeedback"),
);

test("the declared skip is checked BEFORE any PR attribution", () => {
  const skipAt = fn.indexOf("detectDeclaredSkip(result.stdout)");
  const prMatchAt = fn.indexOf("const prMatch = result.stdout.match");
  const existingAt = fn.indexOf("existing feature PR found");
  assert.ok(skipAt > 0, "the declared-skip check is gone from implementApprovedIssues");
  assert.ok(prMatchAt > 0, "PR extraction is gone — test needs updating");
  assert.ok(skipAt < prMatchAt,
    "PR extraction runs first, so an unrelated open PR still masks a declared skip");
  assert.ok(skipAt < existingAt,
    "the existing-PR fallback runs first, so it still claims another issue's PR as this run's output");
});

test("a declared skip is only honoured when the branch did not move", () => {
  const block = fn.slice(fn.indexOf("const declaredSkip ="), fn.indexOf("const prMatch"));
  assert.match(block, /getRemoteBranchSha/,
    "without a SHA check the trailer is taken on trust, which is the assumption that should never be load-bearing");
  assert.match(block, /beforeSha !== afterSha/, "the guard must compare, not merely fetch");
  assert.match(block, /skipped: true/, "the no-movement case must return a skip");
  assert.ok(/logger\.warn/.test(block),
    "a trailer contradicted by real commits must be visible, not silently dropped");
});

test("the structured detector never falls back to prose", () => {
  const detector = agent.slice(
    agent.indexOf("function detectDeclaredSkip"),
    agent.indexOf("function detectSkipSignal"),
  );
  assert.match(detector, /FOREMAN_RESULT/, "it must read the trailer");
  for (const phrase of ["skipped because", "no immediate code change", "slice(-2000)"]) {
    assert.ok(!detector.includes(phrase),
      `the pre-PR check must not use the free-text heuristic (${phrase}) — a guess cannot pre-empt evidence`);
  }
});

test("the fuzzy heuristic still exists, downstream", () => {
  assert.match(agent, /function detectSkipSignal/,
    "the late free-text check catches agents that explained themselves without the trailer; removing it loses that");
  assert.match(agent, /detectDeclaredSkip\(stdout\)/,
    "detectSkipSignal should delegate its structured half rather than duplicating the regex");
});

// --- A skip on one issue must not take the batch with it -------------------
//
// Found by second-pass.mjs on Slashbin-Ingest-Gateway#138, 2026-09-28, while
// reviewing a skills:publish commit. The trailer had no issue scope, so
// `skippedIssues: issueNumbers ?? []` marked every issue in the batch skipped
// whenever the agent declared one. orchestrator.ts then writes a skip record per
// issue and filters each out for backoffWindowFor(skipCount) — 30m rising to 24h.
//
// `implement-approved-issues` selects exactly ONE issue per invocation while the
// orchestrator hands it the whole actionable set, so a single unusable spec took
// every issue behind it off the board for a defect in a spec it never read.

test("the trailer carries an optional issue scope", () => {
  const detector = agent.slice(
    agent.indexOf("function detectDeclaredSkip"),
    agent.indexOf("function detectSkipSignal"),
  );
  assert.match(detector, /issue=/,
    "detectDeclaredSkip must parse the issue scope, or a scoped trailer is silently unscoped");
  assert.match(detector, /issue\?: number/,
    "the scope must be surfaced on the return type, not parsed and dropped");
});

test("a scoped skip narrows skippedIssues to the named issue", () => {
  const block = fn.slice(fn.indexOf("const declaredSkip ="), fn.indexOf("const prMatch"));
  assert.match(block, /skippedIssues: scoped \? \[named\] : \(issueNumbers \?\? \[\]\)/,
    "a scoped trailer must narrow the skip; unscoped must still cover the batch");
});

test("an issue scope naming something outside the batch is not trusted", () => {
  const block = fn.slice(fn.indexOf("const declaredSkip ="), fn.indexOf("const prMatch"));
  assert.match(block, /includes\(named\)/,
    "the named issue must be checked against the batch — otherwise a typo silently skips nothing");
  assert.ok(/logger\.warn/.test(block.slice(block.indexOf("includes(named)"))),
    "an out-of-batch scope must be visible, not silently widened");
});

test("the agent is told to include the issue scope", () => {
  assert.match(agent, /FOREMAN_RESULT: skipped issue=/,
    "the prompt must show the scoped form, or agents keep emitting the batch-wide one");
  assert.match(agent, /Always include/,
    "the prompt must say the scope is required, not merely available");
});
