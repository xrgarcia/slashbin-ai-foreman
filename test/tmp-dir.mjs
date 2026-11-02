// Temp directories for tests that are removed when the test process exits.
// `node --test` runs each test file in its own process, so the dirs live for
// the whole file and never outlive it, even when a test throws.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = new Set();
let hooked = false;

export function mkTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const d of made) rmSync(d, { recursive: true, force: true });
    });
  }
  return dir;
}
