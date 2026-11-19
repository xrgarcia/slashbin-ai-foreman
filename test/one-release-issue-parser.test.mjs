// One parser decides which issues a release PR lists: release-tracker.ts `releaseIssues` (the `- #N` lines
// Promote writes, foreman#86). 759fd6e copied the receiver's loose `#N` body scan into github-work-source.ts and
// a Dependabot changelog `ip-address#217` put an unapproved issue In Review (SLA-5144). This fails the build when
// a second place pulls `#N` out of a PR body with a loose regex. An allow-list entry needs a written reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
/** file (relative to src/) -> why a loose `#N` scan of a body is not a release-issue parse. */
const ALLOWED = {
  "release-tracker.ts": "the one strict parser",
  "github/corrections.ts": "scans an ISSUE body for parent/mention references, not a PR body",
};
const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []);
const LOOSE_SCAN = /matchAll\(\s*\/[^\n]*#\(?(?:\\d|\[0-9\])/;

test("no second release-issue parser: no loose #N scan of a body outside release-tracker.ts", () => {
  const found = [];
  for (const f of files(src)) {
    const rel = relative(src, f).replaceAll("\\", "/");
    if (ALLOWED[rel]) continue;
    readFileSync(f, "utf8").split("\n").forEach((l, i) => { if (/body/i.test(l) && LOOSE_SCAN.test(l)) found.push(`${rel}:${i + 1}: ${l.trim()}`); });
  }
  assert.deepEqual(found, [], "route release membership through releaseIssues() in src/release-tracker.ts");
});

test("the guard catches the regression it exists for", () => {
  assert.ok(LOOSE_SCAN.test('[...String(p.body ?? "").matchAll(/#(\\d+)\\b/g)]'));
});
