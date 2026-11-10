// foreman#116: a revision that reverts what the PR description claims must not leave the description claiming it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteBodyForRevert, revisionLeavesBodyStale, amendRevisedPrBody, bodySyncFor, droppedFromSubjects, REVERTED_HEADING } from "../dist/pr-body.js";
import { registerPlugin, startPlugins, resetRegistryForTests } from "../dist/plugins/registry.js";
import { GitHubPlugin } from "../dist/plugins/github.js";
import { readResultV1 } from "../dist/contract/result-v1.js";

const BODY = `Closes #699

| Item | Change | Status |
|---|---|---|
| #695 | @grpc/grpc-js lockfile note | **Landed** |
| #696 | @grpc/grpc-js 1.14.4 → 1.14.6 | **Landed** |
| #6961 | other | **Landed** |

- #696 bump verified
- #697 unrelated
`;

test("a body claiming an item + a revision that reverts it: the body no longer claims it landed", () => {
  const { body, struck } = rewriteBodyForRevert(BODY, { items: ["#696"], findings: [2] });
  const row = body.split("\n").find((l) => l.includes("1.14.6"));
  assert.ok(!/\*\*Landed\*\*/.test(row), row);
  assert.match(row, /~~Landed~~ \*\*Reverted\*\*/);
  assert.match(body, /- ~~#696 bump verified~~ \(reverted in revision\)/);
  assert.equal(struck, 2);
  assert.match(body, new RegExp(`${REVERTED_HEADING}[\\s\\S]*- #696`));
  assert.match(body, /finding #2/);
});

test("unrelated lines survive; #69 never matches #696, #696 never matches #6961", () => {
  const { body } = rewriteBodyForRevert(BODY, { items: ["#696"] });
  assert.match(body, /\| #695 \|.*\*\*Landed\*\*/);
  assert.match(body, /\| #6961 \|.*\*\*Landed\*\*/);
  assert.match(body, /- #697 unrelated/);
});

test("idempotent, and a second revert updates the one section instead of stacking another", () => {
  const once = rewriteBodyForRevert(BODY, { items: ["#696"] });
  assert.equal(rewriteBodyForRevert(once.body, { items: ["#696"] }).changed, false);
  const twice = rewriteBodyForRevert(once.body, { items: ["#695"] });
  assert.equal(twice.body.split(REVERTED_HEADING).length, 2);
  assert.match(twice.body, /- #696/);
  assert.match(twice.body, /- #695/);
});

test("nothing matched mechanically: the section still stands so the body is never silently stale", () => {
  const r = rewriteBodyForRevert("Does a thing.", { findings: [1] });
  assert.ok(r.changed);
  assert.match(r.body, new RegExp(REVERTED_HEADING));
});

test("revisionLeavesBodyStale: stale flag, or a revert that did not say the body was rewritten", () => {
  assert.equal(revisionLeavesBodyStale({ outcome: "pushed", pr_body_stale: true }), true);
  assert.equal(revisionLeavesBodyStale({ outcome: "reverted" }), true);
  assert.equal(revisionLeavesBodyStale({ outcome: "reverted", pr_body_stale: false }), false);
  assert.equal(revisionLeavesBodyStale({ outcome: "pushed" }), false);
});

test("reverted_items is part of the v1 reviser line", () => {
  const line = 'FOREMAN_RESULT_V1 {"schema":1,"role":"reviser","outcome":"reverted","reverted_items":["#696"],"pr_body_stale":true}';
  const v = readResultV1(line, "reviser");
  assert.equal(v.status, "ok");
  assert.deepEqual(v.result.reverted_items, ["#696"]);
});

test("amendRevisedPrBody reads the body and PATCHes the rewritten one through REST", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-116-"));
  const log = join(dir, "calls.json");
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a.includes("PATCH")) { fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(a)); process.exit(0); }
console.log(JSON.stringify(${JSON.stringify(BODY)}));
`);
  chmodSync(join(dir, "gh"), 0o755);
  resetRegistryForTests();
  const gh = new GitHubPlugin();
  registerPlugin({ id: "gh-host", roles: ["codeHost"], enabled: () => true, codeHost: gh.codeHost });
  await startPlugins({ repos: [], codeHost: "gh-host" }, { logger: { info() {}, warn() {}, error() {}, debug() {} }, configText: () => null });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  const savedTok = process.env.FOREMAN_GITHUB_TOKEN;
  process.env.FOREMAN_GITHUB_TOKEN = "test";
  try {
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const r = { outcome: "reverted", reverted_items: ["#696"], pr_body_stale: true };
    const { changed, matched } = await amendRevisedPrBody({ githubRepo: "o/r", repoPath: dir }, 700, bodySyncFor(r, []), r, logger);
    assert.equal(changed, true);
    assert.equal(matched, 2);
    const args = JSON.parse(readFileSync(log, "utf8"));
    const body = args.find((x) => x.startsWith("body=")).slice(5);
    assert.ok(args.includes("repos/o/r/pulls/700"));
    assert.ok(!/1\.14\.6 \| \*\*Landed\*\*/.test(body));
    assert.match(body, /Reverted in revision/);
  } finally {
    resetRegistryForTests();
    process.env.PATH = saved;
    if (savedTok === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = savedTok;
  }
});

test("revisePRFeedback amends the body before it reports success, and fails the pass when it cannot", () => {
  const src = readFileSync(new URL("../src/phases/revise-workflow.ts", import.meta.url), "utf8");
  const amend = src.indexOf("amendRevisedPrBody(");
  assert.ok(amend > 0 && amend < src.lastIndexOf("return { success: true, summary"), "the amend comes before the success return");
  assert.match(src, /return \{ success: false, error: `PR description sync failed/);
  assert.match(src, /bodyNote\}/, "the instruction reaches every prompt, repo-local skill and default included");
  assert.ok((src.match(/\$\{bodyNote\}/g) ?? []).length >= 2);
});

const SUBJECT = "fix: drop @grpc/grpc-js 1.14.6 bump, no runtime smoke test possible (#700)";

test("legacy output, no v1 line: the revision's own commit subject names what it dropped, and the incident row is struck", () => {
  const sync = bodySyncFor(null, ["fix: address review feedback (#700)", SUBJECT]);
  assert.equal(sync.needed, true);
  assert.equal(sync.certain, false);
  const { body, matched } = rewriteBodyForRevert(BODY, { items: sync.items });
  const row = body.split("\n").find((l) => l.includes("1.14.6"));
  assert.ok(!/\*\*Landed\*\*/.test(row), row);
  assert.ok(matched >= 1);
});

test("an ordinary fix subject needs no sync", () => {
  assert.equal(bodySyncFor(null, ["fix: address review feedback (#700)"]).needed, false);
  assert.equal(bodySyncFor({ outcome: "pushed" }, ["fix: tighten the guard"]).needed, false);
});

test("v1 says reverted with no reverted_items: items come from the commit subjects; with nothing to match, matched is 0 so the pass fails", () => {
  const v1 = { outcome: "reverted", reverted_findings: [2], pr_body_stale: true };
  const withSubject = bodySyncFor(v1, [SUBJECT]);
  assert.equal(withSubject.certain, true);
  assert.ok(rewriteBodyForRevert(BODY, { items: withSubject.items }).matched >= 1);
  const none = bodySyncFor(v1, ["fix: address review feedback"]);
  assert.equal(none.certain, true);
  assert.equal(rewriteBodyForRevert(BODY, { items: none.items, findings: [2] }).matched, 0);
});

test("droppedFromSubjects reads refs, packages, versions and paths", () => {
  assert.deepEqual(droppedFromSubjects(["revert: back out #12 in src/a.ts"]).items.sort(), ["#12", "src/a.ts"]);
});
