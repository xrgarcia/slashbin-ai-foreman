// The session output protocol: what a Claude session's output says. Parsing only
// - no I/O, no process, no filesystem. The runner (./runner.ts) produces the
// output; this module reads it, and the phases act on what it found.

export interface RevisionResult {
  success: boolean;
  error?: string;
  /**
   * The revision deliberately made no commit and SAID SO via the
   * FOREMAN_REVISION trailer. Distinct from a silent no-op, which stays a
   * failure — see the SHA check in revisePRFeedback.
   */
  noCommit?: boolean;
  /** The reason given on the trailer. Present only when `noCommit` is true. */
  noCommitReason?: string;
  /**
   * The agent found the issue's work already present on the feature branch and
   * produced no PR because there is nothing to land (`FOREMAN_RESULT: landed`).
   * `landedIssue` is the issue it named; the Foreman closes it as completed.
   */
  landed?: boolean;
  landedIssue?: number;
  landedReason?: string;
  /** The session's own final message, for observers (unredacted, uncapped). */
  summary?: string;
  /**
   * The run was refused by the Claude session limit, not failed on its merits.
   * The orchestrator reports it to the upstream back-off and charges no retry.
   */
  upstreamLimit?: UpstreamLimit;
}

/**
 * A revision that correctly changes nothing must be able to say so.
 *
 * Structured trailer, not prose. `9ed3c02` in the EM repo is the same lesson
 * from the review side: a gate that reads an agent's narrative instead of a
 * declared field grades the wrong thing. The reason is required — a bare
 * "no-commit" is indistinguishable from the silent no-op this guard exists to
 * catch.
 *
 *   FOREMAN_REVISION no-commit reason=<why no code change was needed>
 */
export const REVISION_NO_COMMIT = /FOREMAN_REVISION\s+no-commit\s+reason=(.+)/i;

/** One parsed FOREMAN_REVIEW trailer line. */
/**
 * The Tech Lead's `hold=` slug for an approval it left unmerged on purpose (`review-pr --no-merge`):
 * QA runs next and a PASS merges it (EM#923). A wait the Foreman itself owns, not a reviewer's hold.
 */
export const QA_PENDING_HOLD = "qa-pending";
/** `--merge-approved` wrote nothing: the PR's head is no longer the sha QA passed (`verdict=NONE`), or the Tech Lead has no APPROVE on it. */
export const HEAD_MOVED_HOLD = "head-moved";
export const NOT_APPROVED_HOLD = "not-approved";

export interface ReviewTrailer {
  pr: number;
  verdict: string;
  merged: boolean;
  deploy: string;
  /**
   * Reason the reviewer DELIBERATELY withheld the issue's outcome label, from the
   * optional `hold=` field. Undefined when the field is absent (every trailer
   * written before this field existed) or when it says no/none/false.
   *
   * This exists to keep one honest case from being punished by the label
   * reconciler: a reviewer that cannot yet judge an acceptance criterion (e.g. one
   * that only becomes observable at a later time boundary) is RIGHT to leave the
   * label alone, and must be able to say so. Without a way to declare it, a
   * deliberate hold and a dropped label are the same observation, and automation
   * has to guess — which means overwriting a correct judgment with a rubber stamp.
   */
  hold?: string;
}

export interface ReviewResult {
  success: boolean;
  error?: string;
  // The skill's final summary text (parsed from the stream-json result event).
  summary?: string;
  // Concise per-PR status parsed from the FOREMAN_REVIEW trailer(s), including the
  // deployment outcome — e.g. "#100 APPROVE · merged · deploy SUCCESS". Surfaced
  // in the Foreman's Discord status line. Undefined if no trailer was emitted.
  statusLine?: string;
  // The same trailers, structured, so the orchestrator can check the run's
  // post-condition (did the issues it claims to have merged actually advance?).
  trailers?: ReviewTrailer[];
  /**
   * The run was refused by the Claude session limit, not failed on its merits.
   * The orchestrator reports it to the upstream back-off and charges no retry.
   */
  upstreamLimit?: UpstreamLimit;
}

export interface ImplementationResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  // True when the agent deliberately declined to implement (e.g., the issue body
  // says "investigate first, no code change yet"). Distinguishes a clean no-op
  // from a real implementation failure so the orchestrator can back off instead
  // of treating it as a retryable error.
  skipped?: boolean;
  // Reason the agent gave for skipping, surfaced from its output.
  skipReason?: string;
  // What the skip waits on (`owner/repo#N` or `#N`), from the trailer's
  // `waiting_on=` field. Undefined when the skip named none.
  waitingOn?: string;
  // Issues the agent decided to skip. Empty/undefined when no skip was detected.
  skippedIssues?: number[];
  /**
   * The agent found the issue's work already present on the feature branch and
   * produced no PR because there is nothing to land (`FOREMAN_RESULT: landed`).
   * `landedIssue` is the issue it named; the Foreman closes it as completed.
   */
  landed?: boolean;
  landedIssue?: number;
  landedReason?: string;
  /** The session's own final message, for observers (unredacted, uncapped). */
  summary?: string;
  /**
   * The run was refused by the Claude session limit, not failed on its merits.
   * The orchestrator reports it to the upstream back-off and charges no retry.
   */
  upstreamLimit?: UpstreamLimit;
}

// Detect a deliberate skip in the agent's output. Two signals, in order of
// reliability:
//  1. Structured trailer: `FOREMAN_RESULT: skipped reason="<text>"` — what we
//     ask the skill to emit.
//  2. Free-text heuristic: the agent wrote about "skipping" or "no immediate
//     code change". Less precise but catches well-behaved agents that explained
//     themselves without using the structured trailer.
/**
 * The STRUCTURED trailer only — no free-text heuristic.
 *
 * This one is consulted BEFORE any PR detection, so it must never fire on an
 * agent that merely talked about skipping while actually implementing. The
 * trailer is a declaration; the heuristic in detectSkipSignal is a guess, and a
 * guess does not get to pre-empt the evidence.
 */
// Exported for tests: the field parse is what broke, so it is tested by calling.
export function detectDeclaredSkip(stdout: string): { skipped: boolean; reason?: string; issue?: number; waitingOn?: string } {
  // Find the trailer LINE first, then read its fields off it, so the fields may
  // appear in any order. The previous shape — `skipped(?:\s+reason="...")?` —
  // only bound `reason` when it immediately followed `skipped`, so the moment the
  // documented format grew an `issue=` field in front of it the reason silently
  // became "no reason given". That is not cosmetic: the reason is persisted as
  // state.skipped[n].reason and is the ONLY input to isResolvedTransientSkip,
  // which recognises a transient wait (an open PR on the branch) solely by matching the agent's own
  // wording. A dropped reason turns a self-clearing skip into a 24h back-off.
  //
  // The trailer must START a line. Unanchored, prose that merely names it is a
  // declaration: Slashbin-console 2026-10-01 18:27Z and 19:35Z, an agent wrote
  // "I left off the `FOREMAN_RESULT: skipped` line on purpose" and was booked as
  // a batch-wide skip — #1107/#1111/#1115 backed off for 1h, then 2h, for a skip
  // nobody declared (slashbin-ai-foreman#49). The last trailer line wins.
  const lines = stdout.match(/^[ \t]*FOREMAN_RESULT:\s*skipped[^\n]*/gim);
  if (!lines) return { skipped: false };
  const trailer = lines[lines.length - 1].trim();
  const reason = trailer.match(/\breason="([^"]*)"/i);
  // An OPTIONAL `issue=<N>` scopes the skip to the one issue the agent stopped
  // on. Without it the skip applies to the whole batch we handed over, which is
  // right when the agent judged the batch as a whole and wrong when it stopped
  // on one spec — and `implement-approved-issues` selects exactly ONE issue per
  // invocation, so unscoped there means every other approved issue in the repo
  // gets backed off 30m..24h for a defect in a spec it never read.
  const scoped = trailer.match(/\bissue="?#?(\d+)"?/i);
  // An OPTIONAL `waiting_on="owner/repo#N"` (or `#N` in this repo) names the
  // issue or PR the skip waits on. The held issue runs again once it closes or
  // merges (backoff.skip.hold). Read only from this field — never parsed out of
  // the prose reason — and read with the reason removed, so a reason that
  // quotes the field cannot set it.
  const waiting = trailer.replace(/\breason="[^"]*"/i, "").match(/\bwaiting_?on="?((?:[\w.-]+\/[\w.-]+)?#\d+)"?/i);
  return {
    skipped: true,
    reason: reason ? reason[1] : "no reason given",
    issue: scoped ? Number(scoped[1]) : undefined,
    waitingOn: waiting ? waiting[1] : undefined,
  };
}

/**
 * `FOREMAN_RESULT: landed issue=<N> reason="<evidence>"` — the work is already
 * on the feature branch, so there is nothing to build (Slashbin-Ingest-Gateway#222
 * and jerky_skuvault_service#478, 2026-10-26). Anchored to a line start like the
 * skip trailer, and `issue=` is REQUIRED: this closes an issue, so it never
 * applies to a batch. The last trailer line wins. Exported for tests.
 */
export function detectDeclaredLanded(stdout: string): { landed: boolean; issue?: number; reason?: string } {
  const lines = stdout.match(/^[ \t]*FOREMAN_RESULT:\s*landed[^\n]*/gim);
  if (!lines) return { landed: false };
  const trailer = lines[lines.length - 1].trim();
  const issue = trailer.match(/\bissue="?#?(\d+)"?/i);
  if (!issue) return { landed: false };
  const reason = trailer.match(/\breason="([^"]*)"/i);
  return { landed: true, issue: Number(issue[1]), reason: reason ? reason[1] : "no evidence given" };
}

export function detectSkipSignal(stdout: string): { skipped: boolean; reason?: string } {
  // Structured trailer (preferred)
  const declared = detectDeclaredSkip(stdout);
  if (declared.skipped) {
    return declared;
  }

  // Free-text heuristics on the last 2000 chars (agents tend to put the
  // conclusion at the end of their output).
  const tail = stdout.slice(-2000).toLowerCase();
  const phrases = [
    "skipped because",
    "skipping this issue",
    "no implementation needed",
    "no immediate code change",
    "cannot be implemented",
    "no code change is warranted",
    "issue body explicitly says",
    "decided not to implement",
    "declined to implement",
  ];
  for (const phrase of phrases) {
    if (tail.includes(phrase)) {
      return { skipped: true, reason: `output indicates skip ("${phrase}")` };
    }
  }
  return { skipped: false };
}

/** How much of a run's final summary is kept for logging and Discord display. */
export const SUMMARY_DISPLAY_LIMIT = 2000;

/**
 * Parse the final `result` event from a stream-json transcript and return its
 * text IN FULL. Undefined when no result event is present.
 *
 * This used to `.slice(0, 2000)` before returning, which silently destroyed the
 * outcome it was feeding. The review prompt requires the FOREMAN_REVIEW trailer to
 * be the last thing the agent emits, so on any review whose summary exceeds 2000
 * characters the trailer sat past the cut. The caller then parsed the truncated
 * string, found no trailer, and — because `summary` was non-null, so the
 * `?? result.stdout` fallback never fired — recorded a complete, correct review as
 * "ended without declaring an outcome".
 *
 * Worked example, slashbin-io-worker PR #589 (2026-08-05): full result text 3,672
 * chars, trailer at index 3,571, present in the full text and absent from the
 * truncated one. The agent had complied exactly; the harness threw the answer away
 * and the run was booked as FAILED.
 *
 * The truncation is a DISPLAY concern and now belongs at the display sites
 * (`SUMMARY_DISPLAY_LIMIT`), never between the agent's answer and the code that
 * reads it. Note this failure was biased toward the reviews that did the most
 * work: the longer and more thorough the write-up, the likelier its trailer fell
 * past the cut.
 */
export function extractStreamResult(stdout: string): string | undefined {
  const lines = stdout.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]);
      if (evt && evt.type === "result") {
        return typeof evt.result === "string" ? evt.result : JSON.stringify(evt);
      }
    } catch {
      // not a JSON line — keep scanning
    }
  }
  return undefined;
}

/** A Claude refusal on the account session limit, as read from a failed run. */
export interface UpstreamLimit {
  reason: string;
  /** The reset the refusal stated, resolved to epoch ms; absent when unparseable. */
  resetAtMs?: number;
}

/**
 * Classify a FAILED run as a Claude session-limit refusal, or `undefined`.
 *
 * Two arms, one per output mode (2026-10-01 journal: 294 of 294 review hits on
 * the first, 97 of 97 implement/revise hits on the second):
 *  - stream-json (review): the last `"type":"result"` event has
 *    `is_error: true` and `api_error_status: 429`.
 *  - plain text (implement, revise): no result event, and the trimmed stdout
 *    starts with "You've hit your" and mentions a limit.
 * A bare "session limit" substring anywhere is NOT enough — prose can carry it.
 */
export function detectUpstreamLimit(stdout: string): UpstreamLimit | undefined {
  const lines = stdout.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let evt: { type?: unknown; is_error?: unknown; api_error_status?: unknown; result?: unknown };
    try {
      evt = JSON.parse(lines[i]);
    } catch {
      continue; // not a JSON line — keep scanning
    }
    if (!evt || evt.type !== "result") continue;
    if (evt.is_error !== true || evt.api_error_status !== 429) return undefined;
    const reason = typeof evt.result === "string" && evt.result.trim() ? evt.result.trim() : "Claude API 429";
    return { reason, resetAtMs: parseClaudeReset(reason) };
  }
  const text = stdout.trim();
  if (/^You(?:'|\u2019)ve hit your/.test(text) && /limit/i.test(text)) {
    const reason = text.split("\n")[0].slice(0, 300);
    return { reason, resetAtMs: parseClaudeReset(text) };
  }
  return undefined;
}

/**
 * `resets 12:10pm (America/Chicago)` → the next occurrence of that wall-clock
 * time in that zone, as epoch ms. Resolved through Intl (not a fixed offset) so
 * DST is honoured. Unparseable text or an unknown zone → undefined.
 */
export function parseClaudeReset(text: string, now = Date.now()): number | undefined {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
  if (!m) return undefined;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return undefined;
  const zone = m[4].trim();
  try {
    const today = zonedParts(now, zone);
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const at = zonedWallToUtc(today.year, today.month, today.day + dayOffset, hour, minute, zone);
      if (at > now) return at;
    }
  } catch {
    // RangeError on an unknown time zone
  }
  return undefined;
}

function zonedParts(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset (ms) of `zone` from UTC at instant `ms`. */
function zoneOffset(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant whose wall-clock in `zone` reads the given fields (day may overflow). */
function zonedWallToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffset(guess, zone);
  const second = guess - zoneOffset(first, zone);
  return second;
}

export interface CustomStageResult {
  /** `pass` / `blocked` as declared by the FOREMAN_STAGE trailer; `failed` when none was. */
  verdict: "pass" | "blocked" | "failed";
  reason?: string;
  /** Set when the Claude session limit refused the run — no verdict was reached. */
  upstreamLimit?: UpstreamLimit;
}
