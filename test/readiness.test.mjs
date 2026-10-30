// An approved issue waits for the prerequisites its own Pre-Flight declares
// (slashbin-ai-foreman#91; origin jerky_service#185, 2026-10-16): a structured
// `readiness` block, read before a session is spent. Parser and evaluator are
// pure and take a stubbed gh; the eligibility and comment tests drive the built
// connector with a fake `gh` on PATH. Nothing reaches GitHub.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseReadiness, unmetReadiness } from "../dist/github/readiness.js";
import { loadConfig } from "../dist/config.js";
import { configureIssueCache } from "../dist/github.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
const block = (...lines) => ["## Pre-Flight", "```readiness", ...lines, "```", "", "## Acceptance", "- **Script:** `scripts/x/x-acceptance.mjs`"].join("\n");

// ---- parser ----

test("each valid predicate form parses", () => {
  const r = parseReadiness(block(
    "file_at_ref: o/marketing rick-bot/context/playbooks/voicemail.md main",
    "issue_closed: o/svc#12",
    "pr_merged: o/svc#34 base=main",
  ));
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.predicates, [
    { kind: "file_at_ref", repo: "o/marketing", path: "rick-bot/context/playbooks/voicemail.md", ref: "main" },
    { kind: "issue_closed", repo: "o/svc", number: 12 },
    { kind: "pr_merged", repo: "o/svc", number: 34, base: "main" },
  ]);
});

test("each invalid form is named, and holds", () => {
  for (const line of [
    "pr_merged: o/svc#34",                    // no base=
    "pr_merged: o/svc#34 base=",              // empty base
    "file_at_ref: o/marketing path.md",       // no ref
    "file_at_ref: marketing path.md main",    // no owner
    "issue_closed: #12",                      // no repo
    "issue_closed: o/svc#x",
    "branch_exists: o/svc main",              // unknown predicate
    "just some prose",
  ]) {
    const r = parseReadiness(block("issue_closed: o/svc#1", line));
    assert.deepEqual(r.invalid, [`invalid readiness line: ${line}`], line);
    assert.equal(r.predicates.length, 1, "the valid line still parses");
  }
});

test("no block, and informational Pre-Flight text, declare nothing", () => {
  assert.deepEqual(parseReadiness(""), { predicates: [], invalid: [] });
  assert.deepEqual(parseReadiness("## Problem\nx"), { predicates: [], invalid: [] });
  const prose = "## Pre-Flight\n- None external.\n- Needs `voicemail.md` on marketing main (file_at_ref: o/m a.md main)\n\n## Acceptance\n- x";
  assert.deepEqual(parseReadiness(prose), { predicates: [], invalid: [] });
});

test("a readiness block outside Pre-Flight, or with another info string, is not read", () => {
  assert.deepEqual(parseReadiness("## Solution\n```readiness\nbogus\n```"), { predicates: [], invalid: [] });
  assert.deepEqual(parseReadiness("## Pre-Flight\n```text\nbogus\n```"), { predicates: [], invalid: [] });
});

test("two blocks are invalid", () => {
  const body = "## Pre-Flight\n```readiness\nissue_closed: o/a#1\n```\n```readiness\nissue_closed: o/a#2\n```";
  const r = parseReadiness(body);
  assert.equal(r.invalid.length, 1);
  assert.match(r.invalid[0], /2 readiness blocks/);
  assert.deepEqual(r.predicates, []);
});

// ---- evaluator ----

const err = (stderr) => Object.assign(new Error("Command failed"), { stderr });
const P = (line) => parseReadiness(block(line));

test("file_at_ref: 200 is met, 404 is unmet, any other error is unreadable and holds", () => {
  const line = "file_at_ref: o/m a/b.md main";
  assert.deepEqual(unmetReadiness(P(line), () => "abc123"), []);
  const missing = unmetReadiness(P(line), () => { throw err("gh: Not Found (HTTP 404)"); });
  assert.deepEqual(missing, [line]);
  const down = unmetReadiness(P(line), () => { throw err("gh: Server Error (HTTP 500)"); });
  assert.equal(down.length, 1);
  assert.match(down[0], /unreadable/);
  assert.ok(down[0].startsWith(line));
});

test("file_at_ref reads the path at the ref", () => {
  const calls = [];
  unmetReadiness(P("file_at_ref: o/m dir/a+b.md release/1"), (a) => { calls.push(a[1]); return "x"; });
  assert.deepEqual(calls, ["repos/o/m/contents/dir/a%2Bb.md?ref=release%2F1"]);
});

test("pr_merged needs merged AND the named base", () => {
  const line = "pr_merged: o/s#5 base=main";
  const pr = (merged, base) => () => JSON.stringify({ merged, base });
  assert.deepEqual(unmetReadiness(P(line), pr(true, "main")), []);
  assert.deepEqual(unmetReadiness(P(line), pr(true, "develop")), [line], "merged to develop is not merged to main");
  assert.deepEqual(unmetReadiness(P(line), pr(false, "main")), [line]);
});

test("issue_closed needs a closed issue; a closed issue does not satisfy a file_at_ref", () => {
  const closed = () => "closed";
  assert.deepEqual(unmetReadiness(P("issue_closed: o/s#5"), closed), []);
  assert.deepEqual(unmetReadiness(P("issue_closed: o/s#5"), () => "open"), ["issue_closed: o/s#5"]);
  const line = "file_at_ref: o/m a.md main";
  const asIssue = (a) => { if (a[1].includes("/contents/")) throw err("gh: Not Found (HTTP 404)"); return "closed"; };
  assert.deepEqual(unmetReadiness(P(line), asIssue), [line]);
});

test("every unmet predicate and every invalid line is named", () => {
  const r = parseReadiness(block("issue_closed: o/s#1", "issue_closed: o/s#2", "oops"));
  assert.deepEqual(unmetReadiness(r, () => "open"), ["invalid readiness line: oops", "issue_closed: o/s#1", "issue_closed: o/s#2"]);
});

// ---- eligibility and the hold comment, through the built connector ----

let tmp, state, saved;
const stateFile = () => join(tmp, "state.json");
const setState = (patch) => { state = { ...(existsSync(stateFile()) ? fileState() : {}), ...patch }; writeFileSync(stateFile(), JSON.stringify(state)); };
const fileState = () => JSON.parse(readFileSync(stateFile(), "utf8"));
const posted = () => fileState().comments.filter((c) => c.posted);

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "foreman-readiness-test-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const S = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile())}, "utf8"));
const a = process.argv.slice(2);
const out = (x) => process.stdout.write(typeof x === "string" ? x : JSON.stringify(x));
const fail = (m) => { process.stderr.write(m); process.exit(1); };
if (a[0] === "issue" && a[1] === "list") out(S.board);
else if (a[0] === "issue" && a[1] === "comment") {
  S.comments.push({ body: a[a.indexOf("--body") + 1], author: { login: "foreman-bot" }, posted: true });
  fs.writeFileSync(${JSON.stringify(stateFile())}, JSON.stringify(S));
}
else if (a[0] === "api" && a[1] === "user") out("foreman-bot");
else if (a[0] === "api" && a[1] === "graphql") {
  const q = a[a.indexOf("-f") + 1];
  const field = q.includes("timelineItems") ? "timelineItems" : "comments";
  const all = field === "comments" ? S.comments : S.labeled;
  const ci = a.findIndex((x) => /^c=/.test(x));
  const end = ci < 0 ? all.length : Number(a[ci].slice(2));
  const start = Math.max(0, end - 100);
  S.calls = (S.calls || 0) + 1;
  fs.writeFileSync(${JSON.stringify(stateFile())}, JSON.stringify(S));
  out({ data: { repository: { issue: { [field]: {
    pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
    nodes: all.slice(start, end) } } } } });
}
else if (a[0] === "api" && /\\/dependencies\\/blocked_by$/.test(a[1])) out("[]");
else if (a[0] === "api" && /^repos\\/example\\/repo\\/issues\\/\\d+$/.test(a[1])) out(S.body);
else if (a[0] === "api" && a[1].startsWith("repos/o/m/contents/")) {
  if (S.fileError) fail("gh: Server Error (HTTP 500)");
  if (S.fileOnMain) out("sha"); else fail("gh: Not Found (HTTP 404)");
}
else out("[]");
`);
  chmodSync(join(bin, "gh"), 0o755);
  saved = { PATH: process.env.PATH, token: process.env.FOREMAN_GITHUB_TOKEN };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test-fake";
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];
  configureIssueCache({ ttlMs: 0 });
  state = {};
});

after(() => {
  process.env.PATH = saved.PATH;
  if (saved.token === undefined) delete process.env.FOREMAN_GITHUB_TOKEN;
  else process.env.FOREMAN_GITHUB_TOKEN = saved.token;
  rmSync(tmp, { recursive: true, force: true });
});

function config() {
  const p = join(tmp, "cfg.json");
  writeFileSync(p, JSON.stringify({ stages: [{ type: "implement" }], repos: [{ name: "ws", repoPath: tmp, githubRepo: "example/repo" }] }));
  return loadConfig(p);
}

/** A fresh module instance: what a daemon restart gives (the in-memory hold maps start empty). */
async function connector(restart = "") {
  const { GitHubIssueConnector } = await import(`../dist/github-work-source.js?restart=${restart}`);
  return new GitHubIssueConnector();
}

const eligible = async (c) => {
  const cfg = config();
  return (await c.selectEligible(cfg.repos[0], logger)).map((w) => w.issueNumber);
};

const HELD_BODY = block("file_at_ref: o/m rick-bot/voicemail.md main");

function reset(labels = ["approved"], body = HELD_BODY) {
  state = {};
  setState({
    board: [{ number: 7, title: "seven", labels: labels.map((name) => ({ name })) }],
    body, comments: [], fileOnMain: false,
    labeled: [{ label: { name: "approved" }, actor: { login: "ray" } }],
  });
}

test("a held issue is excluded, and eligible on the cycle after its predicates turn true", async () => {
  reset();
  const c = await connector("a");
  assert.deepEqual(await eligible(c), []);
  assert.deepEqual(await eligible(c), []);
  setState({ fileOnMain: true });
  assert.deepEqual(await eligible(c), [7]);
});

test("an unreadable predicate holds", async () => {
  reset();
  setState({ fileError: true });
  assert.deepEqual(await eligible(await connector("b")), []);
});

test("an invalid line holds the issue and the comment names it", async () => {
  reset(["approved"], block("pr_merged: o/s#3"));
  assert.deepEqual(await eligible(await connector("c")), []);
  assert.match(posted()[0].body, /invalid readiness line: pr_merged: o\/s#3/);
});

test("no block, or informational Pre-Flight text, leaves the issue eligible, with no comment", async () => {
  reset(["approved"], "## Pre-Flight\n- None external.\n\n## Acceptance\n- **Script:** `scripts/x/x-acceptance.mjs`\n");
  assert.deepEqual(await eligible(await connector("d")), [7]);
  assert.equal(posted().length, 0);
});

test("a blocked issue with satisfied predicates stays excluded; so does a lifecycle one", async () => {
  reset(["approved", "blocked"]);
  setState({ fileOnMain: true });
  assert.deepEqual(await eligible(await connector("e")), []);
  reset(["approved", "pr under review"]);
  setState({ fileOnMain: true });
  assert.deepEqual(await eligible(await connector("f")), []);
});

test("the exclusions run before any readiness read: no comment on a blocked issue", async () => {
  reset(["approved", "blocked"]);
  await eligible(await connector("g"));
  assert.equal(posted().length, 0);
});

test("one hold comment for a reason: none on the second cycle, none after a restart", async () => {
  reset();
  const c = await connector("h");
  await eligible(c);
  assert.equal(posted().length, 1);
  const body = posted()[0].body;
  assert.match(body, /<!-- foreman:readiness-hold \S+ -->/, "hidden marker");
  assert.match(body, /file_at_ref: o\/m rick-bot\/voicemail\.md main/, "names the unmet predicate");
  assert.match(body, /@ray/, "names the approver from the labeled event");
  assert.match(body, /starts automatically/);
  await eligible(c);
  assert.equal(posted().length, 1, "second cycle");
  await eligible(await connector("h-restarted"));
  assert.equal(posted().length, 1, "after a simulated restart: dedupe is on the issue, not memory");
});

test("a changed reason gets a new comment", async () => {
  reset();
  await eligible(await connector("i"));
  setState({ body: block("file_at_ref: o/m rick-bot/voicemail.md main", "issue_closed: o/s#1") });
  await eligible(await connector("i-restarted"));
  assert.equal(posted().length, 2);
});

test("the approved label is never touched", async () => {
  reset();
  await eligible(await connector("j"));
  assert.deepEqual(fileState().board[0].labels, [{ name: "approved" }]);
});

test("R1: 30+ human comments after the hold marker, then a restart: no repeat", async () => {
  reset();
  await eligible(await connector("k"));
  assert.equal(posted().length, 1);
  const humans = Array.from({ length: 130 }, (_, i) => ({ body: `chat ${i}`, author: { login: "ray" } }));
  setState({ comments: [...fileState().comments, ...humans] });
  await eligible(await connector("k-restarted"));
  assert.equal(posted().length, 1, "marker found across pages");
});

test("R2/R4: 50+ label events after the approval: the announcement names the approver", async () => {
  reset();
  const noise = Array.from({ length: 230 }, (_, i) => ({ label: { name: `l${i}` }, actor: { login: "someone" } }));
  setState({ labeled: [{ label: { name: "approved" }, actor: { login: "ray" } }, ...noise] });
  await eligible(await connector("l"));
  assert.equal(posted().length, 1);
  assert.match(posted()[0].body, /@ray/);
  assert.doesNotMatch(posted()[0].body, /@unknown/);
});

test("a failed history read posts nothing", async () => {
  reset();
  setState({ comments: [{ body: "x", author: { login: "ray" } }], labeled: null });
  await eligible(await connector("m"));
  assert.equal(posted().length, 0);
});
