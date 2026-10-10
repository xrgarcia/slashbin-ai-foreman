#!/usr/bin/env node
// Generate docs/configuration.md, the complete `.ai-agent.json` reference. Run as
// `npm run docs:generate` (writes every generated doc) or `npm run docs:check`
// (exits 1 when a committed doc differs from what this would write). Run
// `npm run build` first.
//
// Nothing a reader needs to trust is written down here:
//   - every key, its type and its default come from the BUILT `configSchema`;
//   - each key's description is the comment above it in `src/config.ts`, and
//     each section is a `// --- Name ---` header there;
//   - each env override is read from `loadConfig`'s merge block, and which
//     per-repo keys fall back to the top-level value from its `entry.X ?? parsed.X`;
//   - the `backoff` groups, their defaults and descriptions come from the BUILT
//     `DEFAULT_BACKOFF` and the comments in `src/backoff.ts`; their env names
//     from `backoffEnvName`, the same function `mergeBackoff` reads them with.
// What IS written here is prose. A key without a comment stops the run, so a
// new setting cannot ship undocumented.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(root, "docs", "configuration.md");
const CONFIG_SRC = join(root, "src", "config.ts");
const BACKOFF_SRC = join(root, "src", "backoff.ts");
const builtConfig = join(root, "dist", "config.js");
const builtBackoff = join(root, "dist", "backoff.js");

function fail(msg) {
  console.error(`generate-configuration: ${msg}`);
  process.exit(1);
}

for (const f of [CONFIG_SRC, BACKOFF_SRC]) if (!existsSync(f)) fail(`${f} not found.`);
for (const f of [builtConfig, builtBackoff]) if (!existsSync(f)) fail(`${f} not found — run \`npm run build\` first.`);

const { configSchema, defaultLifecycleLabels } = await import(builtConfig);
const { DEFAULT_BACKOFF, backoffDelay, backoffEnvName, formatWait } = await import(builtBackoff);
const { BUILTIN_STAGES } = await import(join(root, "dist", "stages.js"));
const { toJSONSchema } = await import("zod");

// --- Reading a `z.object({ ... })` block's comments ---

/**
 * The fields of one `name = z.object({` block, in order, each with the comment
 * above it and the `// --- Section ---` it sits under. The comment lines right
 * under a section header (before a blank line) are that section's intro.
 */
function readBlock(src, name, file) {
  const m = src.match(new RegExp(`const ${name} = z\\.object\\(\\{\\n([\\s\\S]*?)\\n\\}\\)`));
  if (!m) fail(`could not find \`const ${name} = z.object({ ... })\` in ${file}.`);
  const fields = [];
  const sections = [];
  let pending = [];
  let introFor = null;
  for (const line of m[1].split("\n")) {
    const header = line.match(/^ {2}\/\/ --- (.*?) ---$/);
    const comment = line.match(/^ {2}\/\/ ?(.*)$/);
    const field = line.match(/^ {2}(\w+):/);
    if (header) {
      sections.push({ title: header[1], intro: "" });
      introFor = sections.at(-1);
      pending = [];
    } else if (comment) {
      pending.push(comment[1]);
    } else if (field) {
      fields.push({ key: field[1], section: sections.at(-1)?.title ?? "", text: prose(pending) });
      pending = [];
      introFor = null;
    } else if (line.trim() === "") {
      if (introFor && pending.length) introFor.intro = prose(pending);
      introFor = null;
      pending = [];
    }
  }
  return { fields, sections };
}

/** Comment lines → markdown prose: an empty `//` line is a paragraph break. */
function prose(lines) {
  return lines.join("\n").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).join("\n\n");
}

const configSrc = readFileSync(CONFIG_SRC, "utf8");
const backoffSrc = readFileSync(BACKOFF_SRC, "utf8");
const top = readBlock(configSrc, "configSchema", "src/config.ts");
const repo = readBlock(configSrc, "repoEntrySchema", "src/config.ts");
const labels = readBlock(configSrc, "lifecycleLabelsSchema", "src/config.ts");
const backoff = readBlock(backoffSrc, "backoffConfigSchema", "src/backoff.ts");

const load = configSrc.match(/export function loadConfig\([\s\S]*?\n\}/);
if (!load) fail("could not find `export function loadConfig` in src/config.ts.");
const envOf = {};
for (const [, key, env] of load[0].matchAll(/^\s+(\w+): process\.env\.(\w+) \?\?/gm)) envOf[key] = env;
const legacyEnv = {};
for (const [, key, env] of load[0].matchAll(/^\s+(\w+): process\.env\.(\w+),/gm)) legacyEnv[key] = env;
const fallsBack = new Set([...load[0].matchAll(/^\s+(\w+): entry\.\1 \?\? parsed\.\1,/gm)].map((m) => m[1]));

// --- The schema ---

const shape = configSchema.shape;
const json = toJSONSchema(configSchema, { io: "input", unrepresentable: "any" }).properties ?? {};
const defaults = configSchema.parse({});
const repoShape = shape.repos.unwrap().element.shape;

const missing = (b, where) => b.fields.filter((f) => !f.text).map((f) => `${where}${f.key}`);
const undocumented = [
  ...missing(top, ""),
  ...missing(labels, "lifecycleLabels."),
  ...missing(backoff, "backoff."),
  ...repo.fields.filter((f) => !(f.key in shape) && !f.text).map((f) => `repos[].${f.key}`),
];
if (undocumented.length) fail(`no comment above: ${undocumented.join(", ")} — describe each setting where it is declared.`);
for (const k of Object.keys(shape)) if (!top.fields.some((f) => f.key === k)) fail(`configSchema.${k} was not found in the source block.`);
for (const k of Object.keys(DEFAULT_BACKOFF)) if (!backoff.fields.some((f) => f.key === k)) fail(`backoff.${k} was not found in src/backoff.ts.`);

// --- Rendering ---

const code = (s) => `\`${s}\``;
const human = (key, v) => (/Ms$/.test(key) && typeof v === "number" && v > 0 ? ` (${formatWait(v)})` : "");
// Blocks with a section of their own: the default points there.
const SEE = {
  lifecycleLabels: "see [Lifecycle labels](#lifecycle-labels-lifecyclelabels)",
  paperclip: "see [paperclip.md](paperclip.md)",
  stages: `the built-ins in order: ${BUILTIN_STAGES.map(code).join(" → ")}`,
};
function shown(key, v) {
  if (key in SEE) return SEE[key];
  if (v === undefined) return "none";
  const s = JSON.stringify(v);
  return s.length > 70 ? "see `src/config.ts`" : `${code(s)}${human(key, v)}`;
}
function typeOf(p) {
  if (!p) return "";
  if (p.enum) return p.enum.map((e) => JSON.stringify(e)).join(" \\| ");
  if (p.type === "array") return `${p.items?.type ?? "object"}[]`;
  if (p.type) return p.type === "integer" ? "integer" : p.type;
  return "object";
}

const lines = [];
const out = (...l) => lines.push(...l);

out(
  "<!-- GENERATED by scripts/docs/generate-configuration.mjs from src/config.ts and src/backoff.ts. Do not edit by hand: run `npm run build && npm run docs:generate`. -->",
  "",
  "# Configuration reference",
  "",
  "Every setting the Foreman reads, with its default, its environment override and what it does.",
  "",
  "- **Where it lives.** `.ai-agent.json` (or `ai-agent.config.json`) in the daemon's working directory,",
  "  or the file named by `--config <path>`. Start from `.ai-agent.example.json`.",
  "- **Precedence.** An environment variable beats the file; the file beats the default. Every key is",
  "  optional except `repos[].name` and `repos[].repoPath`.",
  "- **Validation.** The whole file is checked when it loads. A wrong type or out-of-range value stops",
  "  the daemon at start with the key named, never mid-run.",
  "- **Hot reload.** The daemon re-reads the file at the start of every cycle, so an edit takes effect",
  "  on the next cycle without a restart. An edit that fails validation is logged and the last good",
  "  config keeps running.",
  "",
);

for (const section of top.sections) {
  const fields = top.fields.filter((f) => f.section === section.title);
  out(`## ${section.title}`, "");
  if (section.intro) out(section.intro, "");
  for (const f of fields) {
    if (f.key === "backoff") {
      out(`### ${code("backoff")}`, "", f.text, "", "See [Back-offs](#back-offs) below for every group.", "");
      continue;
    }
    const facts = [`Type: ${typeOf(json[f.key])}`, `Default: ${shown(f.key, defaults[f.key])}`];
    if (envOf[f.key]) facts.push(`Env: ${code(envOf[f.key])}`);
    if (f.key in repoShape) facts.push(fallsBack.has(f.key) ? "Per repo: yes, falls back to this value" : "Per repo: yes");
    out(`### ${code(f.key)}`, "", facts.join(" · "), "", f.text, "");
  }
}

const repoOnly = repo.fields.filter((f) => !(f.key in shape));
out(
  "## Per-repo entries (`repos[]`)",
  "",
  "Each entry is one repo. Besides the keys marked *Per repo* above, an entry takes:",
  "",
  ...repoOnly.map((f) => `- ${code(f.key)}: ${f.text}`),
  "",
  "```json",
  JSON.stringify({ repos: [{ name: "api", repoPath: "~/code/api", githubRepo: "acme/api", reviewEnabled: true }] }, null, 2),
  "```",
  "",
);

// --- Back-offs ---

const groups = Object.entries(DEFAULT_BACKOFF);
const isWindow = (v) => typeof v === "object" && v !== null && "baseMs" in v;
const limitOf = (v) => Object.keys(v).find((k) => !["baseMs", "capMs", "factor"].includes(k));
// The waits a group actually makes: a `maxAttempts` group stops after its
// last attempt, so it waits one time fewer than it tries.
function sequence(v) {
  const waits = [];
  const most = "maxAttempts" in v ? v.maxAttempts - 1 : 8;
  for (let n = 1; n <= most; n++) {
    const w = backoffDelay(n, v);
    waits.push(formatWait(w));
    if (w >= v.capMs) break;
  }
  return waits.join(", ");
}

out(
  "## Back-offs",
  "",
  "Every wait the Foreman makes before it tries something again is in the `backoff` block",
  "(`src/backoff.ts`). Each condition is its own group, and every wait grows the same way:",
  "",
  "```",
  "wait N in a row = min(baseMs × factor^(N−1), capMs)",
  "```",
  "",
  "A success clears the count, so the next spell of trouble starts again at `baseMs`. A blip costs",
  "one short wait; only trouble that lasts gets the long ones. Set `factor` to `1` for a fixed wait.",
  "Waits held in memory (`agentUnavailable`, `repoFailure`, `upstream`) reset when the daemon restarts,",
  "which only means it retries sooner.",
  "",
  "| Group | Waits with the defaults | Limit |",
  "|---|---|---|",
  ...groups.filter(([, v]) => isWindow(v)).map(([g, v]) => {
    const limit = limitOf(v);
    return `| ${code(g)} | ${sequence(v) || "none"} | ${limit ? `${code(limit)} ${v[limit]}` : "none"} |`;
  }),
  ...groups.filter(([, v]) => !isWindow(v)).map(([g, v]) => `| ${code(g)} | ${typeof v === "number" && /Ms$/.test(g) ? formatWait(v) : "—"} | ${/Ms$/.test(g) ? "—" : code(v)} |`),
  "",
  "Override any part; the rest keep their defaults:",
  "",
  "```json",
  JSON.stringify({ backoff: { skip: { baseMs: 120000, capMs: 3600000 }, verifyRetry: { maxAttempts: 5 }, upstream: { factor: 3 } } }, null, 2),
  "```",
  "",
  "Every field also has an environment override, `AI_AGENT_BACKOFF_<GROUP>_<FIELD>` in upper snake",
  "case, which beats the file.",
  "",
);
for (const [g, v] of groups) {
  const f = backoff.fields.find((x) => x.key === g);
  out(`### ${code(`backoff.${g}`)}`, "", f.text, "");
  if (isWindow(v)) {
    out("| Field | Default | Env |", "|---|---|---|");
    for (const [k, d] of Object.entries(v)) out(`| ${code(k)} | ${code(d)}${human(k, d)} | ${code(backoffEnvName(g, k))} |`);
    out("");
  } else {
    out(`Default: ${code(v)}${human(g, v)} · Env: ${code(backoffEnvName(g))}`, "");
  }
}
out(
  "### Older keys",
  "",
  "These top-level keys predate the `backoff` block and are still read. A value in the block wins over",
  "them, and an `AI_AGENT_BACKOFF_*` variable wins over their env names.",
  "",
  "| Old key | Env | Sets |",
  "|---|---|---|",
  `| ${code("skipBackoffMs")} | ${code(legacyEnv.skipBackoffMs)} | ${code("backoff.skip.baseMs")} |`,
  `| ${code("upstreamBackoffBaseMs")} | ${code(legacyEnv.upstreamBackoffBaseMs)} | ${code("backoff.upstream.baseMs")} |`,
  `| ${code("upstreamBackoffCapMs")} | ${code(legacyEnv.upstreamBackoffCapMs)} | ${code("backoff.upstream.capMs")} |`,
  "",
);
for (const k of ["skipBackoffMs", "upstreamBackoffBaseMs", "upstreamBackoffCapMs"]) {
  if (!legacyEnv[k]) fail(`loadConfig no longer reads the legacy key ${k}; update the Older keys table.`);
}

// --- Lifecycle labels ---

const labelDefaults = defaultLifecycleLabels();
out(
  "## Lifecycle labels (`lifecycleLabels`)",
  "",
  "Top-level only: the stages hand work to each other by label, so the whole fleet shares one set.",
  "The names must be distinct, and none may equal a repo's `triggerLabel`. Every session gets them as",
  "`FOREMAN_LIFECYCLE_LABELS` (JSON) and the repo's trigger label as `FOREMAN_TRIGGER_LABEL`.",
  "`npm run labels:install` creates any that are missing.",
  "",
  "| Key | Default | Meaning |",
  "|---|---|---|",
  ...labels.fields.map((f) => `| ${code(f.key)} | ${code(labelDefaults[f.key])} | ${f.text.replace(/\n+/g, " ")} |`),
  "",
  "## Elsewhere",
  "",
  "- `stages`: the stage list and custom stages, README \"Pipeline stages\" and `src/stages.ts`.",
  "- `paperclip`: every key of the board mirror, [paperclip.md](paperclip.md).",
  "- The states an issue moves through and the events the Foreman reports, [lifecycle.md](lifecycle.md).",
  "",
);

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== text) fail("docs/configuration.md is stale — run `npm run build && npm run docs:generate` and commit the result.");
  console.log("docs/configuration.md is up to date.");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
