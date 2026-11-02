// The work-source record store (EM#1244 f1): one JSON record per issue or PR,
// kept as one Foreman comment on the item (GitHub) or in memory.
//
// Three layers, none touching GitHub: the GitHub store over an injected fake gh
// runner (logic: cache, edit in place, no-op saves, other logins); the same
// store reached as production reaches it, through the registered work source and
// a fake `gh` binary first on PATH (the retry in gh()); and the in-memory store.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubRecordStore, RECORD_MARKER, parseRecordBody, recordBody } from "../dist/github/record-store.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { activeWorkSource } from "../dist/plugins/registry.js";
import { startGitHubWorkSource } from "./agent-plugins.mjs";
import { mkTmp } from "./tmp-dir.mjs";

const SELF = "foreman-bot";
const REPO = "example/records";
const issue = (n) => ({ repo: REPO, kind: "issue", number: n });
const pr = (n) => ({ repo: REPO, kind: "pr", number: n });
const cfg = { repoPath: tmpdir(), githubRepo: REPO };

/** A fake gh runner over an in-memory comment board. `fail` decides which calls throw. */
function fakeIo({ fail = () => false } = {}) {
  const calls = [];
  const board = new Map(); // "n" -> [{ id, login, body }]
  let nextId = 100;
  const io = {
    login: () => SELF,
    run(args) {
      calls.push(args);
      const err = fail(args, calls.length);
      if (err) throw new Error(err);
      const url = args.find((a) => a.startsWith("repos/")) ?? "";
      const bodyArg = args.find((a) => a.startsWith("body="))?.slice(5);
      const m = url.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/);
      if (m && !args.includes("-X")) {
        return (board.get(m[1]) ?? []).filter((c) => c.body.startsWith(RECORD_MARKER))
          .map((c) => JSON.stringify(c)).join("\n");
      }
      if (m && args.includes("POST")) {
        const row = { id: nextId++, login: SELF, body: bodyArg };
        board.set(m[1], [...(board.get(m[1]) ?? []), row]);
        return String(row.id);
      }
      const e = url.match(/^repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/);
      if (e && args.includes("PATCH")) {
        for (const rows of board.values()) for (const c of rows) if (c.id === Number(e[1])) c.body = bodyArg;
        return "";
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  };
  return { io, calls, board };
}
const writes = (calls) => calls.filter((a) => a.includes("POST") || a.includes("PATCH"));
const reads = (calls) => calls.filter((a) => a.includes("--paginate"));

test("a saved record is read back by a fresh process from the issue's Foreman comment", async () => {
  const { io, board } = fakeIo();
  const record = { attempts: 2, hold: { reason: "waiting", since: "2026-11-02" }, tags: ["a", "b"] };
  assert.equal(await new GitHubRecordStore(io).saveRecord(issue(7), record, cfg), true);
  const body = board.get("7")[0].body;
  assert.ok(body.startsWith(RECORD_MARKER), "the comment opens with the marker");
  const fresh = new GitHubRecordStore(io); // a new process: empty cache, same board
  assert.deepEqual(await fresh.loadRecord(issue(7), cfg), { status: "found", record });
});

test("an item with no record comment loads as absent", async () => {
  const { io } = fakeIo();
  assert.deepEqual(await new GitHubRecordStore(io).loadRecord(issue(1), cfg), { status: "absent" });
});

test("a second save with a changed value edits the same comment", async () => {
  const { io, calls, board } = fakeIo();
  const store = new GitHubRecordStore(io);
  await store.saveRecord(pr(9), { n: 1 }, cfg);
  await store.saveRecord(pr(9), { n: 2 }, cfg);
  assert.equal(board.get("9").length, 1, "one record comment per item");
  assert.deepEqual(writes(calls).map((a) => a.includes("POST") ? "POST" : "PATCH"), ["POST", "PATCH"]);
  assert.match(writes(calls)[1].find((a) => a.startsWith("repos/")), /^repos\/example\/records\/issues\/comments\/100$/);
  assert.deepEqual(await new GitHubRecordStore(io).loadRecord(pr(9), cfg), { status: "found", record: { n: 2 } });
});

for (const [field, before, after] of [["reason", "old", "changed"], ["attempts", 1, 2]]) {
  test(`a loaded record edited in place (hold.${field}) and saved reaches the comment and a fresh process`, async () => {
    const { io, calls, board } = fakeIo();
    const store = new GitHubRecordStore(io);
    assert.equal(await store.saveRecord(issue(9), { hold: { [field]: before } }, cfg), true);
    const loaded = await store.loadRecord(issue(9), cfg);
    loaded.record.hold[field] = after;
    assert.equal(await store.saveRecord(issue(9), loaded.record, cfg), true);
    assert.equal(writes(calls).length, 2, "the edit must PATCH the comment");
    assert.equal([...board.values()].flat().length, 1, "exactly one record comment");
    const fresh = await new GitHubRecordStore(io).loadRecord(issue(9), cfg);
    assert.deepEqual(fresh.record, { hold: { [field]: after } });
  });
}

test("editing a loaded record without saving changes nothing stored", async () => {
  for (const store of [new GitHubRecordStore(fakeIo().io), new InMemoryRecordStore()]) {
    await store.saveRecord(issue(10), { hold: { reason: "kept" } }, cfg);
    (await store.loadRecord(issue(10), cfg)).record.hold.reason = "mutated";
    assert.deepEqual((await store.loadRecord(issue(10), cfg)).record, { hold: { reason: "kept" } });
  }
});

test("a PR record uses the issues comment endpoint", async () => {
  const { io, calls } = fakeIo();
  await new GitHubRecordStore(io).saveRecord(pr(12), { a: 1 }, cfg);
  assert.ok(writes(calls)[0].includes("repos/example/records/issues/12/comments"));
});

test("a save identical to the stored record makes no gh call", async () => {
  const { io, calls } = fakeIo();
  const first = new GitHubRecordStore(io);
  await first.saveRecord(issue(3), { a: 1, b: { c: 2 } }, cfg);
  const before = calls.length;
  assert.equal(await first.saveRecord(issue(3), { b: { c: 2 }, a: 1 }, cfg), true, "key order does not matter");
  assert.equal(calls.length, before, "identical to the cached record: no call");
  // A fresh process: one read to learn the stored record, then still no write.
  const fresh = new GitHubRecordStore(io);
  assert.equal(await fresh.saveRecord(issue(3), { a: 1, b: { c: 2 } }, cfg), true);
  assert.equal(calls.length, before + 1);
  assert.equal(writes(calls).length, 1);
});

test("reads are one per item per process", async () => {
  const { io, calls } = fakeIo();
  const store = new GitHubRecordStore(io);
  await store.loadRecord(issue(4), cfg);
  await store.loadRecord(issue(4), cfg);
  await store.saveRecord(issue(4), { a: 1 }, cfg);
  await store.loadRecord(issue(4), cfg);
  assert.equal(reads(calls).length, 1);
});

test("gh unreachable: load is unavailable, never an empty record", async () => {
  const { io } = fakeIo({ fail: () => "error connecting to api.github.com" });
  const store = new GitHubRecordStore(io);
  const result = await store.loadRecord(issue(5), cfg);
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /error connecting/);
  assert.equal((await store.loadRecord(issue(5), cfg)).status, "unavailable", "a failed read is not cached as absent");
});

test("an unresolved Foreman login is unavailable, not absent", async () => {
  const { io } = fakeIo();
  const store = new GitHubRecordStore({ ...io, login: () => undefined });
  assert.equal((await store.loadRecord(issue(5), cfg)).status, "unavailable");
  assert.equal(await store.saveRecord(issue(5), { a: 1 }, cfg), false);
});

test("a failed save reports false and leaves the cache unchanged", async () => {
  let breakWrites = false;
  const { io, board } = fakeIo({ fail: (args) => breakWrites && (args.includes("POST") || args.includes("PATCH")) ? "HTTP 502 Bad Gateway" : "" });
  const store = new GitHubRecordStore(io);
  await store.saveRecord(issue(6), { v: 1 }, cfg);
  breakWrites = true;
  assert.equal(await store.saveRecord(issue(6), { v: 2 }, cfg), false);
  assert.deepEqual(await store.loadRecord(issue(6), cfg), { status: "found", record: { v: 1 } });
  breakWrites = false;
  assert.equal(await store.saveRecord(issue(6), { v: 2 }, cfg), true, "the failed value was not cached as stored, so it is written now");
  assert.equal(board.get("6")[0].body, recordBody({ v: 2 }));
});

test("a failed first save leaves the item absent", async () => {
  const { io } = fakeIo({ fail: (args) => args.includes("POST") ? "HTTP 502 Bad Gateway" : "" });
  const store = new GitHubRecordStore(io);
  assert.equal(await store.saveRecord(issue(8), { v: 1 }, cfg), false);
  assert.deepEqual(await store.loadRecord(issue(8), cfg), { status: "absent" });
});

test("a marker comment from another login is ignored", async () => {
  const { io, board } = fakeIo();
  board.set("2", [{ id: 5, login: "someone-else", body: recordBody({ forged: true }) }]);
  const store = new GitHubRecordStore(io);
  assert.deepEqual(await store.loadRecord(issue(2), cfg), { status: "absent" });
  assert.equal(await store.saveRecord(issue(2), { real: true }, cfg), true);
  assert.equal(board.get("2")[0].body, recordBody({ forged: true }), "their comment is untouched");
  assert.deepEqual(await new GitHubRecordStore(io).loadRecord(issue(2), cfg), { status: "found", record: { real: true } });
});

test("a record comment that cannot be parsed is unavailable, not absent", async () => {
  const { io, board } = fakeIo();
  board.set("11", [{ id: 6, login: SELF, body: `${RECORD_MARKER}\nFreeform edit by a human` }]);
  assert.equal((await new GitHubRecordStore(io).loadRecord(issue(11), cfg)).status, "unavailable");
});

test("the body round-trips JSON that would close an HTML comment", () => {
  const record = { text: "a --> b <!-- c -->", n: [1, null, "x"] };
  const body = recordBody(record);
  assert.equal(body.split("\n").length, 3);
  assert.ok(!body.split("\n")[2].slice(0, -4).includes("-->"));
  assert.deepEqual(parseRecordBody(body), record);
});

test("in memory, an issue and a PR with the same number are separate; on GitHub they are one item", async () => {
  const { io } = fakeIo();
  const store = new GitHubRecordStore(io);
  await store.saveRecord(issue(1), { kind: "issue" }, cfg);
  assert.deepEqual(await store.loadRecord(pr(1), cfg), { status: "found", record: { kind: "issue" } }, "GitHub shares one number space");
  const mem = new InMemoryRecordStore();
  await mem.saveRecord(issue(1), { kind: "issue" });
  assert.deepEqual(await mem.loadRecord(pr(1)), { status: "absent" });
});

test("the in-memory store: save, load, copy semantics, absent", async () => {
  const store = new InMemoryRecordStore();
  assert.deepEqual(await store.loadRecord(issue(1)), { status: "absent" });
  const record = { a: [1] };
  assert.equal(await store.saveRecord(issue(1), record), true);
  record.a.push(2);
  const loaded = await store.loadRecord(issue(1));
  assert.deepEqual(loaded, { status: "found", record: { a: [1] } });
  loaded.record.a.push(3);
  assert.deepEqual(await store.loadRecord(issue(1)), { status: "found", record: { a: [1] } });
  assert.deepEqual(await store.loadRecord(pr(1)), { status: "absent" });
  assert.equal(await store.saveRecord(issue(2), [1]), false, "an array is not a record");
});

// ---- through the registered work source and a fake gh binary ----

let bin, state;
before(async () => {
  const dir = mkTmp("foreman-record-store-");
  bin = join(dir, "bin");
  state = join(dir, "state.json");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const S = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
S.log.push(a.join(" "));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(S));
const record = a.some((x) => /issues\\/\\d+\\/comments|issues\\/comments\\//.test(x));
if (record && S.transient > 0) { S.transient--; save(); process.stderr.write("error connecting to api.github.com\\n"); process.exit(1); }
save();
if (a[0] === "api" && a[1] === "user") { process.stdout.write("${SELF}\\n"); process.exit(0); }
const url = a.find((x) => x.startsWith("repos/")) || "";
const body = (a.find((x) => x.startsWith("body=")) || "").slice(5);
let m;
if ((m = url.match(/issues\\/(\\d+)\\/comments/)) && !a.includes("-X")) {
  process.stdout.write((S.board[m[1]] || []).filter((c) => c.body.startsWith("${RECORD_MARKER}")).map((c) => JSON.stringify(c)).join("\\n"));
} else if (m && a.includes("POST")) {
  const row = { id: 500 + S.log.length, login: "${SELF}", body };
  (S.board[m[1]] = S.board[m[1]] || []).push(row); save(); process.stdout.write(String(row.id));
} else if ((m = url.match(/issues\\/comments\\/(\\d+)$/)) && a.includes("PATCH")) {
  for (const rows of Object.values(S.board)) for (const c of rows) if (c.id === Number(m[1])) c.body = body;
  save();
} else { process.stderr.write("unexpected " + a.join(" ") + "\\n"); process.exit(1); }
`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "fake";
  await startGitHubWorkSource();
});
const setState = (s) => writeFileSync(state, JSON.stringify({ log: [], board: {}, transient: 0, ...s }));
const getState = () => JSON.parse(readFileSync(state, "utf8"));

test("the registered work source exposes the store; one transient failure is retried away", async () => {
  setState({ transient: 1 });
  const source = activeWorkSource();
  assert.equal(typeof source.loadRecord, "function");
  assert.equal(typeof source.saveRecord, "function");
  assert.equal(await source.saveRecord(issue(21), { ok: true }, cfg), true, "the caller sees no error");
  assert.ok(getState().log.filter((l) => l.includes("issues/21/comments")).length >= 2, "gh was retried");
  assert.deepEqual(await source.loadRecord(issue(21), cfg), { status: "found", record: { ok: true } });
});

test("through the work source: gh never reachable gives unavailable", async () => {
  setState({ transient: 99 });
  const result = await activeWorkSource().loadRecord(issue(22), cfg);
  assert.equal(result.status, "unavailable");
});
