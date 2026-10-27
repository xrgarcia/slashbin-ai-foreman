// comments.ts: the pure renderers behind a card's thread (Foreman issue 74).
import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewBody, redactComment, capComment, agentText } from "../dist/paperclip/comments.js";

// The shape the Tech Lead posts (slashbin-cli PR 143, 2026-10-03).
const BODY = [
  "The naming fix addresses #142; all four CI checks are green. One S2 remains.",
  "",
  "### S2 — blocking",
  "",
  "**[S2] Org-wide status output omits the stream identifier** — `src/commands/generated/data-streams.ts:24` — The command renders only currentStep.",
  "**Required outcome:** rows show dataStreamId.",
  "",
  "### S4",
  "",
  "**[S4] Status fixtures use step names** — `tests/backward-compat.test.ts:1652` — strings, not numbers.",
  "",
  "<sub>Tech Lead · REQUEST_CHANGES · reviewed on codex</sub>",
].join("\n");

test("parseReviewBody: the opening paragraph and every finding with severity and location", () => {
  assert.deepEqual(parseReviewBody(BODY), {
    summary: "The naming fix addresses #142; all four CI checks are green. One S2 remains.",
    findings: [
      { severity: "S2", title: "Org-wide status output omits the stream identifier", where: "src/commands/generated/data-streams.ts:24" },
      { severity: "S4", title: "Status fixtures use step names", where: "tests/backward-compat.test.ts:1652" },
    ],
  });
  assert.deepEqual(parseReviewBody(null), { findings: [] });
});

test("redactComment: token shapes and secret-named assignments, plain prose untouched", () => {
  const out = redactComment(
    "ghp_0123456789abcdefghij0123456789abcdef sk-ant-api03-abcdefghijklmnopqrstuv AKIAABCDEFGHIJKLMNOP " +
    "Bearer abcdefghijklmnop1234 postgres://u:hunter2pass@db:5432/x DATABASE_PASSWORD=supersecret1 tokens counted: 12",
    [],
  );
  for (const leak of ["ghp_0123", "sk-ant-api03", "AKIAABCD", "abcdefghijklmnop1234", "hunter2pass", "supersecret1"]) {
    assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  }
  assert.ok(out.includes("tokens counted: 12"));
});

test("capComment and agentText", () => {
  assert.equal(capComment("short", 100), "short");
  const c = capComment("y".repeat(500), 200);
  assert.equal(c.length, 200);
  assert.ok(c.endsWith("… (truncated)"));
  assert.equal(agentText("Done.\nFOREMAN_IMPL issue=#7\n\n\n\nTests pass."), "Done.\n\nTests pass.");
});
