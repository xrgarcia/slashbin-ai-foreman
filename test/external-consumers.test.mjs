// Exports another repo imports from this build. The EM's 5-minute Paperclip
// sync (slashbin-engineering-manager scripts/paperclip-sync.mjs, via
// scripts/paperclip-board.mjs) places rows through these; 6d64dfc moved
// issueStage out of paperclip/board.js and the sync threw on every run from
// 2026-10-10 16:50 until 18:56. Removing or moving one is a change to that repo too.
import { test } from "node:test";
import assert from "node:assert/strict";

const CONSUMED = {
  "../dist/paperclip/board.js": ["statusName", "withStage", "stageTarget", "liveRows", "ensureStageLabels", "FOREMAN_BLOCKED_PREFIX"],
  "../dist/github-work-source.js": ["issueStage", "SOURCE_BLOCKED_LABEL"],
  "../dist/paperclip/client.js": ["PaperclipClient"],
  "../dist/config.js": ["loadConfig"],
};

for (const [path, names] of Object.entries(CONSUMED)) {
  test(`${path.replace("../dist/", "")} keeps what the EM's Paperclip sync imports`, async () => {
    const mod = await import(path);
    for (const n of names) assert.notEqual(mod[n], undefined, `${n} is imported by the EM's Paperclip sync`);
  });
}
