import { GitHubIssueConnector } from "./github.js";
import type { PriorState, ReleaseEvent, SessionEvent, WaitingItem, WorkItem, WorkObserver, WorkSourceAdapter, WorkState } from "./adapters.js";
import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";

/**
 * The work source each repo selects from and reports to. GitHub issues unless
 * a source has been registered. Kept out of adapters.ts so that module never
 * imports a connector.
 *
 * Also the one dispatch point for observers (EM#417). The orchestrator reports
 * through the wrappers below, never through the adapter directly, so a report
 * can never reach the source and miss the observers. With no observer
 * registered every wrapper is exactly the adapter call it replaced.
 */
let registered: WorkSourceAdapter | null = null;

export function registerWorkSource(adapter: WorkSourceAdapter | null): void {
  registered = adapter;
}

/** The active adapter. The orchestrator uses the wrappers below instead. */
export function workSourceFor(_repoConfig: RepoConfig): WorkSourceAdapter {
  return registered ?? new GitHubIssueConnector();
}

const observers: WorkObserver[] = [];

/**
 * Per-observer, per-event limit. Generous because observers run OFF the build
 * path (see `enqueue`): the daemon's gh calls are execFileSync and block the
 * event loop, so a 5 s limit expired on a healthy Paperclip during the
 * startup sweep and dropped the note (2026-10-01, first mirror run). A hung
 * observer now delays only the notes queued behind it, never a build step.
 *
 * Counted in time the event loop was free, not wall time: the startup
 * promotion sweep held the loop for 32 s, so a wall-clock 30 s limit fired
 * before the observer had sent one request, and the abandoned call then ran
 * alongside the next one (2026-10-02, first live-activity run).
 */
export const OBSERVER_TIMEOUT_MS = 30_000;

/** How often the observer clock ticks; a tick later than twice this means the loop was held, and is not counted. */
const OBSERVER_TICK_MS = 1_000;

/**
 * Rejects once `limitMs` of free event-loop time has passed. A late tick (the
 * loop was blocked by a synchronous call) adds nothing, so a blocked loop can
 * never expire an observer that has not yet had the chance to run.
 */
export function loopTimeout(limitMs: number, onExpire: () => void, tickMs = OBSERVER_TICK_MS): () => void {
  let used = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap <= tickMs * 2) used += gap;
    if (used >= limitMs) {
      clearInterval(timer);
      onExpire();
    }
  }, tickMs);
  return () => clearInterval(timer);
}

/** Events are delivered in order, one at a time, behind the build. */
let queue: Promise<void> = Promise.resolve();

function enqueue<K extends keyof WorkObserver>(
  method: K,
  args: Parameters<NonNullable<WorkObserver[K]>>,
  logger: Logger,
): void {
  if (observers.length === 0) return;
  queue = queue.then(() => fanOut(method, args, logger));
}

/** Resolves when every queued event has been delivered (tests, shutdown). */
export function drainObservers(): Promise<void> {
  return queue;
}

/**
 * Register an observer. No de-duplication: registering the same instance twice
 * is a boot-path bug, and doubled events make it visible instead of hiding it.
 */
export function addObserver(o: WorkObserver): void {
  observers.push(o);
}

/**
 * Deliver one event to every observer, in registration order. Each call is
 * awaited on its own, raced against the timeout, and any error is logged at
 * info and dropped, so one bad observer neither fails the caller nor stops the
 * observers after it. Never rejects.
 */
async function fanOut<K extends keyof WorkObserver>(
  method: K,
  args: Parameters<NonNullable<WorkObserver[K]>>,
  logger: Logger,
): Promise<void> {
  for (const obs of observers) {
    const fn = obs[method] as ((...a: unknown[]) => Promise<void>) | undefined;
    if (typeof fn !== "function") continue;
    let stop: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => fn.apply(obs, args)),
        new Promise<never>((_, reject) => {
          stop = loopTimeout(OBSERVER_TIMEOUT_MS, () =>
            reject(new Error(`observer ${method} timed out after ${OBSERVER_TIMEOUT_MS} ms`)),
          );
        }),
      ]);
    } catch (err) {
      try {
        logger.info(`observer ${method} failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // a broken logger must not turn an ignored observer error into a thrown one
      }
    } finally {
      stop?.();
    }
  }
}

export async function selectWork(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
): Promise<WorkItem[]> {
  return workSourceFor(repoConfig).selectWork(repoConfig, config, logger);
}

export async function claimWork(item: WorkItem, repoConfig: RepoConfig, logger: Logger): Promise<void> {
  await workSourceFor(repoConfig).claim(item, repoConfig, logger);
  enqueue("onClaim", [item, repoConfig, logger], logger);
}

export async function reportWorkState(
  item: WorkItem,
  from: PriorState,
  to: WorkState,
  repoConfig: RepoConfig,
  logger: Logger,
): Promise<boolean> {
  const changed = await workSourceFor(repoConfig).reportState(item, from, to, repoConfig, logger);
  enqueue("onState", [item, from, to, repoConfig, logger], logger);
  return changed;
}

export async function reportWorkPrLink(
  item: WorkItem,
  prUrl: string,
  repoConfig: RepoConfig,
  logger: Logger,
): Promise<void> {
  await workSourceFor(repoConfig).reportPrLink(item, prUrl, repoConfig, logger);
  enqueue("onPrLink", [item, prUrl, repoConfig, logger], logger);
}

export async function reportWorkBlocked(
  item: WorkItem,
  reason: string,
  repoConfig: RepoConfig,
  logger: Logger,
): Promise<void> {
  await workSourceFor(repoConfig).reportBlocked(item, reason, repoConfig, logger);
  enqueue("onBlocked", [item, reason, repoConfig, logger], logger);
}

/**
 * `item` moved `from` → `to` and the source already shows it (a review agent
 * wrote the outcome label itself). Observers only: the source is not written.
 */
export async function notifyObserversState(
  item: WorkItem,
  from: PriorState,
  to: WorkState,
  repoConfig: RepoConfig,
  logger: Logger,
): Promise<void> {
  enqueue("onState", [item, from, to, repoConfig, logger], logger);
}

/** The feature PR delivering `item` merged to the base branch. Observers only. */
export async function notifyObserversMerged(item: WorkItem, repoConfig: RepoConfig, logger: Logger): Promise<void> {
  enqueue("onMerged", [item, repoConfig, logger], logger);
}

/** `item` was handed to promotion (develop → main). Observers only. */
export async function notifyObserversPromoted(item: WorkItem, repoConfig: RepoConfig, logger: Logger): Promise<void> {
  enqueue("onPromoted", [item, repoConfig, logger], logger);
}

/** An upstream (github / claude) started refusing work. Observers only. */
export async function notifyBackoffPause(upstream: string, reason: string, logger: Logger): Promise<void> {
  enqueue("onBackoffPause", [upstream, reason, logger], logger);
}

/** An upstream back-off cleared. Observers only. */
export async function notifyBackoffResume(upstream: string, logger: Logger): Promise<void> {
  enqueue("onBackoffResume", [upstream, logger], logger);
}

/** A session started, changed hands or ended. Observers only. */
export async function notifySession(event: SessionEvent, logger: Logger): Promise<void> {
  enqueue("onSession", [event, logger], logger);
}

/** The repo's full set of backed-off items this cycle. Observers only. */
export async function notifyWaiting(repo: string, waiting: ReadonlyArray<WaitingItem>, logger: Logger): Promise<void> {
  enqueue("onWaiting", [repo, waiting, logger], logger);
}

/** Promotion on `repo` is stalled (`detail`) or no longer stalled (null). Observers only. */
export async function notifyPromotionStall(repo: string, detail: string | null, logger: Logger): Promise<void> {
  enqueue("onPromotionStall", [repo, detail, logger], logger);
}

/** A release PR opened, merged or closed. Observers only. */
export async function notifyRelease(event: ReleaseEvent, logger: Logger): Promise<void> {
  enqueue("onRelease", [event, logger], logger);
}
