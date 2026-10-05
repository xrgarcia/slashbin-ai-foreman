/**
 * The blocked queue's way out (Ray, 2026-10-05).
 *
 * The state machine blocks work for a reason, and that stays as it is. What it
 * lacked was the other half: once a card is Blocked, nothing asked whether the
 * reason still held. Work done out of band — a person reconciles a branch,
 * pushes a fix to a PR, merges the missing PR, lands a fix on the base branch —
 * cleared the cause but not the block, so the card sat in Blocked until someone
 * noticed and cleared it by hand (jerky_service #76/#79, 2026-10-05).
 *
 * Each kind of block has a fixed list of checks. They run every pass against
 * facts the orchestrator gathers read-only, and the first that passes resolves
 * the block: the Foreman clears its own state and moves the card back to the
 * column its GitHub labels call for, with a note naming the check. A fact the
 * Foreman could not establish (undefined) never passes — unknown keeps the block.
 */

/** Why the Foreman stopped on an item. */
export type BlockKind =
  | "skip"                 // the implementer declined: a transient precondition
  | "divergence"           // the feature branch diverged from its base
  | "verify-no-pr"         // labelled merged, but no merged PR closes the issue
  | "verify-exhausted"     // dev verification failed its last attempt
  | "revision-exhausted"   // revision failed its retries
  | "revision-stalemate";  // reviser and reviewer disagree with no commit

/** What the Foreman can observe about a blocked item, each answered read-only. */
export interface BlockFacts {
  /** The precondition a skip named is gone (branch reconciled, blocking PR closed). */
  transientCauseGone?: boolean;
  /** The feature branch no longer diverges from its base. */
  divergenceCleared?: boolean;
  /** A merged PR into the base branch now closes the issue. */
  mergedPrFound?: boolean;
  /** The base branch gained commits after the block: a fix may have landed. */
  baseAdvanced?: boolean;
  /** Someone pushed to the PR after the Foreman stopped on it. */
  prHeadMoved?: boolean;
}

export type UnblockCheck = keyof BlockFacts;

/** The checks each kind of block is released by, in order. */
export const UNBLOCK_CHECKS: Readonly<Record<BlockKind, readonly UnblockCheck[]>> = {
  "skip": ["transientCauseGone"],
  "divergence": ["divergenceCleared"],
  "verify-no-pr": ["mergedPrFound"],
  "verify-exhausted": ["baseAdvanced"],
  "revision-exhausted": ["prHeadMoved"],
  "revision-stalemate": ["prHeadMoved"],
};

/** The note each check leaves on the card when it releases one. */
export const CHECK_WORDS: Readonly<Record<UnblockCheck, string>> = {
  transientCauseGone: "the condition the skip named has cleared",
  divergenceCleared: "the feature branch no longer diverges from its base",
  mergedPrFound: "a merged PR now closes the issue",
  baseAdvanced: "new commits landed on the base branch since the hold — verifying again",
  prHeadMoved: "the PR received new commits since the Foreman stopped — resuming",
};

/** The first check for `kind` that `facts` pass, or null. Only `true` passes. */
export function passingCheck(kind: BlockKind, facts: BlockFacts): UnblockCheck | null {
  return UNBLOCK_CHECKS[kind].find((c) => facts[c] === true) ?? null;
}

/** The card note for a release by `check`. */
export function unblockedReason(check: UnblockCheck): string {
  return `unblocked: ${CHECK_WORDS[check]}`;
}
