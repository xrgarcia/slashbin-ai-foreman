// Event-loop delay, measured per lane pass (slashbin-ai-foreman#228).
//
// Core runs `gh` and `git` through synchronous child-process calls, and every one of them
// holds the whole process: timers, sockets and HTTP callbacks wait. Nothing measured that, so
// a Paperclip or registry call that timed out looked like an upstream fault.
//
// A sampler timer ticks every 10 ms. A tick that fires late is one stall event, recorded once
// in a shared log with the gap it measured (the interval plus how late it was, the same
// convention as Node's own event-loop histogram, so an idle loop reads about 10 ms). A pass
// remembers where the log stood when it began and, at its end, reads only the events since:
// no pass resets or consumes another's, and the work to report a pass is the number of stalls
// during it, not the number of passes in flight. A stall is recorded only when the loop next
// reaches the timer, which can be after the pass that caused it has ended, so the pass end
// also asks, synchronously, whether the tick is overdue. That is why the first pass after
// start is measured without warm-up and no timer or await is added at a pass end.
//
// Percentiles are per tick: a window of N ticks holds the recorded stalls and N minus that
// many on-time ticks (0 ms). Like Node's histogram, one long stall is one sample, so a pass
// also reports `blocked`, the total stalled milliseconds.
import { performance } from "node:perf_hooks";
import type { Logger } from "./logger.js";

/** Sampling interval. */
export const EVENT_LOOP_INTERVAL_MS = 10;

/** A tick later than this is a stall event; smaller lateness is timer jitter. */
const STALL_THRESHOLD_MS = 1;

/** The fixed, greppable prefix of the per-pass line. */
export const EVENT_LOOP_DELAY_PREFIX = "Event-loop delay";

/** One lane pass's window. */
export interface PassWindow {
  readonly startSeq: number;
  readonly startMs: number;
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

/** The p-th percentile of `ticks` samples of which `stalls` (ascending) are non-zero and the rest 0. */
function percentile(stalls: readonly number[], ticks: number, p: number): number {
  const zeros = Math.max(0, ticks - stalls.length);
  const rank = Math.max(0, Math.ceil((p / 100) * (zeros + stalls.length)) - 1);
  return rank < zeros ? 0 : stalls[rank - zeros];
}

export function startEventLoopDelayMonitor(now: () => number = () => performance.now()): EventLoopDelayMonitor {
  const log: number[] = []; // stall gaps in ms; log[i] is event number base + i
  let base = 0;
  const active = new Set<PassWindow>();
  let expected = now() + EVENT_LOOP_INTERVAL_MS;

  /** Records the tick if it is late, and consumes it. */
  const sample = (): void => {
    const t = now();
    const late = t - expected;
    expected = t + EVENT_LOOP_INTERVAL_MS;
    if (late >= STALL_THRESHOLD_MS && active.size > 0) log.push(late + EVENT_LOOP_INTERVAL_MS);
  };

  const timer = setInterval(sample, EVENT_LOOP_INTERVAL_MS);
  timer.unref();

  return {
    begin() {
      const w: PassWindow = { startSeq: base + log.length, startMs: now() };
      active.add(w);
      return w;
    },
    end(w, logger, repo, lane) {
      sample(); // a stall the loop has not yet reached its timer to record
      active.delete(w);
      const stalls = log.slice(w.startSeq - base).sort((a, b) => a - b);
      const ticks = Math.max(1, Math.floor((now() - w.startMs) / EVENT_LOOP_INTERVAL_MS));
      const p50 = round1(percentile(stalls, ticks, 50));
      const p99 = round1(percentile(stalls, ticks, 99));
      const max = round1(stalls.length ? stalls[stalls.length - 1] : 0);
      const blocked = round1(stalls.reduce((sum, v) => sum + v, 0));
      // Events before the oldest window still open are no one's: drop them.
      const oldest = active.size ? Math.min(...[...active].map((a) => a.startSeq)) : base + log.length;
      log.splice(0, oldest - base);
      base = oldest;
      logger.info(`${EVENT_LOOP_DELAY_PREFIX} repo=${repo} lane=${lane} p50=${p50}ms p99=${p99}ms max=${max}ms blocked=${blocked}ms`, { repo, lane, p50, p99, max, blocked });
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
