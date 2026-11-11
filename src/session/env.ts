import type { LifecycleLabels } from "../config.js";
import type { ClaudeTrust } from "../claude-trust.js";
import { redactAll } from "../redact.js";
import { DEFAULT_GITHUB_CONVENTIONS, type GithubConventions } from "../config-schema/github.js";

export interface SpawnOptions {
  /** The runtime's Claude Code trust: the checkout is trusted before the session starts. */
  trust: ClaudeTrust;
  /** Working directory for the claude process. */
  cwd: string;
  /** Daemon env names the session inherits on top of SESSION_ENV_ESSENTIALS (config `sessionEnv`). */
  sessionEnv: string[];
  /** Value to inject as GH_TOKEN (controls GitHub account attribution). */
  ghToken?: string;
  /** The repo's trigger label, handed to the session as FOREMAN_TRIGGER_LABEL. */
  triggerLabel: string;
  /** The configured lifecycle labels, handed to the session as FOREMAN_LIFECYCLE_LABELS. */
  lifecycleLabels: LifecycleLabels;
  /** The `github` block: its blocked and priority labels reach the session as FOREMAN_BLOCKED_LABEL / FOREMAN_PRIORITY_LABELS. */
  github?: GithubConventions;
  model?: string;
  allowedTools: string[];
  /** MCP client config to load (`--mcp-config`); each server it names is allowed. */
  mcpConfig?: string;
  maxTurns: number;
  maxDurationMs: number;
  /**
   * Emit the full turn-by-turn interaction as newline-delimited JSON
   * (`--output-format stream-json --verbose`) instead of just the final text.
   * Used by the review phase so the transcript captures every tool call + result.
   */
  streamJson?: boolean;
  /**
   * When set, the raw stdout/stderr stream is appended to this file verbatim for
   * post-hoc debugging. The directory is created if needed.
   */
  transcriptPath?: string;
  /**
   * What this run was working on, for the timeout line. `Claude CLI timed out
   * after 3600000ms` with nothing else on it reads as a daemon fault; the owner
   * read exactly that as "the merge did not happen" on 2026-09-22 (issue #41),
   * when in fact the run had merged the PR 55 minutes earlier.
   */
  runLabel?: string;
  /** Extra session env on top of the label env every session gets. */
  extraEnv?: Record<string, string>;
}

/**
 * Daemon env names every session inherits when set: what a shell, git over SSH
 * and the Claude CLI need to run. Nothing else crosses unless `sessionEnv`
 * names it.
 */
export const SESSION_ENV_ESSENTIALS: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TZ", "TMPDIR", "TERM", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK",
];

/** Copy each name present in the daemon env. */
export function pickEnv(names: readonly string[], into: Record<string, string> = {}): Record<string, string> {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined) into[n] = v;
  }
  return into;
}

/**
 * A Claude session's whole environment, built from an allowlist.
 *
 * It used to be `{ ...process.env }`. The production daemon runs under
 * `doppler run`, so every session — run with --dangerously-skip-permissions —
 * held every secret in that config, both GitHub tokens among them; on
 * 2026-10-01 a custom-stage session listed its env and printed
 * FOREMAN_GITHUB_TOKEN into its Claude transcript.
 *
 * Order matters: the inherited names first, then GH_TOKEN, the label vars and
 * extraEnv, so nothing inherited can overwrite the token this phase assigned.
 * Set here because every session goes through spawnClaudeWithOptions — a new
 * caller cannot forget the label vars or widen the env by accident.
 */
export function buildSessionEnv(opts: SpawnOptions): Record<string, string> {
  const env = pickEnv([...SESSION_ENV_ESSENTIALS, ...(opts.sessionEnv ?? [])]);
  // GH_TOKEN must be a string or absent — never literal "undefined".
  if (opts.ghToken) env.GH_TOKEN = opts.ghToken;
  // The configured label names, for the skill. The daemon filtering on a renamed
  // trigger label while the skill runs `gh issue list --label approved` selects
  // work the agent never finds, so the skill reads these instead of its own
  // literals. Labels as one JSON map (`JSON.parse` once, iterate the set); the
  // trigger label on its own, since it selects work and a skill uses it alone in
  // `--label`.
  setLabelEnv(env, opts.triggerLabel, opts.lifecycleLabels, opts.github);
  if (opts.extraEnv) Object.assign(env, opts.extraEnv);
  return env;
}

/**
 * Every label name a session may read or write: the trigger label alone (it is
 * used alone in `--label`), the lifecycle labels and the priority tiers as JSON,
 * and the blocked label. Set the same way for the builder, the Tech Lead and the
 * SRE, so no skill falls back on a literal name.
 */
export function setLabelEnv(
  env: Record<string, string>,
  triggerLabel: string | undefined,
  lifecycleLabels: LifecycleLabels | undefined,
  github: GithubConventions = DEFAULT_GITHUB_CONVENTIONS,
): void {
  if (triggerLabel) env.FOREMAN_TRIGGER_LABEL = triggerLabel;
  if (lifecycleLabels) env.FOREMAN_LIFECYCLE_LABELS = JSON.stringify(lifecycleLabels);
  env.FOREMAN_BLOCKED_LABEL = github.blockedLabel;
  env.FOREMAN_PRIORITY_LABELS = JSON.stringify(github.priorityLabels);
}

/** A value shorter than this is not redacted: too likely to match ordinary text. */
const MIN_SECRET_LENGTH = 8;

/**
 * The values redacted from everything a child prints: every agent's GitHub token and
 * each `sessionEnv` name, read from the daemon env at spawn, 8+ characters,
 * longest first (so a value containing another is replaced whole).
 */
export function secretValues(sessionEnv: readonly string[]): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const name of ["FOREMAN_GITHUB_TOKEN", "EM_GITHUB_TOKEN", "TECHLEAD_GITHUB_KEY", "SRE_GITHUB_KEY", ...sessionEnv]) {
    const value = process.env[name];
    if (value !== undefined && value.length >= MIN_SECRET_LENGTH && !out.some((s) => s.value === value)) {
      out.push({ name, value });
    }
  }
  return out.sort((a, b) => b.value.length - a.value.length);
}

/**
 * Redact a stream written in chunks. A value split across two chunks would
 * escape a per-chunk redactor, so `push` holds back the last L − 1 characters
 * (L = longest value) — the most of a value that can still be incomplete — and
 * prepends them to the next chunk. `flush` releases the held tail; it MUST run
 * before the stream ends, or whatever was written last (the run's trailer) is lost.
 */
export function createStreamRedactor(secrets: ReadonlyArray<{ name: string; value: string }>): {
  push(chunk: string): string;
  flush(): string;
} {
  const hold = secrets.reduce((m, s) => Math.max(m, s.value.length), 0) - 1;
  let tail = "";
  return {
    push(chunk: string): string {
      if (secrets.length === 0) return chunk;
      const text = redactAll(tail + chunk, secrets);
      const cut = Math.max(0, text.length - hold);
      tail = text.slice(cut);
      return text.slice(0, cut);
    },
    flush(): string {
      const out = redactAll(tail, secrets);
      tail = "";
      return out;
    },
  };
}
