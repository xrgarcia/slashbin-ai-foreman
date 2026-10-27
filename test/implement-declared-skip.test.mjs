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
// issue and filters each out for backoffDelay(skipCount, backoff.skip) — 5 min rising to 4 h by default.
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
  assert.match(block, /skippedIssues: named !== undefined \? \[named\] : \(issueNumbers \?\? \[\]\)/,
    "a scoped trailer must narrow the skip; unscoped must still cover the batch");
});

// In skill mode the prompt names the batch, but a repo-local skill still runs
// its own `gh issue list` first, which is strictly WIDER than issueNumbers, because the batch
// was already filtered by the implemented cache and by the skip back-off while
// those issues stay open and `approved` on GitHub. So an out-of-batch scope is
// routine. Widening the skip to the batch over it would reintroduce the exact
// starvation the scope exists to prevent.
test("an out-of-batch issue scope is honoured, not widened to the batch", () => {
  const block = fn.slice(fn.indexOf("const declaredSkip ="), fn.indexOf("const prMatch"));
  assert.ok(!/skippedIssues: scoped/.test(block),
    "the scope must not depend on batch membership");
  assert.match(block, /includes\(named\)/,
    "an out-of-batch scope should still be reported, so the case stays observable");
  const afterCheck = block.slice(block.indexOf("includes(named)"));
  assert.ok(!/logger\.warn/.test(afterCheck),
    "an out-of-batch scope is expected in skill mode — warning on it trains operators to ignore warnings");
});

test("the agent is told to include the issue scope", () => {
  assert.match(agent, /FOREMAN_RESULT: skipped issue=/,
    "the prompt must show the scoped form, or agents keep emitting the batch-wide one");
  assert.match(agent, /Always include/,
    "the prompt must say the scope is required, not merely available");
});

// --- The trailer's fields must parse in either order -----------------------
//
// second-pass.mjs on Slashbin-Ingest-Gateway#138, 2026-09-28. The parse was
// `skipped(?:\s+reason="([^"]*)")?`, which binds `reason` ONLY when it directly
// follows `skipped`. Documenting the scoped form as
// `skipped issue=123 reason="..."` therefore dropped every reason to the literal
// "no reason given" — and the reason is the sole input to
// isResolvedTransientSkip, so a self-clearing divergence skip would have become
// a back-off rising to its cap (backoff.skip).
//
// These call the real function rather than grepping the source, because the
// defect was in what the regex MATCHED, which source text cannot show.

test("reason and issue parse regardless of field order", async () => {
  const { detectDeclaredSkip } = await import("../dist/agent.js");

  const scopedFirst = detectDeclaredSkip(
    'FOREMAN_RESULT: skipped issue=427 reason="cited path does not exist"',
  );
  assert.equal(scopedFirst.skipped, true);
  assert.equal(scopedFirst.issue, 427);
  assert.equal(scopedFirst.reason, "cited path does not exist",
    "reason must parse when issue= comes first — this is the documented order");

  const reasonFirst = detectDeclaredSkip(
    'FOREMAN_RESULT: skipped reason="cited path does not exist" issue=427',
  );
  assert.equal(reasonFirst.issue, 427);
  assert.equal(reasonFirst.reason, "cited path does not exist");
});

test("the legacy unscoped trailer still parses and stays batch-wide", async () => {
  const { detectDeclaredSkip } = await import("../dist/agent.js");
  const legacy = detectDeclaredSkip('FOREMAN_RESULT: skipped reason="investigation only"');
  assert.equal(legacy.skipped, true);
  assert.equal(legacy.reason, "investigation only");
  assert.equal(legacy.issue, undefined,
    "an unscoped trailer must not acquire a scope, or it would narrow a batch judgement");
});

test("a reason on a later line is NOT swept into the trailer", async () => {
  const { detectDeclaredSkip } = await import("../dist/agent.js");
  const spread = detectDeclaredSkip('FOREMAN_RESULT: skipped issue=5\nreason="on the next line"');
  assert.equal(spread.issue, 5);
  assert.equal(spread.reason, "no reason given",
    "the parse is line-scoped on purpose — prose after the trailer must not become the reason");
});

test("no trailer at all is not a skip", async () => {
  const { detectDeclaredSkip } = await import("../dist/agent.js");
  assert.equal(detectDeclaredSkip("I decided to skip this issue entirely.").skipped, false,
    "prose must not reach the pre-PR check — that is detectSkipSignal's job, downstream");
});

// slashbin-ai-foreman#49: an agent that NAMED the trailer in prose, while
// deliberately not emitting it, was booked as a batch-wide skip — twice — and
// three approved issues backed off for 1h, then 2h. The text is from the
// 2026-10-01T19:34:55Z Slashbin-console implement log.
test("prose that names the trailer is not a declaration", async () => {
  const { detectDeclaredSkip } = await import("../dist/agent.js");
  const prose =
    "To unblock, PR #1175 needs a review and a merge into `develop`.\n\n" +
    "I left off the `FOREMAN_RESULT: skipped` line on purpose. No single issue is at fault, " +
    "and a line without `issue=` would hold every approved issue for up to 24 hours.\n";
  assert.equal(detectDeclaredSkip(prose).skipped, false,
    "only a line that STARTS with the trailer declares a skip");
});

test("a real trailer after prose still parses, and the last one wins", async () => {
  const { detectDeclaredSkip } = await import("../dist/agent.js");
  const out = detectDeclaredSkip(
    "Commented on #9 with what would unblock it.\n\n" +
    "FOREMAN_RESULT: skipped issue=8 reason=\"superseded\"\n" +
    "FOREMAN_RESULT: skipped issue=9 reason=\"cited path does not exist\"\n",
  );
  assert.equal(out.skipped, true);
  assert.equal(out.issue, 9);
  assert.equal(out.reason, "cited path does not exist");
});
