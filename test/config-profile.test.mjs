// Config profiles (EM#1150 f7): Slashbin's defaults live in src/profiles/slashbin.ts, chosen
// with `"profile": "slashbin"`. Neutral default < profile < explicit file value; an unknown
// profile is a startup error; and Slashbin's names appear nowhere else in src/.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { PROFILES, profileNamed, applyProfile } from "../dist/profiles/index.js";

let tmp;
const savedEnv = {};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-config-profile-"));
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
  const config = {
    repos: [{ name: "app", repoPath: tmp, githubRepo: "acme/app", skillPath: "builtin:", revisionSkillPath: "builtin:" }],
    ...extra,
  };
  writeFileSync(path, JSON.stringify(config));
  return loadConfig(path);
}

const BASE_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch"];

// (a) The values the core carried before this change, written out so the profile can't drift.
test("the slashbin profile resolves to exactly the values the core used to hard-code", () => {
  const c = load({ profile: "slashbin" });
  assert.equal(c.profile, "slashbin");
  assert.equal(c.unstickEscalationOwner, "xrgarcia");
  assert.deepEqual(c.qaRepos, ["xrgarcia/Slashbin-console"]);
  assert.equal(c.qaSecretsRunner, "scripts/secrets/doppler-run.mjs");
  assert.equal(c.divergenceRulerLogin, "slashbin-engineering-manager");
  assert.equal(c.epicRefLabel, "engineering-manager");
  assert.equal(c.paperclip.commentAuthorHeader, "x-slashbin-comment-author");
  assert.equal(c.paperclip.enabled, false, "the profile's paperclip block does not turn the board on");
  assert.deepEqual(c.reviewAllowedTools, [
    ...BASE_TOOLS,
    "mcp__github__*",
    "mcp__pg-dev-console__*", "mcp__pg-dev-worker__*", "mcp__pg-prod-console__*", "mcp__pg-prod-worker__*",
    "mcp__redis-dev-console__*", "mcp__redis-dev-ingest__*", "mcp__redis-dev-worker__*",
    "mcp__redis-prod-console__*", "mcp__redis-prod-ingest__*", "mcp__redis-prod-worker__*",
    "mcp__railway__*", "mcp__slashbin-ai-knowledge__*",
  ]);
  // Each repo carries the globals the phases read off repoConfig.
  assert.equal(c.repos[0].divergenceRulerLogin, "slashbin-engineering-manager");
  assert.equal(c.repos[0].epicRefLabel, "engineering-manager");
});

// (b) Neutral: nothing operator-specific. Each path's clean degradation is tested where it
// lives: unstick-giveup (no owner), epic-ready-to-close and release-stage (no label),
// divergence-repair (no ruler), paperclip-config-client (no header).
test("no profile gives the neutral defaults", () => {
  const c = load({});
  assert.equal(c.profile, undefined);
  assert.equal(c.unstickEscalationOwner, undefined);
  assert.deepEqual(c.qaRepos, []);
  assert.equal(c.qaSecretsRunner, undefined);
  assert.equal(c.divergenceRulerLogin, undefined);
  assert.equal(c.epicRefLabel, undefined);
  assert.equal(c.paperclip.commentAuthorHeader, undefined);
  assert.deepEqual(c.reviewAllowedTools, BASE_TOOLS);
  assert.equal(c.repos[0].divergenceRulerLogin, undefined);
  assert.equal(c.repos[0].epicRefLabel, undefined);
});

// (c)
test("an explicit file value beats the profile, and a nested block merges key by key", () => {
  const c = load({
    profile: "slashbin",
    unstickEscalationOwner: "someone-else",
    qaRepos: [],
    epicRefLabel: "my-em",
    paperclip: { url: "http://127.0.0.1:9999" },
  });
  assert.equal(c.unstickEscalationOwner, "someone-else");
  assert.deepEqual(c.qaRepos, []);
  assert.equal(c.epicRefLabel, "my-em");
  assert.equal(c.repos[0].epicRefLabel, "my-em");
  assert.equal(c.paperclip.url, "http://127.0.0.1:9999");
  assert.equal(c.paperclip.commentAuthorHeader, "x-slashbin-comment-author", "an unset nested key still takes the profile's");
  assert.equal(c.divergenceRulerLogin, "slashbin-engineering-manager", "an unset key still takes the profile's");

  const overridden = load({ profile: "slashbin", paperclip: { commentAuthorHeader: "x-other" } });
  assert.equal(overridden.paperclip.commentAuthorHeader, "x-other");
});

test("an env value still beats both the profile and the file", () => {
  process.env.AI_AGENT_UNSTICK_ESCALATION_OWNER = "from-env";
  try {
    assert.equal(load({ profile: "slashbin", unstickEscalationOwner: "from-file" }).unstickEscalationOwner, "from-env");
  } finally {
    delete process.env.AI_AGENT_UNSTICK_ESCALATION_OWNER;
  }
});

// (d)
test("an unknown profile is a startup error that names the valid profiles", () => {
  assert.throws(() => load({ profile: "nope" }), /Unknown config profile "nope"\. Valid profiles: slashbin\./);
  assert.throws(() => profileNamed("toString"), /Unknown config profile "toString"/, "an inherited Object key is not a profile");
  assert.deepEqual(Object.keys(PROFILES), ["slashbin"]);
});

test("applyProfile copies the profile's arrays and blocks, so a config never aliases the profile", () => {
  const out = applyProfile({}, profileNamed("slashbin"));
  out.qaRepos.push("x/y");
  out.paperclip.commentAuthorHeader = "changed";
  assert.deepEqual(profileNamed("slashbin").qaRepos, ["xrgarcia/Slashbin-console"]);
  assert.equal(profileNamed("slashbin").paperclip.commentAuthorHeader, "x-slashbin-comment-author");
});

// The ratchet: Slashbin's names may live only in src/profiles/. Comments count, so a
// deployment's names can't creep back in through prose.
test("Slashbin's names appear in src/ only under src/profiles/", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const banned = ["xrgarcia", "slashbin-engineering-manager", "x-slashbin-comment-author", "engineering-manager #"];
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (relative(src, p) !== "profiles") walk(p); continue; }
      const lines = readFileSync(p, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const word of banned) if (line.includes(word)) hits.push(`${relative(src, p)}:${i + 1}: ${word}`);
      });
    }
  };
  walk(src);
  assert.deepEqual(hits, [], `move these into src/profiles/:\n${hits.join("\n")}`);
});
