// What the phases remember between passes, in one object per daemon.
//
// Every field is in-memory only: a restart forgets it, and the durable facts
// (records, releases, streaks) live in the stores on the ForemanRuntime. These
// were module-level maps spread over the phases; one instance makes the memory
// something a test builds fresh and a second runtime does not share.

import { BackoffTracker } from "./backoff.js";

export class PhaseMemory {
  // --- Observers ---

  /**
   * Merged / promoted events already delivered to observers, keyed
   * `<kind>:<owner/repo>#<n>`. Several paths can see the same merge (the review's
   * own trailer, a failed-but-landed review, dead-zone detection on every later
   * pass, the implement stage's already-merged sweep), and a promotion whose
   * label strip failed is seen again next cycle. An observer gets each once.
   */
  readonly observerEventsSent = new Set<string>();
  /**
   * Per repo, the issues held in the build queue and what holds them (an open
   * feature PR, or a merge awaiting dev verification). Observers hear "queued"
   * once per hold, not once per cycle.
   */
  readonly queuedBehind = new Map<string, Map<number, string>>();
  /** `phase:owner/repo#pr` already logged as paused by the blocked label, so a standing hold logs once. */
  readonly blockedPauseNoted = new Set<string>();

  // --- Implement and revise failures ---

  /** Per-repo consecutive implement failures. At `backoff.repoFailure.maxFailures` the repo's implement stage pauses (failurePause), longer each time it trips. */
  readonly failureCount = new Map<string, number>();
  readonly failurePause = new BackoffTracker();
  readonly revisionFailureCount = new Map<string, number>();
  /**
   * Repos whose revision retries are exhausted AND already escalated. Without this
   * the cap was reached silently: the count hit maxFailures, every later cycle took
   * the `debug` skip branch, and the stuck PR sat there with nobody told. The set is
   * cleared the moment a revision succeeds or the pending feedback clears, so a repo
   * that recovers escalates again if it breaks again.
   */
  readonly revisionEscalated = new Set<string>();
  /**
   * The PR head SHA revision stopped on after its retries were exhausted, per
   * repo. A different head later means someone pushed to the PR out of band: the
   * `revision-exhausted` unblock check (src/unblock.ts) resumes on it. A no-commit
   * stalemate's head is persisted with its streak (src/no-commit-streak.ts).
   */
  readonly revisionStoppedHead = new Map<string, string>();
  /** PRs already escalated for too many review rounds (REVIEW_ROUNDS_ALERT), once per PR per newest review. */
  readonly reviewRoundsAlerted = new Set<string>();
  readonly reviewFailureCount = new Map<string, number>();
  readonly reviewFailurePause = new BackoffTracker();
  /** Per-repo last failure, for retry context. */
  readonly lastFailureReason = new Map<string, string>();

  // --- Promotion and the dead zone ---

  /** Last cycle on which each repo checked whether an empty ready-for-prod set is actually a stall. Rate-limits one compare API call per repo; see tryPromotion. */
  readonly lastStallCheckCycle = new Map<string, number>();
  /**
   * Per-repo set of issue numbers already alerted as dead-zoned, so a STANDING
   * condition alerts once instead of every reconcile cycle. Cleared per-issue when
   * the issue leaves the dead-zone, so a genuine re-entry alerts again.
   */
  readonly deadZoneAlerted = new Map<string, Set<number>>();
  /**
   * Per-repo set of issue numbers we already attempted to auto-recover, so a
   * repo whose verification is INDETERMINATE (unmapped service, verifier crash)
   * does not re-spend a multi-minute deploy poll on every cycle, forever.
   */
  readonly deadZoneRecoveryAttempted = new Map<string, Set<number>>();
  /** The held set last named, per repo. A restart costs one repeated note (EM#1244 f4). */
  readonly heldNoted = new Map<string, string>();

  // --- Review, QA and verify waits ---

  /** Per repo: the review waiting after the Tech Lead could not take a PR (backoff.agentUnavailable). */
  readonly reviewDefer = new BackoffTracker();
  /** `repo#pr` already announced as left for a person (no reviewer), so it is logged once. */
  readonly leftForHuman = new Set<string>();
  /** Per repo: the QA phase waiting after a tooling hold (backoff.agentUnavailable). */
  readonly qaDefer = new BackoffTracker();
  /** Per PR head: the merge retry waiting after a PASS the Tech Lead could not merge yet (backoff.approvedUnmerged). */
  readonly qaMergeWait = new BackoffTracker();
  /** Per repo: the verify stage waiting after the SRE could not run at all (backoff.agentUnavailable). */
  readonly verifyDefer = new BackoffTracker();

  // --- Release stage ---

  /** Per `repo#pr`: a release waiting after a passing failure (backoff.releaseRetry). */
  readonly releaseBackoff = new BackoffTracker();
  /** Per repo: when it was last scanned for releases to adopt. */
  readonly lastAdoptScan = new Map<string, number>();
  /** Per repo: when a held release last compared the production head with the one it was verified at. */
  readonly lastHeadProbe = new Map<string, number>();
  /** Per repo: the production head this pass already read, so a hold in the same pass records it without a second read. */
  readonly passHead = new Map<string, string>();
  /** `repo#pr` already found to name no issue to adopt; `repo#issue` already checked for an SRE sweep hold. */
  readonly adoptChecked = new Set<string>();

  // --- Custom stages and lane passes ---

  /**
   * A custom stage's last verdict per repo, keyed `<repo>\0<stage id>`, with the
   * feature-branch head it was reached on. A verdict stands until that head moves:
   * the pass loop polls every minute, and re-running the same skill on the same
   * code each time would spend a session per poll to learn nothing new.
   */
  readonly customStageVerdicts = new Map<string, { headSha: string; outcome: "ok" | "blocked" | "failed"; reason?: string }>();
  /**
   * Pass counter per (repo, lane). The fleet-wide `cycle=N` alone became
   * unreadable the moment repos ran concurrently, so every line carries
   * `repo`, `lane` and `repoCycle` — that lane's own pass count on that repo.
   */
  readonly laneCycleCounter = new Map<string, number>();
}
