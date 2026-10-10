import { GitHubIssueConnector } from "./github-work-source.js";
import type { WorkEvent, WorkItem, WorkObserver, WorkSourceAdapter } from "./adapters.js";
import type { AgentConfig, RepoConfig } from "./config.js";
import { transition, type Move } from "./lifecycle.js";
import type { Logger } from "./logger.js";
import { loadRepoState } from "./state.js";

/**
 * The work source each repo selects from and reports to. GitHub issues unless
 * a source has been registered. Kept out of adapters.ts so that module never
 * imports a connector.
 *
 * Also the one dispatch point for observers (EM#417). The orchestrator reports
 * every event through `emit` (a lifecycle move through `advance`), never
 * through the adapter directly, so an event can never reach the source and
 * miss the observers. The orchestrator never knows whether any observer — the
 * Paperclip plugin or another — is registered.
 */
let registered: WorkSourceAdapter | null = null;

export function registerWorkSource(adapter: WorkSourceAdapter | null): void {
  registered = adapter;
}

/** The active adapter. The orchestrator uses `emit` / `advance` instead. */
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

function enqueue(event: WorkEvent, logger: Logger): void {
  if (observers.length === 0) return;
  queue = queue.then(() => fanOut(event, logger));
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

/** True when any observer is registered: a session's report costs GitHub reads, spent only for someone. */
export function hasObservers(): boolean {
  return observers.length > 0;
}

/**
 * Deliver one event to every observer, in registration order. Each call is
 * awaited on its own, raced against the timeout, and any error is logged at
 * info and dropped, so one bad observer neither fails the caller nor stops the
 * observers after it. Never rejects.
 */
async function fanOut(event: WorkEvent, logger: Logger): Promise<void> {
  for (const obs of observers) {
    let stop: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => obs.onEvent(event, logger)),
        new Promise<never>((_, reject) => {
          stop = loopTimeout(OBSERVER_TIMEOUT_MS, () =>
            reject(new Error(`observer ${event.kind} timed out after ${OBSERVER_TIMEOUT_MS} ms`)),
          );
        }),
      ]);
    } catch (err) {
      try {
        logger.info(`observer ${event.kind} failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * The one way an event leaves the core. With a repo, the work source records
 * it first (an `observed` transition excepted: the source already shows it);
 * then every observer is told, in order, off the build path. Resolves what
 * the source returned: `true` when it recorded a change.
 */
export async function emit(event: WorkEvent, repoConfig: RepoConfig | null, logger: Logger): Promise<boolean> {
  const recorded = repoConfig && !(event.kind === "transition" && event.observed)
    ? await workSourceFor(repoConfig).record(event, repoConfig, logger)
    : false;
  enqueue(event, logger);
  return recorded;
}

/**
 * Make lifecycle move `move` on `item` (lifecycle.ts holds the table). With
 * `observed`, the move already happened on the source (a review agent wrote
 * the outcome label itself), so only observers hear of it.
 */
export function advance(
  item: WorkItem,
  move: Move,
  repoConfig: RepoConfig,
  logger: Logger,
  opts: { observed?: boolean } = {},
): Promise<boolean> {
  return emit({ kind: "transition", item, observed: opts.observed === true, ...transition(move) }, repoConfig, logger);
}

/**
 * Tell observers where every open item stands on the source, so a card the
 * Foreman stopped acting on is put back where it belongs. Reads the source
 * only when someone is listening.
 */
export async function publishSnapshot(repoConfig: RepoConfig, logger: Logger): Promise<void> {
  if (!hasObservers()) return;
  const items = await workSourceFor(repoConfig).snapshot(repoConfig, logger);
  const held = loadRepoState(repoConfig.name).verifyHeld ?? {};
  await emit({
    kind: "snapshot",
    repo: repoConfig.githubRepo,
    items: items.map((i) => (held[i.item.issueNumber] ? { ...i, verifyHeld: true } : i)),
  }, null, logger);
}
