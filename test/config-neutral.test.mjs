// The core ships neutral: a deployment's own values (logins, repo names, MCP tool lists,
// header names) come only from its git-ignored .ai-agent.json. The built-in `profile`
// bundle was removed when the code went public; a config still naming one must stop
// startup rather than silently lose the values it supplied.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";

let tmp;
const savedEnv = {};
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-config-neutral-"));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AI_AGENT_")) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  }
});
after(() => {
  Object.assign(process.env, savedEnv);
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function load(extra) {
  const path = join(tmp, `cfg-${n++}.json`);
  writeFileSync(path, JSON.stringify({
    repos: [{ name: "app", repoPath: tmp, githubRepo: "acme/app", skillPath: "builtin:", revisionSkillPath: "builtin:" }],
    ...extra,
  }));
  return loadConfig(path);
}

test("an empty config gives the neutral defaults", () => {
  const c = load({});
  assert.equal(c.unstickEscalationOwner, undefined);
  assert.deepEqual(c.qaRepos, []);
  assert.equal(c.qaSecretsRunner, undefined);
  assert.equal(c.epicRefLabel, undefined);
  assert.equal(c.paperclip.commentAuthorHeader, undefined);
  assert.deepEqual(c.reviewAllowedTools, ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch"]);
  assert.equal(c.repos[0].epicRefLabel, undefined);
});

test("a deployment's values come from the file, and env still wins", () => {
  const c = load({ unstickEscalationOwner: "op", qaRepos: ["acme/web"], epicRefLabel: "em", paperclip: { commentAuthorHeader: "x-h" } });
  assert.equal(c.unstickEscalationOwner, "op");
  assert.deepEqual(c.qaRepos, ["acme/web"]);
  assert.equal(c.repos[0].epicRefLabel, "em");
  assert.equal(c.paperclip.commentAuthorHeader, "x-h");
  process.env.AI_AGENT_UNSTICK_ESCALATION_OWNER = "from-env";
  try { assert.equal(load({ unstickEscalationOwner: "op" }).unstickEscalationOwner, "from-env"); }
  finally { delete process.env.AI_AGENT_UNSTICK_ESCALATION_OWNER; }
});

test("a leftover `profile` key stops startup and names the keys to set instead", () => {
  assert.throws(() => load({ profile: "anything" }), /"profile" was removed: set its keys \(unstickEscalationOwner/);
});
