// The filing policy: the ONE place that decides whether a dependency batch is
// filed. The sweep asks; nothing else decides.
//
// Rules, in order:
//   1. The ledger cannot be read      -> skip. Never file on "unknown".
//   2. A batch issue is already open  -> skip. One open batch per repo.
//   3. The key has a terminal outcome -> skip. A landed batch is not re-filed.
//      A new head SHA is a new key, so it files once.
//   4. The key was filed MAX_FILINGS times in the last 24 h -> hold, and put it to
//      the EM. This is the structural backstop: a future bug in landed
//      detection becomes one EM message, not hundreds of sessions. Whether the
//      EM already has the notice is the EM question's own state (the unstick
//      entry, EmHandoffs.noteDependencyBatchLoop), never a flag kept here.
//   5. Otherwise file.

import type { BatchHistory } from "./ledger.js";

/** The same batch filed this many times inside the window is a loop. */
export const MAX_FILINGS_PER_WINDOW = 3;
export const FILING_WINDOW_MS = 24 * 60 * 60_000;

export type FilingDecision =
  | { action: "file" }
  | { action: "skip"; reason: "ledger-unavailable" | "issue-open" | "terminal-outcome" }
  | { action: "hold"; filings: number };

export interface FilingFacts {
  /** The ledger's history of this batch: undefined = never filed, null = unreadable. */
  history: BatchHistory | undefined | null;
  /** A dependency-batch issue is open on the repo. */
  batchIssueOpen: boolean;
  now: Date;
}

export class DependencyBatchFilingPolicy {
  constructor(
    private readonly maxFilings: number = MAX_FILINGS_PER_WINDOW,
    private readonly windowMs: number = FILING_WINDOW_MS,
  ) {}

  decide(facts: FilingFacts): FilingDecision {
    if (facts.history === null) return { action: "skip", reason: "ledger-unavailable" };
    if (facts.batchIssueOpen) return { action: "skip", reason: "issue-open" };
    const history = facts.history;
    if (history?.outcome) return { action: "skip", reason: "terminal-outcome" };
    const since = facts.now.getTime() - this.windowMs;
    const filings = (history?.filings ?? []).filter((at) => Date.parse(at) > since).length;
    if (filings >= this.maxFilings) return { action: "hold", filings };
    return { action: "file" };
  }
}
