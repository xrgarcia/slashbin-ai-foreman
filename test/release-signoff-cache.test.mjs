// The sign-off gate's comment read must not repeat every pass for an issue that was never adopted:
// 2026-11-14 it was 2,536 of 3,103 REST calls in an hour. `gh` is a stub on PATH that counts calls.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { ReleaseSignoff, NOT_ADOPTED_TTL_MS } from "../dist/github/release-signoff.js";

const dir = mkTmp("fake-gh-signoff-");
const log = join(dir, "calls");
const mode = join(dir, "mode");
// comments: either an EM-only thread, or one carrying the adoption mark by the Foreman.
writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$2" >> "${log}"
case "$2" in
  */comments*) if [ "$(cat "${mode}")" = carried ]; then echo '{"body":"<!-- foreman:release-carried pr=9 -->","by":"foreman-bot"}'; else echo '{"body":"looks good","by":"em"}'; fi ;;
  */events*) echo '{"label":"ready for prod release","by":"foreman-bot"}' ;;
esac
`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "t-test-token";
const cfg = { githubRepo: "o/r", repoPath: tmpdir(), lifecycleLabels: { readyForProd: "ready for prod release" } };
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const reset = (m) => { writeFileSync(log, ""); writeFileSync(mode, m); };

test("a never-adopted issue reads its comments once, not on every pass", async () => {
  reset("plain");
  const gate = new ReleaseSignoff();
  for (let i = 0; i < 5; i++) assert.equal(await gate.foremanApplied(cfg, 7), false);
  assert.equal(calls().length, 1, `five passes made ${calls().length} gh calls`);
});

test("the never-adopted answer expires and is read again", async (t) => {
  reset("plain");
  const gate = new ReleaseSignoff();
  await gate.foremanApplied(cfg, 7);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + NOT_ADOPTED_TTL_MS + 1);
  await gate.foremanApplied(cfg, 7);
  assert.equal(calls().length, 2);
});

test("an adopted issue the Foreman labeled itself is still re-read and still holds", async () => {
  reset("carried");
  const gate = new ReleaseSignoff();
  assert.equal(await gate.foremanApplied(cfg, 8), true);
  assert.equal(await gate.foremanApplied(cfg, 8), true);
  assert.equal(calls().filter((c) => c.includes("/comments")).length, 2, "the hold is never cached");
});
