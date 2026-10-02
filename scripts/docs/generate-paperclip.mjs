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
//   - the five status buckets come from the schema's `statusMap` keys;
//   - every step's status and note text come from `PAPERCLIP_STEPS` in the
//     built `src/paperclip/mirror.ts`, the table the mirror itself runs on.
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

const { configSchema } = await import(builtConfig);
const { PAPERCLIP_STEPS, PAPERCLIP_CREATE_STATUS, PAPERCLIP_TASK_TITLE_FORMAT } = await import(builtMirror);
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
if (buckets.length !== 5) fail(`expected exactly five status buckets in paperclip.statusMap, found ${buckets.length}: ${buckets.join(", ")}`);

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
  blocked: "The Foreman declines or cannot finish the issue (with its reason).",
  merged: "The pull request is merged to the base branch.",
  promoted: "The merged work is handed to promotion to production.",
  backoffPause: "A GitHub or Claude limit pauses the build in progress.",
  backoffResume: "The build in progress resumes after that limit clears.",
};
const stepIds = Object.keys(PAPERCLIP_STEPS);
const unknown = stepIds.filter((s) => !(s in WHEN));
const dropped = Object.keys(WHEN).filter((s) => !stepIds.includes(s));
if (unknown.length) fail(`PAPERCLIP_STEPS has step(s) this generator does not describe: ${unknown.join(", ")}. Add them to WHEN.`);
if (dropped.length) fail(`WHEN describes step(s) PAPERCLIP_STEPS no longer has: ${dropped.join(", ")}.`);
for (const s of stepIds) {
  const st = PAPERCLIP_STEPS[s].status;
  if (st !== null && !buckets.includes(st)) fail(`step ${s} sets status "${st}", which is not a statusMap bucket.`);
}
if (!buckets.includes(PAPERCLIP_CREATE_STATUS)) fail(`PAPERCLIP_CREATE_STATUS "${PAPERCLIP_CREATE_STATUS}" is not a statusMap bucket.`);

// --- Render ---

const code = (v) => "`" + String(v).replace(/`/g, "\\`") + "`";
const cell = (v) => String(v).replace(/\|/g, "\\|");
const typeOf = (p) => (p.type === "object" ? "object" : p.type ?? "any");
const defaultOf = (f) => (defaults[f] === undefined ? "—" : code(JSON.stringify(defaults[f])));

const configRows = fields.map((f) =>
  `| ${code(f)} | ${typeOf(props[f])} | ${envOf[f] ? code(envOf[f]) : "none"} | ${defaultOf(f)} | ${cell(descriptions[f])} |`);

const setters = (b) => {
  const by = stepIds.filter((s) => PAPERCLIP_STEPS[s].status === b).map(code);
  if (b === PAPERCLIP_CREATE_STATUS) by.unshift("task creation");
  return by.length ? by.join(", ") : "never — the Foreman does not close issues";
};
const statusRows = buckets.map((b) => `| ${code(b)} | ${setters(b)} | ${code(`statusMap.${b}`)}, else ${code(b)} |`);

const stepRows = stepIds.map((s) => {
  const { status, note } = PAPERCLIP_STEPS[s];
  return `| ${code(s)} | ${cell(WHEN[s])} | ${status ? code(status) : "unchanged"} | ${code(note)} |`;
});

const exampleBlock = JSON.stringify({ paperclip: {
  enabled: true, url: defaults.url, companyId: "<your Paperclip company id>", agentName: defaults.agentName,
} }, null, 2);

const doc = `<!-- GENERATED by scripts/docs/generate-paperclip.mjs — do not edit by hand.
     Regenerate with \`npm run build && npm run docs:generate\`; \`npm run docs:check\` fails when this file is stale. -->

# Paperclip mirror

The Foreman can mirror its work onto a [Paperclip](https://github.com/paperclipai/paperclip)
company: each GitHub issue it builds gets a Paperclip task, held by a Foreman agent, whose
status follows the build and which gets a note at every step.

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

The Foreman moves a task between five status buckets. Each is sent to Paperclip under its
\`statusMap\` name if one is configured, else under the bucket name itself.

| Bucket | Set by the Foreman at | Name sent to Paperclip |
|---|---|---|
${statusRows.join("\n")}

\`done\` and \`cancelled\` follow the GitHub issue closing, which the Foreman never does: they are
left to whatever else syncs GitHub issues into the same company. Merged, promoted and blocked
are therefore notes, not statuses.

## Notes per step

Every step below posts one note on the issue's task. \`{name}\` in a note is filled from the
event. A step with a status also sets the task's status (see above). Secrets the Foreman
knows of are redacted from every note before it is sent.

| Step | When | Status | Note |
|---|---|---|---|
${stepRows.join("\n")}

A task is created only when the Foreman picks an issue up (\`claim\`). A later step on an issue
that has no task writes nothing.

## Assignment

Every step that sets a status also assigns the task to the Foreman's agent (\`agentId\`), so the
task is held by the Foreman from the moment it is picked up. Note-only steps leave the assignee
alone; a task reassigned by hand in Paperclip goes back to the Foreman at its next status
change. The agent is registered with every wake path off (no heartbeat, no wake-on-demand), so
assigning a task to it never makes Paperclip start a run.

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
2. \`npm run build && npm run paperclip:register\` — registers the agent named \`agentName\` with
   every wake path off and writes \`paperclip.agentId\` into the file. Re-running it finds the
   same agent and switches its wake paths off again.
3. \`npm run labels:install\` — the configured labels exist on every configured repo.
4. Restart the daemon.

## Verify

\`\`\`bash
npm run build && npm run paperclip:doctor        # or: node dist/cli.js paperclip:doctor [--config <path>]
\`\`\`

The doctor is read-only: it checks that Paperclip answers, the company exists, the agent is
registered with both wake paths off, and the \`paperclip\` block is complete. It prints one
\`PASS\` or \`FAIL\` line per check, naming what failed, and exits 0 only when every check passes.

To see it work, give a GitHub issue in a configured repo its trigger label. When the Foreman
picks it up, its Paperclip task appears, assigned to the Foreman, with a
${code(PAPERCLIP_STEPS.claim.note)} note, and gains a note at each step after.

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
