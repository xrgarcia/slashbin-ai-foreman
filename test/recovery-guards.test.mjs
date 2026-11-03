// Guards from the 2026-10-14..18 log review: recovery must not act on what it
// could not read, nor adopt a PR whose build is still pushing.
//
// Source-level for the reconciler, as in reconciler-rejection.test.mjs: it
// shells out to git and gh end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ForemanRuntime } from "../dist/runtime.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf-8");

test("a failed open-PR or closed-PR lookup is unknown, and the reconciler skips the branch", () => {
  const r = src("src/reconciler.ts");
  const open = r.slice(r.indexOf("function hasOpenPR"), r.indexOf("function readClosedPrs"));
  assert.match(open, /catch \{[\s\S]*?return "unknown";/);
  const closed = r.slice(r.indexOf("function readClosedPrs"), r.indexOf("export function pruneMergedBranches"));
  assert.match(closed, /catch \{[\s\S]*?return "unknown";/);
  assert.match(r, /existingPR === "unknown"\) \{[\s\S]*?continue;/);
  assert.match(r, /closedPrs === "unknown"\) {[\s\S]*?continue;/);
});

test("a build in flight is counted per repo and cleared only when every build ends", () => {
  const rt = new ForemanRuntime();
  assert.equal(rt.builds.isInFlight("acme"), false);
  rt.builds.started("acme");
  rt.builds.started("acme");
  rt.builds.ended("acme");
  assert.equal(rt.builds.isInFlight("acme"), true);
  rt.builds.ended("acme");
  assert.equal(rt.builds.isInFlight("acme"), false);
  assert.equal(rt.builds.isInFlight("other"), false);
});

test("the review stage does not adopt an unlabeled PR while that repo is building", () => {
  const q = src("src/github/review-queue.ts");
  const fn = q.slice(q.indexOf("export function adoptOrphanedReviewCandidate"));
  assert.ok(fn.indexOf("isBuildInFlight(config.name)") > -1);
  assert.ok(fn.indexOf("isBuildInFlight(config.name)") < fn.indexOf("adopted.push"));
  for (const p of ["src/phases/implement.ts", "src/phases/revise.ts"]) {
    const s = src(p);
    assert.match(s, /activeRuns\.set\(runAbort, repoName\);\n\s*rt\.builds\.started\(repoName\);/, p);
    assert.match(s, /activeRuns\.delete\(runAbort\);\n\s*rt\.builds\.ended\(repoName\);/, p);
  }
});

test("a refused start exits 78, which the unit does not restart", () => {
  assert.match(src("src/cli.ts"), /Refusing to start[\s\S]{0,400}process\.exit\(78\)/);
  assert.match(src("deploy/slashbin-foreman.service.example"), /^RestartPreventExitStatus=78$/m);
});
