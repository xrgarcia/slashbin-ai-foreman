// Runner refusals are config, not code (src/refusal.ts): Claude's are the
// defaults; any other CLI is a `runner` block. Run with `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { detectRefusal, parseReset, runnerConfigSchema, DEFAULT_RUNNER, configureRunner, runnerName, CLAUDE_REFUSAL_PATTERNS } from "../dist/refusal.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");

test("defaults are Claude's: name, the 429 result and the limit banner", () => {
  assert.equal(DEFAULT_RUNNER.name, "Claude");
  assert.deepEqual([...DEFAULT_RUNNER.refusalPatterns], [...CLAUDE_REFUSAL_PATTERNS]);
  const hit = detectRefusal({ stdout: "You've hit your session limit · resets 9am (America/Chicago)\n" }, DEFAULT_RUNNER, NOW);
  assert.match(hit.reason, /hit your session limit/);
  assert.ok(hit.resetAtMs > NOW);
  assert.equal(detectRefusal({ stdout: "Implemented #12. We are near the session limit." }, DEFAULT_RUNNER, NOW), undefined);
});

test("another runner is config alone: its own patterns, exit codes and ISO reset", () => {
  const codex = runnerConfigSchema.parse({
    name: "Codex",
    refusalPatterns: [String.raw`\brate_limit_exceeded\b`],
    refusalExitCodes: [75],
    resetPattern: String.raw`retry after (?<iso>\S+Z)`,
  });
  const line = JSON.stringify({ error: "rate_limit_exceeded: retry after 2026-11-05T13:00:00Z" });
  const hit = detectRefusal({ stdout: `{"type":"start"}\n${line}\n` }, codex, NOW);
  assert.equal(hit.reason, "rate_limit_exceeded: retry after 2026-11-05T13:00:00Z", "the JSON line's own message");
  assert.equal(hit.resetAtMs, Date.parse("2026-11-05T13:00:00Z"));
  assert.deepEqual(detectRefusal({ stdout: "", exitCode: 75 }, codex, NOW), { reason: "exit 75", resetAtMs: undefined });
  assert.equal(detectRefusal({ stdout: "You've hit your session limit" }, codex, NOW), undefined, "Claude's banner is not Codex's refusal");
  assert.equal(detectRefusal({ stdout: "", stderr: "x", exitCode: 1 }, codex, NOW), undefined);
});

test("stderr is read too, and only the tail of each stream", () => {
  assert.ok(detectRefusal({ stdout: "", stderr: "You've hit your usage limit" }, DEFAULT_RUNNER, NOW));
  const buried = "You've hit your usage limit\n" + "x".repeat(20_000);
  assert.equal(detectRefusal({ stdout: buried }, DEFAULT_RUNNER, NOW), undefined, "a refusal is the run's last word");
});

test("a bad pattern fails at config load, not when a refusal needs recognising", () => {
  assert.throws(() => runnerConfigSchema.parse({ refusalPatterns: ["(unclosed"] }));
});

test("parseReset: past or unparseable resets are undefined", () => {
  assert.equal(parseReset("retry after 2020-01-01T00:00:00Z", String.raw`retry after (?<iso>\S+)`, NOW), undefined);
  assert.equal(parseReset("nothing", String.raw`retry after (?<iso>\S+)`, NOW), undefined);
  assert.equal(parseReset("x", "(bad", NOW), undefined);
});

test("configureRunner names the runner daemon-wide", () => {
  try {
    configureRunner(runnerConfigSchema.parse({ name: "Codex" }));
    assert.equal(runnerName(), "Codex");
  } finally {
    configureRunner(DEFAULT_RUNNER);
  }
});

