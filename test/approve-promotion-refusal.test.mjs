// The Tech Lead's approve-promotion prints `REFUSED: <why>` and then a TECHLEAD_APPROVAL trailer
// (exit 4). The Foreman's stop message must carry the reason, not the trailer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvePromotionViaTechLead } from "../dist/plugins/tech-lead.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };

function fakeTechLead(script) {
  const dir = mkdtempSync(join(tmpdir(), "fake-tl-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "tech-lead.mjs"), script);
  return dir;
}

test("a refused promotion carries the REFUSED reason, not the trailer", async () => {
  process.env.TECHLEAD_GITHUB_KEY ??= "test-key";
  const why = "3 commit(s) reached develop without an approved PR: aaa, bbb, ccc";
  const dir = fakeTechLead(`console.log(${JSON.stringify("REFUSED: " + why)});\n`
    + `console.log("TECHLEAD_APPROVAL pr=#57 kind=promotion verdict=REFUSE");\nprocess.exit(4);\n`);
  const r = await approvePromotionViaTechLead({ githubRepo: "o/r" }, { techLeadPath: dir }, 57, "abc123", logger);
  assert.equal(r.kind, "refused");
  assert.equal(r.reason, why);
});

test("a refusal with no REFUSED line falls back to the last non-trailer line", async () => {
  process.env.TECHLEAD_GITHUB_KEY ??= "test-key";
  const dir = fakeTechLead(`console.log("nope, because");\nconsole.log("TECHLEAD_APPROVAL pr=#5 kind=promotion verdict=REFUSE");\nprocess.exit(4);\n`);
  const r = await approvePromotionViaTechLead({ githubRepo: "o/r" }, { techLeadPath: dir }, 5, "abc123", logger);
  assert.equal(r.reason, "nope, because");
});
