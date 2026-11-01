// foreman#151: a child closed in production asks the EM whether its epic is ready
// to close, once per epic and closed issue; the EM's check decides.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStatePath } from "../dist/state.js";
import { tryUnstick } from "../dist/phases/unstick.js";
import { epicRefs, noteEpicChildClosed, UNSTICK_KINDS } from "../dist/unstick.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { slashbinProfile } from "../dist/profiles/slashbin.js";

/** The epic label Slashbin's issues use (`epicRefLabel`, from its profile). */
const LABEL = slashbinProfile.epicRefLabel;

await startAgentPlugins();

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";

test("epic-ready-to-close is an unstick kind, and an epic is read from the References line", () => {
  assert.ok(UNSTICK_KINDS.includes("epic-ready-to-close"));
  assert.deepEqual(epicRefs("## References\n- engineering-manager #880\n- slashbin-engineering-manager #880, engineering-manager #12", LABEL), [880, 12]);
  assert.deepEqual(epicRefs("follow-up to #1538", LABEL), []);
});

test("no epicRefLabel: no epic is parsed from any body", () => {
  assert.deepEqual(epicRefs("## References\n- engineering-manager #880", undefined), []);
  assert.deepEqual(epicRefs("## References\n- tracker #7", "tracker"), [7], "any configured label works");
  assert.deepEqual(epicRefs("see a.b #3 and axb #4", "a.b"), [3], "the label is matched literally, not as a regex");
});

test("two children of one epic: two EM calls, one per close; a repeat close adds none", async () => {
  setStatePath(mkdtempSync(join(tmpdir(), "erc-state-")));
  const em = mkdtempSync(join(tmpdir(), "erc-em-"));
  const log = join(em, "calls.jsonl");
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "bin/em.mjs"), `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log("acted");`);
  const repo = { name: "erc", githubRepo: "o/erc", repoPath: join(em, "no-such-clone"), lifecycleLabels: {} };
  const config = { emRepoPath: em, sessionEnv: [], backoff: { verifyRetry: { maxAttempts: 3 } } };
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  assert.equal(noteEpicChildClosed("erc", "o/erc", 5, [880], LABEL), 1);
  assert.equal(noteEpicChildClosed("erc", "o/erc", 6, [880], LABEL), 1);
  assert.equal(noteEpicChildClosed("erc", "o/erc", 5, [880], LABEL), 0);
  assert.equal(await tryUnstick(repo, config, logger, 1, {}), 2);
  const made = calls();
  assert.equal(made.length, 2);
  for (const argv of made) {
    assert.equal(argv[argv.indexOf("--kind") + 1], "epic-ready-to-close");
    assert.equal(argv[argv.indexOf("--issue") + 1], "0");
  }
  assert.match(made.map((a) => a[a.indexOf("--reason") + 1]).join("\n"), /o\/erc#5 was closed.*engineering-manager #880[\s\S]*o\/erc#6 was closed/);
  assert.equal(await tryUnstick(repo, config, logger, 2, {}), 0);
});
