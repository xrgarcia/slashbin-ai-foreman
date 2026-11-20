// The merged-PR read behind netZeroOffProduction selects `commits`, which GitHub prices at 100 commits x 100
// authors per PR, against a 500,000-node cap per query. A window over the cap throws on every release scan:
// 2026-11-19, `--limit 100` asked for 1,000,000 nodes and held two issues at release pending for 16 hours.
// GitHub's own count for 50 PRs was 505,050, i.e. 10,101 per PR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MERGED_PR_WINDOW } from "../dist/github/release.js";

const NODES_PER_PR = 1 + 100 + 100 * 100;
const GITHUB_NODE_CAP = 500_000;

test("the merged-PR window fits GitHub's node cap with commits selected", () => {
  assert.ok(MERGED_PR_WINDOW * NODES_PER_PR <= GITHUB_NODE_CAP, `${MERGED_PR_WINDOW} PRs ask for ${MERGED_PR_WINDOW * NODES_PER_PR} nodes`);
  assert.equal(50 * NODES_PER_PR, 505_050, "the per-PR cost matches what GitHub reported for 50 PRs");
});
