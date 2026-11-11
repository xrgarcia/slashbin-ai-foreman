// A runner that refused work, told apart from one that failed at it.
//
// An agent CLI out of tokens, over its session limit or rate-limited has not
// failed on the merits: the same work succeeds once the limit lifts. Charging
// that refusal to a retry counter spends the retries on nothing (2026-10-01:
// 393 Claude refusals in four hours deadlocked a repo), and reporting it as a
// failure sends a person a non-question (2026-11-05: the EM seat ran out of
// tokens and its "could not answer" became a decision for the owner).
//
// What a refusal LOOKS like belongs to the runner, not to the Foreman. So the
// Foreman's core holds only the rule (`detectRefusal`: match the configured
// patterns or exit codes, read a stated reset time); the patterns are config
// (`runner` in .ai-agent.json). Claude's are the shipped defaults, as data, so
// a Codex or any other CLI is a config change and never a code change.
//
// Core: no phase, source or plugin code here. Module-level like backoff.ts:
// detection runs inside session parsing and agent plugins, which take no config,
// so the daemon hands the live block over at start and on every reload.
import { z } from "zod";

/** Claude's refusals: a final stream-json result carrying HTTP 429, or the "You've hit your … limit" banner, also behind a wrapper's prefix ("em unstick failed: session ERROR: You've hit …"). */
export const CLAUDE_REFUSAL_PATTERNS: readonly string[] = Object.freeze([
  String.raw`"api_error_status"\s*:\s*429\b`,
  String.raw`\bYou(?:'|’)ve hit your\b[^\n]*\blimit`,
]);

/** Claude's stated reset: `resets 12:10pm (America/Chicago)`. Named groups hour, minute, ampm, zone. */
export const CLAUDE_RESET_PATTERN = String.raw`resets\s+(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<ampm>am|pm)\s*\((?<zone>[^)]+)\)`;

// A string that must compile as a regular expression: a bad pattern fails at
// config load, never silently at the moment a refusal needs recognising.
const regex = z.string().min(1).refine((s) => {
  try { new RegExp(s, "mi"); return true; } catch { return false; }
}, "not a valid regular expression");

export const runnerConfigSchema = z.object({
  // The agent CLI's display name. It keys the daemon-wide limit back-off and
  // names the runner in every note ("stopped: Claude usage limit"). Default
  // "Claude".
  name: z.string().min(1).default("Claude"),
  // How a refusal shows in the runner's output. Every case-insensitive,
  // multiline regex in `patterns` is tried against the tail of stdout and
  // stderr. A match is a refusal: no retry is charged, and the runner is paused
  // daemon-wide until the limit lifts. Default: Claude's 429 result and its
  // "You've hit your … limit" banner. Set your runner's own for Codex or any
  // other CLI.
  refusalPatterns: z.array(regex).default([...CLAUDE_REFUSAL_PATTERNS]),
  // Exit codes that mean a refusal, for a runner that signals one by its exit
  // status. Default none.
  refusalExitCodes: z.array(z.coerce.number().int()).default([]),
  // Where a refusal states when the limit lifts. Named groups: `iso` (any
  // Date-parseable time), or `hour` with optional `minute`, `ampm` and `zone`
  // (an IANA zone, else the daemon's). A stated reset wins over the back-off
  // window, so the runner is not probed before it can answer. Default Claude's
  // "resets 12:10pm (America/Chicago)".
  resetPattern: regex.default(CLAUDE_RESET_PATTERN),
}).prefault({});

export type RunnerConfig = Readonly<z.infer<typeof runnerConfigSchema>>;

/** What a config with no `runner` block runs on: Claude. */
export const DEFAULT_RUNNER: RunnerConfig = Object.freeze(runnerConfigSchema.parse({}));

/** A run the runner refused: why, in its own words, and when it said the limit lifts. */
export interface Refusal {
  reason: string;
  resetAtMs?: number;
}

/** What a finished run left behind. */
export interface RunOutput {
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
}

/** Process-wide: the live runner block, handed over by the daemon at start and reload. */
let active: RunnerConfig = DEFAULT_RUNNER;

/** Apply the loaded `runner` block daemon-wide. Until called, Claude's defaults stand. */
export function configureRunner(r: RunnerConfig): void {
  active = r;
}

/** The `runner` block in force daemon-wide. */
export function runnerSettings(): RunnerConfig {
  return active;
}

/** The builder runner's name: the key its back-off is kept under. */
export function runnerName(): string {
  return active.name;
}

/** How much of each stream is read: a refusal is the run's last word, never buried mid-transcript. */
const TAIL = 8_000;

/**
 * Whether a finished run was a refusal, by `rules` (the live block by default).
 * Pure apart from the clock `now`.
 */
export function detectRefusal(out: RunOutput, rules: Pick<RunnerConfig, "refusalPatterns" | "refusalExitCodes" | "resetPattern"> = active, now = Date.now()): Refusal | undefined {
  const text = [out.stdout.slice(-TAIL), (out.stderr ?? "").slice(-TAIL)].filter(Boolean).join("\n");
  let reason: string | undefined;
  for (const p of rules.refusalPatterns) {
    const m = new RegExp(p, "mi").exec(text);
    if (m) { reason = reasonOf(lineAt(text, m.index)); break; }
  }
  if (reason === undefined && out.exitCode !== undefined && out.exitCode !== null && rules.refusalExitCodes.includes(out.exitCode)) {
    reason = `exit ${out.exitCode}`;
  }
  if (reason === undefined) return undefined;
  return { reason, resetAtMs: parseReset(text, rules.resetPattern, now) };
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The refusal in the runner's own words: a JSON line's message field, else the line itself. */
function reasonOf(line: string): string {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    for (const k of ["result", "message", "error"]) {
      const v = o?.[k];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 300);
    }
  } catch {
    // a plain-text line
  }
  return line.trim().slice(0, 300) || "runner refused the run";
}

/**
 * The first future instant `pattern` names in `text`, as epoch ms; undefined when
 * it names none, or one already past. Wall-clock times resolve through Intl in
 * their zone, so DST is honoured. Pure apart from `now`.
 */
export function parseReset(text: string, pattern: string, now = Date.now()): number | undefined {
  let g: Record<string, string | undefined> | undefined;
  try {
    g = new RegExp(pattern, "i").exec(text)?.groups;
  } catch {
    return undefined;
  }
  if (!g) return undefined;
  if (g.iso) {
    const at = Date.parse(g.iso);
    return Number.isFinite(at) && at > now ? at : undefined;
  }
  if (g.hour === undefined) return undefined;
  let hour = Number(g.hour);
  const minute = g.minute ? Number(g.minute) : 0;
  if (g.ampm) {
    hour %= 12;
    if (g.ampm.toLowerCase() === "pm") hour += 12;
  }
  if (!Number.isInteger(hour) || hour > 23 || minute > 59) return undefined;
  const zone = g.zone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const today = zonedParts(now, zone);
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const at = zonedWallToUtc(today.year, today.month, today.day + dayOffset, hour, minute, zone);
      if (at > now) return at;
    }
  } catch {
    // RangeError on an unknown time zone
  }
  return undefined;
}

function zonedParts(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset (ms) of `zone` from UTC at instant `ms`. */
function zoneOffset(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in `zone` (day may overflow; Date.UTC normalises it). */
function zonedWallToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffset(guess, zone);
  return guess - zoneOffset(first, zone);
}

/**
 * Classify a FAILED builder run as a refusal by the live runner, or `undefined`.
 * Claude's by default: a final stream-json result with `api_error_status: 429`,
 * or the plain "You've hit your … limit" banner. A bare "session limit"
 * substring in prose is NOT enough.
 */
export function detectUpstreamLimit(stdout: string, stderr?: string, exitCode?: number | null): Refusal | undefined {
  return detectRefusal({ stdout, stderr, exitCode });
}

/** Claude's `resets 12:10pm (America/Chicago)` → the next such instant, as epoch ms; undefined when unparseable. */
export function parseClaudeReset(text: string, now = Date.now()): number | undefined {
  return parseReset(text, CLAUDE_RESET_PATTERN, now);
}
