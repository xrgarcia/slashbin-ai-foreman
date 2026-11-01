// The README's plugin table names the shipped plugins (EM#1150 f8): every file it
// names exists, and every plugin the composition root registers has a row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const section = readme.split("\n## Plugins\n")[1]?.split("\n## ")[0] ?? "";
const named = [...section.matchAll(/`(src\/[^`]+\.ts|test\/[^`]+\.mjs)`/g)].map((m) => m[1]);

test("the README has a Plugins section naming files", () => {
  assert.ok(named.length > 0, "README.md must have a '## Plugins' section naming src/ files");
});

test("every file the README's Plugins section names exists", () => {
  const missing = [...new Set(named)].filter((f) => !existsSync(join(root, f)));
  assert.deepEqual(missing, []);
});

test("every plugin the composition root imports has a row in the README's Plugins table", () => {
  const index = readFileSync(join(root, "src/plugins/index.ts"), "utf8");
  const files = [...index.matchAll(/^import \{ [A-Z]\w*Plugin \} from "\.\/([^"]+)\.js";/gm)].map((m) => `src/plugins/${m[1]}.ts`);
  assert.ok(files.length >= 6, `expected the six built-in plugins, saw ${files.join(", ")}`);
  const rows = section.split("\n").filter((l) => l.startsWith("| "));
  const unlisted = files.filter((f) => !rows.some((r) => r.includes(`\`${f}\``)));
  assert.deepEqual(unlisted, []);
});
