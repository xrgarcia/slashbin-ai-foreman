// The Tech Lead hand-off (EM#427). Run with `npm test` after `npm run build`.
//
// The contract under test is the one that keeps reviews from ever waiting on
// Codex: exit 3 means "wrote nothing" and MUST come back as a fallback so the
// Claude review runs; any other failure must NOT, because it may have written.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewViaTechLead } from "../dist/agent.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const repo = { name: "r", githubRepo: "o/r" };

function fakeTechLead(script) {
  const dir = mkdtempSync(join(tmpdir(), "fake-tech-lead-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/tech-lead.mjs"), script);
  return { techLeadPath: dir, emRepoPath: "/em", reviewMaxDurationMs: 30_000 };
}

process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";

test("exit 3 (wrote nothing) falls back to the Claude review", async () => {
  const cfg = fakeTechLead('console.log("Codex first read failed (signed-out) — nothing written"); process.exit(3);');
  const r = await reviewViaTechLead(repo, cfg, 5, logger);
  assert.equal(r.fallback, true);
  assert.match(r.reason, /signed-out/);
});

test("a trailer from the Tech Lead is parsed exactly like the Claude review's", async () => {
  const cfg = fakeTechLead('console.log("APPROVED and merged"); console.log("FOREMAN_REVIEW pr=#5 verdict=APPROVE merged=yes deploy=SUCCESS");');
  const r = await reviewViaTechLead(repo, cfg, 5, logger);
  assert.equal(r.success, true);
  assert.equal(r.trailers.length, 1);
  assert.equal(r.trailers[0].merged, true);
});

test("any other failure is a failure, NOT a fallback — it may have written", async () => {
  const cfg = fakeTechLead('console.error("boom after posting"); process.exit(1);');
  const r = await reviewViaTechLead(repo, cfg, 5, logger);
  assert.equal("fallback" in r, false);
  assert.equal(r.success, false);
});

test("exit 0 with no trailer is a failure, as on the Claude path", async () => {
  const cfg = fakeTechLead('console.log("done, I think");');
  const r = await reviewViaTechLead(repo, cfg, 5, logger);
  assert.equal(r.success, false);
  assert.match(r.error, /without a FOREMAN_REVIEW trailer/);
});

test("unset techLeadPath is a fallback, so the default config is unchanged", async () => {
  const r = await reviewViaTechLead(repo, { reviewMaxDurationMs: 1000 }, 5, logger);
  assert.equal(r.fallback, true);
});

test("the configured label names reach the Tech Lead as they reach Claude", async () => {
  const cfg = fakeTechLead('console.log(`labels ${process.env.FOREMAN_TRIGGER_LABEL} ${process.env.FOREMAN_LIFECYCLE_LABELS}`); process.exit(3);');
  const labelled = { ...repo, triggerLabel: "go", lifecycleLabels: { prUnderReview: "in-review", prPendingActions: "needs-changes" } };
  const r = await reviewViaTechLead(labelled, cfg, 5, logger);
  assert.equal(r.fallback, true);
  assert.match(r.reason, /labels go \{"prUnderReview":"in-review","prPendingActions":"needs-changes"\}/);
});
