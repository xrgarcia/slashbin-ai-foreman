// The Paperclip mirror delegates to five collaborators (EM#1267 feature 4): the
// card index, placement, the session lease, snapshot sync and thread notes.
// Each owns one job and its state; the mirror builds them and wires them with
// ports (src/paperclip/ports.ts). A collaborator that imports another is a
// hidden coupling that puts the five back into one class, so none may: they
// share only steps.ts, env.ts, ports.ts and the modules outside the mirror.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "paperclip");
const COLLABORATORS = ["card-index", "placement", "lease", "snapshot-sync", "thread-notes"];
// Every module specifier a file imports or re-exports from, type-only ones included.
const specifiersOf = (name) =>
  [...readFileSync(join(dir, `${name}.ts`), "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]);
const lineCount = (name) => readFileSync(join(dir, `${name}.ts`), "utf8").split("\n").length;

for (const name of COLLABORATORS) {
  test(`${name} imports no other collaborator, nor the mirror`, () => {
    const forbidden = [...COLLABORATORS.filter((c) => c !== name), "mirror"].map((c) => `./${c}.js`);
    const found = specifiersOf(name).filter((s) => forbidden.includes(s));
    assert.deepEqual(found, [], `${name}.ts imports ${found.join(", ")}; take what it needs through a port in ports.ts instead`);
  });
}

test("the shared modules import no collaborator", () => {
  for (const shared of ["steps", "env", "ports"]) {
    const found = specifiersOf(shared).filter((s) => COLLABORATORS.some((c) => s === `./${c}.js`) || s === "./mirror.js");
    assert.deepEqual(found, [], `${shared}.ts imports ${found.join(", ")}`);
  }
});

test("the mirror is the observer facade, and no collaborator outgrows 600 lines", () => {
  assert.ok(lineCount("mirror") < 600, `mirror.ts is ${lineCount("mirror")} lines`);
  for (const name of COLLABORATORS) assert.ok(lineCount(name) <= 600, `${name}.ts is ${lineCount(name)} lines`);
});
