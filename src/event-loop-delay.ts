// Event-loop delay, measured per lane pass (slashbin-ai-foreman#228).
//
// Core runs `gh` and `git` through synchronous child-process calls, and every one of them
// holds the whole process: timers, sockets and HTTP callbacks wait. Nothing measured that, so
// a Paperclip or registry call that timed out looked like an upstream fault. One process-wide
// perf_hooks histogram, read and reset when a lane pass ends, gives each pass its own figures.
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { Logger } from "./logger.js";

/** Sampling resolution. A recorded value includes this much baseline, so an idle loop reads ~10 ms. */
export const EVENT_LOOP_RESOLUTION_MS = 10;

/** The fixed, greppable prefix of the per-pass line. */
export const EVENT_LOOP_DELAY_PREFIX = "Event-loop delay";

const NS_PER_MS = 1e6;

export interface EventLoopDelayMonitor {
  /** Logs one line for the pass that just ended, then resets the histogram. */
  reportPass(logger: Logger, repo: string, lane: string): void;
  /** Stops sampling. */
  disable(): void;
}

const round1 = (ms: number): number => Math.round(ms * 10) / 10;

export function startEventLoopDelayMonitor(histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS })): EventLoopDelayMonitor {
  histogram.enable();
  return {
    reportPass(logger, repo, lane) {
      // An empty window (a pass shorter than one tick) has no samples; its percentiles are not numbers.
      const empty = histogram.count === 0;
      const p50 = empty ? 0 : round1(histogram.percentile(50) / NS_PER_MS);
      const p99 = empty ? 0 : round1(histogram.percentile(99) / NS_PER_MS);
      const max = empty ? 0 : round1(histogram.max / NS_PER_MS);
      histogram.reset();
      logger.info(`${EVENT_LOOP_DELAY_PREFIX} repo=${repo} lane=${lane} p50=${p50}ms p99=${p99}ms max=${max}ms`, { repo, lane, p50, p99, max });
    },
    disable() {
      histogram.disable();
    },
  };
}

/**
 * Runs one lane pass and logs its event-loop delay on every outcome: it returns, it throws, or
 * the GitHub back-off cuts it short. The pass's result or error passes through untouched.
 */
export async function withPassDelay<T>(monitor: EventLoopDelayMonitor, logger: Logger, repo: string, lane: string, pass: () => Promise<T>): Promise<T> {
  try {
    return await pass();
  } finally {
    // A stall is recorded when the loop next runs its sampling timer, after the blocking call
    // returns. Without this tick a pass that ends right after its last sync call would report
    // zeros and leave the stall to be charged to the next pass. The sampling timer is due
    // earlier than this one, so it fires first.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    monitor.reportPass(logger, repo, lane);
  }
}
