// Event-loop delay, measured per lane pass (slashbin-ai-foreman#228).
//
// Core runs `gh` and `git` through synchronous child-process calls, and every one of them
// holds the whole process: timers, sockets and HTTP callbacks wait. Nothing measured that, so
// a Paperclip or registry call that timed out looked like an upstream fault.
//
// A sampler timer ticks every 10 ms. A tick that fires late is one stall event, with the gap it
// measured (the interval plus how late it was, the same convention as Node's own event-loop
// histogram). Stalls are folded into running totals shared by all passes: a count, a sum, a
// fixed set of power-of-two buckets, and a monotonic stack for the largest. A pass snapshots
// the totals when it begins and subtracts them when it ends, so reporting a pass costs a
// constant, never the number of passes in flight and never a replay of history. A stall is
// recorded only when the loop next reaches the timer, which can be after the pass that caused
// it has ended, so the pass end also asks, synchronously, whether the tick is overdue. That is
// why the first pass after start is measured without warm-up and no timer or await is added.
//
// Percentiles are over the stalls observed in the pass (on-time ticks are not samples, and a
// blocked loop runs no ticks to count); with none, every figure is 0. A percentile is the
// upper bound of its bucket, capped at the pass's max. `blocked` is the total stalled ms.
import { performance } from "node:perf_hooks";
import type { Logger } from "./logger.js";

/** Sampling interval. */
export const EVENT_LOOP_INTERVAL_MS = 10;

/** A tick later than this is a stall event; smaller lateness is timer jitter. */
const STALL_THRESHOLD_MS = 1;

/** The fixed, greppable prefix of the per-pass line. */
export const EVENT_LOOP_DELAY_PREFIX = "Event-loop delay";

const BUCKETS = 24; // bucket b holds gaps up to 2^b ms; the last takes everything larger

const bucketOf = (ms: number): number => Math.min(BUCKETS - 1, Math.max(0, Math.ceil(Math.log2(ms))));

/** One lane pass's window: the totals when it began. */
export interface PassWindow {
  readonly seq: number;
  readonly count: number;
  readonly sum: number;
  readonly buckets: readonly number[];
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
  let count = 0;
  let sum = 0;
  const buckets: number[] = new Array(BUCKETS).fill(0);
  // Stalls whose value exceeds every later one, oldest first: the front entry at or after a
  // window's start is that window's max.
  const maxStack: Array<{ seq: number; v: number }> = [];
  let open = 0;
  let expected = now() + EVENT_LOOP_INTERVAL_MS;

  /** Records the tick if it is late, and consumes it. */
  const sample = (): void => {
    const t = now();
    const late = t - expected;
    expected = t + EVENT_LOOP_INTERVAL_MS;
    if (late < STALL_THRESHOLD_MS || open === 0) return;
    const v = late + EVENT_LOOP_INTERVAL_MS;
    while (maxStack.length && maxStack[maxStack.length - 1].v <= v) maxStack.pop();
    maxStack.push({ seq: count, v });
    count += 1;
    sum += v;
    buckets[bucketOf(v)] += 1;
  };

  const timer = setInterval(sample, EVENT_LOOP_INTERVAL_MS);
  timer.unref();

  return {
    begin() {
      open += 1;
      return { seq: count, count, sum, buckets: buckets.slice() };
    },
    end(w, logger, repo, lane) {
      sample(); // a stall the loop has not yet reached its timer to record
      open -= 1;
      const n = count - w.count;
      let max = 0;
      let p50 = 0;
      let p99 = 0;
      if (n > 0) {
        let lo = 0;
        let hi = maxStack.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (maxStack[mid].seq >= w.seq) hi = mid; else lo = mid + 1;
        }
        max = maxStack[lo].v;
        const at = (p: number): number => {
          const rank = Math.ceil((p / 100) * n);
          let seen = 0;
          for (let b = 0; b < BUCKETS; b++) {
            seen += buckets[b] - w.buckets[b];
            if (seen >= rank) return Math.min(max, 2 ** b);
          }
          return max;
        };
        p50 = at(50);
        p99 = at(99);
      }
      const blocked = sum - w.sum;
      if (open === 0) maxStack.length = 0;
      const f = { repo, lane, p50: round1(p50), p99: round1(p99), max: round1(max), blocked: round1(blocked) };
      logger.info(`${EVENT_LOOP_DELAY_PREFIX} repo=${repo} lane=${lane} p50=${f.p50}ms p99=${f.p99}ms max=${f.max}ms blocked=${f.blocked}ms`, f);
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
