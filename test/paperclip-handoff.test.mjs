// The handoff table (src/paperclip/handoff.ts): every stage says what its holder
// does and when it is done. SLA-1550, 2026-10-15: a card reached the EM with
// only "Dev verification passed" and "approved", and the release gate sat.
import test from "node:test";
import assert from "node:assert/strict";
import { STAGE_HANDOFF, DEFAULT_HANDOFF_LABELS, handoffComment, handoffNextLine } from "../dist/paperclip/handoff.js";
import { STAGES } from "../dist/lifecycle.js";
import { defaultLifecycleLabels } from "../dist/config.js";

const facts = { repo: "example/r", issueNumber: 7, seat: "Engineering Manager", pr: { number: 9 } };

test("every lifecycle stage has a handoff, and every placeholder fills", () => {
  for (const stage of STAGES) {
    const h = STAGE_HANDOFF[stage];
    assert.ok(h, `no handoff for ${stage}`);
    const text = `${handoffComment(stage, facts)}\n${handoffNextLine(stage, facts)}`;
    assert.doesNotMatch(text, /\{\w+\}/, `${stage} leaves a placeholder unfilled`);
    assert.match(text, h.act ? /— action needed\*\*/ : /— no action needed from this card\*\*/);
  }
});

test("the label names quoted are the lifecycle's defaults", () => {
  const d = defaultLifecycleLabels();
  for (const [k, v] of Object.entries(DEFAULT_HANDOFF_LABELS)) assert.equal(d[k], v, k);
});

test("pendingVerification asks the EM for its release gate and names done; labels come from config", () => {
  const text = handoffComment("pendingVerification",
    { ...facts, evidence: { text: "PR #9 verified in dev", at: "2026-10-15T16:27:04Z", url: "https://github.com/example/r/pull/9#issuecomment-1" } },
    { ...DEFAULT_HANDOFF_LABELS, readyForProd: "ship it" });
  assert.equal(text, [
    "**Next: Engineering Manager — action needed**",
    "- **Do:** Run the EM release gate (`/deliver-to-prod` step 3a) for example/r#7 and, if it passes, apply `ship it` to the issue. The prod release does not start until you do.",
    "- **Why:** dev verification passed (`pr approved`) — PR #9 verified in dev (2026-10-15 16:27Z)",
    "- **Links:** [example/r#7](https://github.com/example/r/issues/7) · [PR #9](https://github.com/example/r/pull/9) · [evidence](https://github.com/example/r/pull/9#issuecomment-1)",
    "- **Done when:** `ship it` is on example/r#7; the Foreman then moves this card to Release authorized and opens the release PR",
  ].join("\n"));
});

test("needsRuling names /rule-on-scope with the PR; prodVerifyHeld says to sort the hold", () => {
  assert.match(handoffComment("needsRuling", facts), /`\/rule-on-scope example\/r 9`/);
  assert.match(handoffComment("needsRuling", { ...facts, pr: undefined }), /`\/rule-on-scope example\/r <PR>`/);
  assert.equal(handoffNextLine("prodVerifyHeld", facts), "Next: Engineering Manager — sort the prod-verification hold on example/r#7");
});
