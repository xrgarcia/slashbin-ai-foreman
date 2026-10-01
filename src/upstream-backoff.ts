import { execFileSync } from "node:child_process";

/**
 * Daemon-wide back-off for upstreams that refuse work: the GitHub API rate limit
 * (primary or secondary) and the Claude account session limit.
 *
 * A limit is a property of the ACCOUNT, not of one call. Once one `gh` call is
 * refused, every call on that token is refused until the reset; once one Claude
 * launch is refused, so is every other. The code used to model both as a
 * per-call failure, so every repo loop kept polling into the wall.
 *
 * 2026-10-01: 4,526 `RATE LIMIT EXHAUSTED` lines and 393 Claude session-limit
 * refusals in under four hours, every refusal charged to a per-repo retry
 * counter. Slashbin-io-docs PR #411 exhausted its revision retries on refusals
 * alone and deadlocked that repo until a manual restart.
 *
 * This module is the ONLY owner of that state — one entry per upstream, shared
 * by every repo loop. Nothing else stores a limit, a window or a probe result.
 *
 *  - github: `runGh` refuses to spawn while blocked; at each window end the
 *    module itself probes `gh api rate_limit` (free against the REST quota) per
 *    configured token and either clears or extends.
 *  - claude: there is no free probe, so the next real launch IS the probe. At
 *    window end the state goes half-open and `tryAcquire` admits exactly one
 *    caller; its result clears or extends.
 *
 * One Discord message per transition per upstream (enter, extend, clear) —
 * never per repo or per refused call.
 */

export type Upstream = "github" | "claude";

/** Thrown by `runGh` while GitHub is backing off — no `gh` process was spawned. */
export class UpstreamBackoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamBackoffError";
  }
}

type Level = "info" | "warn" | "error";

interface UpstreamState {
  state: "clear" | "blocked" | "half-open";
  /** Consecutive windows in the current (or most recent) episode. */
  consecutive: number;
  /** When the current window ends (ms epoch). */
  until: number;
  lastClearedAt: number;
  lastWindowMs: number;
  /** A stated reset (Claude "resets 12:10pm (...)") not yet reached. */
  resetAtMs?: number;
  /** claude only: the single half-open launch has been handed out. */
  probeOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: (() => void)[];
}

const NAMES: Record<Upstream, string> = { github: "GitHub", claude: "Claude" };

let baseMs = 120_000;
let capMs = 3_600_000;
let notifyFn: ((text: string, level: Level) => void) | undefined;

const states: Record<Upstream, UpstreamState> = {
  github: freshState(),
  claude: freshState(),
};

function freshState(): UpstreamState {
  return {
    state: "clear", consecutive: 0, until: 0, lastClearedAt: 0, lastWindowMs: 0,
    probeOut: false, timer: null, waiters: [],
  };
}

/**
 * Apply daemon-level settings. Called once at startup; the defaults (2 min base,
 * 60 min cap, log-only) stand if it is never called.
 */
export function configureUpstreamBackoff(opts: {
  baseMs: number;
  capMs: number;
  notify?: (text: string, level: Level) => void;
}): void {
  if (Number.isFinite(opts.baseMs) && opts.baseMs > 0) baseMs = opts.baseMs;
  if (Number.isFinite(opts.capMs) && opts.capMs > 0) capMs = opts.capMs;
  notifyFn = opts.notify;
}

function notify(text: string, level: Level): void {
  // With no notifier the transition still reaches the log — a back-off must
  // never be silent just because the Discord bridge is off.
  if (notifyFn) {
    try {
      notifyFn(text, level);
    } catch {
      // a broken notifier must not wedge the state machine
    }
  } else {
    console.warn(`[upstream] ${text}`);
  }
}

/** `min(base * 2^(n-1), cap)` — same shape as the per-issue skip back-off. */
function windowFor(consecutive: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, consecutive - 1), capMs);
}

function formatDuration(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (ms < 60_000) return plural(Math.max(1, Math.round(ms / 1000)), "second");
  if (ms < 3_600_000) return plural(Math.round(ms / 60_000), "minute");
  return plural(Math.round((ms / 3_600_000) * 10) / 10, "hour");
}

/** Local wall-clock HH:MM of an epoch-ms instant. */
function formatClock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

function schedule(u: Upstream, windowMs: number): void {
  const s = states[u];
  if (s.timer) clearTimeout(s.timer);
  s.until = Date.now() + windowMs;
  s.lastWindowMs = windowMs;
  s.timer = setTimeout(() => {
    s.timer = null;
    onWindowEnd(u);
  }, windowMs);
  // The back-off must not hold a finished process (`--once`, tests) open; the
  // daemon's own loops keep it alive while it runs.
  s.timer.unref?.();
}

function enter(u: Upstream, reason: string, resetAtMs?: number): void {
  const s = states[u];
  const now = Date.now();
  // A re-entry soon after a clear (a secondary limit the probe cannot see)
  // continues the doubling; a later one starts again at the base.
  s.consecutive = s.lastClearedAt > 0 && now - s.lastClearedAt < s.lastWindowMs ? s.consecutive + 1 : 1;
  s.state = "blocked";
  s.probeOut = false;
  s.resetAtMs = resetAtMs !== undefined && resetAtMs > now ? resetAtMs : undefined;
  const windowMs = windowFor(s.consecutive);
  schedule(u, windowMs);
  notify(`Foreman backing off ${NAMES[u]} for ${formatDuration(windowMs)} — ${reason}`, "warn");
}

function extend(u: Upstream, resetAtMs?: number): void {
  const s = states[u];
  const now = Date.now();
  s.consecutive++;
  s.state = "blocked";
  s.probeOut = false;
  const stated = resetAtMs !== undefined && resetAtMs > now ? resetAtMs : undefined;
  s.resetAtMs = u === "claude" ? stated : undefined;
  const windowMs = Math.max(windowFor(s.consecutive), stated !== undefined ? stated - now : 0);
  schedule(u, windowMs);
  notify(
    `Foreman still limited by ${NAMES[u]} — backing off ${formatDuration(windowMs)} (until ${formatClock(now + windowMs)})`,
    "warn",
  );
}

function clear(u: Upstream): void {
  const s = states[u];
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  s.state = "clear";
  s.probeOut = false;
  s.resetAtMs = undefined;
  s.lastClearedAt = Date.now();
  notify(`Foreman ${NAMES[u]} back-off cleared — resuming`, "info");
  releaseWaiters(u);
}

function releaseWaiters(u: Upstream): void {
  const waiters = states[u].waiters.splice(0);
  for (const w of waiters) w();
}

function onWindowEnd(u: Upstream): void {
  if (u === "github") {
    const probe = probeGitHub();
    if (probe.clear) clear("github");
    else extend("github", probe.resetAtMs);
    return;
  }
  const s = states.claude;
  const now = Date.now();
  if (s.resetAtMs !== undefined && s.resetAtMs > now) {
    // Claude said when it resets; probing before then only spends a launch.
    const windowMs = s.resetAtMs - now;
    schedule("claude", windowMs);
    notify(`Foreman still limited by Claude — backing off until ${formatClock(s.resetAtMs)}`, "warn");
    return;
  }
  s.state = "half-open";
  s.probeOut = false;
  releaseWaiters("claude");
}

interface RateResource {
  remaining?: number;
  reset?: number;
}

/**
 * One `gh api rate_limit` per configured token, deliberately NOT via `runGh`
 * (which refuses while blocked). Clear only when core AND graphql have quota
 * on EVERY token. The reset of the latest exhausted resource bounds the next
 * window; a probe that itself fails extends on the computed window alone.
 */
function probeGitHub(): { clear: boolean; resetAtMs?: number } {
  const tokens = [process.env.FOREMAN_GITHUB_TOKEN, process.env.EM_GITHUB_TOKEN].filter(
    (t): t is string => !!t,
  );
  // No token configured: probe with the ambient gh auth so the state can still clear.
  const envs = tokens.length > 0
    ? tokens.map((t) => ({ ...process.env, GH_TOKEN: t }))
    : [{ ...process.env }];
  let allClear = true;
  let latestReset = 0;
  for (const env of envs) {
    try {
      const out = execFileSync("gh", ["api", "rate_limit"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        env,
      });
      const resources = (JSON.parse(out)?.resources ?? {}) as Record<string, RateResource>;
      for (const name of ["core", "graphql"]) {
        const r = resources[name];
        if (typeof r?.remaining === "number" && r.remaining > 0) continue;
        allClear = false;
        if (typeof r?.reset === "number") latestReset = Math.max(latestReset, r.reset);
      }
    } catch (err) {
      allClear = false;
      console.warn(`[upstream] GitHub rate_limit probe failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  return allClear ? { clear: true } : { clear: false, resetAtMs: latestReset > 0 ? latestReset * 1000 : undefined };
}

/**
 * Record that an upstream refused work. Enters the back-off when clear; while
 * already backing off it is a no-op (no second message).
 */
export function signalUpstreamLimit(u: Upstream, reason: string, resetAtMs?: number): void {
  if (states[u].state !== "clear") return;
  enter(u, reason, resetAtMs);
}

/** True while blocked, and for claude also while the half-open probe is out. */
export function isUpstreamBlocked(u: Upstream): boolean {
  const s = states[u];
  if (s.state === "blocked") return true;
  return s.state === "half-open" && s.probeOut;
}

/** Resolves immediately when clear; otherwise when the back-off ends. */
export function whenUpstreamClear(u: Upstream): Promise<void> {
  if (!isUpstreamBlocked(u)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    states[u].waiters.push(resolve);
  });
}

/**
 * Permission to launch a Claude session. False while blocked or while the
 * half-open probe is out; true exactly once when half-open (that launch is the
 * probe, and its `reportClaudeResult` decides clear vs extend).
 */
export function tryAcquire(u: "claude"): boolean {
  const s = states[u];
  if (s.state === "clear") return true;
  if (s.state === "half-open" && !s.probeOut) {
    s.probeOut = true;
    return true;
  }
  return false;
}

/**
 * Report a finished Claude launch. `limited` = the run was refused by the
 * session limit. Concurrent sessions refused in the same window produce one
 * message and one window; only the half-open probe's result can clear or extend.
 */
export function reportClaudeResult(limited: boolean, reason?: string, resetAtMs?: number): void {
  const s = states.claude;
  if (s.state === "clear") {
    if (limited) enter("claude", reason ?? "Claude session limit", resetAtMs);
    return;
  }
  if (s.state === "blocked") {
    if (limited && resetAtMs !== undefined && resetAtMs > Date.now() && resetAtMs > (s.resetAtMs ?? 0)) {
      s.resetAtMs = resetAtMs;
    }
    return;
  }
  // half-open
  if (limited) extend("claude", resetAtMs);
  else clear("claude");
}
