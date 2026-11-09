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

// Agent contract step 4a: the typed waitingOn decides; the reason is only the fallback.
import { waitingPr } from "../dist/phases/implement.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { githubCodeHost } from "../dist/plugins/github.js";
setCodeHost(githubCodeHost());
const reads = (m) => async (ref) => {
  const s = m[`${ref.repo}#${ref.number}`];
  if (!s) throw new Error("unreadable");
  return s;
};
test("waitingPr names a PR in its own repo, never an issue or a failed read", async () => {
  const r = reads({ "o/r#7": { open: true, isPr: true }, "o/r#5": { open: false, isPr: true }, "other/repo#5": { open: true, isPr: true }, "o/r#12": { open: true, isPr: false } });
  assert.deepEqual(await waitingPr({ waitingOn: "#7" }, "o/r", r), { repo: "o/r", number: 7 });
  assert.deepEqual(await waitingPr({ waitingOn: "#5" }, "o/r", r), { repo: "o/r", number: 5 });
  assert.deepEqual(await waitingPr({ waitingOn: "other/repo#5" }, "o/r", r), { repo: "other/repo", number: 5 });
  assert.equal(await waitingPr({ waitingOn: "#12" }, "o/r", r), null);
  assert.equal(await waitingPr({ waitingOn: "#99" }, "o/r", r), null);
  assert.equal(await waitingPr({}, "o/r", r), null);
});
