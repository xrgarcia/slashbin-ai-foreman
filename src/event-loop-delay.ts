// Event-loop stalls (slashbin-ai-foreman#228).
//
// Core runs `gh` and `git` through synchronous child-process calls, and every one of them holds
// the whole process: timers, sockets and HTTP callbacks wait. Nothing measured that, so a
// Paperclip or registry call that timed out looked like an upstream fault. This answers one
// question: does the loop freeze for seconds, when, and what was running.
//
// 1. A stall detector: an unref'd 100 ms interval measures the real gap since its last tick.
//    A gap over 250 ms logs one `Event-loop stall <gap>ms active=<repo:lane,...>` line naming
//    the lane passes in flight (a Set: O(1) to add and remove). The timer can only run after the
//    loop is free, which may be after the blocking pass has ended, so a pass end also checks
//    the gap synchronously, while the pass is still in the set.
// 2. Node's own event-loop-delay histogram, one for the process, logged (p50, p99, max in ms)
//    and reset every window (5 minutes).
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Logger } from "./logger.js";

export const STALL_TICK_MS = 100;
export const STALL_THRESHOLD_MS = 250;
export const DELAY_WINDOW_MS = 5 * 60 * 1000;
export const EVENT_LOOP_STALL_PREFIX = "Event-loop stall";
export const EVENT_LOOP_DELAY_PREFIX = "Event-loop delay";

export interface EventLoopMonitorOptions {
  /** Clock, ms. Tests inject one. */
  now?: () => number;
  /** Histogram window, ms. Defaults to 5 minutes. */
  windowMs?: number;
}

export interface EventLoopMonitor {
  /** Runs one lane pass with it counted as in flight; its result or error passes through. */
  track<T>(repo: string, lane: string, pass: () => Promise<T>): Promise<T>;
  /** Stops both detectors. */
  disable(): void;
}

export function startEventLoopMonitor(logger: Logger, opts: EventLoopMonitorOptions = {}): EventLoopMonitor {
  const now = opts.now ?? (() => performance.now());
  const active = new Set<string>();
  let last = now();

  /** Consumes the elapsed gap; logs it when it is a stall. */
  const check = (): void => {
    const t = now();
    const gap = t - last;
    last = t;
    if (gap > STALL_THRESHOLD_MS) {
      const gapMs = Math.round(gap);
      logger.info(`${EVENT_LOOP_STALL_PREFIX} ${gapMs}ms active=${[...active].join(",")}`, { gap: gapMs, active: [...active] });
    }
  };
  const tick = setInterval(check, STALL_TICK_MS);
  tick.unref();

  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const toMs = (ns: number): number => Math.round(ns / 1e5) / 10;
  const report = setInterval(() => {
    const p50 = toMs(histogram.percentile(50));
    const p99 = toMs(histogram.percentile(99));
    const max = toMs(histogram.max);
    histogram.reset();
    logger.info(`${EVENT_LOOP_DELAY_PREFIX} p50=${p50}ms p99=${p99}ms max=${max}ms`, { p50, p99, max });
  }, opts.windowMs ?? DELAY_WINDOW_MS);
  report.unref();

  return {
    async track(repo, lane, pass) {
      const id = `${repo}:${lane}`;
      active.add(id);
      try {
        return await pass();
      } finally {
        check(); // a stall inside this pass the timer has not yet reached
        active.delete(id);
      }
    },
    disable() {
      clearInterval(tick);
      clearInterval(report);
      histogram.disable();
    },
  };
}
