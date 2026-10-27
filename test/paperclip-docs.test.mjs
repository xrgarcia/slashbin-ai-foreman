// docs/paperclip.md is generated from the built config schema and the mirror's
// step table; a change to either that is not regenerated fails here (npm test
// builds first, so this checks against the current source).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("docs/paperclip.md matches what the generator writes", () => {
  const r = spawnSync(process.execPath, [join(root, "scripts", "docs", "generate-paperclip.mjs"), "--check"], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
