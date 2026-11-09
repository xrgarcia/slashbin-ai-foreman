# Metrics

The `metrics` observer plugin logs when each work item advances through the lifecycle, so the time
spent in each stage, and from pickup to production, can be read back. Off by default.

```json
"metrics": { "enabled": true, "retentionDays": 90 }
```

`path` is optional (a leading `~` is expanded). The default file is `foreman-metrics.db` in the
Foreman's state directory. It is SQLite in WAL mode, so the EM, PO and bots on this machine can read it
while the Foreman writes. Keys: see `docs/configuration.md`.

## What is recorded

Raw events only; durations are computed when read. Table `events(id, at, repo, issue, kind, stage, detail)`
(`at` is ISO-8601 UTC, `repo` is `owner/name`, `detail` is JSON):

| kind | stage | when |
|---|---|---|
| `transition` | the stage entered | the Foreman moved the item (`detail`: move, from, to, observed) |
| `stage` | the stage entered | a snapshot shows a stage different from the last one seen, e.g. a move the EM made |
| `closed` | `done` or `notPlanned` | the item closed (once) |
| `claim`, `blocked`, `unblocked`, `escalated`, `merged`, `promoted`, `verifyWaiting` | none | context rows |
| `session` | none | one row per item a session lists (`detail`: phase, status, pr, reviewer, detail) |
| `release` | none | one row per issue in a release PR (`detail`: state, pr) |

An implement session lists a whole batch of candidates but builds one, so pickup is derived by the
report, not stored. The table `item_stage(repo, issue, stage, at)` holds the last stage seen, to avoid
duplicate rows. The first snapshot after enabling records each open item at its current stage with that
moment as the time, so its earlier history is not known.

Retention: rows older than `retentionDays` are deleted at start and at most hourly after.

## Reading it

```
npm run metrics:report -- [--repo <name>] [--issue <n>] [--since <days>] [--json]
```

Per item: pickup time (the latest `implement` session `started` naming the item before its first
`inReview`), each stage entered (the first build appears as a derived `implementing` span from pickup to `inReview`, since the Foreman writes no such row; `approved` ends at pickup) with the time in it, total pickup to `done`, and approved to `done`.
Then, over items that reached `done` in the window (default 30 days): count, median, p75 and p90 hours
per stage and for the total. `--repo` takes the name or `owner/name`. The command runs whether or not
the plugin is enabled.

Direct SQL, e.g. the stage log of one item:

```sql
SELECT at, kind, stage FROM events
WHERE repo = 'xrgarcia/example' AND issue = 42 AND stage IS NOT NULL
ORDER BY at;
```
