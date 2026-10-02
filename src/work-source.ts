import { GitHubIssueConnector } from "./github.js";
import type { PriorState, WorkItem, WorkObserver, WorkSourceAdapter, WorkState } from "./adapters.js";
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
 * Not configurable on purpose: a value set to zero by mistake would cut off
 * every observer, and one set high would let an observer stall every step.
 */
const OBSERVER_TIMEOUT_MS = 5_000;

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => fn.apply(obs, args)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`observer ${method} timed out after ${OBSERVER_TIMEOUT_MS} ms`)),
            OBSERVER_TIMEOUT_MS,
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
      if (timer) clearTimeout(timer);
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
  await fanOut("onClaim", [item, repoConfig, logger], logger);
}

export async function reportWorkState(
  item: WorkItem,
  from: PriorState,
  to: WorkState,
  repoConfig: RepoConfig,
  logger: Logger,
): Promise<boolean> {
  const changed = await workSourceFor(repoConfig).reportState(item, from, to, repoConfig, logger);
  await fanOut("onState", [item, from, to, repoConfig, logger], logger);
  return changed;
}

export async function reportWorkPrLink(
  item: WorkItem,
  prUrl: string,
  repoConfig: RepoConfig,
  logger: Logger,
): Promise<void> {
  await workSourceFor(repoConfig).reportPrLink(item, prUrl, repoConfig, logger);
  await fanOut("onPrLink", [item, prUrl, repoConfig, logger], logger);
}

export async function reportWorkBlocked(
  item: WorkItem,
  reason: string,
  repoConfig: RepoConfig,
  logger: Logger,
): Promise<void> {
  await workSourceFor(repoConfig).reportBlocked(item, reason, repoConfig, logger);
  await fanOut("onBlocked", [item, reason, repoConfig, logger], logger);
}

/** The feature PR delivering `item` merged to the base branch. Observers only. */
export async function notifyObserversMerged(item: WorkItem, repoConfig: RepoConfig, logger: Logger): Promise<void> {
  await fanOut("onMerged", [item, repoConfig, logger], logger);
}

/** `item` was handed to promotion (develop → main). Observers only. */
export async function notifyObserversPromoted(item: WorkItem, repoConfig: RepoConfig, logger: Logger): Promise<void> {
  await fanOut("onPromoted", [item, repoConfig, logger], logger);
}

/** An upstream (github / claude) started refusing work. Observers only. */
export async function notifyBackoffPause(upstream: string, reason: string, logger: Logger): Promise<void> {
  await fanOut("onBackoffPause", [upstream, reason, logger], logger);
}

/** An upstream back-off cleared. Observers only. */
export async function notifyBackoffResume(upstream: string, logger: Logger): Promise<void> {
  await fanOut("onBackoffResume", [upstream, logger], logger);
}
