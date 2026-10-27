// The Foreman's lifecycle: the one state machine every work item moves through,
// from "authorized" to "shipped". Core, and free of any source or plugin: the
// GitHub connector translates a move into labels, the Paperclip plugin
// translates the same move into a card's column, and neither reads the other.
//
// Three parts:
//   STAGES   — where an item can be. The `…ing` stages are a live session.
//   MOVES    — every state change the Foreman makes, by name: the state it
//              expects the item in, and the state it leaves it in.
//   SESSIONS — the stage a running session holds its items in, and where an
//              item goes back to when the session ends with nothing newer.
//
// The orchestrator never names a (from, to) pair itself: it calls
// `advance(item, "<move>")` (work-source.ts), which looks the move up here. A
// move missing from this table cannot be made. docs/lifecycle.md is generated
// from these tables (`npm run docs:lifecycle`), so the doc is what runs.

import type { PriorState, WorkState } from "./adapters.js";

/** Where a work item can be, in the order an item meets them. */
export const STAGES = [
  "approved", "implementing", "inReview", "reviewing", "changesRequested", "revising",
  "merged", "verifying", "pendingVerification", "releaseAuthorized", "awaitingRelease", "releasing",
  "prodVerifyHeld", "needsRuling", "blocked",
] as const;
export type Stage = (typeof STAGES)[number];

/** A stage, or "done": in production, verified there, and closed by the Foreman. */
export type StageOrDone = Stage | "done";

/** What each stage means, for the generated doc and for anyone placing a card. */
export const STAGE_MEANING: Readonly<Record<StageOrDone, string>> = Object.freeze({
  approved: "Authorized and waiting to be built (or queued behind an open feature PR).",
  implementing: "An implement session is building it.",
  inReview: "Its PR is open and waiting for review.",
  reviewing: "A review session is reviewing its PR.",
  changesRequested: "The review asked for changes, or CI bounced the PR; waiting to be revised.",
  revising: "A revise session is addressing the review.",
  merged: "Merged to the base branch; waiting for dev verification.",
  verifying: "A verify session is checking it in dev.",
  pendingVerification: "Dev-verified (or merged with no verify stage); awaiting EM verification, which ends in the release authorization.",
  releaseAuthorized: "The EM verified it and authorized production; the promote stage puts it in a release PR next.",
  awaitingRelease: "In an open release PR the release stage does not own (no release label: opened by hand, or before the release stage ran).",
  releasing: "In a release PR the Foreman owns: the Tech Lead approves it, then the SRE merges, deploys and verifies it in production.",
  prodVerifyHeld: "Deployed to production, but the SRE's prod verification held or failed; the Foreman re-verifies it on a back-off.",
  needsRuling: "Its PR is not converging under review (sent back REVIEW_ROUNDS_ALERT times since the last ruling, or the Tech Lead flagged a spec question); revision waits for the EM's scope ruling. Or a skipped issue used up backoff.skip.maxAttempts sessions; it runs again once a person changes the issue (an agent's edit or label buys one session; its comment releases nothing).",
  blocked: "Needs a person: blocked on the source, or the Foreman declined it or ran out of retries.",
  done: "Closed by the Foreman after the SRE's prod verification passed.",
});

/** The stage each state the Foreman reports puts an item in. */
export const STATE_STAGE = Object.freeze({
  queued: "approved",
  inReview: "inReview",
  changesRequested: "changesRequested",
  merged: "merged",
  approved: "pendingVerification",
  releasing: "releasing",
  prodVerifyHeld: "prodVerifyHeld",
  released: "done",
} as const satisfies Record<WorkState, StageOrDone>);

/**
 * Every state change the Foreman makes. `from` is the state the caller knows
 * the item is in; "unknown" tells the work source to read the item first and
 * move only what is actually there (recovery). `to` is the state it reports.
 * `why` is the trigger, in one line, for the generated doc.
 */
export const MOVES = Object.freeze({
  queue: { from: "new", to: "queued", why: "Held behind an open feature PR on the same branch; builds once that PR merges or closes." },
  implemented: { from: "new", to: "inReview", why: "An implement session (or a reconciliation, or orphan adoption) opened the PR." },
  alreadyApproved: { from: "new", to: "approved", why: "Implement found the work already merged and there is no verify stage." },
  alreadyMerged: { from: "new", to: "merged", why: "Implement found the work already merged; dev verification is next." },
  reviewApproved: { from: "inReview", to: "approved", why: "The review approved and merged, and there is no verify stage." },
  reviewMerged: { from: "inReview", to: "merged", why: "The review approved and merged; dev verification is next." },
  changesRequested: { from: "inReview", to: "changesRequested", why: "The review asked for changes, its CI is red, or a stranded changes-requested verdict is caught up." },
  revised: { from: "changesRequested", to: "inReview", why: "A revise session pushed changes; back to review." },
  verifyPassed: { from: "merged", to: "approved", why: "Dev verification passed; the EM verifies next, and authorizes production with `ready for prod release`." },
  recoverPassed: { from: "unknown", to: "approved", why: "Dead-zone recovery: a merged PR left its issue unadvanced, and a fresh verification passed." },
  recoverFailed: { from: "unknown", to: "changesRequested", why: "Dead-zone recovery: a fresh verification failed." },
  recoverMerged: { from: "unknown", to: "merged", why: "Dead-zone recovery with a verify stage: the merge is recorded and verification follows." },
  release: { from: "unknown", to: "queued", why: "An orphan: in review with no open PR; released back to the queue." },
  releaseQueued: { from: "releaseAuthorized", to: "releasing", why: "The promote stage put an EM-authorized item in the release PR (opened, updated, or already listing it), or found its work already in production with no prod verification on record." },
  alreadyReleased: { from: "releaseAuthorized", to: "released", why: "Authorized, its work already in production, and a passed prod verification on record for it: closed." },
  prodVerified: { from: "releasing", to: "released", why: "The release PR merged (tagged) and the SRE's prod verification passed: commented and closed." },
  prodHeld: { from: "releasing", to: "prodVerifyHeld", why: "The release PR merged (tagged) but prod verification held, failed or did not run: labelled, reopened if GitHub's keywords closed it, re-verified on a back-off." },
  prodReverified: { from: "prodVerifyHeld", to: "released", why: "A later prod re-verification passed: commented and closed." },
  soakHeld: { from: "released", to: "prodVerifyHeld", why: "Closed after prod verification, but the SRE's 30-minute soak held or failed: reopened, labelled, re-verified on a back-off." },
} as const satisfies Record<string, { from: PriorState; to: WorkState; why: string }>);
export type Move = keyof typeof MOVES;

/** A move, resolved: its endpoints and the stage it lands the item in. */
export interface Transition {
  move: Move;
  from: PriorState;
  to: WorkState;
  stage: StageOrDone;
}

/** The transition `move` makes. Throws on a name outside the table: a typo is a bug, never a no-op. */
export function transition(move: Move): Transition {
  const m = (MOVES as Record<string, { from: PriorState; to: WorkState } | undefined>)[move];
  if (!m) throw new Error(`lifecycle: no move "${String(move)}"`);
  return { move, from: m.from, to: m.to, stage: STATE_STAGE[m.to] };
}

/** The move a review outcome makes: approved, merged (verify next) or changes requested. */
export function reviewMove(to: "approved" | "merged" | "changesRequested"): Move {
  return to === "approved" ? "reviewApproved" : to === "merged" ? "reviewMerged" : "changesRequested";
}

/** The session phases, and the stage each holds its items in while it runs. */
export const SESSION_STAGE = Object.freeze({
  implement: "implementing",
  review: "reviewing",
  verify: "verifying",
  revise: "revising",
} as const satisfies Record<string, Stage>);
export type SessionStagePhase = keyof typeof SESSION_STAGE;

/** The stage an item returns to when a session ends and nothing newer said where it belongs. */
export const SESSION_FALLBACK_STAGE = Object.freeze({
  implement: "approved",
  review: "inReview",
  verify: "merged",
  revise: "changesRequested",
} as const satisfies Record<SessionStagePhase, Stage>);

/**
 * Where a release event leaves its items: in an open release PR, or in production. A closed PR moves nothing.
 * With the release stage on, the moves that follow a merge (prodVerified, prodHeld) place the item again
 * in the same pass, and the end-of-pass snapshot puts an open item back at the stage its labels name.
 */
export const RELEASE_STAGE = Object.freeze({
  open: "awaitingRelease",
  merged: "done",
  closed: null,
} as const satisfies Record<"open" | "merged" | "closed", StageOrDone | null>);
