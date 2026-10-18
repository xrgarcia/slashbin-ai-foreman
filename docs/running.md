# Running the daemon

Starting, stopping and watching the Foreman, how long it waits before retrying
something, and what it spends of GitHub's API budget.

## Daemon management

```bash
npm start          # Start daemon in background
npm stop           # Graceful stop (waits for in-progress work)
npm restart        # Stop + start
npm run status     # Show running state, uptime, recent logs
npm run logs       # Show last 30 lines of agent.log
npm run logs -- 100 # Show last 100 lines

# One repo only: npm run start:repo / stop:repo / status:repo / logs:repo -- <name>

# Foreground / debugging
npm run start:fg   # Run in foreground (ctrl+c to stop)
npm run once       # Run one poll cycle and exit
npm run dev        # Watch mode (auto-reload on source changes)
```

The CLI itself: `node dist/cli.js [--config <path>] [--repo <name>] [--once]`, and
`--help`. To run it as a service that survives reboots, see
`deploy/slashbin-foreman.service.example`.

The daemon writes `.agent[-<repo>].pid` itself at startup, before it does any
work — not just when launched via `npm start`. A daemon started any other way
(`doppler run -- node dist/cli.js`, a detached shell, a supervisor) is therefore
still visible to `status`, `stop` and `restart`.

It also refuses to start when that PID file names a live process, so a second
daemon cannot end up reviewing and merging the same PRs as the first. A stale
file left by a killed daemon is taken over automatically.

**Config reloads live.** The daemon re-reads `.ai-agent.json` every cycle, so most
edits — including a repo added to `repos` — apply without a restart. A repo added this
way is onboarded before its first piece of work ([onboarding.md](onboarding.md)).

**Graceful stop.** On stop the daemon drains every lane of every repo before exiting,
for up to the longest run any watched repo is budgeted (the largest `maxDurationMs`, or
`reviewMaxDurationMs` if longer), so a restart does not kill a build mid-flight. Set
`AI_AGENT_SHUTDOWN_DRAIN_MS` when you deliberately want a fast, work-destroying stop.

**State.** What the Foreman has done and is waiting on is kept in `.agent-state.json`,
so a restart picks up where it left off.

## Back-offs

Every wait before the Foreman tries something again lives in one `backoff` block. Each
condition has its own group, and every wait grows the same way: the Nth wait in a row is
`min(baseMs × factor^(N−1), capMs)`. A success resets it, so a blip costs one short wait
and only trouble that lasts gets the long ones.

| Group | When it waits | Default waits |
|---|---|---|
| `skip` | The implement session declined an issue on purpose | 5 min, doubling to 4 h |
| `verifyRetry` | A dev verification failed (`maxAttempts` 3, then a person) | 10 min, then 20 min |
| `agentUnavailable` | The Tech Lead or the SRE could not run at all | 2 min, doubling to 30 min |
| `repoFailure` | A repo's sessions failed `maxFailures` (2) times in a row | 5 min, doubling to 1 h |
| `upstream` | GitHub's rate limit or Claude's session limit refused work | 2 min, doubling to 1 h |
| `gh` | One `gh` call failed on a network error or 5xx (`maxAttempts` 3) | 1 s, then 3 s |

Override only what you need; the rest keep their defaults. Every field also has an env
override, e.g. `AI_AGENT_BACKOFF_SKIP_BASE_MS`.

```json
{
  "backoff": {
    "skip": { "baseMs": 120000, "capMs": 3600000 },
    "verifyRetry": { "maxAttempts": 5 },
    "upstream": { "factor": 3 }
  }
}
```

The older top-level `skipBackoffMs`, `upstreamBackoffBaseMs` and `upstreamBackoffCapMs`
still work. Every group (including `approvedUnmerged`, `releaseRetry` and
`prodVerifyRetry`), field and env name: [configuration.md](configuration.md#back-offs).

Code: `src/backoff.ts`.

## GitHub API budget

Each poll cycle spends **one GraphQL request per repo** for issue discovery. GitHub's
GraphQL limit is **5,000 requests/hour per token**, so the discovery floor is:

```
repos × (3600000 / pollIntervalMs)   requests/hour
```

The daemon logs this as `estDiscoveryGraphQlPerHour` on startup — check it against
5,000 after adding repos or lowering the poll interval. 20 repos at a 60 s interval is
1,200/hour; the same 20 repos would need an interval under ~15 s before discovery alone
threatened the ceiling. Merges, reviews, and promotions spend additional requests on
top, but only when there is work.

This budget is why the discovery phases share **one open-issue snapshot per repo per
cycle** rather than issuing a query per label. Before that change, six lookups each ran
their own `gh issue list` — 20 repos on a 60 s interval came to ~7,200 requests/hour,
which permanently exhausted the token and made roughly one lookup in six fail. A failed
lookup silently skips that phase for that repo that cycle, so `approved` issues sat
unimplemented with nothing but generic errors in the log.

Two consequences worth knowing:

- **Keep `issueCacheTtlMs` below `pollIntervalMs`**, or a cycle can be served entirely
  from the previous cycle's snapshot and an externally-applied `approved` label waits an
  extra cycle. The daemon warns at startup if you cross that line.
- **Rate-limit rejections are logged as `[gh] RATE LIMIT EXHAUSTED`** and are
  deliberately not retried — the budget is already spent. If you see them, raise
  `pollIntervalMs` or reduce the repo count.

`issueSnapshotLimit` (default 500) caps the open issues fetched per snapshot; it must
exceed a repo's open-issue count, and truncation is logged.
