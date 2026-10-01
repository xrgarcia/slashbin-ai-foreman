// The builder MCP config: server names come out of it (never values), a missing
// or broken file leaves the builder exactly as it was, and the config path is
// resolved for every repo. Run with `npm test` after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mcpServerNames } from "../dist/agent.js";

const quiet = { warn() {}, info() {}, debug() {}, error() {}, child() { return quiet; } };
const dir = mkdtempSync(join(tmpdir(), "builder-mcp-"));

test("server names are read from mcpServers", () => {
  const p = join(dir, "ok.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { "pg-dev-console": { headers: { Authorization: "Bearer x" } }, "redis-dev-worker": {} } }));
  assert.deepEqual(mcpServerNames(p, quiet), ["pg-dev-console", "redis-dev-worker"]);
});

test("a missing file means no MCP servers — the builder runs as before", () => {
  assert.deepEqual(mcpServerNames(join(dir, "absent.json"), quiet), []);
});

test("an unreadable file means no MCP servers", () => {
  const p = join(dir, "bad.json");
  writeFileSync(p, "{not json");
  assert.deepEqual(mcpServerNames(p, quiet), []);
});

test("a name that is not a plain identifier is never turned into a tool pattern", () => {
  const p = join(dir, "odd.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { "ok-one": {}, "*": {}, "a,b": {} } }));
  assert.deepEqual(mcpServerNames(p, quiet), ["ok-one"]);
});
