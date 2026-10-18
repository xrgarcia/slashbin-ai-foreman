# Review phase (opt-in)

[Project README](../README.md) · [All documentation](README.md)

## Contents

- [When a PR is reviewed](#when-a-pr-is-reviewed)
- [Outcome-label reconciliation](#outcome-label-reconciliation)
- [Declaring a deliberate hold](#declaring-a-deliberate-hold)
- [Review config](#review-config)

The Review phase closes the loop between Implementation and Revision by handing
open feature PRs awaiting review to the **Tech Lead** (`techLeadPath`) — automating the
human or agent reviewer step. It is **disabled by default** (`reviewEnabled: false`); a
vanilla config keeps the original behavior, with no review step.

It differs from Implementation and Revision in three ways, because review is a
decision-layer workflow rather than an in-repo edit:

- **Runs as a separate program.** The Foreman runs `bin/tech-lead.mjs review-pr` in
  the Tech Lead's checkout, which carries its own review procedure. When it cannot
  take a review (its model is unavailable), the PR waits and is offered again after
  a `backoff.agentUnavailable` wait.
- **Runs under a separate token.** Reviews and merges are attributed to the account
  behind `TECHLEAD_GITHUB_KEY` (distinct from `FOREMAN_GITHUB_TOKEN`), keeping the
  reviewer identity separate from the implementer identity, so the Foreman never
  approves its own work ([security.md](security.md#two-github-identities)).
- **Owns its own outcomes.** The reviewer posts the verdict, merges approved PRs, and
  transitions issue labels itself. The label side effects feed the other phases:
  approve → `pr approved` (awaiting the human release gate); request changes →
  `pr pending actions` (Revise). The Foreman reconciles the label as a backstop
  when the reviewer merged without setting it — see below.

With `srePath` set, review ends at the merge (issue → `pr merged`) and the verify stage
checks the work in dev ([pipeline.md](pipeline.md#the-stages)).

## When a PR is reviewed

A PR is gated into review only when its linked issue is labeled `pr under review`,
it has an open `featureBranch → baseBranch` PR, and there is no review by
`reviewerLogin` newer than the PR's latest commit (a freshness guard against
re-review loops).

Every review run's full turn-by-turn interaction (`--output-format stream-json`) is
written verbatim to `logs/review/<repo>-cycle<N>-<timestamp>.log` for debugging.

## Outcome-label reconciliation

The merge is performed by code, but the *record* of what the merge meant used to be
left entirely to the review agent to remember to write. When a session ended after
merging but before labeling, the issue stayed at `pr under review` with its PR
already closed — invisible to every phase, since the review gate only matches OPEN
PRs. Measured over one week on a 20-repo fleet: **12 of 53 merges (~23%) stranded
their issue this way.**

The outcome was never actually unknown — it arrives in the `FOREMAN_REVIEW` trailer
the Foreman already parses. `reviewLabelReconcile` (default `true`) spends it: after
a run reports a merge, any linked issue still sitting at `pr under review` is moved
to the label its own trailer implies.

Four conditions gate every write, so the reconciler can only ever repair a missing
write — never invent one, never overrule anyone:

1. the issue is still at `pr under review` with no outcome label (a skill that
   labels correctly never reaches this code, so a healthy pipeline is unchanged);
2. a **merged** PR provably closed that issue, under the strict closing-keyword
   predicate (a bare "related to #N" never counts);
3. that PR emitted a trailer this run whose fields are unambiguous;
4. the reviewer did not declare a hold (below).

It never applies `ready for prod release`. That label authorizes production and
remains a human act.

Set `reviewLabelReconcile: false` (or `AI_AGENT_REVIEW_LABEL_RECONCILE=false`) to
keep labeling strictly agent-owned.

## Declaring a deliberate hold

A reviewer that merges but *intentionally* leaves the label unset — typically an
acceptance criterion that cannot be observed yet — appends an optional `hold=` field
to that PR's trailer:

```
FOREMAN_REVIEW pr=#100 verdict=APPROVE merged=yes deploy=SUCCESS hold=criterion-not-observable-until-0300z
```

The Foreman then neither sets the label nor re-verifies behind it, and surfaces the
issue as *held* rather than failed. The hold is persisted in `.agent-state.json`, so
it survives restarts, and clears automatically once the issue leaves the dead zone.

Without this, a deliberate hold and a dropped label are the same observation, and
automation has to guess — which means overwriting a correct judgment with a rubber
stamp.

The four-field trailer remains the contract: `hold=` is optional and trails the
original fields, so trailers written before it existed parse identically.

## Review config

Global; `reviewEnabled` and `reviewerLogin` can also be set per repo, and a per-repo
value wins. Every key in full: [configuration.md#review-phase](configuration.md#review-phase).

| Key | Default | Description |
|---|---|---|
| `reviewEnabled` | `false` | Enable the Review phase (per-repo override supported) |
| `techLeadPath` | — | The Tech Lead's checkout. **Required when any repo has review on** (startup fails otherwise) |
| `reviewModel` | — | Model override for review runs (independent of `model`) |
| `reviewMaxTurns` | `200` | Max turns (review + verify is long-running) |
| `reviewMaxDurationMs` | `3600000` (60 min) | Max review duration |
| `reviewAllowedTools` | broad MCP + shell set | Tool surface for the review skill |
| `reviewerLogin` | — | GitHub login the review runs as (freshness guard). Unset = a verdict by any reviewer counts as current |
| `reviewLabelReconcile` | `true` | Set the outcome label from the run's own trailer when the skill merged without labeling. Env: `AI_AGENT_REVIEW_LABEL_RECONCILE` |

Requires `techLeadPath` and `TECHLEAD_GITHUB_KEY` in the environment when enabled.

Code: `src/phases/review.ts`, `src/review-report.ts`, `src/review-checkout.ts`.
