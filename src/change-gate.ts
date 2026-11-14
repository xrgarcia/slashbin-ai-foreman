import type { Logger } from "./logger.js";
import type { ChangeSignal } from "./plugins/contract.js";

/**
 * Decides whether a repo needs checking this pass, from a plugin's change signal.
 *
 * With no signal installed `due` is always true: the Foreman polls exactly as it did before the
 * signal existed. With one, a consumer (the fleet-state refresh, or a lane) checks a repo when
 *   - it has not checked it yet, or
 *   - the signal reported the repo changed since this consumer last checked, or
 *   - `forceMs` has passed since this consumer last checked it (the safety net for a missed event), or
 *   - the signal cannot answer (it threw): then everything is due.
 * The signal is only ever used to skip work, never to start any.
 *
 * Each consumer keeps its own view, so a change one lane consumed still wakes another lane.
 */
export interface ChangeGateOptions {
  /** The installed signal, read on every call so a plugin started or stopped later takes effect. */
  signal: () => ChangeSignal | undefined;
  /** Every watched repo (`owner/name`): the signal is always asked about all of them, so one shared cursor loses no repo's change. */
  repos: () => readonly string[];
  /** The longest a quiet repo goes unchecked. */
  forceMs: () => number;
  logger: Logger;
  now?: () => number;
  /** The signal is asked at most this often, however many consumers call (default 5 s). */
  pollTtlMs?: number;
}

const DEFAULT_POLL_TTL_MS = 5_000;

export class ChangeGate {
  private cursor: string | null = null;
  private lastPollAt = -Infinity;
  private polling: Promise<void> | null = null;
  /** Per repo, how many reports named it; a consumer compares against what it last saw. */
  private readonly seq = new Map<string, number>();
  private allSeq = 0;
  private readonly seen = new Map<string, { at: number; seq: number; all: number }>();
  private failing = false;

  constructor(private readonly o: ChangeGateOptions) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** True when a change signal is installed, so skipping is possible at all. */
  active(): boolean {
    return this.o.signal() !== undefined;
  }

  /** Whether `repo` needs checking now by `consumer` (a stable name such as `state` or `lane:branch-sync`). Records the check when true. */
  async due(consumer: string, repo: string): Promise<boolean> {
    const signal = this.o.signal();
    if (!signal) return true;
    await this.poll(signal);
    const key = `${consumer}\u0000${repo}`;
    const t = this.now();
    const prior = this.seen.get(key);
    const seq = this.seq.get(repo) ?? 0;
    const changed = !prior || prior.seq < seq || prior.all < this.allSeq;
    const forced = prior !== undefined && t - prior.at >= this.o.forceMs();
    if (!changed && !forced) return false;
    this.seen.set(key, { at: t, seq, all: this.allSeq });
    return true;
  }

  /** The subset of `repos` that `consumer` must check now. */
  async dueRepos(consumer: string, repos: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const r of repos) if (await this.due(consumer, r)) out.push(r);
    return out;
  }

  private poll(signal: ChangeSignal): Promise<void> {
    if (this.polling) return this.polling;
    if (this.now() - this.lastPollAt < (this.o.pollTtlMs ?? DEFAULT_POLL_TTL_MS)) return Promise.resolve();
    const run = (async () => {
      try {
        const report = await signal.changedSince(this.cursor, this.o.repos());
        this.cursor = report.cursor;
        if (report.changed === "all") this.allSeq++;
        else for (const r of report.changed) this.seq.set(r, (this.seq.get(r) ?? 0) + 1);
        if (this.failing) this.o.logger.info("change signal answering again");
        this.failing = false;
      } catch (err) {
        // Fail open: a signal that cannot answer must never make work wait. Everything is due until it can.
        this.allSeq++;
        if (!this.failing) {
          this.o.logger.warn("change signal failed — every repo is polled in full until it answers", {
            error: err instanceof Error ? err.message.split("\n")[0] : String(err),
          });
        }
        this.failing = true;
      } finally {
        this.lastPollAt = this.now();
        this.polling = null;
      }
    })();
    this.polling = run;
    return run;
  }
}
