// A plugin command's large stdout survives a pipe (exitAfterFlush, 2026-11-15:
// metrics:runs --json was cut at 65,536 bytes when piped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = join(here, "..", "dist", "exit-after-flush.js");

function runChild(body) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", body], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    // Read slowly, so the child's writes back up in the pipe as they do behind a busy reader.
    child.stdout.on("data", (d) => { out += d; child.stdout.pause(); setTimeout(() => child.stdout.resume(), 5); });
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("exitAfterFlush delivers every byte of a 512 KB write to a pipe, then exits with the code", async () => {
  const { code, out } = await runChild(
    `import { exitAfterFlush } from ${JSON.stringify(mod)};\n` +
    `console.log(JSON.stringify({ rows: "x".repeat(512 * 1024) }));\n` +
    `await exitAfterFlush(3);`,
  );
  assert.equal(code, 3);
  assert.equal(JSON.parse(out).rows.length, 512 * 1024);
});

test("cli.ts ends a plugin command through exitAfterFlush, never a bare process.exit", () => {
  const cli = readFileSync(join(here, "..", "src", "cli.ts"), "utf8");
  assert.match(cli, /const allPassed = await command\(doctorConfig\);\s*await exitAfterFlush\(allPassed \? 0 : 1\);/);
});
