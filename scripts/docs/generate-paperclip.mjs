#!/usr/bin/env node
// Generate docs/paperclip.md from the code the Paperclip mirror runs on. Run as
// `npm run docs:generate` (writes the file) or `npm run docs:check` (exits 1
// when the committed file differs from what this would write). Run
// `npm run build` first.
//
// Nothing a reader needs to trust is written down here:
//   - the config fields, their types and defaults come from the BUILT
//     `configSchema` (its `paperclip` block, parsed from `{}`);
//   - each field's description is the comment above it in `src/config.ts`;
//   - each env override is read from `mergePaperclip` in `src/config.ts`;
//   - the six status buckets come from the schema's `statusMap` keys;
//   - every step's move and note text come from `PAPERCLIP_STEPS` in the
//     built `src/paperclip/mirror.ts`, the table the mirror itself runs on;
//   - the lifecycle stages, their default holder / status / stage label and
//     the stage labels' names and colors come from the schema's defaults.
// What IS written here is prose and one "when" line per step. A step, field or
// bucket this file does not know, or one it knows that the code dropped, stops
// the run, so the doc cannot quietly fall behind the code.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(root, "docs", "paperclip.md");
const CONFIG_SRC = join(root, "src", "config.ts");
const MIRROR_SRC = join(root, "src", "paperclip", "mirror.ts");
const builtConfig = join(root, "dist", "config.js");
const builtMirror = join(root, "dist", "paperclip", "mirror.js");

function fail(msg) {
  console.error(`generate-paperclip: ${msg}`);
  process.exit(1);
}

for (const f of [CONFIG_SRC, MIRROR_SRC]) if (!existsSync(f)) fail(`${f} not found.`);
for (const f of [builtConfig, builtMirror]) if (!existsSync(f)) fail(`${f} not found — run \`npm run build\` first.`);

const { configSchema, PAPERCLIP_STAGES, PAPERCLIP_FOREMAN_ROLE } = await import(builtConfig);
const { PAPERCLIP_STEPS, PAPERCLIP_CREATE_STATUS, PAPERCLIP_TASK_TITLE_FORMAT } = await import(builtMirror);
const { FOREMAN_BLOCKED_PREFIX } = await import(builtMirror.replace(/mirror\.js$/, "board.js"));
const { toJSONSchema } = await import("zod");

// --- The schema ---

const pcSchema = configSchema.shape?.paperclip;
if (!pcSchema) fail("configSchema has no `paperclip` block.");
const json = toJSONSchema(pcSchema, { io: "input", unrepresentable: "any" });
const props = json.properties ?? {};
const defaults = pcSchema.parse({});
const fields = Object.keys(props);
if (fields.length === 0) fail("the `paperclip` block has no fields.");

const buckets = props.statusMap?.propertyNames?.enum ?? [];
if (buckets.length !== 6) fail(`expected exactly six status buckets in paperclip.statusMap, found ${buckets.length}: ${buckets.join(", ")}`);

// --- The source: field comments and env overrides ---

const configSrc = readFileSync(CONFIG_SRC, "utf8");
const block = configSrc.match(/const paperclipConfigSchema = z\.object\(\{\n([\s\S]*?)\n\}\);/);
if (!block) fail("could not find `const paperclipConfigSchema = z.object({ ... });` in src/config.ts.");
const descriptions = {};
let pending = [];
for (const line of block[1].split("\n")) {
  const comment = line.match(/^ {2}\/\/ ?(.*)$/);
  const field = line.match(/^ {2}(\w+):/);
  if (comment) pending.push(comment[1]);
  else if (field) {
    descriptions[field[1]] = pending.join(" ").trim();
    pending = [];
  }
}
const merge = configSrc.match(/function mergePaperclip\([\s\S]*?\n\}/);
if (!merge) fail("could not find `function mergePaperclip` in src/config.ts.");
const envOf = {};
for (const [, field, env] of merge[0].matchAll(/^\s+(\w+): process\.env\.(\w+),/gm)) envOf[field] = env;

for (const f of fields) if (!descriptions[f]) fail(`paperclip.${f} has no comment above it in src/config.ts.`);
for (const f of Object.keys(envOf)) if (!fields.includes(f)) fail(`mergePaperclip maps ${envOf[f]} to paperclip.${f}, which the schema does not have.`);

// --- The steps ---

// When each step happens. Written here because it describes the Foreman's
// cycle, not the mirror; the key set must equal PAPERCLIP_STEPS exactly.
const WHEN = {
  claim: "The Foreman picks the issue up to build it. The task is created here if none exists.",
  queued: "The issue goes back to the build queue: it carried a lifecycle label, but no pull request covers it and nothing merged.",
  prLink: "The Foreman opens the pull request that delivers the issue.",
  inReview: "The issue's pull request is waiting for review.",
  changesRequested: "The review asked for changes; the Foreman will revise.",
  approved: "The review approved the pull request.",
  blocked: "The Foreman declines the issue or runs out of revision retries (with its reason): it needs a person.",
  merged: "The pull request is merged to the base branch.",
  releaseWaiting: "The issue is in an open release pull request (base branch → production branch). Written once per release pull request.",
  released: "That release pull request merges to the production branch.",
  inProduction: "Promotion finds the issue's work already on the production branch, with no release pull request left to merge.",
  releaseClosed: "That release pull request is closed without merging; the task stays in review until the next one.",
  backoffPause: "A GitHub or Claude limit pauses the build in progress.",
  backoffResume: "The build in progress resumes after that limit clears.",
  waiting: "The Foreman holds the issue back this cycle (an occupied branch, a branch divergence). Written once per reason, not once per cycle. A skip in its back-off is not a wait: it stays in the `blocked` stage with that stage's owner.",
  resumed: "An issue the Foreman had moved to blocked is no longer held back.",
  implementFinished: "The build session for the issue ends (a pull request, commits on the open one, or a skip with its reason).",
  implementFailed: "The build session for the issue fails.",
  reviseStarted: "A session starts revising the issue's pull request after review feedback.",
  reviseFinished: "That revision session ends.",
  reviseFailed: "That revision session fails.",
  reviewStarted: "A review of the issue's pull request starts; the note names the reviewer.",
  reviewHandoff: "The first reviewer declines and the review passes to another, with the reason.",
  reviewFinished: "The review ends, with its outcome.",
  reviewFailed: "The review fails.",
};
const stepIds = Object.keys(PAPERCLIP_STEPS);
const unknown = stepIds.filter((s) => !(s in WHEN));
const dropped = Object.keys(WHEN).filter((s) => !stepIds.includes(s));
if (unknown.length) fail(`PAPERCLIP_STEPS has step(s) this generator does not describe: ${unknown.join(", ")}. Add them to WHEN.`);
if (dropped.length) fail(`WHEN describes step(s) PAPERCLIP_STEPS no longer has: ${dropped.join(", ")}.`);
const MOVES = [...PAPERCLIP_STAGES, "done", "waiting"];
for (const s of stepIds) {
  const st = PAPERCLIP_STEPS[s].stage;
  if (st !== null && !MOVES.includes(st)) fail(`step ${s} moves to "${st}", which is not a lifecycle stage, done or waiting.`);
}

// What each lifecycle stage means. The key set must equal PAPERCLIP_STAGES.
const STAGE_WHEN = {
  approved: "Authorized and waiting to be built.",
  implementing: "A build session is running on it.",
  inReview: "Its pull request waits for review.",
  reviewing: "A review session is running on it.",
  changesRequested: "The review asked for changes; waiting for a revision.",
  revising: "A revision session is running on it.",
  pendingVerification: "Approved and merged to the base branch; waiting for verification before release.",
  awaitingRelease: "Verified (or in an open release pull request); waiting for the release to merge.",
  blocked: "Needs a person: the issue is labelled `blocked`, or the Foreman declined it or ran out of retries.",
};
const stageKeys = [...PAPERCLIP_STAGES];
if (stageKeys.join() !== Object.keys(STAGE_WHEN).join()) fail(`STAGE_WHEN must describe exactly ${stageKeys.join(", ")}.`);
for (const st of stageKeys) {
  const b = defaults.board?.[st];
  if (!b) fail(`paperclip.board has no default for stage ${st}.`);
  if (!buckets.includes(b.status)) fail(`stage ${st} defaults to status "${b.status}", which is not a statusMap bucket.`);
  if (b.label !== null && !(b.label in defaults.stageLabels)) fail(`stage ${st} defaults to label "${b.label}", which stageLabels does not define.`);
}
if (!buckets.includes(PAPERCLIP_CREATE_STATUS)) fail(`PAPERCLIP_CREATE_STATUS "${PAPERCLIP_CREATE_STATUS}" is not a statusMap bucket.`);

// --- Render ---

const code = (v) => "`" + String(v).replace(/`/g, "\\`") + "`";
const cell = (v) => String(v).replace(/\|/g, "\\|");
const typeOf = (p) => (p.type === "object" ? "object" : p.type ?? "any");
const defaultOf = (f) => (defaults[f] === undefined ? "—" : code(JSON.stringify(defaults[f])));

const configRows = fields.map((f) =>
  `| ${code(f)} | ${typeOf(props[f])} | ${envOf[f] ? code(envOf[f]) : "none"} | ${defaultOf(f)} | ${cell(descriptions[f])} |`);

const bucketOf = (move) => (move === null ? null : move === "done" ? move : move === "waiting" ? "blocked" : defaults.board[move].status);
const setters = (b) => {
  const by = stepIds.filter((s) => bucketOf(PAPERCLIP_STEPS[s].stage) === b).map(code);
  if (b === PAPERCLIP_CREATE_STATUS) by.unshift("task creation");
  return by.length ? by.join(", ") : "never by default — the Foreman does not close issues";
};
const statusRows = buckets.map((b) => `| ${code(b)} | ${setters(b)} | ${code(`statusMap.${b}`)}, else ${code(b)} |`);

const stepRows = stepIds.map((s) => {
  const { stage, note } = PAPERCLIP_STEPS[s];
  return `| ${code(s)} | ${cell(WHEN[s])} | ${stage ? code(stage) : "unchanged"} | ${code(note)} |`;
});

const stageRows = stageKeys.map((st) => {
  const b = defaults.board[st];
  return `| ${code(st)} | ${cell(STAGE_WHEN[st])} | ${code(b.owner)} | ${code(b.status)} | ${b.label === null ? "none" : code(b.label)} |`;
});
const labelRows = Object.entries(defaults.stageLabels).map(([k, l]) => `| ${code(k)} | ${code(l.name)} | ${code(l.color)} |`);

// A generic two-role example: a reviewer agent holds review, a lead holds verification and release.
const rolesExample = JSON.stringify({ paperclip: {
  agentReportsTo: "lead",
  roles: {
    reviewer: { name: "Reviewer", title: "Code reviewer", reportsTo: "lead" },
    lead: { name: "Lead", title: "Engineering lead", role: "general" },
  },
  board: {
    inReview: { owner: "reviewer" },
    reviewing: { owner: "reviewer" },
    pendingVerification: { owner: "lead", status: "todo" },
    awaitingRelease: { owner: "lead" },
  },
} }, null, 2);

const exampleBlock = JSON.stringify({ paperclip: {
  enabled: true, url: defaults.url, companyId: "<your Paperclip company id>", agentName: defaults.agentName,
} }, null, 2);

const doc = `<!-- GENERATED by scripts/docs/generate-paperclip.mjs — do not edit by hand.
     Regenerate with \`npm run build && npm run docs:generate\`; \`npm run docs:check\` fails when this file is stale. -->

# Paperclip mirror

The Foreman can mirror its work onto a [Paperclip](https://github.com/paperclipai/paperclip)
company: each GitHub issue it builds gets a Paperclip task whose holder, status and stage label
follow the issue through its lifecycle, and which gets a note at every step.

GitHub stays the only work source. Paperclip only ever shows what the Foreman is doing; nothing
set in Paperclip starts, stops or changes a build. The mirror is off by default, and a config
without a \`paperclip\` block runs exactly as it would without this feature.

## Configuration

The \`paperclip\` block sits at the top level of \`.ai-agent.json\` (never per repo: one Foreman
is one Paperclip agent). Each environment variable, when set, overrides the file's value for
that one field. The block is read once at startup — restart the daemon after changing it.

| Field | Type | Env override | Default | Description |
|---|---|---|---|---|
${configRows.join("\n")}

\`enabled\` is a boolean; given as a string (as the env var always is) it takes \`true\` / \`false\`,
\`1\` / \`0\`, \`yes\` / \`no\` or \`on\` / \`off\`, and any other value stops the Foreman at startup.
\`companyId\` is required once \`enabled\` is true; the Foreman refuses to start without it.
The mirror runs only when \`enabled\` is true **and** both \`companyId\` and \`agentId\` are set;
with \`agentId\` missing the daemon logs that it is skipping the mirror and runs without it.
\`agentId\` is written by \`npm run paperclip:register\`, not by hand.

A minimal block, before registration:

\`\`\`json
${exampleBlock}
\`\`\`

## Identity key

A task is matched to its GitHub issue by the **first line of the task's description**, built
from \`identityKeyFormat\` (default ${code(defaults.identityKeyFormat)}): \`{repo}\` is the issue's
full \`owner/name\` and \`{N}\` its number. Before creating a task the Foreman scans the company's
tasks for one whose description starts with that line, and adopts it if found — so a task
another tool created for the same issue is reused, not duplicated, **provided both use the same
format**. A task the Foreman creates is titled ${code(PAPERCLIP_TASK_TITLE_FORMAT)}, its
description is the identity line, a blank line, and the issue's GitHub URL.

## Status mapping

Each step moves the task to a lifecycle stage (see **Board stages**), and the stage sets one of
six status buckets. Each is sent to Paperclip under its
\`statusMap\` name if one is configured, else under the bucket name itself.

| Bucket | Set by default at | Name sent to Paperclip |
|---|---|---|
${statusRows.join("\n")}

Merging to the base branch is a note, not a status: the work is not in production yet. Once
the issue is in a release pull request (base branch → production branch) the task goes to
\`in_review\` with a note naming that pull request, and to \`done\` when it merges. The Foreman
reads the release pull request each cycle from the GitHub state it already holds; when it
leaves the open set, one GitHub read says whether it merged or was closed. The pull request
being waited on is saved per repo, so a merge that lands while the Foreman is down is seen at
the next start. \`cancelled\` is left to whatever else syncs GitHub issues into the same
company.

An issue that needs a person goes to the \`blocked\` stage: the source labels it \`blocked\`,
or the Foreman declines it or runs out of revision retries (\`blocked\` step). It is held by
the stage's owner (\`board.blocked\`), with the reason as its unblock descriptor's action,
prefixed \`${FOREMAN_BLOCKED_PREFIX.trim()}\`, and the stage label \`blocked\`. It stays there until the issue
moves on (the Foreman picks it up again, or its labels change) — including through a skip's
back-off, which keeps it with that owner rather than turning it into a \`waiting\` hold.

The Foreman also uses the \`blocked\` status for a hold that is not a person's to clear: an
issue it is holding back right now (\`waiting\`). Paperclip only accepts \`blocked\` with an unblock descriptor, so the
Foreman sends one owned by its agent, with the reason as the action — the reason shows on the
task itself. When the issue stops waiting the Foreman moves it back to the stage it was in, and
Paperclip clears the descriptor. Both are written only when they change: the task's own status
and descriptor are the record, so a restarted Foreman reads them back instead of repeating
them. A sync that also writes these tasks should leave a \`blocked\` task held by the Foreman's
agent, or one whose descriptor starts with \`${FOREMAN_BLOCKED_PREFIX.trim()}\`, alone unless the issue has
closed or changed stage, or the two will flip it back and forth.

## Notes per step

Every step below posts one note on the issue's task (a session step, on the task of each issue
the session is about). \`{name}\` in a note is filled from the event. A step with a stage also moves the task there (see **Board stages**). Secrets the Foreman
knows of are redacted from every note before it is sent.

| Step | When | Moves to | Note |
|---|---|---|---|
${stepRows.join("\n")}

A task is created only when the Foreman picks an issue up (\`claim\`). A later step on an issue
that has no task writes nothing.

## Session summaries

With \`comments.enabled\` on (the default) the build, review and revision sessions write a short
markdown summary in place of their one-line notes above, so a card's thread reads as a record of
the work rather than a list of transitions. Each is written from what the Foreman already holds —
no extra model call:

| Event (\`comments.events\` key) | The comment |
|---|---|
| \`implementStart\` | **Foreman started implementing**, and the goal: the issue's title. Replaces the \`claim\` note; a retry says so. |
| \`implementEnd\` | The pull request (link and title), its diff stat (with \`includeDiffStat\`), and the agent's own closing summary: what changed, how, tests and their result, risks or deferrals. A skip gives the agent's reason; a failure the error. |
| \`reviewStart\` | Who is reviewing which pull request; a hand-off to another reviewer, with the reason. |
| \`reviewEnd\` | The verdict, whether it merged and deployed, the review's opening paragraph, and each finding as a bullet with its severity and location, read from the review the reviewer posted on the pull request. |
| \`reviseStart\` / \`reviseEnd\` | The revision starting, then what it addressed (the agent's closing summary), or why it changed nothing. |
| \`progress\` | The status notes: queued, under review, changes requested, approved, merged, waiting, back-off. |
| \`release\` | The release notes: waiting on the release pull request, released, in production. |
| \`blocked\` | Why the Foreman cannot go on, in its own words. |

A note a session triggers while it runs (the pull request opened, the issue under review or
approved) is posted after that session's summary, so the thread reads in order; one the summary
already says (the pull request link, a merge) is dropped. An event turned off in
\`comments.events\` posts nothing and still moves the card. With \`comments.enabled\` off every
step posts its one-line note from the table above.

Every comment, summary or note, is redacted (secrets the Foreman knows of, and anything shaped
like a token: GitHub, Anthropic/OpenAI, Slack and AWS keys, bearer tokens, JWTs, a password in a
URL, a \`*_TOKEN=\`/\`password:\`-style assignment) and capped at \`comments.maxLength\`
characters, marked \`… (truncated)\` when cut. No comment is posted when it is identical to the
task's latest comment: the latest is read from Paperclip once per task per process, so neither a
repeating cycle nor a restart writes the same note twice in a row.

## Board stages

Paperclip's columns are fixed, so each task carries two things beyond its status: the agent
holding it (whoever owns the next action, so each agent's view is its own queue) and a stage
label naming where it is inside that status. Both come from \`board\`, one entry per lifecycle
stage: \`owner\` is \`${PAPERCLIP_FOREMAN_ROLE}\` (the Foreman's own agent) or a key of \`roles\`,
\`status\` a status bucket, and \`label\` a key of \`stageLabels\` or \`null\`. Each entry, and each
field in it, falls back to its default on its own, so a config names only what it changes.

| Stage | Meaning | Default owner | Default status | Default stage label |
|---|---|---|---|---|
${stageRows.join("\n")}

The defaults suit a Foreman that is the only agent: it holds every task. A task carries at most
one stage label; a move swaps it and leaves every other label on the task alone. Each stage
label is created in the company on first use (by name, so one created by hand is reused):

| Key | Default name | Default color |
|---|---|---|
${labelRows.join("\n")}

When the issue ships (\`done\`) its stage label is removed and it stays with whoever held it.
A config that names a stage owner or label that does not exist stops the Foreman at startup.

### Roles

\`roles\` adds agents that only hold tasks — a reviewer, a lead who verifies and releases. Each
is a Paperclip agent like the Foreman's, registered by \`npm run paperclip:register\` with every
wake path off, so assigning it a task never makes Paperclip start a run. Two roles and the
stages they take over:

\`\`\`json
${rolesExample}
\`\`\`

\`reportsTo\` names another role key or \`${PAPERCLIP_FOREMAN_ROLE}\`; \`agentReportsTo\` is the
Foreman's own. Both are applied at registration; left unset, Paperclip's value is kept.

### Live sessions

The \`implementing\`, \`reviewing\` and \`revising\` stages last exactly as long as the session.
A state the issue reaches meanwhile (the review approves it, say) is applied when the session
ends; a session that ends with none returns the task to the stage it came from (\`approved\`,
\`inReview\` or \`changesRequested\`). Each review note names the reviewer.

While any session runs, the Foreman's agent carries a lease in its metadata
(\`foremanLive\`: the tasks held and when, renewed every few minutes). Past
\`liveLeaseMinutes\` without renewal the lease is void. A Foreman that starts with a lease left
by a process that died mid-session returns those tasks to their stages, and any other tool
that writes the same tasks can read the lease to leave live ones alone.

## Assignment

Every move to a lifecycle stage assigns the task to that stage's owner (see above). Note-only
steps leave the assignee alone; a task reassigned by hand in Paperclip goes back at its next
move. The Foreman's agent is registered with every wake path off (no heartbeat, no
wake-on-demand), so assigning a task to it never makes Paperclip start a run.

## Projects

With \`projects\` on, every task is filed under a Paperclip project for its repo, named by
\`projectNameFormat\` (default ${code(defaults.projectNameFormat)}): \`{name}\` is the repo's
name (\`my-service\`), \`{repo}\` its full \`owner/name\`. The project is looked up by name,
archived ones included, and created only when none has that name, so renaming the format
creates new projects rather than renaming old ones. A project the Foreman creates gets the status
\`projectStatus\` (default ${code(defaults.projectStatus)}); an existing project's status is never changed. A task the Foreman creates carries the
project from the start; at startup, and at every refresh of its task list after, the Foreman
sets the project on any task with an identity line (its own or another tool's) that lacks it.

## Live activity

The board is the queue: \`in_progress\` means a session is running on the task right now,
\`blocked\` that the Foreman is holding it back (with the reason on the task), and the stage
label and holder say what the task waits for otherwise. With \`agentStatus\` on, the Foreman's agent is
\`running\` while any session runs and \`idle\` otherwise, written only on a change.

Earlier versions kept one extra summary task held by the agent; the Foreman cancels it at
startup.

## When Paperclip is down

The mirror is best-effort and never blocks the Foreman. Every Paperclip call is caught; a
failure logs one warning when an outage starts (\`Paperclip mirror: … failed, notes are skipped
until Paperclip answers again\`) and one info line when the next call succeeds. Notes and status
changes due during the outage are skipped, not queued, and builds, reviews and promotions carry
on unaffected. A skipped status is set again at the issue's next status-setting step; an issue
picked up while Paperclip was down gets no task, because only the pick-up creates one.

## Set up

In Claude Code, from the Foreman's directory, say **"integrate the Foreman into my Paperclip
app"**: the \`setup-paperclip-integration\` skill walks through the steps below and changes
configuration only. By hand:

1. Add the \`paperclip\` block above to \`.ai-agent.json\`, with your company's id.
2. Optionally, add \`roles\` and the \`board\` stages they own (see **Roles**).
3. \`npm run build && npm run paperclip:register\` — registers the agent named \`agentName\`, and
   each role, with every wake path off and writes their ids into the file. Re-running it finds
   the same agents (by name) and switches their wake paths off again.
4. \`npm run labels:install\` — the configured labels exist on every configured repo.
5. Restart the daemon.

## Verify

\`\`\`bash
npm run build && npm run paperclip:doctor        # or: node dist/cli.js paperclip:doctor [--config <path>]
\`\`\`

The doctor is read-only: it checks that Paperclip answers, the company exists, the agent is
registered with both wake paths off, the \`paperclip\` block is complete, and every configured
role is registered under its name with its wake paths off. It prints one
\`PASS\` or \`FAIL\` line per check, naming what failed, and exits 0 only when every check passes.

To see it work, give a GitHub issue in a configured repo its trigger label. When the Foreman
picks it up, its Paperclip task appears, in progress and assigned to the Foreman, with a
\`Foreman started implementing\` comment naming the goal (${code(PAPERCLIP_STEPS.claim.note)} with
\`comments.enabled\` off), and gains a comment at each step after.

## Remove

Set \`paperclip.enabled\` to \`false\` (or \`AI_AGENT_PAPERCLIP_ENABLED=false\`), or delete the
block, and restart the daemon. The Foreman then makes no Paperclip call at all. Tasks and notes
already written stay in Paperclip; delete the Foreman agent there if you no longer want it.
`;

if (process.argv.includes("--check")) {
  const onDisk = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  if (onDisk !== doc) {
    console.error(onDisk === null
      ? "docs/paperclip.md is missing — run `npm run docs:generate`."
      : "docs/paperclip.md is stale — run `npm run build && npm run docs:generate` and commit the result.");
    process.exit(1);
  }
  console.log("docs/paperclip.md is up to date.");
} else {
  writeFileSync(OUT, doc);
  console.log(`wrote ${OUT}`);
}
