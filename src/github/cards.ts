// The GitHub reads behind a snapshot's cards (`WorkSourceAdapter.cards`): what
// an observer that owns every card of a repo needs beyond the open issues'
// labels. Read only while such an observer is listening (`paperclip.ownsCards`).
//
//   - the issues closed since the last read, with how they closed, so a card
//     follows its issue to done or cancelled. One GraphQL read per repo every
//     CLOSED_READ_MS; the first looks back CLOSED_FIRST_LOOKBACK_MS, each later
//     one from the start of the last good read (less an overlap).
//   - why a held issue is held (slashbin_data_receiver#43, ported): the newest
//     labelling with the blocked label, and the newest comment its author posted
//     from 15 minutes before it on. Read only for issues carrying the label, once
//     per HOLD_TTL_MS each.
//
// Ported from slashbin_data_receiver server/paperclip-sync (issue-rules.mjs
// holdReason, paperclip-sync.mjs readClosedSince / readHoldReasons), which wrote
// these cards before the Foreman owned them.

import type { ItemState, SnapshotHold } from "../adapters.js";
import type { Logger } from "../logger.js";
import { gh } from "./gh.js";

/** How often each repo's closed issues are read. */
export const CLOSED_READ_MS = 10 * 60_000;
/** How far the first read after a start looks back. */
export const CLOSED_FIRST_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** Each later read starts this much before the last one did: clock skew and GitHub write latency. */
const CLOSED_OVERLAP_MS = 2 * 60_000;
/** Issues per page, and pages per read: a read past them resumes from the same `since` next time. */
const CLOSED_PAGE_SIZE = 50;
const CLOSED_MAX_PAGES = 4;
/** How long a held issue's reason is kept before it is read again. */
export const HOLD_TTL_MS = 10 * 60_000;
/** Held issues read per request. */
const HOLDS_PER_REQUEST = 25;
/** Issues whose state is read per request. */
const STATES_PER_REQUEST = 25;

/**
 * The line a card held on GitHub shows. It starts with `blocked: ` (the Paperclip
 * plugin's FOREMAN_BLOCKED_PREFIX, whose HOLD_PREFIX is this same text; a test
 * holds the two equal, since the core never imports the plugin), so every reader
 * takes it for a block, not a waiting hold. The text the receiver wrote, so a
 * card it held reads as the Foreman's own.
 */
export const HOLD_PREFIX = "blocked: on GitHub — ";
/** The holder's comment may come just before the label or after it. */
const HOLD_WINDOW_MS = 15 * 60_000;
const HOLD_LINE_MAX = 160;
const HOLD_COMMENT_MAX = 4000;
/** The head of the comment that copies the holder's words onto the card. */
export const HOLD_COMMENT_HEAD = "Held on GitHub by ";

export interface ClosedIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "completed" | "not_planned";
}

type LabelEvent = { createdAt: string; actor?: { login?: string } | null; label?: { name?: string } | null };
type IssueComment = { url: string; createdAt: string; author?: { login?: string } | null; body?: string | null };

const byTime = (a: { createdAt: string }, b: { createdAt: string }) => Date.parse(a.createdAt) - Date.parse(b.createdAt);
const day = (iso: string | undefined) => String(iso ?? "").slice(0, 10);
/** A comment's first non-empty line, markdown bold and code marks stripped, at most HOLD_LINE_MAX characters. */
function headline(body: string | null | undefined): string {
  const line = String(body ?? "").replaceAll("**", "").replaceAll("`", "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return Array.from(line).slice(0, HOLD_LINE_MAX).join("");
}

/**
 * Why an open issue is held. L = the newest labelling with `label`; R = the
 * newest comment by L's actor at or after L − 15 minutes. With no R the line
 * says who labelled it and when, and that no reason was posted.
 */
export function holdReason(label: string, events: readonly LabelEvent[], comments: readonly IssueComment[]): SnapshotHold {
  const L = events.filter((e) => e.label?.name === label).sort(byTime).at(-1) ?? null;
  const login = L?.actor?.login ?? null;
  const R = L && login
    ? comments.filter((c) => c.author?.login === login && Date.parse(c.createdAt) >= Date.parse(L.createdAt) - HOLD_WINDOW_MS).sort(byTime).at(-1) ?? null
    : null;
  if (!R) {
    const by = `labelled ${label} by ${login ?? "unknown"} on ${L ? day(L.createdAt) : "unknown date"}`;
    return { action: `${HOLD_PREFIX}${by}; no reason posted on the issue`, comment: null, commentUrl: null, author: null };
  }
  const signed = `(${login}, ${day(R.createdAt)})`;
  return {
    action: HOLD_PREFIX + [headline(R.body), signed, R.url].filter(Boolean).join(" "),
    comment: `${HOLD_COMMENT_HEAD}${login}, ${day(R.createdAt)}:\n\n${String(R.body ?? "").slice(0, HOLD_COMMENT_MAX)}\n\n${R.url}`,
    commentUrl: R.url,
    author: login,
  };
}

function graphql(query: string, cwd: string): Record<string, unknown> {
  const out = gh(["api", "graphql", "-f", `query=${query}`], cwd);
  const parsed = JSON.parse(out || "{}") as { data?: Record<string, unknown> | null; errors?: Array<{ message?: string }> };
  if (!parsed.data) throw new Error(`GitHub query failed: ${(parsed.errors ?? []).map((e) => e.message).join("; ") || "no data"}`);
  return parsed.data;
}

function repoArgs(repo: string): string {
  const [owner, name] = repo.split("/");
  return `owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}`;
}

/** repo → when its last good closed read started. */
const closedReadAt = new Map<string, number>();
/** repo → when its next closed read is due. */
const closedDueAt = new Map<string, number>();

/** Forget every watermark and cached reason (tests). */
export function resetCardReads(): void {
  closedReadAt.clear();
  closedDueAt.clear();
  holdCache.clear();
}

/**
 * The issues in `repo` closed (and so last updated) since its last read, or []
 * when no read is due yet. A failed read is logged and gives []; the watermark
 * stays, so the next read covers the gap.
 */
export function recentlyClosed(repo: string, cwd: string, logger: Logger, now = Date.now()): ClosedIssue[] {
  if (now < (closedDueAt.get(repo) ?? 0)) return [];
  closedDueAt.set(repo, now + CLOSED_READ_MS);
  const last = closedReadAt.get(repo);
  const since = new Date(last === undefined ? now - CLOSED_FIRST_LOOKBACK_MS : last - CLOSED_OVERLAP_MS).toISOString();
  const out: ClosedIssue[] = [];
  try {
    let after: string | null = null;
    for (let page = 0; page < CLOSED_MAX_PAGES; page++) {
      const d = graphql(`query { repository(${repoArgs(repo)}) {
  issues(states: CLOSED, filterBy: { since: ${JSON.stringify(since)} }, first: ${CLOSED_PAGE_SIZE}, orderBy: { field: UPDATED_AT, direction: DESC }${after ? `, after: ${JSON.stringify(after)}` : ""}) {
    pageInfo { hasNextPage endCursor } nodes { number title url stateReason } } } }`, cwd);
      const conn = (d.repository as { issues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<{ number: number; title: string; url: string; stateReason?: string | null }> } } | null)?.issues;
      if (!conn) throw new Error(`${repo}: not readable`);
      for (const n of conn.nodes ?? []) {
        out.push({ number: n.number, title: n.title, url: n.url, state: n.stateReason === "NOT_PLANNED" ? "not_planned" : "completed" });
      }
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) {
        closedReadAt.set(repo, now);
        return out;
      }
      after = conn.pageInfo.endCursor;
    }
    // More than the pages allow: what was read is used; the watermark stays, so the rest comes next time.
    logger.warn(`cards: ${repo} closed more than ${CLOSED_PAGE_SIZE * CLOSED_MAX_PAGES} issues since ${since}; the rest are read next time`);
    return out;
  } catch (err) {
    logger.warn(`cards: ${repo} closed issues not read: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
}

/** `repo#N` → its hold reason and when it was read. */
const holdCache = new Map<string, { at: number; hold: SnapshotHold }>();

/**
 * Why each of `numbers` (open, carrying `label`) is held. A reason read within
 * HOLD_TTL_MS is reused. One that cannot be read is left out: the card keeps
 * what it says. Never throws.
 */
export function holdReasons(repo: string, cwd: string, label: string, numbers: readonly number[], logger: Logger, now = Date.now()): Map<number, SnapshotHold> {
  const out = new Map<number, SnapshotHold>();
  const due: number[] = [];
  for (const n of numbers) {
    const c = holdCache.get(`${repo}#${n}`);
    if (c && now - c.at < HOLD_TTL_MS) out.set(n, c.hold);
    else due.push(n);
  }
  for (let i = 0; i < due.length; i += HOLDS_PER_REQUEST) {
    const batch = due.slice(i, i + HOLDS_PER_REQUEST);
    try {
      const d = graphql(`query { repository(${repoArgs(repo)}) { ${batch.map((n, j) => `h${j}: issue(number: ${n}) {
  timelineItems(last: 50, itemTypes: [LABELED_EVENT]) { nodes { ... on LabeledEvent { createdAt actor { login } label { name } } } }
  comments(last: 50) { nodes { url createdAt author { login } body } } }`).join("\n")} } }`, cwd);
      const r = d.repository as Record<string, { timelineItems?: { nodes?: LabelEvent[] }; comments?: { nodes?: IssueComment[] } } | null> | null;
      batch.forEach((n, j) => {
        const issue = r?.[`h${j}`];
        if (!issue) return;
        const hold = holdReason(label, issue.timelineItems?.nodes ?? [], issue.comments?.nodes ?? []);
        holdCache.set(`${repo}#${n}`, { at: now, hold });
        out.set(n, hold);
      });
    } catch (err) {
      logger.warn(`cards: ${repo} hold reasons not read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/**
 * Whether each of `numbers` is open or how it closed, read live from GitHub,
 * 25 to a request. Not the open-issue view: a full read of it carried
 * cmneb_data_receiver#218, closed minutes before, with its old labels, and
 * the card went done → in_review (2026-10-15). A number that cannot be read
 * (a missing issue, a number that is not a positive integer) is left out, so
 * nothing is guessed. One unresolvable number makes `gh` fail its whole
 * request, so a batch that throws is re-read one number per request and only
 * the numbers that still throw are left out. A healthy batch stays one request.
 * Never throws. `query` is the GraphQL call (tests inject one).
 */
export function issueStates(
  repo: string, cwd: string, numbers: readonly number[], logger: Logger,
  query: (q: string, cwd: string) => Record<string, unknown> = graphql,
): Map<number, ItemState> {
  const out = new Map<number, ItemState>();
  const want = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0);
  const read = (batch: readonly number[]): void => {
    const d = query(`query { repository(${repoArgs(repo)}) { ${batch.map((n, j) => `s${j}: issue(number: ${n}) { state stateReason }`).join(" ")} } }`, cwd);
    const r = d.repository as Record<string, { state?: string; stateReason?: string | null } | null> | null;
    batch.forEach((n, j) => {
      const st = r?.[`s${j}`]?.state;
      if (st === "OPEN") out.set(n, "open");
      else if (st === "CLOSED") out.set(n, r?.[`s${j}`]?.stateReason === "NOT_PLANNED" ? "not_planned" : "completed");
    });
  };
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  for (let i = 0; i < want.length; i += STATES_PER_REQUEST) {
    const batch = want.slice(i, i + STATES_PER_REQUEST);
    try {
      read(batch);
    } catch (err) {
      logger.warn(`cards: ${repo} issue states not read: ${message(err)}`);
      for (const n of batch) {
        try {
          read([n]);
        } catch (e) {
          logger.warn(`cards: ${repo} issue state #${n} not read: ${message(e)}`);
        }
      }
    }
  }
  return out;
}
