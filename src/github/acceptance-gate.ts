// An approved issue is built only when its `## Acceptance` section names how the
// work will be accepted: a committed script under `scripts/`, or a deliberate
// `**No-Script:**` reason.
//
// Origin: EM#99 / jerky_service#200. The EM's `approved_gate_hook.py` refuses to
// apply `approved` to an issue without one, but a customer applying the label
// themselves bypasses that hook. The Foreman enforces the same structural rule at
// pickup. This mirrors `section_body`, `acceptance_script_paths` and the
// No-Script branch of `check_acceptance` in that hook; both are tested against the
// same corpus (test/fixtures/acceptance-gate-cases.json). It judges structure
// only: whether the named script exists or ran is the EM hook's business.

export interface AcceptanceVerdict {
  ok: boolean;
  /** Present when `ok` is false: what is missing and what to add. Never quotes the issue body. */
  reason?: string;
}

const HEADER = "## Acceptance";
const NO_SCRIPT_MARKER = "no-script:";
const NO_SCRIPT_MIN_CHARS = 40;
const SCRIPT_PATH = /scripts\/[A-Za-z0-9_./-]+/g;
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
  `or \`- **No-Script:** <why no caller can observe this change, at least ${NO_SCRIPT_MIN_CHARS} characters>\`.`,
  "The build starts on its own once the body is fixed.",
].join(" ");

/** Whether an issue body may be built: the structural rule of the EM's `approved` gate. */
export function acceptanceVerdict(body: string): AcceptanceVerdict {
  const section = sectionBody(body);
  if (section === null) {
    return { ok: false, reason: `the issue has no \`## Acceptance\` section. ${FIX}` };
  }
  if (scriptPaths(section).length > 0) return { ok: true };
  const idx = section.toLowerCase().indexOf(NO_SCRIPT_MARKER);
  if (idx === -1) {
    return { ok: false, reason: `the \`## Acceptance\` section names no script and no No-Script reason. ${FIX}` };
  }
  const line = section.slice(idx + NO_SCRIPT_MARKER.length).trim().split("\n", 1)[0].trim();
  const reason = line.replace(/^[*_` ]+|[*_` ]+$/g, "");
  if ([...reason].length < NO_SCRIPT_MIN_CHARS) {
    return { ok: false, reason: `the \`## Acceptance\` section's No-Script reason is under ${NO_SCRIPT_MIN_CHARS} characters. ${FIX}` };
  }
  return { ok: true };
}
