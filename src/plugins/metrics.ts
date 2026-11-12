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
    purpose: "Records how long each stage takes and how each item ends, for `npm run metrics:report`.",
    onWhen: "`metrics.enabled`",
    requires: { config: ["metrics.enabled", "metrics.path", "metrics.retentionDays"], env: [] },
    whenOff: "Nothing is recorded; the lifecycle is unchanged.",
  };
  readonly commands = {
    "metrics:report": (config: AgentConfig) => runReport(config),
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
