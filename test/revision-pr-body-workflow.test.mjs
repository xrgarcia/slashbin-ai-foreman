// foreman#116, through the real revisePRFeedback: a fake `claude` pushes a revert (the code host reports a new
// head) and prints legacy or v1 output; a fake code host holds the PR body. Whatever the reviser prints, the
// body handed back to review no longer claims the reverted item as landed, or the pass fails.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { revisePRFeedback } from "../dist/phases/revise-workflow.js";
import { loadConfig } from "../dist/config.js";
import { ClaudeTrust } from "../dist/claude-trust.js";
import { createLogger } from "../dist/logger.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { githubCodeHost } from "../dist/plugins/github.js";

const logger = createLogger({ format: "text", level: "error" });
const BODY = "Closes #699\n\n| Item | Change | Status |\n|---|---|---|\n| #696 | @grpc/grpc-js 1.14.4 → 1.14.6 | **Landed** |\n| #697 | other | **Landed** |\n";
const SUBJECT = "fix: drop @grpc/grpc-js 1.14.6 bump, no runtime smoke test possible (#700)";
let tmp, saved, outFile, cfg;
let body, subjects;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-116-wf-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  mkdirSync(join(tmp, "repo"));
  outFile = join(tmp, "claude-out.txt");
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\nprocess.stdout.write(require("fs").readFileSync(${JSON.stringify(outFile)}, "utf8"));\n`);
  chmodSync(join(bin, "claude"), 0o755);
  saved = { PATH: process.env.PATH, token: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-dummy-value-not-a-token";
  process.chdir(tmp);
  const p = join(tmp, "cfg.json");
  writeFileSync(p, JSON.stringify({ repos: [{ name: "t", repoPath: join(tmp, "repo"), githubRepo: "example/t" }] }));
  cfg = { ...loadConfig(p).repos[0], skillPath: "builtin:", revisionSkillPath: "builtin:" };
  let calls = 0;
  setCodeHost({
    ...githubCodeHost(),
    getRemoteBranchSha: async () => (calls++ % 2 === 0 ? "a".repeat(40) : "b".repeat(40)),
    commitSubjects: async () => subjects,
    editPrBody: async (_c, _pr, rewrite) => { const n = rewrite(body); if (n === null) return false; body = n; return true; },
  });
});
after(() => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.token === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = saved.token;
  rmSync(tmp, { recursive: true, force: true });
});

const run = async (out, subs) => {
  body = BODY; subjects = subs;
  writeFileSync(outFile, out);
  return await revisePRFeedback(new ClaudeTrust(), cfg, logger, undefined, 700, [699]);
};
const claimsLanded = () => body.split("\n").some((l) => l.includes("1.14.6") && /\*\*Landed\*\*/.test(l));

test("legacy output (a repo-local skill): the revert's commit subject is enough, the #696 row no longer says Landed", async () => {
  const r = await run("reverted the bump\n", [SUBJECT]);
  assert.equal(r.success, true);
  assert.ok(!claimsLanded(), body);
  assert.match(body, /\| #697 \| other \| \*\*Landed\*\*/);
});

test("v1 reverted, reverted_items omitted: items come from the commit subject", async () => {
  const r = await run('FOREMAN_RESULT_V1 {"schema":1,"role":"reviser","outcome":"reverted","reverted_findings":[2],"pr_body_stale":true}\n', [SUBJECT]);
  assert.equal(r.success, true);
  assert.ok(!claimsLanded(), body);
});

test("v1 reverted, nothing names the item anywhere: the pass fails, the PR is not handed back", async () => {
  const r = await run('FOREMAN_RESULT_V1 {"schema":1,"role":"reviser","outcome":"reverted","reverted_findings":[2],"pr_body_stale":true}\n', ["fix: address review feedback"]);
  assert.equal(r.success, false);
  assert.match(r.error, /no line of it names what was reverted/);
});

test("v1 reverted_items names it: struck, success", async () => {
  const r = await run('FOREMAN_RESULT_V1 {"schema":1,"role":"reviser","outcome":"reverted","reverted_items":["#696"],"pr_body_stale":true}\n', ["fix: address review feedback"]);
  assert.equal(r.success, true);
  assert.ok(!claimsLanded(), body);
});

test("an ordinary fix leaves the body alone", async () => {
  const r = await run('FOREMAN_RESULT_V1 {"schema":1,"role":"reviser","outcome":"pushed","changed":["code"]}\n', ["fix: address review feedback (#700)"]);
  assert.equal(r.success, true);
  assert.equal(body, BODY);
});
