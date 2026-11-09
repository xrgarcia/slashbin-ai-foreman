// The endless-loops guard: no step runs twice on the same input (src/step-attempts.ts).
//
// Every stage in src/stages.ts declares, in STEP_INPUTS, the input it acts on and where the rule "unchanged
// input, no rerun" is enforced. A stage added without a declaration fails here, as does a declaration whose
// guard has gone, so a new repeating phase cannot ship without saying what bounds it. Also holds the attempt
// ledger itself: the 4th admission on one input is held, a new input or a later ruling starts again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_STAGES } from "../dist/stages.js";
import { UNSTICK_KINDS } from "../dist/unstick.js";
import { STEP_INPUTS, InputAttempts, MAX_REVIEW_ATTEMPTS_PER_HEAD, attemptsOn } from "../dist/step-attempts.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stages = [...BUILTIN_STAGES];

test("every stage declares the input it acts on, and nothing else is declared", () => {
  assert.ok(stages.length > 0);
  assert.deepEqual(Object.keys(STEP_INPUTS).sort(), [...stages].sort(), "STEP_INPUTS and src/stages.ts name the same stages");
});

for (const stage of stages) {
  test(`${stage}: its declaration is complete and its guard exists`, () => {
    const step = STEP_INPUTS[stage];
    assert.ok(step, `${stage} is declared`);
    if (!step.repeats) {
      assert.ok(step.why.length > 10, "a one-shot step says why it cannot run twice on one input");
      return;
    }
    assert.ok(step.input.length > 5, "a repeating step names its input");
    assert.ok(step.cap === "state" || (Number.isInteger(step.cap) && step.cap > 0), "its cap is finite, or the state itself moves");
    if (step.cap !== "state") assert.ok(UNSTICK_KINDS.includes(step.hold), `a capped step ends in a hold with a named owner (${step.hold})`);
    else assert.ok(step.hold === null || UNSTICK_KINDS.includes(step.hold));
    const file = join(root, step.guard.file);
    assert.ok(existsSync(file), `${step.guard.file} exists`);
    assert.ok(readFileSync(file, "utf8").includes(step.guard.symbol), `${step.guard.file} still contains ${step.guard.symbol}`);
  });
}

test("the review cap is the one the review phase admits with", () => {
  assert.equal(STEP_INPUTS.review.cap, MAX_REVIEW_ATTEMPTS_PER_HEAD);
  const phase = readFileSync(join(root, "src/phases/review.ts"), "utf8");
  assert.match(phase, /rt\.attempts\.admit\([^;]*MAX_REVIEW_ATTEMPTS_PER_HEAD/);
});

// --- the ledger ---------------------------------------------------------------

const repo = { githubRepo: "example/r" };
function store({ broken = false } = {}) {
  const prs = new Map();
  return {
    loadPrRecord: async (_rc, n) => (broken ? null : structuredClone(prs.get(n) ?? {})),
    updatePrRecord: async (_rc, n, change) => {
      if (broken) return false;
      const d = structuredClone(prs.get(n) ?? {});
      change(d);
      prs.set(n, d);
      return true;
    },
  };
}

test("the 4th admission on one head is held; the first hold says so, the rest do not", async () => {
  const a = new InputAttempts(store());
  for (let i = 1; i <= MAX_REVIEW_ATTEMPTS_PER_HEAD; i++) assert.deepEqual(await a.admit(repo, 7, "review", "sha1", MAX_REVIEW_ATTEMPTS_PER_HEAD), { status: "admitted", count: i });
  const first = await a.admit(repo, 7, "review", "sha1", MAX_REVIEW_ATTEMPTS_PER_HEAD);
  assert.equal(first.status, "held");
  assert.equal(first.first, true);
  const again = await a.admit(repo, 7, "review", "sha1", MAX_REVIEW_ATTEMPTS_PER_HEAD);
  assert.equal(again.status, "held");
  assert.equal(again.first, false);
});

test("a new head starts the count again", async () => {
  const a = new InputAttempts(store());
  for (let i = 0; i < 4; i++) await a.admit(repo, 7, "review", "sha1", 3);
  assert.deepEqual(await a.admit(repo, 7, "review", "sha2", 3), { status: "admitted", count: 1 });
});

test("a ruling posted after the last attempt releases the hold; one posted before does not", async () => {
  const a = new InputAttempts(store());
  for (let i = 0; i < 3; i++) await a.admit(repo, 7, "review", "sha1", 3);
  assert.equal((await a.admit(repo, 7, "review", "sha1", 3, async () => false)).status, "held");
  assert.deepEqual(await a.admit(repo, 7, "review", "sha1", 3, async () => true), { status: "admitted", count: 1 });
});

test("a refunded attempt is not spent", async () => {
  const a = new InputAttempts(store());
  for (let i = 0; i < 3; i++) { await a.admit(repo, 7, "review", "sha1", 3); await a.refund(repo, 7, "review", "sha1"); }
  assert.deepEqual(await a.admit(repo, 7, "review", "sha1", 3), { status: "admitted", count: 1 });
});

test("a record that cannot be read or saved admits nothing (fail closed)", async () => {
  const a = new InputAttempts(store({ broken: true }));
  assert.deepEqual(await a.admit(repo, 7, "review", "sha1", 3), { status: "unavailable" });
});

test("attemptsOn is zero for a different input", () => {
  assert.equal(attemptsOn({ input: "a", count: 2, at: "t" }, "b"), 0);
  assert.equal(attemptsOn({ input: "a", count: 2, at: "t" }, "a"), 2);
  assert.equal(attemptsOn(undefined, "a"), 0);
});
