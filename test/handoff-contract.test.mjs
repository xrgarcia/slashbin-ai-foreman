// The handoff contract every runner sees (EM#614): the reader path reaches the
// Tech Lead and SRE envs, and a builder prompt block is the contract or an
// explicit CONTRACT UNAVAILABLE — never empty, never a throw.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contractBlock, contractReaderPath, CONTRACT_READER_ENV } from "../dist/handoff-contract.js";
import { buildTechLeadEnv, buildSreEnv } from "../dist/agent.js";

const em = mkdtempSync(join(tmpdir(), "em-"));
const reader = join(em, "scripts", "process", "handoff-contract-snapshot.mjs");
mkdirSync(join(em, "scripts", "process"), { recursive: true });

test("the reader path is the EM checkout's snapshot module; none without an absolute checkout", () => {
  assert.equal(contractReaderPath(em), reader);
  assert.equal(contractReaderPath(undefined), undefined);
  assert.equal(contractReaderPath("../relative"), undefined);
});

const repo = { triggerLabel: "approved", lifecycleLabels: {}, github: undefined };
test("Tech Lead and SRE envs carry the reader path when the EM checkout is configured", () => {
  for (const build of [buildTechLeadEnv, buildSreEnv]) {
    assert.equal(build({ emRepoPath: em, sessionEnv: [] }, repo)[CONTRACT_READER_ENV], reader);
    assert.equal(CONTRACT_READER_ENV in build({ sessionEnv: [] }, repo), false);
  }
});

test("a reader that prints the contract is wrapped in the delimiters", () => {
  writeFileSync(reader, "console.log('contract slashbin.handoff-contract revision R');\n");
  const b = contractBlock(reader);
  assert.match(b, /^--- Handoff contract ---\n/);
  assert.match(b, /contract slashbin\.handoff-contract revision R/);
  assert.match(b, /\n--- End handoff contract ---$/);
});

test("the reader's own CONTRACT UNAVAILABLE passes through with its reason", () => {
  writeFileSync(reader, "console.log('CONTRACT UNAVAILABLE: snapshot stale. Do not reconstruct.'); process.exit(1);\n");
  assert.match(contractBlock(reader), /CONTRACT UNAVAILABLE: snapshot stale/);
});

test("no reader, a missing reader, or a crashing reader is CONTRACT UNAVAILABLE, never a throw", () => {
  assert.match(contractBlock(undefined), /CONTRACT UNAVAILABLE: no EM checkout configured/);
  assert.match(contractBlock(join(em, "absent.mjs")), /CONTRACT UNAVAILABLE: contract reader not found/);
  writeFileSync(reader, "throw new Error('boom');\n");
  assert.match(contractBlock(reader), /CONTRACT UNAVAILABLE: contract reader exited 1 with no contract/);
});
