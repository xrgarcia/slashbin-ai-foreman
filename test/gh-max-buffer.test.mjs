// A gh read larger than 1 MiB must not fail. 2026-10-14: the fleet-wide startup
// snapshot outgrew execFileSync's default 1 MiB buffer and every gh call in
// every repo failed as ENOBUFS from the restart on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GH_MAX_BUFFER } from "../dist/github/gh.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("runGh raises the output limit well past the 1 MiB default", () => {
  assert.ok(GH_MAX_BUFFER >= 32 * 1024 * 1024);
  const src = readFileSync(join(root, "src/github/gh.ts"), "utf-8");
  const spawn = src.slice(src.indexOf('execFileSync("gh", args'), src.indexOf("}).trim();"));
  assert.match(spawn, /maxBuffer: GH_MAX_BUFFER/);
});
