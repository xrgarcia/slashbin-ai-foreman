#!/usr/bin/env node
// Create the labels the Foreman runs on, on every repo in the config, where they
// are missing. Run as `npm run labels:install [config-path]` (the install-labels
// skill runs exactly that).
//
// The label set is never written down here: it is each repo's resolved
// `triggerLabel`, every value of `lifecycleLabels` and `github.blockedLabel`
// (the priority labels are read, never written, so they are not installed), read through the BUILT
// `loadConfig` — the same defaults, per-repo overrides and `githubRepo`
// inference the daemon applies, so the names installed are the names the daemon
// will use. Run `npm run build` first.
//
// Read-then-create only: one paginated GET per repo, then one POST per configured
// name absent from it. Nothing is ever DELETEd, PATCHed or PUT, so an existing
// label (colour, description, issues) is never touched, and a second run creates
// nothing. A failed repo does not stop the run; every failure is listed at the end
// and the exit code is 1.
//
// gh runs as the Foreman (`FOREMAN_GITHUB_TOKEN`) when that is set, else as
// whatever account gh itself is logged in as.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist", "config.js");
if (!existsSync(built)) {
  console.error(`${built} not found — run \`npm run build\` first.`);
  process.exit(1);
}
const { loadConfig } = await import(built);

// GitHub's own default label colour; colour is not configurable.
const COLOR = "ededed";

const env = { ...process.env };
if (process.env.FOREMAN_GITHUB_TOKEN) env.GH_TOKEN = process.env.FOREMAN_GITHUB_TOKEN;

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 60_000 });
}

function firstLine(err) {
  const text = `${err?.stderr ?? ""}`.trim() || `${err?.message ?? err}`;
  return text.split("\n")[0];
}

// `gh api --paginate` writes each page's JSON array back to back (`[…][…]`), and
// this gh may predate `--slurp`. Split at top-level boundaries (outside strings)
// and concatenate the pages.
function parsePages(out) {
  const items = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") {
      if (depth++ === 0) start = i;
    } else if (ch === "]" || ch === "}") {
      if (--depth === 0) items.push(...[].concat(JSON.parse(out.slice(start, i + 1))));
    }
  }
  if (depth !== 0 || inString) throw new Error("truncated label list from gh");
  return items;
}

let config;
try {
  config = loadConfig(process.argv[2]);
} catch (err) {
  console.error(`config failed to load: ${err?.message ?? err}`);
  process.exit(1);
}

const lifecycle = [...Object.values(config.lifecycleLabels), config.github.blockedLabel];
const failures = [];

for (const repo of config.repos) {
  const target = repo.githubRepo;
  const wanted = [...new Set([repo.triggerLabel, ...lifecycle])];

  let existing;
  try {
    existing = new Set(parsePages(gh(["api", "-X", "GET", `repos/${target}/labels`, "--paginate"])).map((l) => l.name));
  } catch (err) {
    failures.push(`${target}: could not read labels — ${firstLine(err)}`);
    console.log(`${target}: FAILED to read labels`);
    continue;
  }

  let created = 0;
  let present = 0;
  for (const name of wanted) {
    if (existing.has(name)) {
      present++;
      continue;
    }
    try {
      gh(["api", "-X", "POST", `repos/${target}/labels`, "-f", `name=${name}`, "-f", `color=${COLOR}`]);
      created++;
    } catch (err) {
      failures.push(`${target}: could not create "${name}" — ${firstLine(err)}`);
    }
  }
  console.log(`${target}: created ${created}, present ${present}`);
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`\nall ${config.repos.length} repo(s) carry every configured label`);
