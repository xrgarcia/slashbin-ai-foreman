// Review of foreman#287, S2: a PRESENT but invalid FOREMAN_RESULT_V1 line (implementer or reviser) holds the work for a
// person and names the field; the legacy trailer beside it neither closes the issue nor returns unchanged work to
// review. With NO v1 line the legacy trailer still decides.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { revisePRFeedback } from "../dist/phases/revise-workflow.js";
import { implementApprovedIssues } from "../dist/phases/implement-workflow.js";
import { loadConfig } from "../dist/config.js";
import { ClaudeTrust } from "../dist/claude-trust.js";
import { createLogger } from "../dist/logger.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { githubCodeHost } from "../dist/plugins/github.js";

const logger = createLogger({ format: "text", level: "error" });
const SHA = "a".repeat(40);
let tmp, saved, outFile, cfg;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-s2-"));
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
  // The branch never moves: every read answers the same sha.
  setCodeHost({ ...githubCodeHost(), getRemoteBranchSha: async () => SHA, findOpenFeaturePR: async () => null, forgetOpenPrs: () => {} });
});
after(() => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.token === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = saved.token;
  rmSync(tmp, { recursive: true, force: true });
});

const implement = async (out) => {
  writeFileSync(outFile, out);
  return await implementApprovedIssues(new ClaudeTrust(), cfg, logger, undefined, null, [7], [7], { 7: "foreman/7-thing" });
};
const revise = async (out) => {
  writeFileSync(outFile, out);
  return await revisePRFeedback(new ClaudeTrust(), cfg, logger, undefined, 12, [7], undefined, SHA, "foreman/7-thing");
};

test("R1: an implementer v1 'landed' line without landed_issue holds issue 7 for a person; the legacy landed trailer does not close it", async () => {
  const r = await implement('FOREMAN_RESULT: landed issue=7 reason="already on develop"\nFOREMAN_RESULT_V1 {"schema":1,"role":"implementer","outcome":"landed"}\n');
  assert.equal(r.success, false);
  assert.match(r.contractInvalid ?? "", /landed_issue/);
  assert.ok(!r.landed, "the legacy trailer must not authorize closure");
  assert.ok(!r.skipped);
});

test("implementer, no v1 line: the legacy landed trailer still closes it", async () => {
  const r = await implement('FOREMAN_RESULT: landed issue=7 reason="already on develop"\n');
  assert.equal(r.landed, true);
  assert.equal(r.landedIssue, 7);
  assert.equal(r.contractInvalid, undefined);
});

test("R2: a reviser v1 'no-commit' line without reason_text holds for a person; the legacy no-commit trailer is not honoured", async () => {
  const r = await revise('FOREMAN_REVISION no-commit reason=branch already correct\nFOREMAN_RESULT_V1 {"schema":1,"role":"reviser","outcome":"no-commit"}\n');
  assert.equal(r.success, false);
  assert.ok(!r.noCommit);
  assert.match(r.contractInvalid ?? "", /reason_text/);
});

test("reviser, no v1 line: the legacy no-commit trailer still stands", async () => {
  const r = await revise("FOREMAN_REVISION no-commit reason=branch already correct\n");
  assert.equal(r.success, true);
  assert.equal(r.noCommit, true);
});
