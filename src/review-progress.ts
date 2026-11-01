// A running review's milestones, relayed from the Tech Lead to the PR's cards.
//
// WHY. A Tech Lead review runs for tens of minutes, and until 2026-10-15 the
// card said "Tech Lead reviewing PR #N" and nothing more until the verdict.
// Ray (2026-10-15): "Reading began, reading complete, the depth check began,
// depth check complete, final check ran, final check complete ... just
// something so I can see that there's progress."
//
// WHERE THEY COME FROM. The Tech Lead (slashbin_ai_tech_lead lib/progress.mjs)
// writes one line per milestone on stderr:
//
//   TECH_LEAD_PROGRESS {"milestone":"reading_complete","at":"<ISO>","detail":"14 files, every one opened"}
//
// It writes nothing to Paperclip itself: its Paperclip seat has no heartbeat
// runs, so its keys are refused there. The Foreman reads the lines as they
// stream (plugins/tech-lead.ts reviewViaTechLead) and relays them with its own.
//
// HOW MANY COMMENTS. Paperclip has no comment edit (its routes offer GET and
// DELETE on a comment, no PATCH), so the checklist cannot be one comment
// updated in place. Instead the relay posts at most one comment per stage, on
// the stage's "began" — three at most per review — each the whole checklist so
// far. A burst (a skipped depth check reaches "final check ran" within
// milliseconds of "depth check began") is coalesced by a short settle, and a
// review that ends inside it posts nothing more: the review's own end comment
// carries the full checklist, "final check complete" included.
//
// Nothing here can fail or slow a review: a bad line is skipped, and the
// relay's post never throws into the caller.

/** The prefix of a milestone line on the Tech Lead's stderr. */
export const TECH_LEAD_PROGRESS_PREFIX = "TECH_LEAD_PROGRESS ";

/** The milestones, in order, with the words a card shows for each. */
export const REVIEW_MILESTONES = Object.freeze({
  reading_began: "Reading began",
  reading_complete: "Reading complete",
  depth_check_began: "Depth check began",
  depth_check_complete: "Depth check complete",
  final_check_began: "Final check ran",
  final_check_complete: "Final check complete",
} as const);

export type ReviewMilestoneName = keyof typeof REVIEW_MILESTONES;

export interface ReviewMilestone {
  readonly milestone: ReviewMilestoneName;
  /** ISO time the Tech Lead reached it. */
  readonly at: string;
  /** A one-phrase count on a "complete" (files read, areas checked, the outcome). */
  readonly detail?: string;
}

const ORDER = Object.keys(REVIEW_MILESTONES) as ReviewMilestoneName[];
const DETAIL_CAP = 200;

/** One stderr line as a milestone, or null when it is not one (or is malformed). */
export function parseProgressLine(line: string): ReviewMilestone | null {
  const t = line.trim();
  if (!t.startsWith(TECH_LEAD_PROGRESS_PREFIX)) return null;
  try {
    const v = JSON.parse(t.slice(TECH_LEAD_PROGRESS_PREFIX.length)) as Record<string, unknown>;
    const milestone = v?.milestone;
    if (typeof milestone !== "string" || !ORDER.includes(milestone as ReviewMilestoneName)) return null;
    if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
    const detail = typeof v.detail === "string" ? v.detail.replace(/\s+/g, " ").trim().slice(0, DETAIL_CAP) : "";
    return { milestone: milestone as ReviewMilestoneName, at: v.at, ...(detail ? { detail } : {}) };
  } catch {
    return null;
  }
}

/**
 * Feed it a stream's chunks; it calls `onMilestone` once per complete
 * milestone line. A line split across chunks is joined first. Never throws.
 */
export function milestoneReader(onMilestone: (m: ReviewMilestone) => void): { push(chunk: string): void; end(): void } {
  let partial = "";
  const take = (line: string) => {
    const m = parseProgressLine(line);
    if (!m) return;
    try { onMilestone(m); } catch { /* a relay never fails a review */ }
  };
  return {
    push(chunk) {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      // An unbroken run this long is not a milestone line; drop it rather than grow.
      if (partial.length > 8192) partial = "";
      for (const l of lines) take(l);
    },
    end() {
      take(partial);
      partial = "";
    },
  };
}

/** `text` without its milestone lines: for an error message built from stderr. */
export function withoutProgressLines(text: string): string {
  return text.split("\n").filter((l) => !l.trim().startsWith(TECH_LEAD_PROGRESS_PREFIX)).join("\n");
}

const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });

/** "9:02 AM CT": the time a milestone was reached, in Central time. */
export function centralTime(at: string): string {
  // ICU puts a narrow no-break space before AM/PM; a plain one reads the same everywhere.
  return `${CLOCK.format(new Date(at)).replace(/\s/g, " ")} CT`;
}

/**
 * The checklist: every milestone in order, ticked with its time and count
 * when reached, open when not. A review that stopped shows where.
 */
export function milestoneChecklist(milestones: ReadonlyArray<ReviewMilestone>): string {
  const reached = new Map(milestones.map((m) => [m.milestone, m]));
  return ORDER.map((name) => {
    const m = reached.get(name);
    if (!m) return `- [ ] ${REVIEW_MILESTONES[name]}`;
    return `- [x] ${REVIEW_MILESTONES[name]} · ${centralTime(m.at)}${m.detail ? ` — ${m.detail}` : ""}`;
  }).join("\n");
}

/** The stage a milestone belongs to: one comment at most per stage. */
const stageOf = (name: ReviewMilestoneName): string => name.replace(/_(began|complete)$/, "");

/** Default settle: long enough to fold a burst into one comment, short against a stage. */
export const PROGRESS_SETTLE_MS = 10_000;

type Schedule = (fn: () => void, ms: number) => () => void;
const realSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/**
 * Collects one review's milestones and posts the checklist on each stage's
 * "began", at most once per stage, after `settleMs` of quiet so a burst is one
 * post. `close()` (the review ended) cancels a post not yet sent: the end
 * comment carries the checklist then. `post` may throw or reject; it is
 * swallowed.
 */
export class ReviewProgressRelay {
  private readonly seen: ReviewMilestone[] = [];
  private readonly posted = new Set<string>();
  private cancel: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly post: (milestones: ReadonlyArray<ReviewMilestone>) => unknown,
    private readonly settleMs = PROGRESS_SETTLE_MS,
    private readonly schedule: Schedule = realSchedule,
  ) {}

  /** Every milestone so far, in arrival order. */
  get milestones(): ReadonlyArray<ReviewMilestone> {
    return [...this.seen];
  }

  push(m: ReviewMilestone): void {
    if (this.closed || this.seen.some((s) => s.milestone === m.milestone)) return;
    this.seen.push(m);
    if (!m.milestone.endsWith("_began") || this.posted.has(stageOf(m.milestone)) || this.cancel) return;
    this.cancel = this.schedule(() => this.flush(), this.settleMs);
  }

  close(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = null;
  }

  private flush(): void {
    this.cancel = null;
    if (this.closed) return;
    for (const s of this.seen) if (s.milestone.endsWith("_began")) this.posted.add(stageOf(s.milestone));
    try {
      Promise.resolve(this.post(this.milestones)).catch(() => {});
    } catch { /* a relay never fails a review */ }
  }
}
