// The handoff contract every runner sees (EM#614): the reader path reaches the
// Tech Lead and SRE envs, and a builder prompt block is the contract or an
// explicit CONTRACT UNAVAILABLE — never empty, never a throw.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contractBlock, contractReaderPath, CONTRACT_READER_ENV } from "../dist/handoff-contract.js";
import { buildTechLeadEnv } from "../dist/plugins/tech-lead.js";
import { buildSreEnv } from "../dist/plugins/sre.js";

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

// How the reader is called is the EM client's (tested in the EM repo); a stub client
// beside the reader proves the Foreman delegates to it and only frames the text.
const client = join(em, "scripts", "process", "handoff-contract-client.mjs");

test("the client beside the reader answers, wrapped in the delimiters", () => {
  writeFileSync(client, "export const contractText = (r) => 'contract slashbin.handoff-contract revision R via ' + r.split('/').pop();\n");
  const b = contractBlock(reader);
  assert.match(b, /^--- Handoff contract ---\n/);
  assert.match(b, /contract slashbin\.handoff-contract revision R via handoff-contract-snapshot\.mjs/);
  assert.match(b, /\n--- End handoff contract ---$/);
});

test("no checkout, a relative reader, or no loadable client is CONTRACT UNAVAILABLE, never a throw", () => {
  assert.match(contractBlock(undefined), /CONTRACT UNAVAILABLE: no EM checkout configured/);
  assert.match(contractBlock("relative.mjs"), /CONTRACT UNAVAILABLE: contract reader not found/);
  assert.match(contractBlock(join(tmpdir(), "no-em-here", "reader.mjs")), /CONTRACT UNAVAILABLE: contract client did not load beside/);
  const broken = mkdtempSync(join(tmpdir(), "em-broken-"));
  writeFileSync(join(broken, "handoff-contract-client.mjs"), "throw new Error('boom');\n");
  assert.match(contractBlock(join(broken, "handoff-contract-snapshot.mjs")), /CONTRACT UNAVAILABLE: contract client did not load beside .*boom/);
});
