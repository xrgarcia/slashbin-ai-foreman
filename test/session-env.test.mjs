// A Claude session's env is built from an allowlist, never `{ ...process.env }`:
// the production daemon runs under `doppler run`, and on 2026-10-01 a session
// that listed its env printed FOREMAN_GITHUB_TOKEN into its transcript. And what
// a child prints is redacted — including a value split across two chunks.
//
// Drives the BUILT modules. Every token here is a dummy.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SESSION_ENV_ESSENTIALS,
  buildSessionEnv,
  buildTechLeadEnv,
  secretValues,
  redactAll,
  createStreamRedactor,
} from "../dist/agent.js";
import { loadConfig } from "../dist/config.js";

const FOREMAN = "dummyforeman_0123456789abcdef";
const EM = "dummyem_fedcba9876543210";
const labels = { prUnderReview: "a", prPendingActions: "b", prApproved: "c", readyForProd: "d", inProd: "e" };
const opts = (o = {}) => ({ sessionEnv: [], triggerLabel: "approved", lifecycleLabels: labels, ...o });

let saved;
beforeEach(() => {
  saved = { ...process.env };
  process.env.FOREMAN_GITHUB_TOKEN = FOREMAN;
  process.env.EM_GITHUB_TOKEN = EM;
  process.env.TEST_UNLISTED = "unlisted-value";
  process.env.TEST_LISTED = "listed-value";
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

test("buildSessionEnv: each essential crosses when set and is absent when unset", () => {
  for (const name of SESSION_ENV_ESSENTIALS) {
    process.env[name] = "x";
    assert.equal(buildSessionEnv(opts())[name], "x", `${name} set`);
    delete process.env[name];
    assert.equal(name in buildSessionEnv(opts()), false, `${name} unset`);
    if (name in saved) process.env[name] = saved[name];
  }
});

test("buildSessionEnv: only listed names cross; no token but the assigned GH_TOKEN", () => {
  const env = buildSessionEnv(opts({ sessionEnv: ["TEST_LISTED"], ghToken: FOREMAN }));
  assert.equal(env.TEST_LISTED, "listed-value");
  assert.equal("TEST_UNLISTED" in env, false);
  assert.equal("FOREMAN_GITHUB_TOKEN" in env, false);
  assert.equal("EM_GITHUB_TOKEN" in env, false);
  assert.equal(env.GH_TOKEN, FOREMAN);
  assert.equal(env.FOREMAN_TRIGGER_LABEL, "approved");
  assert.deepEqual(JSON.parse(env.FOREMAN_LIFECYCLE_LABELS), labels);
});

test("buildSessionEnv: a listed name the parent sets cannot overwrite the assigned GH_TOKEN", () => {
  process.env.GH_TOKEN = "parent-gh-token-value";
  const env = buildSessionEnv(opts({ sessionEnv: ["GH_TOKEN"], ghToken: EM }));
  assert.equal(env.GH_TOKEN, EM);
});

test("buildSessionEnv: extraEnv names are present", () => {
  const env = buildSessionEnv(opts({ extraEnv: { FOREMAN_STAGE_ID: "lint" } }));
  assert.equal(env.FOREMAN_STAGE_ID, "lint");
});

test("buildTechLeadEnv: EM token and TECH_LEAD_* only — never the Foreman token or GH_TOKEN", () => {
  process.env.TECH_LEAD_MODEL = "m";
  process.env.GH_TOKEN = "parent-gh-token-value";
  const env = buildTechLeadEnv(
    { sessionEnv: ["TEST_LISTED"], emRepoPath: "/em" },
    { triggerLabel: "approved", lifecycleLabels: labels },
  );
  assert.equal(env.EM_GITHUB_TOKEN, EM);
  assert.equal(env.TECH_LEAD_MODEL, "m");
  assert.equal(env.TECH_LEAD_EM_REPO, "/em");
  assert.equal(env.TEST_LISTED, "listed-value");
  assert.equal(env.FOREMAN_TRIGGER_LABEL, "approved");
  for (const n of ["FOREMAN_GITHUB_TOKEN", "GH_TOKEN", "TEST_UNLISTED"]) assert.equal(n in env, false, n);
});

test("loadConfig: sessionEnv may not name a GitHub token; omitted resolves to []", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-session-env-"));
  try {
    const cfg = (extra) => {
      const p = join(dir, "cfg.json");
      writeFileSync(p, JSON.stringify({ repos: [{ name: "r", repoPath: dir, githubRepo: "o/r" }], ...extra }));
      return p;
    };
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "FOREMAN_GITHUB_TOKEN", "EM_GITHUB_TOKEN"]) {
      assert.throws(() => loadConfig(cfg({ sessionEnv: [name] })), new RegExp(`sessionEnv must not name a GitHub token: "${name}"`));
    }
    const omitted = loadConfig(cfg({}));
    assert.deepEqual(omitted.sessionEnv, []);
    assert.deepEqual(omitted.repos[0].sessionEnv, []);
    const listed = loadConfig(cfg({ sessionEnv: ["NPM_TOKEN"] }));
    assert.deepEqual(listed.sessionEnv, ["NPM_TOKEN"]);
    assert.deepEqual(listed.repos[0].sessionEnv, ["NPM_TOKEN"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secretValues: both tokens and listed names, 8+ characters, longest first", () => {
  process.env.TEST_SHORT = "seven77";
  const s = secretValues(["TEST_LISTED", "TEST_SHORT", "TEST_ABSENT"]);
  assert.deepEqual(s.map((x) => x.name).sort(), ["EM_GITHUB_TOKEN", "FOREMAN_GITHUB_TOKEN", "TEST_LISTED"]);
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].value.length >= s[i].value.length);
});

test("redactAll replaces every occurrence with the name", () => {
  const s = secretValues([]);
  assert.equal(redactAll(`a ${FOREMAN} b ${FOREMAN} ${EM}`, s), "a [REDACTED:FOREMAN_GITHUB_TOKEN] b [REDACTED:FOREMAN_GITHUB_TOKEN] [REDACTED:EM_GITHUB_TOKEN]");
});

test("createStreamRedactor: a value split at every offset across two pushes is redacted", () => {
  const secrets = secretValues([]);
  const input = `before ${FOREMAN} middle ${EM} after\nFOREMAN_STAGE pass\n`;
  for (let i = 0; i <= input.length; i++) {
    const r = createStreamRedactor(secrets);
    const out = r.push(input.slice(0, i)) + r.push(input.slice(i)) + r.flush();
    assert.equal(out, redactAll(input, secrets), `split at ${i}`);
    assert.ok(!out.includes(FOREMAN) && !out.includes(EM));
  }
});

test("createStreamRedactor: no secrets passes chunks through and holds nothing", () => {
  const r = createStreamRedactor([]);
  assert.equal(r.push("abc"), "abc");
  assert.equal(r.flush(), "");
});
