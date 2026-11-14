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
| `session` | none | one row per item a session lists (`detail`: phase, status, pr, reviewer, detail) |
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
(jerky_shipping#856 alternated `pendingVerification` and `awaitingRelease` every pass, ~2000 rows, 2026-11-10, because
only the card view read the open release PR; both views now share that read.)

Retention: rows older than `retentionDays` are deleted at start and at most hourly after.

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
WHERE repo = 'xrgarcia/example' AND issue = 42 AND stage IS NOT NULL
ORDER BY at;
```
