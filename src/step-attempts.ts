// No step runs twice on the same input.
//
// Every repeating step records exactly what it acted on, and when that input has not changed since its last
// attempt the step does not run again. After a bounded number of attempts on one input the step becomes a hold
// with a named owner (an unstick kind), never another retry. The first instance was the no-commit streak,
// keyed by PR and head SHA (src/no-commit-streak.ts, 585b7fc); REVIEW_ROUNDS_ALERT bounds revise by rounds
// since the last ruling (src/phases/common.ts). This file generalizes both:
//
//  - `STEP_INPUTS` declares, for every stage in src/stages.ts, the input it acts on, the guard that enforces
//    "unchanged input, no rerun", its cap and the hold that ends it. test/step-inputs.test.mjs fails when a
//    stage is added without an entry, or an entry names a guard that is gone.
//  - `InputAttempts` is the ledger a step uses when no richer record already keys it: attempts per (PR, step),
//    on the PR's record in the work source (docs/architecture.md "Where state lives"), reset by a new input.
//
// Review is the first step on the ledger: its input is the PR head SHA.

import type { RepoConfig } from "./config.js";
import type { InputAttempt, IssueRecordStore } from "./issue-records.js";
import type { StageType } from "./stages.js";
import type { UnstickKind } from "./unstick.js";

/** Review runs admitted on one PR head before the PR is held for the EM: the first review, a re-review after a no-commit reply, and one more. */
export const MAX_REVIEW_ATTEMPTS_PER_HEAD = 3;

export interface RepeatingStep {
  readonly repeats: true;
  /** What the step acts on: the key whose change is the only thing that lets it run again. */
  readonly input: string;
  /** Where the "same input, no rerun" rule is enforced: a source file and a symbol that must appear in it. */
  readonly guard: { readonly file: string; readonly symbol: string };
  /** Attempts on one unchanged input before it holds; "state" when the step's own write moves the state that picks it up, so an unchanged input is never offered again. */
  readonly cap: number | "state";
  /** The hold that ends the retries, naming its owner: an unstick kind (src/unstick.ts), or null for a "state" step. */
  readonly hold: UnstickKind | null;
}
export interface OneShotStep {
  readonly repeats: false;
  /** Why it cannot run twice on one input. */
  readonly why: string;
}
export type StepInput = RepeatingStep | OneShotStep;

/** One entry per stage in src/stages.ts. A stage that is not declared here fails test/step-inputs.test.mjs. */
export const STEP_INPUTS: Readonly<Record<StageType, StepInput>> = {
  reconcile: {
    repeats: true,
    input: "the issue's label set and state, read live before the label write",
    guard: { file: "src/github-work-source.ts", symbol: "implementationDone" },
    cap: "state",
    hold: null,
  },
  review: {
    repeats: true,
    input: "PR head SHA",
    guard: { file: "src/step-attempts.ts", symbol: "MAX_REVIEW_ATTEMPTS_PER_HEAD" },
    cap: MAX_REVIEW_ATTEMPTS_PER_HEAD,
    hold: "needs-ruling",
  },
  verify: {
    repeats: true,
    input: "the merged PR and the issue's verify hold (attempts, retry time)",
    guard: { file: "src/issue-records.ts", symbol: "VerifyHold" },
    cap: 3,
    hold: "verify-exhausted",
  },
  promote: {
    repeats: true,
    input: "the issues carrying the release label and the open promotion PR's head",
    guard: { file: "src/phases/promote.ts", symbol: "tryPromotion" },
    cap: "state",
    hold: null,
  },
  release: {
    repeats: true,
    input: "the release PR's head SHA and each issue's prod verification attempts",
    guard: { file: "src/phases/release.ts", symbol: "releaseBackoff" },
    cap: "state",
    hold: null,
  },
  revise: {
    repeats: true,
    input: "PR head SHA (no-commit streak), and the review rounds since the last EM scope ruling",
    guard: { file: "src/no-commit-streak.ts", symbol: "MAX_CONSECUTIVE_NO_COMMIT" },
    cap: 2,
    hold: "revision-stalemate",
  },
  implement: {
    repeats: true,
    input: "the issue and its skip record (count, what it waits on)",
    guard: { file: "src/issue-records.ts", symbol: "SkippedIssue" },
    cap: 3,
    hold: "skip",
  },
  "branch-sync": {
    repeats: false,
    why: "it merges production into the base branch; with nothing to merge the next pass is a no-op",
  },
  dependabot: {
    repeats: true,
    input: "the set of open Dependabot PRs, against the durable batch ledger",
    guard: { file: "src/dependency-batch/ledger.ts", symbol: "RecordStoreDependencyBatchLedger" },
    cap: "state",
    hold: "dependency-batch-loop",
  },
  unstick: {
    repeats: true,
    input: "the stuck question's key (kind and reason) on the issue's record",
    guard: { file: "src/unstick.ts", symbol: "UNSTICK_MAX_ATTEMPTS" },
    cap: "state",
    hold: null,
  },
  "skill-deliver": {
    repeats: false,
    why: "it delivers a golden skill hash; a repo already at that hash is current and nothing is delivered",
  },
};

/** The attempt count for `input`: 0 when the input has changed since the attempt was recorded. */
export function attemptsOn(attempt: InputAttempt | undefined, input: string): number {
  return attempt && attempt.input === input ? attempt.count : 0;
}

/** What `admit` decided. `held`: the cap is reached; `first` is true the first time, so the owner is told once. */
export type Admission =
  | { readonly status: "admitted"; readonly count: number }
  | { readonly status: "held"; readonly count: number; readonly first: boolean; readonly since: string }
  | { readonly status: "unavailable" };

/**
 * Attempts per (PR, step), kept on the PR's record. A read or write that fails is "unavailable": the step does
 * not run this pass, because an attempt that cannot be recorded cannot be bounded (fail closed).
 */
export class InputAttempts {
  constructor(private readonly records: IssueRecordStore) {}

  /**
   * Admit one attempt of `step` on PR `pr` at `input`, recording it BEFORE the step runs. At `cap` attempts on the
   * same input it is `held` instead. `answeredBy(since)` (an EM scope ruling posted after the last attempt) releases
   * a hold and starts the count again.
   */
  async admit(
    repoConfig: RepoConfig, pr: number, step: string, input: string, cap: number,
    answeredBy?: (lastAttemptAt: string) => Promise<boolean>, now = new Date(),
  ): Promise<Admission> {
    const record = await this.records.loadPrRecord(repoConfig, pr);
    if (!record) return { status: "unavailable" };
    const prior = record.attempts?.[step];
    let count = attemptsOn(prior, input);
    if (count >= cap && prior && answeredBy && await answeredBy(prior.at)) count = 0;
    if (count >= cap) {
      const first = !prior?.held;
      const since = prior?.at ?? now.toISOString();
      if (first && !await this.records.updatePrRecord(repoConfig, pr, (d) => { d.attempts = { ...d.attempts, [step]: { input, count, at: since, held: true } }; })) return { status: "unavailable" };
      return { status: "held", count, first, since };
    }
    const saved = await this.records.updatePrRecord(repoConfig, pr, (d) => { d.attempts = { ...d.attempts, [step]: { input, count: count + 1, at: now.toISOString() } }; });
    return saved ? { status: "admitted", count: count + 1 } : { status: "unavailable" };
  }

  /** The attempt just admitted did not spend the step (the agent was unavailable, an upstream limit): give it back. */
  async refund(repoConfig: RepoConfig, pr: number, step: string, input: string): Promise<void> {
    await this.records.updatePrRecord(repoConfig, pr, (d) => {
      const a = d.attempts?.[step];
      if (a && a.input === input && a.count > 0) d.attempts = { ...d.attempts, [step]: { ...a, count: a.count - 1 } };
    });
  }
}
