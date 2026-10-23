import { isCustomStage, stageName, type StageEntry, type StageType } from "./stages.js";

// --- Lanes: the unit of concurrency ------------------------------------------
//
// A repo pass used to run every stage in one serial loop, so a 30-minute
// revision on a repo held up that repo's release, verify and review behind it
// (jerky_service 2026-10-14: release PR #146 sat behind a revision and the next
// build). Now each stage group is a LANE, and every (repo, lane) pair drives its
// own loop. A lane runs at most one item per repo at a time; different lanes of
// one repo run side by side; across repos the lane is as wide as the fleet.
//
// Two lanes join stages that must stay in order with each other:
//  - `build`   = revise, then implement — one feature branch, one card being
//                built at a time, and a revision always goes before new work.
//  - `release` = promote, then release — release acts on the release PR that
//                promote just opened or updated.
// Every other built-in is a lane of its own (`unstick` too: a 20-minute EM call
// must not hold a verify or a release).

/** The lane a built-in stage belongs to. */
const LANE_OF: Record<StageType, string> = {
  reconcile: "reconcile",
  review: "review",
  verify: "verify",
  promote: "release",
  release: "release",
  revise: "build",
  implement: "build",
  "branch-sync": "branch-sync",
  dependabot: "dependabot",
  unstick: "unstick",
};

export interface Lane {
  /** Names the lane in logs (`lane=`) and in the daemon's loop key. */
  name: string;
  /** The lane's stages, in configured order. */
  stages: StageEntry[];
}

/**
 * Group the configured stages into lanes, in order of first appearance.
 *
 * A custom stage gates the built-in that FOLLOWS it in `stages`, so it joins
 * that built-in's lane and its `blocked`/`failed` verdict stops the rest of
 * that lane's pass — nothing else. (Before lanes it stopped every later stage
 * of the repo pass; a gate now holds the lane it sits in front of.) A custom
 * stage with no built-in after it runs in a lane of its own, named by its id.
 */
export function lanesFor(stages: readonly StageEntry[]): Lane[] {
  const lanes: Lane[] = [];
  const byName = new Map<string, Lane>();
  let pending: StageEntry[] = [];
  const add = (name: string, entries: StageEntry[]): void => {
    let lane = byName.get(name);
    if (!lane) {
      lane = { name, stages: [] };
      byName.set(name, lane);
      lanes.push(lane);
    }
    lane.stages.push(...entries);
  };
  for (const s of stages) {
    if (isCustomStage(s)) {
      pending.push(s);
      continue;
    }
    add(LANE_OF[s.type], [...pending, s]);
    pending = [];
  }
  if (pending.length > 0) add(stageName(pending[0]), pending);
  return lanes;
}

/**
 * True when the stage changes the repo's shared working clone (`repoPath`):
 * checkouts, merges, pushes, or a Claude session whose cwd is the clone. Those
 * serialize on the repo's checkout lock. Everything else works through the
 * GitHub API, the Tech Lead's or the SRE's own directory, or review's separate
 * clone (review-checkout.ts), and must NOT wait on a build.
 */
export function stageNeedsCheckout(s: StageEntry): boolean {
  if (isCustomStage(s)) return true; // cwd = repoPath (runCustomStage)
  return s.type === "reconcile" || s.type === "revise" || s.type === "implement";
}

/**
 * True when the stage may start a Claude session or a Tech Lead / SRE run.
 * None of these may START once a shutdown is under way, and these are what
 * `maxConcurrentSessions` counts.
 */
export function stageSpawnsSession(s: StageEntry): boolean {
  if (isCustomStage(s)) return true;
  return s.type === "review" || s.type === "verify" || s.type === "revise" || s.type === "implement" || s.type === "release" || s.type === "unstick";
}

// --- Per-repo checkout lock --------------------------------------------------

/** A FIFO async mutex. */
class Mutex {
  private held = false;
  private readonly waiters: Array<() => void> = [];
  async acquire(): Promise<() => void> {
    if (this.held) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(); // hand over directly; `held` stays true
      else this.held = false;
    };
  }
  get waiting(): number {
    return this.waiters.length;
  }
}

async function withKeyedLock<T>(locks: Map<string, Mutex>, key: string, fn: () => Promise<T>): Promise<T> {
  let m = locks.get(key);
  if (!m) {
    m = new Mutex();
    locks.set(key, m);
  }
  const release = await m.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

const checkoutLocks = new Map<string, Mutex>();
const laneLocks = new Map<string, Mutex>();

/** Run `fn` holding `repoName`'s checkout lock: one clone-touching stage at a time per repo. */
export function withCheckoutLock<T>(repoName: string, fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(checkoutLocks, repoName, fn);
}

/**
 * Run `fn` holding the (repo, lane) lock: one pass — so one item — per repo per
 * lane, however many callers ask. The daemon runs one loop per pair, so this
 * only ever queues a second caller such as `--once` or a test.
 */
export function withLaneLock<T>(repoName: string, lane: string, fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(laneLocks, `${repoName}/${lane}`, fn);
}

// --- Optional fleet-wide session ceiling -------------------------------------

let sessionLimit = 0; // 0 = unbounded
let sessionsInUse = 0;
const sessionWaiters: Array<() => void> = [];

/**
 * Cap concurrent session stages across the fleet. 0 (the default) means no cap:
 * the lanes alone bound the work, one item per repo per lane. Set it only if the
 * host cannot carry a session for every busy lane at once.
 */
export function setSessionLimit(limit: number): void {
  sessionLimit = Math.max(0, Math.floor(limit));
  while (sessionWaiters.length > 0 && (sessionLimit === 0 || sessionsInUse < sessionLimit)) {
    sessionsInUse++;
    sessionWaiters.shift()!();
  }
}

/** Run `fn` holding a session slot (immediately, when no ceiling is set). */
export async function withSessionSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (sessionLimit === 0 || sessionsInUse < sessionLimit) sessionsInUse++;
  else await new Promise<void>((resolve) => sessionWaiters.push(resolve));
  try {
    return await fn();
  } finally {
    const next = sessionWaiters.shift();
    if (next && (sessionLimit === 0 || sessionsInUse <= sessionLimit)) next();
    else {
      if (next) sessionWaiters.unshift(next);
      sessionsInUse = Math.max(0, sessionsInUse - 1);
    }
  }
}

/** Session stages waiting for a slot right now, so a stalled ceiling shows in the log. */
export function getQueuedSessionCount(): number {
  return sessionWaiters.length;
}
