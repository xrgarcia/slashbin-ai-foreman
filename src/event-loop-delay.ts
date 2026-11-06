// Event-loop delay, measured per lane pass (slashbin-ai-foreman#228).
//
// Core runs `gh` and `git` through synchronous child-process calls, and every one of them
// holds the whole process: timers, sockets and HTTP callbacks wait. Nothing measured that, so
// a Paperclip or registry call that timed out looked like an upstream fault.
//
// A sampler timer (10 ms) records how late each tick fires. Every lane pass that is in flight
// owns its own histogram and receives every sample taken while it runs, so a pass reports the
// delay of its own window whichever other pass finishes first, and nothing is reset under it.
// A stall is only recorded when the loop next reaches the timer, which can be after the pass
// that caused it has ended; the pass end therefore also asks, synchronously, whether the tick
// is overdue and records that, so a pass sees a stall it ended on and the first pass after
// start is measured without warm-up. Nothing awaits and no timer is added at a pass end.
import { createHistogram, performance, type RecordableHistogram } from "node:perf_hooks";
import type { Logger } from "./logger.js";

/** Sampling interval. */
export const EVENT_LOOP_INTERVAL_MS = 10;

/** The fixed, greppable prefix of the per-pass line. */
export const EVENT_LOOP_DELAY_PREFIX = "Event-loop delay";

const NS_PER_MS = 1e6;

/** One lane pass's window. */
export interface PassWindow {
  readonly histogram: RecordableHistogram;
}

export interface EventLoopDelayMonitor {
  /** Opens a window for a pass that is starting. */
  begin(): PassWindow;
  /** Closes the window and logs one line for it. */
  end(window: PassWindow, logger: Logger, repo: string, lane: string): void;
  /** Stops sampling. */
  disable(): void;
}

const round1 = (ms: number): number => Math.round(ms * 10) / 10;

export function startEventLoopDelayMonitor(now: () => number = () => performance.now()): EventLoopDelayMonitor {
  const active = new Set<PassWindow>();
  let expected = now() + EVENT_LOOP_INTERVAL_MS;

  /** Records how late the tick is (0 or less: on time) into every window in flight, and consumes it. */
  const sample = (): void => {
    const t = now();
    const late = t - expected;
    expected = t + EVENT_LOOP_INTERVAL_MS;
    if (late <= 0) return;
    const ns = Math.max(1, Math.round(late * NS_PER_MS));
    for (const w of active) w.histogram.record(ns);
  };

  const timer = setInterval(sample, EVENT_LOOP_INTERVAL_MS);
  timer.unref();

  return {
    begin() {
      const w: PassWindow = { histogram: createHistogram() };
      active.add(w);
      return w;
    },
    end(w, logger, repo, lane) {
      sample(); // a stall the loop has not yet reached its timer to record
      active.delete(w);
      const h = w.histogram;
      // A window with no sample (a pass shorter than one tick) has no percentiles: zeros.
      const empty = h.count === 0;
      const p50 = empty ? 0 : round1(h.percentile(50) / NS_PER_MS);
      const p99 = empty ? 0 : round1(h.percentile(99) / NS_PER_MS);
      const max = empty ? 0 : round1(h.max / NS_PER_MS);
      logger.info(`${EVENT_LOOP_DELAY_PREFIX} repo=${repo} lane=${lane} p50=${p50}ms p99=${p99}ms max=${max}ms`, { repo, lane, p50, p99, max });
    },
    disable() {
      clearInterval(timer);
    },
  };
}

/**
 * Runs one lane pass and logs its event-loop delay on every outcome: it returns, it throws, or
 * the GitHub back-off cuts it short. The pass's result or error passes through untouched.
 */
export async function withPassDelay<T>(monitor: EventLoopDelayMonitor, logger: Logger, repo: string, lane: string, pass: () => Promise<T>): Promise<T> {
  const window = monitor.begin();
  try {
    return await pass();
  } finally {
    monitor.end(window, logger, repo, lane);
  }
}
