# Metrics

The `metrics` observer plugin logs when each work item advances through the lifecycle, so the time
spent in each stage, and from pickup to production, can be read back. Off by default.

```json
"metrics": { "enabled": true, "retentionDays": 90 }
```

`path` is optional (a leading `~` is expanded). The default file is `foreman-metrics.db` in the
Foreman's state directory (the daemon's working directory, or `FOREMAN_STATE_DIR` when set). It is SQLite in WAL mode, so the EM, PO and bots on this machine can read it
while the Foreman writes. Keys: see `docs/configuration.md`.

## Requirements

The log uses `node:sqlite`, which Node 22.12 (the declared minimum) ships only behind a
flag. With `metrics` off, the daemon starts on 22.12 as usual. With it on where
`node:sqlite` is unavailable, the daemon still starts, logs
`metrics: could not open <path>: ...` and records nothing; `metrics:report` fails on such a
Node as well. Run the Foreman on a Node where `node:sqlite` loads without a flag before
enabling it (`node -e "require('node:sqlite')"` is the check).

## What is recorded

Raw events only; durations are computed when read. Table `events(id, at, repo, issue, kind, stage, detail)`
(`at` is ISO-8601 UTC, `repo` is `owner/name`, `detail` is JSON):

| kind | stage | when |
|---|---|---|
| `transition` | the stage entered | the Foreman moved the item (`detail`: move, from, to, observed) |
| `stage` | the stage entered | a snapshot shows a stage different from the last one seen, e.g. a move the EM made |
| `closed` | `done` or `notPlanned` | the item closed (once) |
| `hold` | none | why an item waits at `pendingVerification` or `awaitingSignoff` (the EM seat's release gate): `detail` is `{stage, reason}`, one row each time the reason changes, again on re-entry |
| `claim`, `blocked`, `unblocked`, `escalated`, `merged`, `promoted`, `verifyWaiting` | none | context rows |
| `session` | none | one row per item a session lists (`detail`: phase, status, pr, reviewer, detail, and the run fields below) |
| `release` | none | one row per issue in a release PR (`detail`: state, pr) |

An implement session lists a whole batch of candidates but builds one, so pickup is derived by the
report, not stored. The table `item_stage(repo, issue, stage, at)` holds the last stage seen, to avoid
duplicate rows. The first snapshot after enabling records each open item at its current stage with that
moment as the time, so its earlier history is not known.

**Hold reasons.** `detail.reason` is one of `grant` (the EM reported no production grant), `gate-failed` (the EM ran the
gate and did not sign: it escalated or declined, or took it once and has not been re-asked), `seat-failed` (the EM call
failed or was refused, so the gate never ran), `seat-silent` (the EM took it, was asked again, and the issue never
moved; or a call still pending after an hour), `other` (no release-gate entry yet, or none of those). The Foreman derives
it each pass from the issue's `release-gate` unstick entry (its `[grant: {...}]` answer from `em.mjs grant-state`, and
how the last EM call ended; `gateWaitReason`, `src/unstick.ts`) and carries it on the snapshot item. It does not read the
EM seat's Paperclip card: the unstick entry is the Foreman's own record of the seat run. At `awaitingSignoff` it is
`gate-failed` when the issue is among the release PR's unsigned issues, else `other`. A grant missing wins over the
call's status. The table `item_hold(repo, issue, stage, reason)` holds the last reason, to avoid duplicate rows.

**One stage per pass.** A snapshot carries the item view and the card view of the same pass; the card's stage wins (it
knows the open release PRs). Separately, a snapshot-seen A -> B -> A within 10 minutes of B is not recorded (the log
keeps B): a safety net, not a substitute for the two views agreeing. The Foreman's own moves are never suppressed.
(shipping_app#856 alternated `pendingVerification` and `awaitingRelease` every pass, ~2000 rows, 2026-11-10, because
only the card view read the open release PR; both views now share that read.)

## The run ledger

Every agent run writes a start and an end in the `session` rows, so what a run came to and which cards it worked
can be read back (foreman#329). Phases: `implement`, `revise`, `review`, `verify`, `qa`, plus three that hold no card
on the board: `qaReport` (the report-only QA that runs after a dev verification has ended; a report already on the PR runs nothing and records nothing), `prodVerify` (one run per SRE production verification or soak call; a verdict read from an
already-posted comment runs nothing and records nothing) and `em` (one run per `em.mjs unstick` call; none when
`emRepoPath` or `EM_GITHUB_TOKEN` is missing). The Paperclip mirror ignores those three phases.

Each session row's `detail` adds:

| key | on | meaning |
|---|---|---|
| `runId` | every start and end | one value per run (`crypto.randomUUID()`); the rows of a run on N cards share it |
| `parentRunId` | a nested run | QA inside a review or verify run carries the enclosing run's id |
| `outcome` | an end | `completed`, `noWork` or `failed`, set by the phase at its own end site; independent of `status` |
| `workedItems` | an end | `[{repo, issueNumber}]`, the cards the run worked or verified; `[]` when none. Stored on the run's first row only (the reader unions the rows), so storage grows with the card count, not its square. A run with no items still writes one row, with no issue |

`at` on a session row is stamped by the phase when the run starts and ends (the recorder's own clock only when
absent), so a duration is the run's, not the observer queue's.

- **completed**: a delivered verdict, including a review requesting changes and a failing QA or SRE verdict.
- **noWork**: a skip, an already-landed issue, a revise with no commit, a review that declared a no-op (`FOREMAN_REVIEW none`, no trailer), a QA verdict read back off the PR (no agent launched, and a reused FAIL launches no review either), a production verification with nothing to verify, an EM call that ruled out of scope. A noWork run records `workedItems: []`.
- **failed**: an error, a defer, a wait (a production verification that answers `wait-until-...` or a tooling hold too), no result, or a review whose merge landed but whose run did not return a verdict.

The `em` run's outcome comes from the EM's own answer, the line `EM unstick-result {"verdict","readable","worked"}`
that `bin/em.mjs unstick` prints before its human line, not from the exit code. `completed`: `acted` or `escalated` with the
answer read back. `noWork`: `out-of-scope`. `failed`: the unknown-kind refusal, a failure, a refusal, a timeout, a
missing or unparsable result line, or an unreadable answer. `workedItems` is the result line's `worked`: the keyed card, plus
the `signedSiblings` the answer lists when it has any.

Rows written before this carry no `runId` and are never billed.

### Reading the runs

```
npm run -s metrics:runs -- --from <ISO UTC> --to <ISO UTC> --json
```

The window is half-open `[from, to)`; a run belongs to the window its end falls in. JSON on stdout, exit 0; an unreadable
store or a bad window prints nothing to stdout and exits 1.

- `billable`: completed top-level runs, each `{runId, phase, outcome, startedAt, endedAt, durationMs, shares}`. `shares` splits
  `durationMs` equally across the run's cards, integers that sum exactly, the remainder to the first in (repo, issueNumber) order.
- `failed`: failed top-level runs, the same shape (never billed; a failed run that listed no cards has no shares).
- `unclassified`: `{runId, repo, issueNumber, reason}`, never billed. `noRunId`: an end row from before the ledger.
  `noEnd`: a start with no end anywhere. `noStart`, `noOutcome`, `noWorkedItems`: a completed run that cannot be priced.
  `orphanNested`: a nested run whose enclosing run does not end in the window.

Nested runs (`parentRunId`) and duplicate end rows never count twice; `noWork` runs are not listed. Customer and price are the
reader's (the EM repo's `invoice:weekly`), never this command's.

Retention: rows older than `retentionDays` are deleted at start and at most hourly after, except the `blocked` rows of a block
that reaches past the cutoff: an old `blocked` row stays unless a clear (`unblocked` or `closed`) of that card, also older than
the cutoff, came after it. An open block, or one that cleared inside the window, never loses its start.

### Reading blocked time

```
npm run -s metrics:blocked -- --from <date> --to <date> [--now <ISO UTC>] [--db <path>] --json
```

One interval per block, from the card's `blocked` and `unblocked`/`closed` rows (foreman#330). The first `blocked` after a
clear starts it; later `blocked` rows never restart or duplicate it, whatever their reason. Only an `unblocked` or a `closed`
row ends it: a board label, a reason change, the report date and the retention cutoff do not.

Weeks run Monday 00:00 to the next Monday 00:00 US Central (DST-aware, so a week can hold 167 or 169 hours). An interval is cut
at those edges; one still open carries into each following week, to the week's end, and in the current week to `now`.
`--from` and `--to` are Central dates (`YYYY-MM-DD`; an ISO instant also works) forming the half-open window `[from, to)`;
a week overlapping it is reported whole. `--db` reads another store (default: the configured one); `--now` replaces the clock.
JSON on stdout, exit 0; an unreadable store or a bad argument prints nothing to stdout and exits 1. Without `--json` it prints
one text line per row.

`rows` holds one object per card and week: `repo`, `issue`, `week` (the Monday, Central), `hours` (two decimals), `intervals`
(blocks touching the week), `open: true` when a block has not cleared, `incomplete: true` when it cannot be established.
`incomplete` is a card whose first block-related row is an `unblocked` (its start was lost); `hours` is `null`, never zero.
The command names no customer; the EM joins that from its customer lookup.

## Reading it

```
npm run metrics:report -- [--repo <name>] [--issue <n>] [--since <days>] [--json]
```

Per item: pickup time (the latest `implement` session `started` naming the item before its first
`inReview`), each stage entered (the first build appears as a derived `implementing` span from pickup to `inReview`, since the Foreman writes no such row; `approved` ends at pickup) with the time in it, total pickup to `done`, and approved to `done`.
Then, over items that reached `done` in the window (default 30 days): count, median, p75 and p90 hours
per stage and for the total. `--repo` takes the name or `owner/name`. The command runs whether or not
the plugin is enabled, but it exits with `No metrics database at <path>` until a daemon
with `metrics.enabled` has created the file.

Then, for `pendingVerification` and `awaitingSignoff`, a table of the hours split by reason (items, total hours,
share, median per item), summed over the same done items. Time at the stage before the first `hold` row, or in history
recorded before reasons existed, is `unrecorded`.

Direct SQL, e.g. the stage log of one item:

```sql
SELECT at, kind, stage FROM events
WHERE repo = 'acme/example' AND issue = 42 AND stage IS NOT NULL
ORDER BY at;
```
