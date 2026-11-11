#!/usr/bin/env node
/**
 * Acceptance for EM#425 child "labels-config-centralize" — every Foreman
 * lifecycle label comes from configuration, with today's Slashbin names as the
 * defaults, and the configured names reach the skills the Foreman runs.
 *
 * Front door: `loadConfig(<path>)` from the BUILT Foreman (`dist/config.js`) —
 * the call the daemon makes at startup on `.ai-agent.json` — plus the source
 * tree the build came from. No GitHub call, no write anywhere: every case reads
 * a temp config file it creates under the OS temp dir and deletes.
 *
 * RED TODAY (features 986a841): case C finds 99 literal label strings in src/,
 * case D finds EM_GATE_LABEL, cases A/B find no `lifecycleLabels` on the config.
 *
 *   A. configured  lifecycleLabels.prUnderReview = "in-review" → resolved "in-review"
 *   B. omitted     no lifecycleLabels               → resolved "pr under review" (Slashbin default)
 *   B2.            every one of the 5 keys resolves to today's name when omitted
 *   C. no literal lifecycle label string left in src/*.ts (tests excluded)
 *   D. EM_GATE_LABEL constant gone
 *   E. the env handed to each `claude` invocation carries FOREMAN_TRIGGER_LABEL
 *      and FOREMAN_LIFECYCLE_LABELS (source-level: the spawn env is built in
 *      session/env.ts and is not reachable without launching a real agent)
 *
 *   node scripts/acceptance/labels-config.mjs
 *   (default ~/code/slashbin-ai-foreman; run `npm run build` there first)
 */
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULTS = {
  prUnderReview: "pr under review",
  prPendingActions: "pr pending actions",
  prApproved: "pr approved",
  readyForProd: "ready for prod release",
  readyToClose: "ready to close",
};

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const distConfig = join(DIR, "dist", "config.js");
if (!existsSync(distConfig)) {
  console.error(`no build at ${distConfig} — run \`npm run build\` in ${DIR}`);
  process.exit(2);
}
const { loadConfig } = await import(pathToFileURL(distConfig).href);

const tmp = mkdtempSync(join(tmpdir(), "foreman-425-"));
const base = { repos: [{ name: "acceptance", repoPath: tmp, githubRepo: "example/acceptance" }] };
const load = (extra) => {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ ...base, ...extra }));
  try {
    return loadConfig(p);
  } catch (e) {
    return { __error: e instanceof Error ? e.message : String(e) };
  }
};

try {
  const a = load({ lifecycleLabels: { prUnderReview: "in-review" } });
  check("A configured prUnderReview resolves", a.lifecycleLabels?.prUnderReview === "in-review",
    `got ${JSON.stringify(a.lifecycleLabels?.prUnderReview ?? a.__error ?? null)}`);

  const b = load({});
  check("B omitted prUnderReview defaults to today's name", b.lifecycleLabels?.prUnderReview === DEFAULTS.prUnderReview,
    `got ${JSON.stringify(b.lifecycleLabels?.prUnderReview ?? b.__error ?? null)}`);
  for (const [k, v] of Object.entries(DEFAULTS)) {
    check(`B2 default ${k}`, b.lifecycleLabels?.[k] === v, `got ${JSON.stringify(b.lifecycleLabels?.[k] ?? null)}`);
  }

  const srcDir = join(DIR, "src");
  // src/*.ts plus session/ and phases/, where the agent.ts split (EM#1267) moved the spawn env and prompt code.
  const files = readdirSync(srcDir, { recursive: true })
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."));
  const literal = new RegExp(`"(${Object.values(DEFAULTS).join("|")})"`, "g");
  let hits = 0;
  const where = [];
  let gate = 0;
  // The one sanctioned home for the names is the schema default in config.ts
  // (`.default("pr under review")` and its four siblings) — that is where the
  // issue puts them. Every other literal is a use that bypasses the config.
  // paperclip/handoff.ts holds the second sanctioned copy: DEFAULT_HANDOFF_LABELS,
  // the fallback the daemon overrides with the loaded names. Comments are prose.
  const isSchemaDefault = (f, line) => (f === "config.ts" && /\.default\("[^"]+"\)/.test(line))
    || (f === join("paperclip", "handoff.ts") && /^\s+\w+: "[^"]+",$/.test(line))
    || /^\s*(\/\/|\*|\/\*)/.test(line);
  for (const f of files) {
    const text = readFileSync(join(srcDir, f), "utf8");
    const n = text.split("\n").filter((l) => !isSchemaDefault(f, l))
      .reduce((acc, l) => acc + (l.match(literal) || []).length, 0);
    if (n) { hits += n; where.push(`${f}:${n}`); }
    gate += (text.match(/EM_GATE_LABEL/g) || []).length;
  }
  check("C no literal lifecycle label in src/ outside the schema defaults", hits === 0, hits ? where.join(" ") : "");
  check("D EM_GATE_LABEL removed", gate === 0, gate ? `${gate} occurrence(s)` : "");

  const agent = readFileSync(join(srcDir, "session", "env.ts"), "utf8");
  check("E spawn env carries FOREMAN_TRIGGER_LABEL", /env\.FOREMAN_TRIGGER_LABEL\s*=|FOREMAN_TRIGGER_LABEL:/.test(agent));
  check("E spawn env carries FOREMAN_LIFECYCLE_LABELS", /env\.FOREMAN_LIFECYCLE_LABELS\s*=|FOREMAN_LIFECYCLE_LABELS:/.test(agent));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
