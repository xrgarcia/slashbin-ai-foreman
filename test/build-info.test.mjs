// The daemon runs only a committed build. On 2026-10-12 an uncommitted edit in
// the live checkout was built and ran in production for a day (4b6c4d3);
// `npm run build` now stamps dist/ with its source, and daemon mode refuses a
// stamp that is missing or dirty.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRefusal } from "../dist/build-info.js";

function distWith(info) {
  const d = mkdtempSync(join(tmpdir(), "build-info-"));
  if (info !== undefined) writeFileSync(join(d, "build-info.json"), JSON.stringify(info));
  return d;
}

test("a clean committed build may start", () => {
  assert.equal(buildRefusal(distWith({ commit: "4b6c4d3abc", dirty: [], builtAt: "2026-10-13T00:00:00Z" })), null);
});

test("a build with uncommitted source is refused, naming the files", () => {
  const why = buildRefusal(distWith({ commit: "4b6c4d3abc", dirty: [" M src/phases/review.ts", "?? src/github/x.ts"], builtAt: "t" }));
  assert.match(why, /uncommitted source on top of 4b6c4d3/);
  assert.match(why, /src\/phases\/review\.ts/);
  assert.match(why, /src\/github\/x\.ts/);
});

test("a build with no stamp (tsc run directly) is refused", () => {
  assert.match(buildRefusal(distWith(undefined)), /missing/);
});

test("a stamp that could not read git is refused", () => {
  assert.match(buildRefusal(distWith({ commit: null, dirty: null, builtAt: "t", error: "not a git repository" })), /not a git repository/);
});

test("npm run build stamps this checkout's own state", () => {
  const info = JSON.parse(readFileSync(new URL("../dist/build-info.json", import.meta.url), "utf8"));
  assert.match(info.commit, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(info.dirty));
});
