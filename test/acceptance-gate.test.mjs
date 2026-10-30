// An approved issue with no committed acceptance script (or a real No-Script reason) is held, not built.
// EM#99 / jerky_service#200. Verdicts are checked against the shared corpus, vendored from the EM repo.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { acceptanceVerdict } from "../dist/github/acceptance-gate.js";
import { loadConfig } from "../dist/config.js";
import { configureIssueCache } from "../dist/github.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
// Vendored from slashbin-engineering-manager scripts/foreman/acceptance-gate-cases.json; the EM's
// approved_gate_hook.py is tested against the same file, so the two enforcers agree.
const corpus = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "acceptance-gate-cases.json"), "utf8"));

test("the shared corpus: every case gets the verdict the EM hook gives", () => {
  assert.equal(corpus.cases.length, 9);
  for (const c of corpus.cases) assert.equal(acceptanceVerdict(c.body).ok, c.ok, c.id);
});

test("a hold reason names the heading and the fix, and never echoes the body", () => {
  for (const c of corpus.cases.filter((x) => !x.ok)) {
    const { reason } = acceptanceVerdict(c.body);
    assert.match(reason, /## Acceptance/, c.id);
    assert.match(reason, /Script|No-Script/, c.id);
    assert.ok(!reason.includes(c.body.split("\n")[0] + "\n\n"), c.id);
  }
});

// ---- through the built connector ----

let tmp, saved;
const stateFile = () => join(tmp, "state.json");
const fileState = () => JSON.parse(readFileSync(stateFile(), "utf8"));
const setState = (patch) => writeFileSync(stateFile(), JSON.stringify({ ...(existsSync(stateFile()) ? fileState() : {}), ...patch }));
const posted = () => fileState().comments.filter((c) => c.posted);

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-acceptance-test-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const S = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile())}, "utf8"));
const a = process.argv.slice(2);
const out = (x) => process.stdout.write(typeof x === "string" ? x : JSON.stringify(x));
if (a[0] === "issue" && a[1] === "list") out(S.board);
else if (a[0] === "issue" && a[1] === "comment") {
  S.comments.push({ body: a[a.indexOf("--body") + 1], author: { login: "foreman-bot" }, posted: true });
  fs.writeFileSync(${JSON.stringify(stateFile())}, JSON.stringify(S));
}
else if (a[0] === "api" && a[1] === "user") out("foreman-bot");
else if (a[0] === "api" && a[1] === "graphql") {
  const q = a[a.indexOf("-f") + 1];
  const all = q.includes("timelineItems") ? S.labeled : S.comments;
  const field = q.includes("timelineItems") ? "timelineItems" : "comments";
  out({ data: { repository: { issue: { [field]: { pageInfo: { hasPreviousPage: false, startCursor: "0" }, nodes: all } } } } });
}
else if (a[0] === "api" && /\\/dependencies\\/blocked_by$/.test(a[1])) out("[]");
else if (a[0] === "api" && /^repos\\/example\\/repo\\/issues\\/\\d+$/.test(a[1])) out(S.body);
else if (a[0] === "api" && a[1].startsWith("repos/o/m/contents/")) { if (S.fileOnMain) out("sha"); else { process.stderr.write("gh: Not Found (HTTP 404)"); process.exit(1); } }
else out("[]");
`);
  chmodSync(join(bin, "gh"), 0o755);
  saved = { PATH: process.env.PATH, token: process.env.FOREMAN_GITHUB_TOKEN };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
  configureIssueCache({ ttlMs: 0 });
});

after(() => {
  process.env.PATH = saved.PATH;
  if (saved.token === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.token;
  rmSync(tmp, { recursive: true, force: true });
});

const caseBody = (id) => corpus.cases.find((c) => c.id === id).body;
const GOOD = caseBody("A1-named-script");
const READINESS = (acceptance) => `## Pre-Flight\n\`\`\`readiness\nfile_at_ref: o/m a/b.md main\n\`\`\`\n\n${acceptance}`;

function reset(body, labels = ["approved"]) {
  rmSync(stateFile(), { force: true });
  setState({
    board: [{ number: 7, title: "seven", labels: labels.map((name) => ({ name })) }],
    body, comments: [], fileOnMain: false,
    labeled: [{ label: { name: "approved" }, actor: { login: "ray" } }],
  });
}

async function connector(restart) {
  const { GitHubIssueConnector } = await import(`../dist/github-work-source.js?acc=${restart}`);
  return new GitHubIssueConnector();
}
const eligible = async (c) => {
  const p = join(tmp, "cfg.json");
  writeFileSync(p, JSON.stringify({ stages: [{ type: "implement" }], repos: [{ name: "ws", repoPath: tmp, githubRepo: "example/repo" }] }));
  return (await c.selectEligible(loadConfig(p).repos[0], logger)).map((w) => w.issueNumber);
};

test("an issue with no acceptance is held with one comment; fixing the body makes it eligible on its own", async () => {
  reset(caseBody("H3-section-without-script-or-no-script"));
  const c = await connector("a");
  assert.deepEqual(await eligible(c), []);
  assert.deepEqual(await eligible(c), []);
  assert.equal(posted().length, 1, "one comment across cycles");
  assert.match(posted()[0].body, /<!-- foreman:readiness-hold acceptance:\S+ -->/);
  assert.match(posted()[0].body, /## Acceptance/);
  assert.match(posted()[0].body, /@ray/);
  await eligible(await connector("a-restarted"));
  assert.equal(posted().length, 1, "none after a restart");
  setState({ body: GOOD });
  assert.deepEqual(await eligible(c), [7]);
  assert.deepEqual(fileState().board[0].labels, [{ name: "approved" }], "label untouched");
});

test("an issue with an acceptance script is eligible and gets no comment", async () => {
  reset(GOOD);
  assert.deepEqual(await eligible(await connector("b")), [7]);
  assert.equal(posted().length, 0);
});

test("a lifecycle-labelled issue is out of scope: no verdict, no comment", async () => {
  reset(caseBody("H1-no-section"), ["approved", "pr under review"]);
  assert.deepEqual(await eligible(await connector("c")), []);
  assert.equal(posted().length, 0);
});

test("readiness and acceptance holds are keyed separately: each is announced, neither suppresses the other", async () => {
  const noAcc = caseBody("H1-no-section");
  reset(READINESS(noAcc));
  const c = await connector("d");
  assert.deepEqual(await eligible(c), []);
  assert.equal(posted().length, 1);
  assert.doesNotMatch(posted()[0].body, /acceptance:/, "readiness comment first");
  setState({ fileOnMain: true });   // readiness now met; acceptance still missing
  assert.deepEqual(await eligible(c), []);
  assert.equal(posted().length, 2, "acceptance announced after readiness");
  assert.match(posted()[1].body, /acceptance:/);
  await eligible(c);
  await eligible(await connector("d-restarted"));
  assert.equal(posted().length, 2, "no repeats");
  setState({ fileOnMain: false });  // readiness unmet again, same reason as the first comment
  await eligible(await connector("d-restarted-2"));
  assert.equal(posted().length, 2, "the older readiness comment still dedupes behind the acceptance one");
});

// ---- the board: the hold reaches the cycle's waiting set (Tech Lead S2, R1/R2) ----

test("the hold comment tells a non-engineer that the EM will add the acceptance material", async () => {
  reset(caseBody("H3-section-without-script-or-no-script"));
  await eligible(await connector("s3"));
  assert.match(posted()[0].body, /Engineering Manager \(EM\) will add the missing acceptance material/);
});

async function cycleWaiting(restart) {
  const { registerWorkSource, addObserver, drainObservers } = await import("../dist/work-source.js");
  const { tryBatchImplementation } = await import("../dist/phases/implement.js");
  const p = join(tmp, "cfg.json");
  writeFileSync(p, JSON.stringify({ stages: [{ type: "implement" }], repos: [{ name: "ws", repoPath: tmp, githubRepo: "example/repo" }] }));
  const cfg = loadConfig(p);
  const seen = [];
  registerWorkSource(await connector(restart));
  addObserver({ async onEvent(e) { if (e.kind === "waiting") seen.push(e); } });
  await tryBatchImplementation(cfg.repos[0], cfg, logger, 1);
  await drainObservers();
  registerWorkSource(null);
  return seen;
}

test("R1: a checkbox-only approved issue, nothing else buildable, is emitted as waiting with its acceptance reason", async () => {
  reset(caseBody("H2-jerky_service-200-checkbox-list-heading-with-suffix"));
  const seen = await cycleWaiting("w1");
  const items = seen.at(-1).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].item.issueNumber, 7);
  assert.match(items[0].reason, /## Acceptance/);
  assert.equal(items[0].skipped, undefined, "a Foreman-held wait, not a skip");
  assert.equal(posted().length, 1);
});

test("R2: every held cycle and a restart emit it, one comment throughout; fixing the body clears it", async () => {
  reset(caseBody("H2-jerky_service-200-checkbox-list-heading-with-suffix"));
  for (const r of ["w2a", "w2b", "w2c-restarted"]) {
    const seen = await cycleWaiting(r);
    assert.deepEqual(seen.at(-1).items.map((i) => i.item.issueNumber), [7], r);
  }
  assert.equal(posted().length, 1, "comment deduplicated across cycles and restart");
  setState({ body: GOOD });
  const after = await cycleWaiting("w2d");
  assert.deepEqual(after.at(-1)?.items ?? [], [], "the board reason is cleared");
});

test("every waiting emit in the implement stage carries the acceptance holds", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "phases", "implement.ts"), "utf8");
  const emits = src.match(/kind: "waiting"[^\n]*/g);
  assert.ok(emits.length >= 5);
  for (const e of emits) assert.match(e, /acceptanceHolds|waitingSet\(/, e);
  assert.match(src, /const waitingSet = \(block[^\n]*\n\s*\.\.\.acceptanceHolds/);
});

test("a generated rework issue (SRE or QA) passes the gate, naming its parent", async () => {
  const { reworkIssueBody } = await import("../dist/phases/verify.js");
  for (const by of ["SRE", "QA"]) {
    const body = reworkIssueBody(7, 70, "diagnostic text", by);
    assert.equal(acceptanceVerdict(body).ok, true, by);
    assert.match(body, /\*\*No-Script:\*\*[^\n]*#7/, by);
  }
});
