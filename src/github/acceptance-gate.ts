// An approved issue is built only when its `## Acceptance` section names how the
// work will be accepted: a committed script under `scripts/`, or a deliberate
// `**No-Script:** <category> — <reason>` (categories below).
//
// Origin: EM#99 / jerky_service#200. The EM's `approved_gate_hook.py` refuses to
// apply `approved` to an issue without one, but a customer applying the label
// themselves bypasses that hook. The Foreman enforces the same structural rule at
// pickup. This mirrors `section_body`, `acceptance_script_paths`, the No-Script
// branch of `check_acceptance` and `check_acceptance_paths_only_in_section` in that
// hook; both are tested against the same corpus (test/fixtures/acceptance-gate-cases.json).
// It judges structure only: whether the named script exists or ran is the EM hook's business.

export interface AcceptanceVerdict {
  ok: boolean;
  /** Present when `ok` is false: what is missing and what to add. Never quotes the issue body. */
  reason?: string;
}

const HEADER = "## Acceptance";
const NO_SCRIPT_MARKER = "no-script:";
const NO_SCRIPT_MIN_CHARS = 40;
const SCRIPT_PATH = /scripts\/[A-Za-z0-9_./-]+/g;
/** The change kinds with no caller surface; `**No-Script:**` must name one. */
export const NO_SCRIPT_CATEGORIES = ["docs-only", "config-only", "ci-only", "dependency-bump", "dead-code-deletion"];
/** A No-Script section describing one of these has a caller surface and needs a script. */
const CALLER_OBSERVABLE: Array<[RegExp, string]> = [
  [/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+\/\S*/im, "an HTTP request"],
  [/\bhttp\s*[1-5]\d\d\b|\b(?:returns?|responds?|responding|status(?:\s+code)?)\s*(?:with\s*)?(?:an?\s+)?(?:http\s*)?[1-5]\d\d\b|\b[1-5]\d\d\s+(?:status|response)\b|\bcurl\b|\bhealth\s+endpoint\b/im, "an HTTP status"],
  [/\b(?:browser|page\s+loads?|loads?\s+the\s+page|playwright|puppeteer)\b/im, "a browser or page load"],
  [/\bcli\s+(?:calls?|invocations?|commands?|runs?)\b|\bslashbin-cli\b/im, "a CLI invocation"],
  [/\bworkflow\s+runs?\b|\bgh\s+(?:workflow|run)\b/im, "a workflow run"],
  [/\blog\s+lines?\b|\bbuild\s+logs?\b|\bdeploy\s+logs?\b/im, "a log line"],
  [/`(?:npm|npx|pnpm|yarn|node|python3?|pytest|make|bash|sh)\s[^`\n]*`|^\s*[|*\-]?\s*(?:npm|npx|pnpm|yarn)\s+\S/im, "a shell command"],
];
/** Mirrors CHILD_WRITES in the EM hook: the reason says the builder writes the check. */
const CHILD_WRITES =
  /\b(?:this (?:child|issue|card|ticket)|the (?:child|implementer|builder|foreman|implementing agent))\s+(?:(?:must|should|will|then)\s+)?(?:writes?|adds?|creates?|commits?|authors?)\s+(?:(?:the|this|its|an?)\s+)?(?:(?:acceptance\s+(?:check|script|test))|check\b|script\b|`?scripts\/[\w.-]+\/[\w./-]*acceptance)/i;
/** Any acceptance script path in the body, with an optional repo prefix. */
const ANY_ACCEPTANCE_PATH = /((?:[\w.-]+\/)*)(scripts\/[\w./-]*acceptance[\w./-]*)/gi;
const DATA_EXTS = new Set([".json", ".jsonl", ".csv", ".txt", ".md", ".yaml", ".yml"]);
const WRAPPER_PREFIXES = ["scripts/secrets/"];

/** The text under a REAL `## Acceptance` heading (alone on its line, CRLF tolerated), or null. */
function sectionBody(body: string): string | null {
  const heading = /^## Acceptance[ \t]*\r?$/m.exec(body);
  if (!heading) return null;
  const rest = body.slice(heading.index + heading[0].length);
  const next = /\r?\n##\s/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Every committed-script path the section names, less data files and the secrets wrapper. */
function scriptPaths(section: string): string[] {
  const out: string[] = [];
  for (const raw of section.match(SCRIPT_PATH) ?? []) {
    const cleaned = raw.replace(/[`.,;:)\]}'"]+$/, "");
    const dot = cleaned.lastIndexOf(".");
    const slash = cleaned.lastIndexOf("/");
    const ext = dot > slash ? cleaned.slice(dot).toLowerCase() : "";
    if (DATA_EXTS.has(ext)) continue;
    if (WRAPPER_PREFIXES.some((p) => cleaned.startsWith(p))) continue;
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

const FIX = [
  "Add to the issue body, under a `## Acceptance` heading, either",
  "`- **Script:** \\`scripts/<area>/<name>-acceptance.mjs\\`` (a script committed to the repo that exercises what a caller sees),",
  `or \`- **No-Script:** <category> — <why no caller can observe this change, at least ${NO_SCRIPT_MIN_CHARS} characters>\`,`,
  `where <category> is one of ${NO_SCRIPT_CATEGORIES.join(", ")}.`,
  "The build starts on its own once the body is fixed.",
].join(" ");

const refuse = (reason: string): AcceptanceVerdict => ({ ok: false, reason: `${reason} ${FIX}` });

/** Every acceptance-script path in the body must be in `## Acceptance` and be this repo's (not repo-prefixed). */
function strayPath(body: string, inSection: string[]): string | null {
  for (const m of body.matchAll(ANY_ACCEPTANCE_PATH)) {
    const prefix = m[1];
    const path = m[2].replace(/[`.,;:)\]}'"]+$/, "");
    const dot = path.lastIndexOf(".");
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
    if (DATA_EXTS.has(ext) || WRAPPER_PREFIXES.some((p) => path.startsWith(p))) continue;
    if (prefix) return `the body names an acceptance script inside another repo (\`${prefix}${path}\`); the SRE runs only scripts from this repo's pushed main, so put it under this repo's \`scripts/\`.`;
    if (!inSection.includes(path)) return `the body names an acceptance script outside \`## Acceptance\` (\`${path}\`); every acceptance script path must appear in that section.`;
  }
  return null;
}

/** Whether an issue body may be built: the structural rule of the EM's `approved` gate. */
export function acceptanceVerdict(body: string): AcceptanceVerdict {
  const section = sectionBody(body);
  if (section === null) {
    return { ok: false, reason: `the issue has no \`## Acceptance\` section. ${FIX}` };
  }
  const paths = scriptPaths(section);
  const stray = strayPath(body, paths);
  if (stray) return refuse(`${stray}`);
  if (paths.length > 0) return { ok: true };
  const idx = section.toLowerCase().indexOf(NO_SCRIPT_MARKER);
  if (idx === -1) {
    return { ok: false, reason: `the \`## Acceptance\` section names no script and no No-Script reason. ${FIX}` };
  }
  const line = section.slice(idx + NO_SCRIPT_MARKER.length).trim().split("\n", 1)[0].trim().replace(/^[*_` ]+|[*_` ]+$/g, "");
  const parts = line.split(/\s+[\u2014\u2013-]\s+|\s*[\u2014\u2013]\s*|:\s+/);
  const category = parts[0].replace(/^[*_`<> ]+|[*_`<> ]+$/g, "").toLowerCase();
  const reason = (parts.length > 1 ? parts.slice(1).join(" ") : "").replace(/^[*_` ]+|[*_` ]+$/g, "");
  if (!NO_SCRIPT_CATEGORIES.includes(category)) {
    return refuse(`the \`## Acceptance\` section's No-Script has category "${category}", which is not a listed one (${NO_SCRIPT_CATEGORIES.join(", ")}); anything else has a caller surface and needs a script.`);
  }
  if ([...reason].length < NO_SCRIPT_MIN_CHARS) {
    return { ok: false, reason: `the \`## Acceptance\` section's No-Script reason is under ${NO_SCRIPT_MIN_CHARS} characters. ${FIX}` };
  }
  for (const [pattern, what] of CALLER_OBSERVABLE) {
    if (pattern.test(section)) {
      return refuse(`the \`## Acceptance\` section's No-Script describes ${what}, which a caller can observe; that needs a script, not No-Script.`);
    }
  }
  if (CHILD_WRITES.test(section)) {
    return refuse("the `## Acceptance` section's No-Script says the builder writes the check; the SRE runs only scripts already pushed to the repo's main, so write the script first.");
  }
  return { ok: true };
}
