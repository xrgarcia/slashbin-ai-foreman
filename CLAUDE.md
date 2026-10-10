# slashbin-ai-agent (Foreman)

Open-source daemon that drives GitHub work through Claude Code CLI: it implements
approved issues, reviews the resulting PRs, revises them on feedback, and promotes
merged work — across many repos from a single process.

## Cycle

Each poll cycle runs the configured `stages` across every configured repo
(`src/stages.ts`; README "Pipeline stages"). Omitted, they are the eight built-ins
in this order, so labels set in one phase are consumed by the right phase next cycle:

```
Reconcile → Review → Verify → Revise → Implement → Branch Sync → Dependabot → Promote
```

Verify runs only when `srePath` is set: the SRE checks each merged PR in dev.

A config may drop or reorder built-ins and add custom `{ id, skillPath }` stages —
one Claude session on that skill against the open feature PR. A custom stage that
reports `blocked` or no verdict stops the later stages for that repo's pass.

1. **Reconcile** — detect orphaned commits on the feature branch with no PR; open one.
2. **Review** *(opt-in, `reviewEnabled`)* — for repos with an open feature PR whose
   linked issue is labeled `pr under review`, invoke a **review skill** that reviews,
   merges clean PRs to the base branch, verifies, and transitions labels itself. Runs
   first among PR-acting phases so it only acts on PRs labeled in a *prior* cycle
   (labels settled → no same-cycle race). See **Review phase** below.
3. **Revise** — for issues labeled `pr pending actions` with an open feature PR, invoke
   the revision skill to address review feedback. Prioritized over new implementation.
4. **Implement** — the work source (`WorkSourceAdapter`; GitHub issues via
   `GitHubIssueConnector`) offers every `approved` issue with no delivering PR; the
   implementation skill is handed all of them (less backed-off ones) to choose from by
   priority, while the Foreman's own per-issue bookkeeping uses a capped ascending batch
   (`discoveryBatch`); on success label the issue `pr under review`.
5. **Branch Sync** — merge `main → develop` to clear post-promotion drift.
6. **Dependabot** — file one issue for the open Dependabot PRs (pre-approved per repo
   with `dependencyPreApproved`).
7. **Promote** — create `develop → main` promotion PRs for `ready for prod release` issues.

Priority within a cycle is encoded by stage order. Only one Claude session runs at a
time (`implementing` mutex) for git-state safety.

## Review phase

The Review phase is categorically different from Implement/Revise, because review is a
decision-layer workflow rather than an in-repo edit:

- **Runs as the Tech Lead, only.** `reviewViaTechLead` runs `bin/tech-lead.mjs
  review-pr` in `techLeadPath`; when it cannot take a review the PR waits a
  `backoff.agentUnavailable` window — there is no Claude review session.
  `reviewSkillPath` and `emRepoPath` are accepted but no longer read.
- **Runs under a separate token.** Reviews/merges are attributed to `TECHLEAD_GITHUB_KEY`
  (distinct from `FOREMAN_GITHUB_TOKEN`) — reviewer identity ≠ implementer identity.
- **Owns its own outcomes.** The reviewer posts the verdict, merges approved PRs, and
  transitions issue labels itself; the orchestrator does **not** relabel afterward. Its
  label side effects feed the other phases (approve → `ready for prod release` → Promote;
  request-changes → `pr pending actions` → Revise).

CI gate (before any review session): the PR's checks are read first. Red →
comment the failing checks on the PR and relabel `pr pending actions` so revise
fixes them, no review spent (capped at 2 bounces since the last review, then it
reviews anyway). Running → wait a pass. No CI → review as before.

Gating (`findPRsNeedingReview`): an open `featureBranch → baseBranch` PR whose linked
issue is `pr under review` (not `pr pending actions`) and with no review by
`reviewerLogin` newer than the PR's latest commit (freshness guard against re-review
loops). Every run's full turn-by-turn interaction (`--output-format stream-json`) is
written to `logs/review/<repo>-cycle<N>-<ts>.log` for debugging.

Disabled by default; opt in per repo with `reviewEnabled`, which needs `techLeadPath`
(startup fails without it). `reviewerLogin` cascades per repo like `model`. See
README "Review phase (opt-in)" for the full config table.

## State (persisted to disk)

Durable state lives in `.agent-state.json` in the daemon's directory (not the target
repo), written after every change and loaded on startup so the daemon survives restarts.

- `implemented` — issue numbers already delivered by a PR (self-heals when a tracked
  entry has no delivering PR — see `docs/implemented-cache-self-heal.md`).
- `skipped` — per-issue back-off records for issues the agent deliberately declined
  (investigation-only, blocked-on-external-verification); cleared on success or after
  the `backoff.skip` window. Some transient skip reasons are re-checked and admitted early.
- `verifyHeld` — merged PRs whose dev verification failed, with their attempt count;
  re-verified per `backoff.verifyRetry`.
- `failed` / failure counters — per-repo consecutive-failure counts. After
  `backoff.repoFailure.maxFailures` in a row the stage pauses for an exponential window.
  A run refused by an upstream limit (GitHub rate limit, Claude session limit) is never charged.

In-memory only: the `implementing` mutex, the repo-failure and agent-unavailable waits, and
the upstream back-off state (all reset on restart — safe, it only retries sooner).

## Back-offs

Every wait before a retry is a group in the `backoff` config block (`src/backoff.ts`),
and every one is `min(baseMs × factor^(N−1), capMs)` for the Nth wait in a row, reset by
a success. Phases read `config.backoff`; module-level code (gh runner, CI gate, lifecycle
scans, upstream back-off) reads `backoffSettings()`, which the daemon refreshes on start
and on every config reload. **A new wait is a new group there, never a constant in a
phase.** Groups, defaults and env names: `docs/configuration.md` (generated).

## GitHub names

Every label, branch prefix, title and signature the Foreman reads or writes on GitHub
is config: the trigger label, `lifecycleLabels`, or the `github` block
(`src/github/conventions.ts`), each defaulting to the name it always had. Phases pass
`repoConfig.github`; `src/github/*` functions take it as a trailing parameter defaulting
to `DEFAULT_GITHUB_CONVENTIONS`. Sessions get every label name as `FOREMAN_*_LABEL(S)`
env vars (`setLabelEnv` in `agent.ts`), so no skill types one. **A new GitHub name is a
key there, never a literal.** The markers the Foreman and its skills talk through
(`FOREMAN_RESULT`, `FOREMAN_REVIEW`, `<!-- foreman-ci-gate -->`, "Related to #N") stay
fixed on purpose.

## Architecture

```
src/
├── cli.ts           # CLI entry point (--once, --repo, --help, --version, paperclip:doctor)
├── config.ts        # Zod-validated config from .ai-agent.json + env vars
├── logger.ts        # Structured logging (JSON/text, levels, child contexts)
├── lifecycle.ts     # THE state machine: stages, moves, session stages (generates docs/lifecycle.md)
├── adapters.ts      # The data contract: WorkEvent, WorkSourceAdapter, WorkObserver (no source-specific code)
├── work-source.ts   # emit()/advance(): one event → the work source records it, observers are told
├── github.ts        # gh-CLI public surface; the code is in github/, one file per concern
│                    #   (gh runner, caches, discovery, review queue, lifecycle scans, CI gate, promotion, …)
├── github-work-source.ts # GitHubIssueConnector: a move → its `gh issue edit`; labels → stages for snapshot
├── redact.ts / review-report.ts # Core helpers shared by the agent runner and plugins
├── agent.ts         # Spawns claude CLI (implement / revise / review)
├── backoff.ts       # Every retry wait: the `backoff` config block, the one formula, BackoffTracker
├── upstream-backoff.ts # Daemon-wide GitHub / Claude limit back-off (sole owner of that state)
├── reconciler.ts    # Orphaned-commit reconciliation + branch-divergence checks
├── state.ts         # Disk persistence (.agent-state.json)
├── stages.ts        # Stage schema, default order, dispatch loop
├── orchestrator.ts  # Stage pass per repo, failure cooldowns, the session slot; dispatches to phases/
├── phases/          # One file per stage: reconcile, implement, revise, verify, review, promote, custom;
│                    #   common.ts holds what they share. Each reports every step via emit/advance
├── daemon.ts        # Poll loop, config hot-reload, Discord bridge, graceful shutdown
├── paperclip/config.ts # The plugin's config block: schema, AI_AGENT_PAPERCLIP_* overrides, checks
├── paperclip/client.ts # Paperclip HTTP client (issues, comments, agents); no retry
├── paperclip/agent.ts  # Registers the Foreman agent, wake paths off (`npm run paperclip:register`)
├── paperclip/mirror.ts # PaperclipMirror: a WorkObserver (plugin) — each event → the issue's card; best-effort
├── paperclip/doctor.ts # Read-only check of the integration, six named PASS/FAIL checks (`npm run paperclip:doctor`)
└── index.ts         # Public API exports
```

## Setup

`docs/setup.md` is what a new install needs; the `setup-foreman` skill interviews the
user and writes the config. `npm run setup` builds, installs the labels and runs
`npm run doctor` (`scripts/doctor.mjs`, read-only PASS/WARN/FAIL per check). With no
config file and no `AI_AGENT_REPO_PATH` the daemon refuses to start rather than work
on its own checkout. **A new precondition the daemon needs is a doctor check.**
Tokens: `FOREMAN_GITHUB_TOKEN`; `TECHLEAD_GITHUB_KEY` for review and sync merges;
`SRE_GITHUB_KEY` with `srePath`.

## Key design decisions

- **Skills own the workflow; the Foreman just triggers.** Implement/revise/review logic
  lives in skills (in the service repo for implement/revise, in `emRepoPath` for review),
  not in TypeScript. The daemon discovers work, spawns Claude on the right skill, and
  reconciles labels/state.
- **One state machine, one call.** Every state change is a named move in `src/lifecycle.ts`;
  the orchestrator calls `advance(item, "<move>")` and reports everything else with `emit()`.
  The work source (GitHub labels) records the event; observers (Paperclip, when enabled) get
  the same event. Only `cli.ts` (the wiring) imports `paperclip/`, plus `config.ts` composing
  the plugin's own block from `paperclip/config.ts`; the connector and the plugin never read
  each other (a test walks every core file and enforces it). A new state change is a row in `MOVES`, never a `(from, to)` pair at a call site.
- **One Claude session at a time** — resource + git-state safety.
- **Phase order is the priority order** — reconcile and review settle prior-cycle state
  before new implementation starts. The default `stages` keeps it; a config that
  reorders the built-ins gives that up.
- **Additive, opt-in config** — new capabilities (e.g. Review) default off so existing
  `.ai-agent.json` files keep working unchanged. Every key is commented where it is
  declared; `docs/configuration.md` is generated from those comments and the generator
  fails on an uncommented key. `docs/README.md` is the docs index.
- **Disk persistence** — `.agent-state.json` survives restarts; the daemon resumes where
  it left off.
