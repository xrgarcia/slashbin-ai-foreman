// foreman#50: a skip whose reason names the PR holding the branch is transient —
// it clears once that PR closes. The reason is the agent's own words, so the
// classifier is tested on the wordings actually seen in the state file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prBlockingSkip } from "../dist/orchestrator.js";

test("the live wordings name the blocking PR", () => {
  assert.equal(prBlockingSkip("features branch occupied by open PR #1204 (#1185); pushing would bundle #1205 into it"), 1204);
  assert.equal(prBlockingSkip("open features→develop PR #411 (for #405, changes requested) must merge or close before #412 can get its own PR"), 411);
  assert.equal(prBlockingSkip("PR #88 is still open on features"), 88);
});

test("durable reasons and mere citations are not PR blocks", () => {
  assert.equal(prBlockingSkip("investigation only — no immediate code change"), null);
  assert.equal(prBlockingSkip("already delivered by PR #50; nothing to do"), null);
  assert.equal(prBlockingSkip("diverged from origin/features"), null);
});
