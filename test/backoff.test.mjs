// The back-off block: one formula, per-key waits, and the config that tunes them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_BACKOFF, BackoffTracker, backoffDelay, backoffEnvName, formatWait } from "../dist/backoff.js";
import { loadConfig } from "../dist/config.js";

test("backoffDelay: base * factor^(n-1), capped; factor 1 is a fixed wait", () => {
  const w = { baseMs: 1_000, capMs: 10_000, factor: 2 };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, w)), [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  assert.equal(backoffDelay(undefined, w), 1_000, "no count reads as the first wait");
  assert.equal(backoffDelay(0, w), 1_000);
  assert.equal(backoffDelay(10_000, w), 10_000, "a huge count never overflows past the cap");
  assert.equal(backoffDelay(7, { baseMs: 5_000, capMs: 60_000, factor: 1 }), 5_000);
  assert.deepEqual([1, 2, 3].map((n) => backoffDelay(n, DEFAULT_BACKOFF.gh)), [1_000, 3_000, 9_000], "gh keeps its 1 s, 3 s steps");
});

test("the defaults are short and grow: no wait starts above 10 minutes", () => {
  for (const [group, v] of Object.entries(DEFAULT_BACKOFF)) {
    if (typeof v !== "object") continue;
    assert.ok(v.baseMs <= 600_000, `${group} starts at ${v.baseMs} ms`);
    assert.ok(v.capMs >= v.baseMs, `${group} cap below its base`);
    assert.ok(v.factor > 1, `${group} does not grow`);
  }
  assert.equal(DEFAULT_BACKOFF.skip.baseMs, 300_000);
  assert.equal(DEFAULT_BACKOFF.verifyRetry.maxAttempts, 3, "the attempt count is unchanged; only the waits are shorter");
  assert.equal(DEFAULT_BACKOFF.repoFailure.maxFailures, 2);
});

test("BackoffTracker: each wait in a row is longer, and a clear starts over", () => {
  const t = new BackoffTracker();
  const w = { baseMs: 100, capMs: 1_000, factor: 2 };
  assert.equal(t.waiting("r", 0), false);
  assert.equal(t.start("r", w, 0), 100);
  assert.equal(t.waiting("r", 99), true);
  assert.equal(t.waiting("r", 100), false);
  assert.equal(t.start("r", w, 100), 200, "the second wait in a row doubles");
  assert.equal(t.count("r"), 2);
  assert.equal(t.waiting("other", 150), false, "keys are independent");
  t.clear("r");
  assert.equal(t.count("r"), 0);
  assert.equal(t.start("r", w, 500), 100, "after a clear the next wait is the base again");
});

test("formatWait and env names", () => {
  assert.equal(formatWait(45_000), "45 s");
  assert.equal(formatWait(300_000), "5 min");
  assert.equal(formatWait(5_400_000), "1.5 h");
  assert.equal(backoffEnvName("verifyRetry", "maxAttempts"), "AI_AGENT_BACKOFF_VERIFY_RETRY_MAX_ATTEMPTS");
  assert.equal(backoffEnvName("stuckMergeGraceMs"), "AI_AGENT_BACKOFF_STUCK_MERGE_GRACE_MS");
});

function load(extra) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-backoff-"));
  const p = join(dir, ".ai-agent.json");
  writeFileSync(p, JSON.stringify({ repos: [{ name: "a", repoPath: dir, githubRepo: "example/a" }], ...extra }));
  try {
    return loadConfig(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("config: no backoff block runs on the defaults, frozen", () => {
  const c = load({});
  assert.deepEqual(c.backoff, DEFAULT_BACKOFF);
  assert.ok(Object.isFrozen(c.backoff) && Object.isFrozen(c.backoff.skip));
});

test("config: a partial block overrides only what it names", () => {
  const c = load({ backoff: { verifyRetry: { baseMs: 60_000, maxAttempts: 5 }, maxCiBounces: 0 } });
  assert.deepEqual(c.backoff.verifyRetry, { ...DEFAULT_BACKOFF.verifyRetry, baseMs: 60_000, maxAttempts: 5 });
  assert.equal(c.backoff.maxCiBounces, 0);
  assert.deepEqual(c.backoff.skip, DEFAULT_BACKOFF.skip);
});

test("config: the old top-level keys still set the new fields, and the block wins over them", () => {
  const old = load({ skipBackoffMs: 1_800_000, upstreamBackoffBaseMs: 60_000, upstreamBackoffCapMs: 600_000 });
  assert.equal(old.backoff.skip.baseMs, 1_800_000);
  assert.deepEqual(old.backoff.upstream, { ...DEFAULT_BACKOFF.upstream, baseMs: 60_000, capMs: 600_000 });
  const both = load({ skipBackoffMs: 1_800_000, backoff: { skip: { baseMs: 120_000 } } });
  assert.equal(both.backoff.skip.baseMs, 120_000);
});

test("config: env beats the file; the new env name beats the old one", () => {
  const c = withEnv({ AI_AGENT_SKIP_BACKOFF_MS: "200000", AI_AGENT_BACKOFF_REPO_FAILURE_MAX_FAILURES: "4" },
    () => load({ backoff: { skip: { baseMs: 120_000 } } }));
  assert.equal(c.backoff.skip.baseMs, 200_000);
  assert.equal(c.backoff.repoFailure.maxFailures, 4);
  const d = withEnv({ AI_AGENT_SKIP_BACKOFF_MS: "200000", AI_AGENT_BACKOFF_SKIP_BASE_MS: "90000" }, () => load({}));
  assert.equal(d.backoff.skip.baseMs, 90_000);
});

test("config: a bad value fails at load, not mid-run", () => {
  assert.throws(() => load({ backoff: { skip: { baseMs: -1 } } }));
  assert.throws(() => load({ backoff: { gh: { factor: 0.5 } } }));
  assert.throws(() => load({ backoff: "fast" }));
});
