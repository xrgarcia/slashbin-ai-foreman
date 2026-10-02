#!/usr/bin/env node
/**
 * PreToolUse hook the Foreman passes to EVERY Claude session it spawns
 * (`--settings`, see src/agent.ts sessionSettings). It blocks Bash commands
 * that would print an environment or credential VALUE.
 *
 * Why it exists: every session gets GH_TOKEN and runs with
 * --dangerously-skip-permissions in the service repo's checkout, so neither a
 * permission prompt nor the service repo's own hooks stand between a session
 * and `env`. Whatever a command prints lands in the session's Claude
 * transcript, a permanent local log; the Foreman's own log redaction never
 * sees it. A printed token is a leaked token, and the remedy is a rotation.
 *
 * Referencing a variable is fine — `gh ...` reads GH_TOKEN itself, and
 * `curl -H "Authorization: token $GH_TOKEN" ...` sends it without printing it.
 * Printing one is not.
 *
 * Contract (Claude Code hooks): JSON on stdin; exit 2 + stderr blocks the call
 * and shows stderr to the model; exit 0 allows. Unreadable input fails open,
 * because a broken gate must not stop every build — it is a guard on top of
 * the env allowlist, not the only one.
 */
import { readFileSync } from "node:fs";

/** A variable name that reads like a credential. */
const SECRET_NAME =
  "[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASS|PASSWD|PASSWORD|_PW|PWD|CREDENTIALS?|AUTH|DATABASE_URL|REDIS_URL|_DSN|_URI)\\b";
/** `$NAME` / `${NAME}` — but not `${#NAME}`, which is only a length. */
const SECRET_REF = `\\$(?:\\{(?!#))?${SECRET_NAME}`;
/** Start of a shell statement: line start, after ; | & ( or a backtick / $( */
const STMT = "(?:^|[;|&(`\\n]\\s*|\\$\\(\\s*)";
/** End of a bare command word. */
const END = "\\s*(?:$|[;|&)>`\\n])";

export const RULES = [
  {
    id: "env-dump",
    what: "dumps the environment (every variable, with its value)",
    re: new RegExp(
      `${STMT}(?:sudo\\s+)?(?:env|printenv|export(?:\\s+-p)?|set|declare\\s+-[a-zA-Z]*[xp][a-zA-Z]*|typeset\\s+-[a-zA-Z]*x[a-zA-Z]*|compgen\\s+-[ev])${END}` +
        `|${STMT}(?:sudo\\s+)?printenv\\s+\\S` +
        `|${STMT}export\\s+[$\`]`,
    ),
  },
  {
    id: "xtrace",
    what: "turns on shell tracing, which echoes every expanded command — tokens included",
    re: /\bset\s+(?:-[a-zA-Z]*x|-o\s+xtrace)\b|\b(?:ba|z|k|da)?sh\s+-[a-zA-Z]*x/,
  },
  {
    id: "print-secret",
    what: "prints a credential variable",
    re: new RegExp(`\\b(?:echo|printf|print|cat|tee|logger|less|more|head|tail)\\b[^\\n|;&]*${SECRET_REF}`),
  },
  {
    id: "heredoc-secret",
    what: "writes a credential variable through a here-document",
    re: new RegExp(`<<-?\\s*['"]?\\w+['"]?[\\s\\S]*${SECRET_REF}`),
    // A quoted delimiter (<<'EOF') does not expand, so it cannot print a value.
    unless: /<<-?\s*['"]\w+['"]/,
  },
  {
    id: "language-env",
    what: "prints environment values from a script",
    re: new RegExp(
      // the whole env object
      `\\b(?:process\\.env|os\\.environ|ENV\\.to_h)\\b(?!\\s*(?:\\.|\\[|\\.get\\s*\\(|,))` +
        // or one credential, passed to a print call
        `|\\b(?:console\\.(?:log|error|info|warn|dir)|print|puts|pp|echo|JSON\\.stringify|System\\.out\\.println|fmt\\.Print\\w*)\\s*\\(?[^\\n;]*?` +
        `(?:process\\.env\\.|process\\.env\\[\\s*['"]|os\\.environ\\[\\s*['"]|os\\.environ\\.get\\(\\s*['"]|os\\.getenv\\(\\s*['"]|ENV\\[\\s*['"]|getenv\\(\\s*['"])${SECRET_NAME}`,
    ),
  },
  {
    id: "proc-env",
    what: "reads another process's environment or command line",
    re: /\/proc\/[^\s/]+\/(?:environ|cmdline)\b/,
  },
  {
    id: "process-args",
    what: "prints full process command lines, where services often carry credentials",
    re: /\bps\b[^\n|;&]*?(?:-o\s*["']?[^\n|;&]*\b(?:args|cmd|command)\b|(?:^|\s)-\w*f\w*(?:\s|$)|(?:^|\s)a[ux][a-z]*(?:\s|$))|\bpgrep\b[^\n|;&]*(?:^|\s)-\w*a\w*(?:\s|$)/,
  },
  {
    id: "gh-token",
    what: "prints the GitHub CLI's token",
    re: /\bgh\s+auth\s+(?:token\b|status\b[^\n;|&]*(?:--show-token|\s-t\b))/,
  },
  {
    id: "git-credential",
    what: "prints a git credential",
    re: /\bgit\s+(?:credential\s+fill\b|config\b[^\n;|&]*(?:extraheader|credential|\.token\b|password))|GIT_TRACE_REDACT\s*=\s*0/i,
  },
  {
    id: "verbose-auth",
    what: "sends a credential with verbose output on, which echoes the Authorization header",
    re: new RegExp(`\\bcurl\\b(?=[^\\n;|&]*${SECRET_REF})(?=[^\\n;|&]*(?:\\s-[a-zA-Z]*v|--verbose|--trace))`),
  },
  {
    id: "secret-store",
    what: "prints values from a secrets manager",
    re: /\bdoppler\s+secrets\b(?!\s+(?:set|delete|notes)\b)(?![^\n;|&]*--only-names)/,
  },
  {
    id: "dotenv",
    what: "reads a .env file, which holds credential values",
    re: /(?:^|[;|&(]\s*)(?:cat|tac|less|more|head|tail|bat|grep|rg|awk|sed|cut|strings|xxd|od|base64|sort|jq|source|\.)(?=\s)[^\n;|&]*?[\s'"=/]\.env(?:\.[\w.-]+)?(?=$|[\s'";|&)])/,
    unless: /\.env\.(?:example|sample|template|dist|defaults?)\b/,
  },
];

export const SAFE_PATHS = [
  "gh and git already read GH_TOKEN from the environment — run the gh/git command itself.",
  "Check auth with `gh auth status` (without --show-token).",
  'Check a variable is set without printing it: `test -n "$NAME" && echo set`.',
  'Send a token in a header without echoing it: `curl -fsS -H "Authorization: token $GH_TOKEN" <url>` (no -v / --trace).',
  "Need to see which variables exist? `compgen -e` is blocked too; ask for the specific name you need, and test it with `test -n`.",
];

/** The first rule a command breaks, or undefined. */
export function violation(command) {
  if (typeof command !== "string" || command.length === 0) return undefined;
  for (const rule of RULES) {
    if (!rule.re.test(command)) continue;
    if (rule.unless && rule.unless.test(command)) continue;
    return rule;
  }
  return undefined;
}

export function message(rule) {
  return [
    `[foreman session-secret-gate] BLOCKED (${rule.id}): this command ${rule.what}.`,
    "Anything a command prints lands in this session's transcript, a permanent log — a printed credential is a leaked one.",
    "Do not rewrite the command to get around this (no base64, eval, temp files or another interpreter). Safe paths:",
    ...SAFE_PATHS.map((s) => `  - ${s}`),
  ].join("\n");
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  if (input?.tool_name && input.tool_name !== "Bash") process.exit(0);
  const rule = violation(input?.tool_input?.command);
  if (!rule) process.exit(0);
  process.stderr.write(message(rule) + "\n");
  process.exit(2);
}

// Run only as a hook, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) main();
