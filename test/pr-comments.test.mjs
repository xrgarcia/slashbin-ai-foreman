// The one shared PR-comment lookup: async, all pages, prefix (QA) or substring (carry, sign-off) matching.
// `gh` is a stub on PATH that prints two pages of bodies after a delay.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCommentStartingWith, hasCommentContaining, commentBodies } from "../dist/github/pr-comments.js";

const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
const page = (...bodies) => bodies.map((b) => JSON.stringify(b)).join("\n");
writeFileSync(join(dir, "gh"), `#!/bin/sh\nsleep 0.3\ncat <<'EOF'\n${page("first page", "## QA Report (report-only)\\n\\nV")}\n${page("page two: <!-- foreman-carried pr=9 --> inside", "last")}\nEOF\n`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "t-test-token";
const cfg = { githubRepo: "o/r", repoPath: tmpdir() };

test("commentBodies decodes every page", async () => {
  assert.equal((await commentBodies(cfg, 1)).length, 4);
});

test("QA matches by prefix, carry and sign-off by substring, across all pages", async () => {
  assert.equal(await hasCommentStartingWith(cfg, 1, "## QA Report (report-only)"), true);
  assert.equal(await hasCommentStartingWith(cfg, 1, "foreman-carried"), false, "a prefix does not match mid-body text");
  assert.equal(await hasCommentContaining(cfg, 1, "<!-- foreman-carried pr=9 -->"), true, "found on the second page");
  assert.equal(await hasCommentContaining(cfg, 1, "pr=10 -->"), false);
});

test("the lookup does not block the event loop for the length of the gh call", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  await hasCommentContaining(cfg, 1, "last");
  clearInterval(timer);
  assert.ok(ticks >= 10, `timer ticked ${ticks} times during a 300ms gh call`);
});
