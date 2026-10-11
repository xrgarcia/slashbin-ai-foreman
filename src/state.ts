import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SavedRelease } from "./release-tracker.js";

interface FailedIssue {
  count: number;
  lastError: string;
}

interface SkippedIssue {
  lastSkippedAt: string; // ISO timestamp
  reason: string;
  // Consecutive times the agent has skipped this issue. Drives the ESCALATING
  // back-off (a fixed snooze never gives up, so a permanently-unactionable issue
  // costs one agent session per window forever — slashbin-ai-foreman#32).
  // Optional for backward compat with state files written before this field existed;
  // absent is read as 0, i.e. the original single-window behavior.
  skipCount?: number;
}

interface HeldIssue {
  /** ISO timestamp of the review run that declared the hold. */
  heldAt: string;
  /** The PR whose review declared it. */
  prNumber: number;
  /** Why the reviewer withheld the outcome label, verbatim from the trailer. */
  reason: string;
}

/** A merged PR whose dev verification did not pass (EM#440). */
export interface VerifyHold {
  /** ISO timestamp of the last verify attempt. */
  heldAt: string;
  prNumber: number;
  /** The SRE's hold slug, or the error that left no verdict. */
  reason: string;
  /** Verify runs spent on this issue so far. */
  attempts: number;
  /** ISO time the SRE said the criterion becomes observable (`hold=wait-until-…`); not retried before it. */
  retryAt?: string;
}

/**
 * A release the release stage is carrying (EM#578), keyed by release PR. Kept
 * so a deploy that merged while the Foreman died is finished after the
 * restart (tagged and verified, never deployed twice), and so a held prod
 * verification is retried on its back-off across restarts.
 */
export interface ProdRelease {
  pr: number;
  url?: string;
  /** The head the Tech Lead approved and the SRE was asked to merge. */
  headSha: string;
  /** The issues the release carries (its `release pending` issues when it started). */
  issues: number[];
  /**
   * `deploying`: handed to the SRE, outcome not yet read. `merged`: merged,
   * tag and verdict not yet recorded. `held`: merged and tagged, prod
   * verification held; re-verified on the prodVerifyRetry back-off.
   * `soaking`: verified and its issues closed; the SRE's 30-minute soak runs
   * once `soakAt` has passed, and the entry goes when it settles.
   */
  phase: "deploying" | "merged" | "held" | "soaking";
  mergeSha?: string;
  /** ISO time the Foreman saw the merge (no earlier than the merge itself). */
  mergedAt?: string;
  /** ISO time from which the soak may run: 30 minutes after `mergedAt`. */
  soakAt?: string;
  /** The soak ran (whatever it found): a release is soaked once, never again. */
  soaked?: boolean;
  tag?: string;
  /** The last hold slug, so a re-verify that holds for the same reason comments once. */
  hold?: string;
  evidence?: string;
  /** Prod verifications that did not pass. */
  attempts: number;
  /** ISO time before which a held release is not re-verified. */
  retryAt?: string;
  /** ISO time the release stage started it. */
  since: string;
  /**
   * Merged by someone else (a person, or before this stage existed): the
   * release stage adopted it for prod verification, soak and close, and never
   * asked the Tech Lead or the SRE to deploy it.
   */
  adopted?: boolean;
}

/** A passed prod verification, per issue: the evidence the promote stage's 0-diff path may close on. */
export interface ProdVerified {
  pr: number;
  mergeSha: string;
  tag?: string;
  evidence?: string;
  /** ISO time it passed. */
  at: string;
}

export interface RepoState {
  implemented: number[];
  failed: Record<number, FailedIssue>;
  // Issues the implementation agent declined to implement (e.g., investigation-only
  // issues whose body explicitly says "no immediate code change"). The orchestrator
  // applies a back-off so we don't re-attempt every cycle.
  // Optional for backward compat with v2 state files written before this field existed.
  skipped?: Record<number, SkippedIssue>;
  // Issues whose reviewer DELIBERATELY withheld the outcome label (trailer
  // `hold=`), e.g. an acceptance criterion that cannot be observed until a later
  // time boundary. Distinct from a dropped label: the reviewer reported the hold,
  // so neither the label reconciler nor dead-zone recovery may overwrite it — a
  // deliberate decision must not be rubber-stamped by an automated verdict.
  // Optional for backward compat with state files written before this field existed.
  held?: Record<number, HeldIssue>;
  // Issues at `pr merged` whose dev verification held or errored (EM#440). Kept
  // apart from `held`, which the reconcile prunes for any issue not at `pr under
  // review` / `pr pending actions`. The verify stage retries from here on a
  // back-off and stops after its attempt cap; the card sits in Blocked meanwhile.
  verifyHeld?: Record<number, VerifyHold>;
  // Feature branches whose commits were REJECTED — the last PR for the branch was
  // closed unmerged and the branch has not moved since. The reconciler refuses to
  // recreate a PR for them, and this records the head SHA it already alerted on so
  // a standing rejection is announced ONCE rather than every reconcile pass.
  // Keyed by branch name; the value is the alerted head SHA, so a NEW commit on the
  // branch (different SHA) is a fresh condition and alerts again.
  // Optional for backward compat with state files written before this field existed.
  rejectedBranches?: Record<string, string>;
  // Set while the feature branch has diverged from its base. Optional for
  // backward compat with state files written before this field existed.
  branchBlock?: BranchBlock;
  // The release PR (base → production) this repo's promoted issues wait on, so
  // its merge is seen even when it lands while the daemon is down. Optional for
  // backward compat with state files written before this field existed.
  release?: SavedRelease;
  // Releases the release stage is carrying, by release PR number (EM#578).
  // Optional for backward compat with state files written before it existed.
  prodReleases?: Record<number, ProdRelease>;
  // Issues whose prod verification passed, by issue number: the evidence the
  // promote stage needs before it closes an already-promoted issue.
  prodVerified?: Record<number, ProdVerified>;
  // Issues the promote stage already commented on for a promotion stall, so a
  // stall that lasts days comments once, not every hour (EM#578).
  promotionStallNoted?: number[];
}

/**
 * The shared feature branch has diverged from its base, so implementation on
 * the repo is stopped until a person reconciles it (foreman#44). Recorded so
 * the stop is announced once per episode — across daemon restarts — and so it
 * is state anyone can read rather than a log line. Cleared when a later cycle
 * finds the branch reconciled.
 */
export interface BranchBlock {
  featureBranch: string;
  baseBranch: string;
  /** Identifies the episode: unchanged while commits pile up on either side. */
  mergeBase: string;
  ahead: number;
  behind: number;
  /** ISO timestamp the episode was first seen. */
  since: string;
  /** Work items already told about this episode. */
  announced: number[];
}

interface PersistedState {
  version: number;
  repos: Record<string, RepoState>;
}

const EMPTY_REPO_STATE: RepoState = {
  implemented: [],
  failed: {},
};

let statePath = ".agent-state.json";

export function setStatePath(dir: string): void {
  statePath = join(dir, ".agent-state.json");
}

/** The directory `.agent-state.json` lives in — other persisted Foreman state sits beside it. */
export function stateDir(): string {
  return dirname(statePath);
}

function loadRaw(): PersistedState {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);

    if (parsed.version === 2 && parsed.repos) {
      // Strip trackedPRs from any existing state
      for (const repoName of Object.keys(parsed.repos)) {
        delete parsed.repos[repoName].trackedPRs;
      }
      return parsed;
    }

    // V1 format (flat) — migrate
    const v1State: RepoState = {
      implemented: Array.isArray(parsed.implemented) ? parsed.implemented : [],
      failed: parsed.failed && typeof parsed.failed === "object" ? parsed.failed : {},
      skipped: {},
    };
    return { version: 2, repos: { _migrated: v1State } };
  } catch {
    return { version: 2, repos: {} };
  }
}

function saveRaw(state: PersistedState): void {
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Best-effort — don't crash the daemon over a state write failure
  }
}

export function loadRepoState(repoName: string): RepoState {
  const state = loadRaw();

  if (state.repos[repoName]) {
    const repo = state.repos[repoName];
    return {
      implemented: [...repo.implemented],
      failed: { ...repo.failed },
      skipped: { ...(repo.skipped ?? {}) },
      held: { ...(repo.held ?? {}) },
      verifyHeld: { ...(repo.verifyHeld ?? {}) },
      rejectedBranches: { ...(repo.rejectedBranches ?? {}) },
      ...(repo.branchBlock ? { branchBlock: { ...repo.branchBlock, announced: [...repo.branchBlock.announced] } } : {}),
      // Dropping this re-announced an open release PR on every promotion pass:
      // trackRelease saw no saved release each time (foreman issue 74).
      ...(repo.release ? { release: { ...repo.release, issues: [...repo.release.issues] } } : {}),
      // Dropped here, a merged release would be deployed again after a restart.
      prodReleases: Object.fromEntries(Object.entries(repo.prodReleases ?? {}).map(([k, v]) => [k, { ...v, issues: [...v.issues] }])),
      prodVerified: { ...(repo.prodVerified ?? {}) },
      ...(repo.promotionStallNoted ? { promotionStallNoted: [...repo.promotionStallNoted] } : {}),
    };
  }

  // Auto-migrate v1 state to the first repo that claims it
  if (state.repos._migrated) {
    const migrated = state.repos._migrated;
    state.repos[repoName] = migrated;
    delete state.repos._migrated;
    saveRaw(state);
    return {
      implemented: [...migrated.implemented],
      failed: { ...migrated.failed },
      skipped: { ...(migrated.skipped ?? {}) },
      held: { ...(migrated.held ?? {}) },
      rejectedBranches: { ...(migrated.rejectedBranches ?? {}) },
    };
  }

  return {
    implemented: [...EMPTY_REPO_STATE.implemented],
    failed: { ...EMPTY_REPO_STATE.failed },
    skipped: {},
    held: {},
    rejectedBranches: {},
  };
}

export function saveRepoState(repoName: string, repoState: RepoState): void {
  const state = loadRaw();
  state.repos[repoName] = repoState;
  saveRaw(state);
}
