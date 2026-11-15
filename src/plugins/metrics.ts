import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import type { WorkEvent, WorkObserver } from "../adapters.js";
import type { AgentConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { stateDir } from "../state-dir.js";
import { MetricsRecorder, openMetricsDb, readRows, sqlite } from "../metrics/recorder.js";
import { aggregate, buildTimelines, formatReport } from "../metrics/report.js";
import { readBlocked, readBlockedRows, parseWindowEdge } from "../metrics/blocked.js";
import { readRuns, readSessionRows } from "../metrics/runs.js";
import type { ForemanPlugin, PluginContext, PluginCatalogEntry } from "./contract.js";

/** The database file: `metrics.path` (`~` expanded), else `foreman-metrics.db` in the state directory. */
export function metricsPath(config: AgentConfig): string {
  const p = config.metrics?.path;
  if (!p) return join(stateDir(), "foreman-metrics.db");
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** `metrics:report [--repo <name>] [--issue <n>] [--since <days>] [--json]` */
export async function runReport(config: AgentConfig, argv: readonly string[] = process.argv.slice(3)): Promise<boolean> {
  const { values } = parseArgs({
    args: [...argv], strict: false,
    options: { repo: { type: "string" }, issue: { type: "string" }, since: { type: "string" }, json: { type: "boolean" }, config: { type: "string" } },
  });
  const days = values.since === undefined ? 30 : Number(values.since);
  const issue = values.issue === undefined ? undefined : Number(values.issue);
  if (!(days > 0) || (issue !== undefined && !Number.isInteger(issue))) {
    console.error("usage: metrics:report [--repo <name>] [--issue <n>] [--since <days>] [--json]");
    return false;
  }
  const path = metricsPath(config);
  if (!existsSync(path)) {
    console.error(`No metrics database at ${path}. Enable it with "metrics": { "enabled": true } (docs/metrics.md).`);
    return false;
  }
  const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    const sinceMs = Date.now() - days * 86_400_000;
    const rows = readRows(db, { sinceIso: new Date(sinceMs).toISOString(), repo: values.repo as string | undefined, issue });
    const timelines = buildTimelines(rows);
    const agg = aggregate(timelines, sinceMs);
    console.log(values.json ? JSON.stringify({ path, sinceDays: days, items: timelines, aggregate: agg }, null, 2) : formatReport(timelines, agg));
    return true;
  } finally {
    db.close();
  }
}

/**
 * `metrics:runs --from <iso> --to <iso> --json`: the billable runs ending in [from, to), as JSON on stdout (docs/metrics.md).
 * On an unreadable store (or a bad window) nothing goes to stdout and it exits 1.
 */
export async function runRuns(config: AgentConfig, argv: readonly string[] = process.argv.slice(3)): Promise<boolean> {
  const { values } = parseArgs({
    args: [...argv], strict: false,
    options: { from: { type: "string" }, to: { type: "string" }, json: { type: "boolean" }, config: { type: "string" } },
  });
  const { from, to } = values as { from?: string; to?: string };
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    console.error("usage: metrics:runs --from <ISO UTC> --to <ISO UTC> --json");
    return false;
  }
  const path = metricsPath(config);
  if (!existsSync(path)) {
    console.error(`No metrics database at ${path}.`);
    return false;
  }
  let out: string;
  try {
    const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
    try {
      out = JSON.stringify(readRuns(readSessionRows(db), from, to), null, 2);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`metrics:runs: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  console.log(out);
  return true;
}

/**
 * `metrics:blocked --from <date|ISO> --to <date|ISO> [--now <ISO>] [--db <path>] [--json]`: each card's blocked hours per
 * Central week, one interval per block (docs/metrics.md). A bare date is that day's Central midnight. `--db` reads a
 * store other than the configured one; `--now` replaces the clock, which fixes where an open block stops.
 * On an unreadable store or a bad argument nothing goes to stdout and it exits 1.
 */
export async function runBlocked(config: AgentConfig, argv: readonly string[] = process.argv.slice(3)): Promise<boolean> {
  const { values } = parseArgs({
    args: [...argv], strict: false,
    options: { from: { type: "string" }, to: { type: "string" }, now: { type: "string" }, db: { type: "string" }, json: { type: "boolean" }, config: { type: "string" } },
  });
  const { from, to } = values as { from?: string; to?: string };
  const now = (values.now as string | undefined) ?? new Date().toISOString();
  if (!from || !to || [from, to].some((v) => Number.isNaN(parseWindowEdge(v))) || Number.isNaN(Date.parse(now))) {
    console.error("usage: metrics:blocked --from <YYYY-MM-DD|ISO> --to <YYYY-MM-DD|ISO> [--now <ISO>] [--db <path>] [--json]");
    return false;
  }
  const path = (values.db as string | undefined) ?? metricsPath(config);
  if (!existsSync(path)) {
    console.error(`No metrics database at ${path}.`);
    return false;
  }
  let out: ReturnType<typeof readBlocked>;
  try {
    const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
    try {
      out = readBlocked(readBlockedRows(db), from, to, now);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`metrics:blocked: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (values.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const r of out.rows) {
      console.log(`${r.repo}#${r.issue}  ${r.week}  ${r.incomplete ? "incomplete" : `${r.hours}h`}${r.open ? "  open" : ""}`);
    }
  }
  return true;
}

class MetricsObserver implements WorkObserver {
  constructor(private readonly recorder: MetricsRecorder) {}
  async onEvent(event: WorkEvent, logger: Logger): Promise<void> {
    this.recorder.record(event, logger); // never throws
  }
  // Closes and stage moves made outside the Foreman (the EM applying `ready for prod release`) only show in the snapshot.
  wantsSnapshot(): boolean { return true; }
}

/**
 * Metrics: an observer that logs each work item's lifecycle events to a local SQLite file
 * (docs/metrics.md). Raw events only; durations are computed by `metrics:report`.
 */
export class MetricsPlugin implements ForemanPlugin {
  readonly id = "metrics";
  readonly roles = ["observer"] as const;
  readonly catalog: PluginCatalogEntry = {
    name: "Metrics",
    purpose: "Records how long each stage takes and how each item ends, for `npm run metrics:report`, each agent run with its outcome and worked cards for `npm run metrics:runs`, and each card's blocked time, one interval per block by Central week, for `npm run metrics:blocked`.",
    onWhen: "`metrics.enabled`",
    requires: { config: ["metrics.enabled", "metrics.path", "metrics.retentionDays"], env: [] },
    whenOff: "Nothing is recorded; the lifecycle is unchanged.",
  };
  readonly commands = {
    "metrics:report": (config: AgentConfig) => runReport(config),
    "metrics:runs": (config: AgentConfig) => runRuns(config),
    "metrics:blocked": (config: AgentConfig) => runBlocked(config),
  };
  private recorder: MetricsRecorder | null = null;
  private obs: MetricsObserver | null = null;
  private path: string | null = null;

  get observer(): WorkObserver | undefined {
    return this.obs ?? undefined;
  }

  enabled(config: AgentConfig): boolean {
    return config.metrics?.enabled === true;
  }

  start(config: AgentConfig, ctx: PluginContext): void {
    this.path = metricsPath(config);
    try {
      this.recorder = new MetricsRecorder(openMetricsDb(this.path), config.metrics.retentionDays);
      this.recorder.retain(true);
      this.obs = new MetricsObserver(this.recorder);
      ctx.logger.info(`Metrics on: ${this.path}`);
    } catch (err) {
      this.recorder = null;
      this.obs = null;
      ctx.logger.warn(`metrics: could not open ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  reconfigure(config: AgentConfig, ctx: PluginContext): void {
    if (metricsPath(config) !== this.path || !this.recorder) {
      this.stop();
      this.start(config, ctx);
      return;
    }
    this.recorder.setRetentionDays(config.metrics.retentionDays);
  }

  stop(): void {
    this.recorder?.close();
    this.recorder = null;
    this.obs = null;
    this.path = null;
  }
}
