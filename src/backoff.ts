// Every wait the Foreman makes before it tries something again, in one place:
// the `backoff` config block, the one formula every wait uses, and the tracker
// that holds a per-repo wait. Core: no phase, source or plugin code here.
// docs/configuration.md is generated from the comments in backoffConfigSchema.
//
// The formula: the Nth wait in a row lasts min(baseMs * factor^(N-1), capMs).
// A success clears the count, so the next spell of trouble starts again at
// baseMs. One short wait for a blip, longer ones only while the trouble lasts —
// never one long fixed wait for everything.
import { z } from "zod";

const ms = z.coerce.number().int().positive();
const factor = z.coerce.number().min(1);

/** The three numbers every wait has. */
const win = (baseMs: number, capMs: number, f: number) => ({
  baseMs: ms.default(baseMs),
  capMs: ms.default(capMs),
  factor: factor.default(f),
});
const count = (n: number) => z.coerce.number().int().positive().default(n);

// Each group below is one condition the Foreman backs off on. Every group has
// `baseMs` (the first wait), `capMs` (the longest), and `factor` (how much each
// wait in a row grows; 1 makes it a fixed wait). Additive and OSS-safe: a config
// without `backoff` gets these defaults.
export const backoffConfigSchema = z.object({
  // An issue the implement session declined on purpose (blocked on something
  // outside the repo, investigation only, already done). It is hidden from the
  // next sessions for one window; each decline in a row doubles it. Default
  // 5 min rising to 4 h (was 30 min rising to 24 h). The old top-level
  // `skipBackoffMs` still sets `baseMs`.
  skip: z.object(win(300_000, 14_400_000, 2)).prefault({}),
  // A dev verification that ran and did not pass. The issue is re-verified after
  // one window, longer each time; after `maxAttempts` failed runs it waits for a
  // person (new commits on the base branch reopen it). Default 10 min, then
  // 20 min, then a person (was a fixed 1 h between each of 3).
  verifyRetry: z.object({ ...win(600_000, 3_600_000, 2), maxAttempts: count(3) }).prefault({}),
  // The Tech Lead (review) or the SRE (verify) could not run at all, e.g. Codex
  // is unavailable. Costs no attempt; the repo just asks again after one window,
  // per repo and per stage. Default 2 min rising to 30 min (was a fixed 15 min).
  agentUnavailable: z.object(win(120_000, 1_800_000, 2)).prefault({}),
  // A repo whose implement or review sessions failed `maxFailures` times in a row
  // pauses that stage for one window, longer each time it trips again; a
  // successful session clears it. `maxFailures` is also how many failed
  // revisions escalate a PR to a person. Default 2 failures, then 5 min rising to
  // 1 h (was a fixed 3 poll cycles).
  repoFailure: z.object({ ...win(300_000, 3_600_000, 2), maxFailures: count(2) }).prefault({}),
  // GitHub's rate limit or Claude's session limit refused work. The whole daemon
  // pauses that upstream; a GitHub reset time it reports wins over the window.
  // Default 2 min rising to 1 h. The old top-level `upstreamBackoffBaseMs` /
  // `upstreamBackoffCapMs` still set `baseMs` / `capMs`.
  upstream: z.object(win(120_000, 3_600_000, 2)).prefault({}),
  // One `gh` call that failed for a passing reason (network, 5xx, timeout) is
  // retried in place, up to `maxAttempts` tries in all. A rate limit is never
  // retried here (that is `upstream`). Default 1 s, then 3 s.
  gh: z.object({ ...win(1_000, 30_000, 3), maxAttempts: count(3) }).prefault({}),
  // How long after a PR merged before its issue, still unadvanced, is reported as
  // stuck (the dead zone). Shorter flags a merge the review is still settling.
  stuckMergeGraceMs: ms.default(900_000),
  // How many times a PR with red CI is sent back to revise without a review
  // before it is reviewed anyway, so a reviewer sees it. 0 never bounces.
  maxCiBounces: z.coerce.number().int().nonnegative().default(2),
}).prefault({});

export type BackoffConfig = Readonly<z.infer<typeof backoffConfigSchema>>;
/** One wait's numbers: the first wait, the longest, and the growth per wait in a row. */
export interface BackoffWindow { readonly baseMs: number; readonly capMs: number; readonly factor: number }

/** The defaults: what a config with no `backoff` block runs on. */
export const DEFAULT_BACKOFF: BackoffConfig = Object.freeze(backoffConfigSchema.parse({}));

/** How long the `n`th wait in a row lasts (n counts from 1): min(base * factor^(n-1), cap). */
export function backoffDelay(n: number | undefined, w: BackoffWindow): number {
  const k = Math.max(1, Math.floor(n ?? 1));
  // Past ~50 doublings the product is beyond any cap; stop before Infinity.
  return Math.min(w.baseMs * w.factor ** Math.min(k - 1, 50), w.capMs);
}

/** A wait's length for a log line: "45 s", "5 min", "1.5 h". */
export function formatWait(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round((ms / 3_600_000) * 10) / 10} h`;
}

/** The env override for a `backoff` field: `AI_AGENT_BACKOFF_<GROUP>_<FIELD>`. */
export function backoffEnvName(group: string, field?: string): string {
  const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return `AI_AGENT_BACKOFF_${snake(group)}${field ? `_${snake(field)}` : ""}`;
}

/** The old top-level keys, each still honoured: file value, and env value. */
export interface LegacyBackoffKeys {
  skipBackoffMs?: unknown;
  upstreamBackoffBaseMs?: unknown;
  upstreamBackoffCapMs?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The raw `backoff` block to parse, by precedence: the old top-level file keys,
 * then the file's `backoff` block, then the old env names, then
 * `AI_AGENT_BACKOFF_*`. A non-object block is passed through for zod to reject.
 */
export function mergeBackoff(fromFile: unknown, legacyFile: LegacyBackoffKeys = {}, legacyEnv: LegacyBackoffKeys = {}): unknown {
  if (fromFile !== undefined && !isObject(fromFile)) return fromFile;
  const out: Record<string, Record<string, unknown> | unknown> = {};
  const set = (group: string, field: string | undefined, v: unknown) => {
    if (v === undefined) return;
    if (!field) { out[group] = v; return; }
    out[group] = { ...(isObject(out[group]) ? out[group] : {}), [field]: v };
  };
  const legacy = (l: LegacyBackoffKeys) => {
    set("skip", "baseMs", l.skipBackoffMs);
    set("upstream", "baseMs", l.upstreamBackoffBaseMs);
    set("upstream", "capMs", l.upstreamBackoffCapMs);
  };
  legacy(legacyFile);
  for (const [group, v] of Object.entries(fromFile ?? {})) {
    if (isObject(v)) for (const [field, fv] of Object.entries(v)) set(group, field, fv);
    else set(group, undefined, v);
  }
  legacy(legacyEnv);
  for (const [group, v] of Object.entries(DEFAULT_BACKOFF)) {
    if (isObject(v)) for (const field of Object.keys(v)) set(group, field, process.env[backoffEnvName(group, field)]);
    else set(group, undefined, process.env[backoffEnvName(group)]);
  }
  return out;
}

// --- The daemon-wide settings, for code that is handed no config ---
//
// The phases read `config.backoff`. The gh runner, the CI gate, the lifecycle
// scans and the upstream back-off are module-level and take no config, so the
// daemon hands them the same block here at start and on every config reload.

let active: BackoffConfig = DEFAULT_BACKOFF;

/** Apply the loaded `backoff` block daemon-wide. Until called, the defaults stand. */
export function configureBackoff(b: BackoffConfig): void {
  active = b;
}

/** The `backoff` block in force daemon-wide. */
export function backoffSettings(): BackoffConfig {
  return active;
}

/**
 * Per-key waits in a row: a repo's review waiting on the Tech Lead, a repo
 * paused after failures. `start` begins the next wait (each longer, per the
 * window); `clear` ends the spell, so the next one starts at `baseMs` again.
 * In memory: a restart clears every wait, which is safe — it only retries sooner.
 */
export class BackoffTracker {
  private readonly by = new Map<string, { until: number; count: number }>();

  /** Begin the next wait for `key`. Returns its length in ms. */
  start(key: string, w: BackoffWindow, now = Date.now()): number {
    const count = (this.by.get(key)?.count ?? 0) + 1;
    const wait = backoffDelay(count, w);
    this.by.set(key, { until: now + wait, count });
    return wait;
  }

  /** Whether `key` is inside a wait right now. */
  waiting(key: string, now = Date.now()): boolean {
    return (this.by.get(key)?.until ?? 0) > now;
  }

  /** How many waits in a row `key` has had (0 when clear). */
  count(key: string): number {
    return this.by.get(key)?.count ?? 0;
  }

  /** The trouble is over: forget the count. */
  clear(key: string): void {
    this.by.delete(key);
  }
}
