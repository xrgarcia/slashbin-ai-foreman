import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SavedRelease } from "./release-tracker.js";
import type { UnstickEntry } from "./unstick.js";

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
  /** The production branch head at the last prod verification attempt; a different head makes a held release due now. */
  verifiedHead?: string;
  /** ISO time the release stage started it. */
  since: string;
  /**
   * Merged by someone else (a person, or before this stage existed): the
   * release stage adopted it for prod verification, soak and close, and never
   * asked the Tech Lead or the SRE to deploy it.
   */
  adopted?: boolean;
}

export interface RepoState {
  implemented: number[];
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
  // The held release the promote stage last named in the log (issue numbers,
  // e.g. "1283"), so a release stopped for a person is WARNed once per change
  // rather than every stall check while it waits.
  promotionHeldNoted?: string;
  // Repo-level questions put to the EM, keyed `0:<kind>[:<tag>]` (src/unstick.ts): they
  // have no issue to keep a record on, so they wait here for the repo-level records of
  // EM#1244 f4. The questions about one issue live in that issue's record.
  repoUnstick?: Record<string, UnstickEntry>;
  // Revisions that pushed nothing by declaration, per PR number, at the head
  // they answered (src/no-commit-streak.ts). Persisted so a restart does not
  // reset a stalemate count (foreman#167).
  noCommitStreaks?: Record<number, NoCommitStreak>;
}

/** Consecutive no-commit revisions on one PR head. A different head starts afresh. */
export interface NoCommitStreak {
  head: string;
  count: number;
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
  /** Ids of EM rulings already carried out or failed (foreman#104): a ruling is acted on once, never retried. */
  ruled?: string[];
}

interface PersistedState {
  version: number;
  repos: Record<string, RepoState>;
  /** Blocks an observer put on its cards, by card id (`CardBlockRecord`). Optional. */
  cardBlocks?: Record<string, CardBlockRecord>;
}

/**
 * A block an observer (the Paperclip mirror) put on one of its cards: why
 * (`reason`, the card's unblock action), whose it is when not the stage's
 * owner (`owner`, a role key), the stage its issue was at when it was blocked
 * (`at`; null: not yet known), and whether it waits on an EM scope ruling
 * (`ruling`). Kept here so a restart re-reads them instead of guessing: a
 * restarted mirror took a needs-ruling card back to the Foreman and a failed
 * deploy's card off the SRE (EM#1150 f6).
 */
export interface CardBlockRecord {
  reason?: string;
  owner?: string;
  at?: string | null;
  ruling?: boolean;
}

/** Every persisted card block, by card id. */
export function loadCardBlocks(): Record<string, CardBlockRecord> {
  const blocks = loadRaw().cardBlocks;
  return blocks && typeof blocks === "object" ? { ...blocks } : {};
}

/** Record `block` for card `id`, or forget it (null). Best-effort, like every state write. */
export function saveCardBlock(id: string, block: CardBlockRecord | null): void {
  const state = loadRaw();
  const blocks = { ...(state.cardBlocks ?? {}) };
  if (block) blocks[id] = block;
  else if (id in blocks) delete blocks[id];
  else return;
  state.cardBlocks = blocks;
  saveRaw(state);
}

const EMPTY_REPO_STATE: RepoState = {
  implemented: [],
};

// FOREMAN_STATE_DIR is set by `npm test` only. Without it a test run in the live checkout
// read and wrote the daemon's own .agent-state.json: on 2026-10-30 a test recorded a
// skip for its fake repo "ws" there, and acceptance-gate R2 failed on it from then on.
let statePath = process.env.FOREMAN_STATE_DIR ? join(process.env.FOREMAN_STATE_DIR, ".agent-state.json") : ".agent-state.json";

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
        splitRepoLevelUnstick(parsed.repos[repoName]);
      }
      return parsed;
    }

    // V1 format (flat) — migrate
    const v1State: RepoState = {
      implemented: Array.isArray(parsed.implemented) ? parsed.implemented : [],
    };
    return { version: 2, repos: { _migrated: v1State } };
  } catch {
    return { version: 2, repos: {} };
  }
}

/**
 * The questions to the EM that name no issue (`issue: 0`) belong to the repo, not to an issue's record:
 * move them out of the legacy `unstick` table into `repoUnstick`, where they stay.
 */
function splitRepoLevelUnstick(repo: Record<string, unknown>): void {
  const legacy = repo.unstick as Record<string, UnstickEntry> | undefined;
  if (!legacy) return;
  const repoLevel = Object.entries(legacy).filter(([, e]) => e.issue === 0);
  if (repoLevel.length === 0) return;
  repo.repoUnstick = { ...(repo.repoUnstick as Record<string, UnstickEntry> | undefined), ...Object.fromEntries(repoLevel) };
  const rest = Object.entries(legacy).filter(([, e]) => e.issue !== 0);
  if (rest.length > 0) repo.unstick = Object.fromEntries(rest);
  else delete repo.unstick;
}

function saveRaw(state: PersistedState): void {
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Best-effort — don't crash the daemon over a state write failure
  }
}

/**
 * What each top-level field held when this copy was loaded, as JSON. Several
 * lanes of one repo now run at once (lanes.ts), and each saves the WHOLE repo
 * record it loaded earlier — so the release lane saving after a deploy would
 * write back the `implemented` list it read before a build finished, and erase
 * it. With the baseline, a save writes only the fields this copy changed and
 * keeps every other field as it now stands on disk.
 *
 * An enumerable symbol: `{ ...state, verifyHeld }` carries it into the copy (so
 * that save is field-level too), and JSON.stringify never writes it.
 */
const BASELINE = Symbol("repoStateBaseline");
type Baselined = RepoState & { [BASELINE]?: Record<string, string | undefined> };

function baselineOf(s: RepoState): Record<string, string | undefined> {
  const b: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(s)) b[k] = JSON.stringify(v);
  return b;
}

function withBaseline(s: RepoState): RepoState {
  (s as Baselined)[BASELINE] = baselineOf(s);
  return s;
}

export function loadRepoState(repoName: string): RepoState {
  return withBaseline(loadRepoStateCopy(repoName));
}

function loadRepoStateCopy(repoName: string): RepoState {
  const state = loadRaw();

  if (state.repos[repoName]) {
    const repo = state.repos[repoName];
    return {
      implemented: [...repo.implemented],
      rejectedBranches: { ...(repo.rejectedBranches ?? {}) },
      ...(repo.branchBlock ? { branchBlock: { ...repo.branchBlock, announced: [...repo.branchBlock.announced] } } : {}),
      // Dropping this re-announced an open release PR on every promotion pass:
      // trackRelease saw no saved release each time (foreman issue 74).
      ...(repo.release ? { release: { ...repo.release, issues: [...repo.release.issues] } } : {}),
      // Dropped here, a merged release would be deployed again after a restart.
      prodReleases: Object.fromEntries(Object.entries(repo.prodReleases ?? {}).map(([k, v]) => [k, { ...v, issues: [...v.issues] }])),
      ...(repo.promotionHeldNoted ? { promotionHeldNoted: repo.promotionHeldNoted } : {}),
      ...(repo.repoUnstick ? { repoUnstick: Object.fromEntries(Object.entries(repo.repoUnstick).map(([k, v]) => [k, { ...v }])) } : {}),
      ...(repo.noCommitStreaks ? { noCommitStreaks: Object.fromEntries(Object.entries(repo.noCommitStreaks).map(([k, v]) => [k, { ...v }])) } : {}),
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
      rejectedBranches: { ...(migrated.rejectedBranches ?? {}) },
    };
  }

  return {
    implemented: [...EMPTY_REPO_STATE.implemented],
    rejectedBranches: {},
  };
}

/**
 * Save a repo's state. A copy from `loadRepoState` writes only the fields it
 * changed since it was loaded (see BASELINE); a record built from scratch
 * replaces the repo's whole entry, as before.
 */
export function saveRepoState(repoName: string, repoState: RepoState): void {
  const state = loadRaw();
  const baseline = (repoState as Baselined)[BASELINE];
  const disk = state.repos[repoName];
  if (!baseline || !disk) {
    state.repos[repoName] = { ...(disk ? legacyFieldsOf(disk) : {}), ...repoState };
  } else {
    const merged: Record<string, unknown> = { ...disk };
    const mine = repoState as unknown as Record<string, unknown>;
    for (const k of new Set([...Object.keys(baseline), ...Object.keys(repoState)])) {
      const now = JSON.stringify(mine[k]);
      if (now === baseline[k]) continue; // untouched here: keep what is on disk
      if (mine[k] === undefined) delete merged[k];
      else merged[k] = mine[k];
    }
    state.repos[repoName] = merged as unknown as RepoState;
  }
  saveRaw(state);
  // The caller may save the same copy again; its next save diffs from this one.
  (repoState as Baselined)[BASELINE] = baselineOf(repoState);
}

// --- The pre-f2 issue-keyed fields (EM#1244 f2) -------------------------------------------------
// `.agent-state.json` used to hold the issue-keyed records. They now live in the work source's record
// store; these two functions are the one-time import's only way to the old copy (legacy-records.ts),
// and go with it when f4 deletes this file.

/** The record fields the file used to hold per issue. */
const LEGACY_ISSUE_FIELDS = ["failed", "skipped", "held", "verifyHeld", "unstick", "prodVerified", "promotionStallNoted"] as const;

type LegacyRepo = Record<string, Record<string, unknown> | unknown[] | undefined>;

function legacyFieldsOf(repo: object): Partial<RepoState> {
  const from = repo as LegacyRepo;
  return Object.fromEntries(LEGACY_ISSUE_FIELDS.filter((f) => from[f] !== undefined).map((f) => [f, from[f]]));
}

/** What the file still holds for each issue of `repoName`, as the record the store keeps. */
export function legacyIssueEntries(repoName: string): Map<number, Record<string, unknown>> {
  const repo = loadRaw().repos[repoName] as unknown as LegacyRepo | undefined;
  const out = new Map<number, Record<string, unknown>>();
  if (!repo) return out;
  const entry = (n: number) => out.get(n) ?? out.set(n, {}).get(n)!;
  for (const field of ["failed", "skipped", "held", "verifyHeld", "prodVerified"] as const) {
    for (const [key, value] of Object.entries((repo[field] ?? {}) as Record<string, unknown>)) {
      if (Number.isInteger(Number(key)) && Number(key) > 0) entry(Number(key))[field] = value;
    }
  }
  for (const [key, value] of Object.entries((repo.unstick ?? {}) as Record<string, UnstickEntry>)) {
    if (value.issue > 0) entry(value.issue).unstick = { ...(entry(value.issue).unstick as object | undefined), [key]: value };
  }
  for (const n of (repo.promotionStallNoted ?? []) as number[]) entry(n).promotionStallNoted = true;
  return out;
}

/** Remove the legacy entries of `issues` from the file (they are in the store, or no longer matter). */
export function dropLegacyIssueEntries(repoName: string, issues: ReadonlySet<number>): void {
  const state = loadRaw();
  const repo = state.repos[repoName] as unknown as LegacyRepo | undefined;
  if (!repo || issues.size === 0) return;
  for (const field of ["failed", "skipped", "held", "verifyHeld", "prodVerified"] as const) {
    const table = repo[field] as Record<string, unknown> | undefined;
    if (!table) continue;
    const keep = Object.entries(table).filter(([k]) => !issues.has(Number(k)));
    if (keep.length > 0) repo[field] = Object.fromEntries(keep);
    else delete repo[field];
  }
  const unstick = repo.unstick as Record<string, UnstickEntry> | undefined;
  if (unstick) {
    const keep = Object.entries(unstick).filter(([, e]) => !issues.has(e.issue));
    if (keep.length > 0) repo.unstick = Object.fromEntries(keep);
    else delete repo.unstick;
  }
  const noted = ((repo.promotionStallNoted ?? []) as number[]).filter((n) => !issues.has(n));
  if (noted.length > 0) repo.promotionStallNoted = noted;
  else delete repo.promotionStallNoted;
  saveRaw(state);
}
