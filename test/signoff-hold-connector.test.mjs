// foreman#198: the connector reads the release PR's EM sign-off status live and
// puts the hold on the card: the PR, and the listed issues that lack a sign-off
// label. Nothing is remembered between passes, so a second connector over the
// same GitHub state (a restart) reads the same. A fake `gh` answers from a JSON
// state file; nothing reaches GitHub.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { configureIssueCache } from "../dist/github.js";
import { GitHubIssueConnector } from "../dist/github-work-source.js";
import { setStateDir as setStatePath } from "../dist/state-dir.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
let tmp, state, saved, config;

const RP = "release pending";
const issue = (number, labels) => ({ number, title: `issue ${number}`, labels: labels.map((name) => ({ name })) });
const prBody = "Release\n\n- #802\n- #809\n- #811\n";
const releasePr = { number: 815, url: "https://github.com/example/sig/pull/815", title: "Release", body: prBody, headRefName: "develop", baseRefName: "main", headRefOid: "a".repeat(40) };
const failing = [{ __typename: "StatusContext", context: "foreman/em-sign-off", state: "FAILURE", targetUrl: "https://example/x" }];
const passing = [{ __typename: "StatusContext", context: "foreman/em-sign-off", state: "SUCCESS" }];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-signoff-hold-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  state = join(tmp, "gh-state.json");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const out = (v) => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); };
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
if (a[0] === "issue" && a[1] === "list") out(flag("--state") === "closed" ? [] : st.issues);
if (a[0] === "pr" && a[1] === "list") out(st.prs);
if (a[0] === "pr" && a[1] === "view") { if (st.rollupUnreadable) { process.stderr.write("GraphQL: could not resolve"); process.exit(1); } out({ statusCheckRollup: st.rollup }); }
out("[]");
`);
  chmodSync(join(bin, "gh"), 0o755);
  saved = { PATH: process.env.PATH, FOREMAN_GITHUB_TOKEN: process.env.FOREMAN_GITHUB_TOKEN, cwd: process.cwd() };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  process.chdir(tmp);
  setStatePath(tmp);
  configureIssueCache({ ttlMs: 0 });
  const p = join(tmp, "cfg.json");
  writeFileSync(p, JSON.stringify({ stages: [{ type: "implement" }], repos: [{ name: "sig", repoPath: tmp, githubRepo: "example/sig" }] }));
  config = loadConfig(p).repos[0];
});

after(() => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.FOREMAN_GITHUB_TOKEN === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.FOREMAN_GITHUB_TOKEN;
  rmSync(tmp, { recursive: true, force: true });
});

const put = (st) => writeFileSync(state, JSON.stringify({ issues: [], prs: [], rollup: [], ...st }));
const board = [issue(802, ["approved"]), issue(809, ["approved"]), issue(811, ["ready for prod release"]), issue(820, ["approved"]), issue(830, [RP])];

test("a failing sign-off status holds the card: the PR and the listed unsigned issues, not signed or unrelated ones", async () => {
  put({ issues: board, prs: [releasePr], rollup: failing });
  const cards = await new GitHubIssueConnector().cards(config, logger);
  const held = cards.find((c) => c.item.issueNumber === 830);
  assert.equal(held.stage, "awaitingSignoff");
  assert.deepEqual(held.signoff, { pr: 815, url: releasePr.url, unsigned: [802, 809] }, "#811 is signed and #820 is not in the release");
  const snap = (await new GitHubIssueConnector().snapshot(config, logger)).find((i) => i.item.issueNumber === 830);
  assert.equal(snap.stage, "awaitingSignoff");
  assert.deepEqual(snap.signoff.unsigned, [802, 809]);
});

test("a restarted connector reads the same hold from GitHub: nothing is remembered", async () => {
  put({ issues: board, prs: [releasePr], rollup: failing });
  const a = (await new GitHubIssueConnector().cards(config, logger)).find((c) => c.item.issueNumber === 830);
  const b = (await new GitHubIssueConnector().cards(config, logger)).find((c) => c.item.issueNumber === 830);
  assert.deepEqual(b.signoff, a.signoff);
});

test("a failing status with no unsigned listed issue still holds the card, naming the release PR", async () => {
  put({ issues: [issue(802, ["ready for prod release"]), issue(830, [RP])], prs: [{ ...releasePr, body: "Release\n\n- #802\n" }], rollup: failing });
  const held = (await new GitHubIssueConnector().cards(config, logger)).find((c) => c.item.issueNumber === 830);
  assert.equal(held.stage, "awaitingSignoff");
  assert.deepEqual(held.signoff, { pr: 815, url: releasePr.url, unsigned: [] });
});

test("a passing, absent or unreadable status, or no release PR, leaves the card Releasing", async () => {
  const stageOf = async () => (await new GitHubIssueConnector().cards(config, logger)).find((c) => c.item.issueNumber === 830);
  for (const st of [
    { prs: [releasePr], rollup: passing },
    { prs: [releasePr], rollup: [] },
    { prs: [releasePr], rollup: failing, rollupUnreadable: true },
    { prs: [], rollup: failing },
  ]) {
    put({ issues: board, ...st });
    const c = await stageOf();
    assert.equal(c.stage, "releasing", JSON.stringify(Object.keys(st)));
    assert.equal(c.signoff, undefined);
  }
});

test("an issue that is not release pending is unaffected by a failing status", async () => {
  put({ issues: board, prs: [releasePr], rollup: failing });
  const cards = await new GitHubIssueConnector().cards(config, logger);
  assert.equal(cards.find((c) => c.item.issueNumber === 809).signoff, undefined);
  assert.notEqual(cards.find((c) => c.item.issueNumber === 809).stage, "awaitingSignoff");
});
