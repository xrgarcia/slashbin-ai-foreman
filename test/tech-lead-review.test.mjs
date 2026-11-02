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
import { reviewViaTechLead } from "../dist/plugins/tech-lead.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const repo = { name: "r", githubRepo: "o/r" };

function fakeTechLead(script) {
  const dir = mkdtempSync(join(tmpdir(), "fake-tech-lead-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/tech-lead.mjs"), script);
  return { techLeadPath: dir, emRepoPath: "/em", reviewMaxDurationMs: 30_000 };
}

process.env.TECHLEAD_GITHUB_KEY ||= "test-token-not-real";

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

// foreman#180: a transient GitHub error inside the Tech Lead is a defer, never a charged failure.
test("a non-zero exit whose stderr is a TLS handshake timeout is deferred like exit 3, flagged transient", async () => {
  const cfg = fakeTechLead('console.error(\'review-pr failed: gh pr view 7: Post "https://api.github.com/graphql": net/http: TLS handshake timeout\'); process.exit(1);');
  const r = await reviewViaTechLead(repo, cfg, 7, logger);
  assert.equal(r.fallback, true);
  assert.equal(r.transient, true);
  assert.match(r.reason, /TLS handshake timeout/);
});

test("5xx, ECONNRESET, ENOTFOUND and dial tcp on stderr are deferred", async () => {
  for (const msg of ["HTTP 502: Bad Gateway", "read ECONNRESET", "getaddrinfo ENOTFOUND api.github.com", "dial tcp 140.82.1.1:443: i/o timeout"]) {
    const cfg = fakeTechLead(`console.error(${JSON.stringify(`review-pr failed: ${msg}`)}); process.exit(1);`);
    const r = await reviewViaTechLead(repo, cfg, 7, logger);
    assert.equal(r.fallback, true, msg);
  }
});

test("auth, 404, 422 and rate-limit failures stay failures", async () => {
  for (const msg of ["HTTP 401: Bad credentials", "HTTP 404: Not Found", "HTTP 422: Validation Failed", "API rate limit exceeded", "merge conflicts"]) {
    const cfg = fakeTechLead(`console.error(${JSON.stringify(`review-pr failed: ${msg}`)}); process.exit(1);`);
    const r = await reviewViaTechLead(repo, cfg, 7, logger);
    assert.equal("fallback" in r, false, msg);
    assert.equal(r.success, false, msg);
  }
});

test("exit 3 from the Tech Lead's own github-unavailable is a transient defer; exit 3 for Codex stays the visible wait", async () => {
  const cfg = fakeTechLead('console.log("GitHub unavailable after 4 attempts — nothing written; retry later."); process.exit(3);');
  const r = await reviewViaTechLead(repo, cfg, 7, logger);
  assert.equal(r.fallback, true);
  assert.equal(r.transient, true);
  const codex = fakeTechLead('console.log("Codex first read failed (signed-out) — nothing written"); process.exit(3);');
  const c = await reviewViaTechLead(repo, codex, 7, logger);
  assert.equal(c.fallback, true);
  assert.equal(c.transient, undefined);
});

test("exit 3 with a TLS timeout on stderr is deferred the same as exit 1", async () => {
  const cfg = fakeTechLead('console.error("gh pr view 7: net/http: TLS handshake timeout"); console.log("retry later"); process.exit(3);');
  const r = await reviewViaTechLead(repo, cfg, 7, logger);
  assert.equal(r.transient, true);
});

test("HTTP 500 on stderr is deferred, transient, not a failure", async () => {
  const cfg = fakeTechLead('console.error("review-pr failed: gh pr view 7: HTTP 500: Internal Server Error"); process.exit(1);');
  const r = await reviewViaTechLead(repo, cfg, 7, logger);
  assert.equal(r.fallback, true);
  assert.equal(r.transient, true);
});
