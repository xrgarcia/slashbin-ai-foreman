/**
 * The metrics report's computation: event rows in, timelines and aggregates out.
 * Pure (no SQLite, no clock), so it is unit-testable on its own. The recorder
 * (recorder.ts) stores raw events; every duration is derived here, at read time.
 */

/** One stored event, `detail` already parsed. */
export interface MetricsRow {
  readonly id?: number;
  readonly at: string;
  readonly repo: string;
  readonly issue: number | null;
  readonly kind: string;
  readonly stage: string | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

export interface StageSpan {
  readonly stage: string;
  readonly at: string;
  /** Hours until the next stage row; null for the item's last row. */
  readonly hours: number | null;
}

export interface ItemTimeline {
  readonly repo: string;
  readonly issue: number;
  /** When the implement session that built it started; null when not derivable. */
  readonly pickup: string | null;
  readonly stages: readonly StageSpan[];
  /** When it reached `done` (in production and closed); null when it has not. */
  readonly doneAt: string | null;
  readonly totalHours: number | null;
  readonly approvedToDoneHours: number | null;
}

export interface Stats { readonly count: number; readonly median: number; readonly p75: number; readonly p90: number }

export interface Aggregate {
  readonly stages: Readonly<Record<string, Stats>>;
  readonly total: Stats | null;
  readonly items: number;
}

const STAGE_KINDS = new Set(["transition", "stage", "closed"]);
const HOUR = 3_600_000;

const hoursBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / HOUR;

/** Linear-interpolated percentile (`p` in 0..1) of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 1) return v[0]!;
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

function stats(values: readonly number[]): Stats {
  return { count: values.length, median: percentile(values, 0.5), p75: percentile(values, 0.75), p90: percentile(values, 0.9) };
}

/** The timeline of one item from all its rows (any order). */
export function buildTimeline(repo: string, issue: number, rows: readonly MetricsRow[]): ItemTimeline {
  const byTime = [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id ?? 0) - (b.id ?? 0));
  const stageRows = byTime.filter((r) => STAGE_KINDS.has(r.kind) && r.stage);
  // A repeat of the stage the item is already in is not an advance.
  const distinct = stageRows.filter((r, i) => i === 0 || r.stage !== stageRows[i - 1]!.stage);
  // Pickup: an implement session lists a whole batch of candidates but builds one, so it is
  // derived: the latest implement-started session naming the item before its first inReview.
  const firstReview = distinct.find((r) => r.stage === "inReview");
  let pickup: string | null = null;
  if (firstReview) {
    for (const r of byTime) {
      if (r.kind !== "session" || r.detail?.phase !== "implement" || r.detail?.status !== "started") continue;
      if (Date.parse(r.at) <= Date.parse(firstReview.at)) pickup = r.at;
    }
  }

  // The build is never a stage row, so the first build is spliced in at pickup: `approved` ends
  // there and `implementing` runs to the first inReview. A real implementing row is left alone.
  const points: Array<{ stage: string; at: string }> = distinct.map((r) => ({ stage: r.stage!, at: r.at }));
  if (pickup && firstReview && !points.some((p) => p.stage === "implementing" && Date.parse(p.at) >= Date.parse(pickup!) && Date.parse(p.at) <= Date.parse(firstReview.at))) {
    const fi = points.findIndex((p) => p.stage === "inReview");
    let idx = 0;
    while (idx < fi && Date.parse(points[idx]!.at) <= Date.parse(pickup)) idx++;
    points.splice(idx, 0, { stage: "implementing", at: pickup });
  }
  const stages: StageSpan[] = points.map((p, i) => ({
    stage: p.stage,
    at: p.at,
    hours: i + 1 < points.length ? hoursBetween(p.at, points[i + 1]!.at) : null,
  }));

  const done = distinct.find((r) => r.stage === "done");
  const approved = distinct.find((r) => r.stage === "approved");
  return {
    repo,
    issue,
    pickup,
    stages,
    doneAt: done?.at ?? null,
    totalHours: pickup && done ? hoursBetween(pickup, done.at) : null,
    approvedToDoneHours: approved && done ? hoursBetween(approved.at, done.at) : null,
  };
}

/** Timelines for every item with rows, ordered by repo then issue. Rows with no issue are skipped. */
export function buildTimelines(rows: readonly MetricsRow[]): ItemTimeline[] {
  const groups = new Map<string, MetricsRow[]>();
  for (const r of rows) {
    if (r.issue === null) continue;
    const key = `${r.repo}#${r.issue}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  return [...groups.values()]
    .map((g) => buildTimeline(g[0]!.repo, g[0]!.issue!, g))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.issue - b.issue);
}

/**
 * Per stage (time an item spent in it, summed over its visits) and for pickup to done,
 * over the timelines that reached `done` at or after `sinceMs`.
 */
export function aggregate(timelines: readonly ItemTimeline[], sinceMs = 0): Aggregate {
  const done = timelines.filter((t) => t.doneAt !== null && Date.parse(t.doneAt) >= sinceMs);
  const perStage = new Map<string, number[]>();
  for (const t of done) {
    const sums = new Map<string, number>();
    for (const s of t.stages) if (s.hours !== null) sums.set(s.stage, (sums.get(s.stage) ?? 0) + s.hours);
    for (const [stage, h] of sums) perStage.set(stage, [...(perStage.get(stage) ?? []), h]);
  }
  const totals = done.map((t) => t.totalHours).filter((h): h is number => h !== null);
  return {
    stages: Object.fromEntries([...perStage].map(([k, v]) => [k, stats(v)])),
    total: totals.length ? stats(totals) : null,
    items: done.length,
  };
}

const fmt = (h: number | null): string => (h === null ? "-" : h < 1 ? `${(h * 60).toFixed(0)}m` : `${h.toFixed(1)}h`);

/** The plain-text report. */
export function formatReport(timelines: readonly ItemTimeline[], agg: Aggregate): string {
  const out: string[] = [];
  for (const t of timelines) {
    out.push(`${t.repo}#${t.issue}`);
    out.push(`  pickup: ${t.pickup ?? "unknown"}`);
    for (const s of t.stages) out.push(`  ${s.at}  ${s.stage.padEnd(20)} ${fmt(s.hours)}`);
    if (t.doneAt) {
      out.push(`  total pickup->done: ${fmt(t.totalHours)}${t.approvedToDoneHours !== null ? `   approved->done: ${fmt(t.approvedToDoneHours)}` : ""}`);
    }
    out.push("");
  }
  out.push(`Aggregate over ${agg.items} item(s) that reached done (hours)`);
  out.push(`  ${"stage".padEnd(22)} count  median    p75    p90`);
  const row = (name: string, s: Stats) =>
    out.push(`  ${name.padEnd(22)} ${String(s.count).padStart(5)} ${s.median.toFixed(1).padStart(7)} ${s.p75.toFixed(1).padStart(6)} ${s.p90.toFixed(1).padStart(6)}`);
  for (const [stage, s] of Object.entries(agg.stages)) row(stage, s);
  if (agg.total) row("TOTAL pickup->done", agg.total);
  return out.join("\n");
}
