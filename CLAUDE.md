# slashbin-ai-agent (Foreman)

Open-source daemon that drives GitHub work through Claude Code CLI: it implements
approved issues, reviews the resulting PRs, revises them on feedback, and promotes
merged work — across many repos from a single process.

## Changing this repo

Since 2026-10-29, changes reach this repo's `features` branch only by branch, PR and a Tech Lead
`review-pr` run. After the merge, restart with `scripts/restart-drained.sh`. `features` merges to
`develop` as the pre-release. That is how *this* repo ships; the repos the Foreman manages are
built on per-issue branches (see **Branches**), never a shared `features`.

## Cycle

Each poll cycle runs the configured `stages` across every configured repo
(`src/stages.ts`; `docs/pipeline.md`). Omitted, they are the eleven built-ins
in this order, so labels set in one phase are consumed by the right phase next cycle:

```
Reconcile → Review → Verify → Promote → Release → Revise → Implement → Branch Sync → Dependabot → Unstick → Skill Deliver
```

Stages run in lanes (`src/lanes.ts`): `build` = revise + implement, `release` = promote +
release, every other stage has its own. The daemon runs one loop per (repo, lane); each item is
handled once at a time. `skill-deliver` runs only on a `syncOnly` repo, which runs no other stage.

Agents are plugin roles (`src/plugins/registry.ts`). Verify needs `srePath`; Release needs
`techLeadPath` and `srePath` (else skipped with a warning; an explicit `release` is refused).
With no reviewer a person merges, and Reconcile closes the issue if nothing releases it.

A dev visual QA FAIL (`hold=visual-qa-failed`) is the EM's decision: the Foreman files nothing, holds the
issue at its cap and raises unstick kind `rework-decision` that cycle (PR, touched files, verdict, evidence).
A charged failure with a verdict calls the EM the same way on its first failure, retries still running. The
EM's fix linked to #N (#N blocked by it, or a sub-issue of #N; `docs/em-coordination.md` §2) or a spec edit releases the hold. (Ray, 2026-10-31; replaces EM#485.)

A config may drop or reorder built-ins and add custom `{ id, skillPath }` stages —
one Claude session on that skill against the open Foreman PR. A custom stage that
reports `blocked` or no verdict stops the later stages for that repo's pass.

1. **Reconcile** — detect orphaned commits on a Foreman branch with no PR; open one.
2. **Review** *(opt-in, `reviewEnabled`)* — for repos with an open Foreman PR whose
   linked issue is labeled `pr under review`, call the reviewer plugin (the Tech Lead), which
   reviews, merges clean PRs to the base branch and transitions labels itself. Runs
   first among PR-acting phases so it only acts on PRs labeled in a *prior* cycle
   (labels settled → no same-cycle race). See **Review phase** below.
3. **Verify** — the SRE verifies each merge in dev; success writes `pr approved`.
4. **Promote** — create `develop → main` promotion PRs for `ready for prod release` issues
   and move them to `release pending`; branch sync lives here too.
5. **Release** (`src/phases/release.ts`, no Claude session) — Tech Lead `approve-promotion`
   at the PR head → SRE `deploy` (merge, deploy, verify) → annotated tag on the merge commit
   (never a GitHub Release, never a `v` prefix) → close each issue on a passed prod
   verification, or `prod verification held` and re-verify on a back-off; then a 30-minute
   soak. A release PR listing an issue without `ready for prod release` (or a label it moves on
   to) is held: no approval, no merge, a failing `github.signoffStatusContext` status and a comment
   naming the issues; it clears itself once the EM signs them (foreman#128). Adopts promotion PRs merged by anyone else in the last 48h. Sends nothing to
   Discord. See docs/lifecycle.md.
6. **Revise** — for issues labeled `pr pending actions` with an open Foreman PR, invoke
   the revision skill to address review feedback. Prioritized over new implementation.
7. **Implement** — the work source (`WorkSourceAdapter`; GitHub issues via
   `GitHubIssueConnector`) offers every `approved` issue with no delivering PR; the
   implementation skill is handed all of them (less backed-off ones) to choose from by
   priority, while the Foreman's own per-issue bookkeeping uses a capped ascending batch
   (`discoveryBatch`); on success label the issue `pr under review`.
8. **Branch Sync** — merge `main → develop` to clear post-promotion drift.
9. **Dependabot** — file one issue for the open Dependabot PRs (pre-approved per repo
   with `dependencyPreApproved`: filed with `approved` and `deliver-to-prod`; owner authorization covers every Foreman-managed repo for
   slashbin.io, jerky.com and cmneb as of 2026-10-24; opt-in per repo, default off).
10. **Unstick** (`src/phases/unstick.ts`, `src/unstick.ts`, no Claude session; runs only with
    `emRepoPath`) — the EM plugin's `bin/em.mjs unstick` takes each stuck issue; the outcome is
    the `unstick` record. See docs/pipeline.md.
11. **Skill Deliver** (`src/phases/skill-deliver.ts`, `syncOnly` repos) — delivers the golden
    skill copies to a human-lane repo. See docs/skill-sync.md.

Priority within a cycle is encoded by stage order. Git safety is locks, not a global mutex:
a per-repo checkout lock (`lanes.ts`; reconcile, revise, implement and custom hold it), a
(repo, lane) lock, and an optional `maxConcurrentSessions` ceiling (`withSessionSlot`).

## Review phase

The Review phase is categorically different from Implement/Revise, because review is a
decision-layer workflow rather than an in-repo edit:

- **Runs as the Tech Lead, only.** The phase reaches the reviewer through
  `roleFor("reviewer", config)`; `reviewViaTechLead` (`src/plugins/tech-lead.ts`) runs
  `bin/tech-lead.mjs review-pr` in `techLeadPath`. When it cannot take a review the PR waits a
  `backoff.agentUnavailable` window — there is no Claude review session. `emRepoPath` is read
  by the EM, QA and Tech Lead plugins and the Unstick stage.
- **Runs under a separate token.** Reviews/merges are attributed to `TECHLEAD_GITHUB_KEY`
  (distinct from `FOREMAN_GITHUB_TOKEN`) — reviewer identity ≠ implementer identity.
- **Owns its own outcomes.** The reviewer posts the verdict, merges approved PRs, and
  transitions issue labels itself; the orchestrator does **not** relabel afterward. Its
  label side effects feed the other phases (approve → `pr merged` → Verify → `pr approved`;
  request-changes → `pr pending actions` → Revise).

CI gate (before any review session): the PR's checks are read first. Red →
comment the failing checks on the PR and relabel `pr pending actions` so revise
fixes them, no review spent (capped at 2 bounces since the last review, then it
reviews anyway). Running → wait a pass. No CI → review as before.

Gating (`findPRsNeedingReview`): an open Foreman-owned PR (`isForemanOwnedHead`) into
`baseBranch` whose linked issue is `pr under review` (not `pr pending actions`) and with no
review by `reviewerLogin` newer than the PR's latest commit (freshness guard against re-review
loops). A Foreman PR that names no open approved issue is reviewed with none, so one review
ignored cannot hold the repo. Every run's full turn-by-turn interaction
(`--output-format stream-json`) is written to `logs/review/<repo>-cycle<N>-<ts>.log`.

Disabled by default; opt in per repo with `reviewEnabled`, which needs `techLeadPath`
(startup fails without it). `reviewerLogin` cascades per repo like `model`. See
`docs/review.md` for the full config table.

## State

Durable state is records in the work source (EM#1244), only through `src/issue-records.ts`: one
marker comment per issue and per PR, and one on a closed Foreman-owned anchor issue for the repo
(`src/github/record-store.ts`). A load answers found, absent or **unavailable**; unavailable is
never read as absent, so the caller leaves the item alone (fail closed). There is no
`.agent-state.json`; `src/legacy-records.ts` moves a leftover one in once and deletes it.

- Issue record: `failed`, `skipped` (back-off for declined issues, cleared on success or after
  `backoff.skip`), `held`, `verifyHeld` (re-verified per `backoff.verifyRetry`), `unstick`,
  `prodVerified`, `promotionStallNoted`, `divergenceTold`.
- PR record: release stage, tracked, no-commit streak, rejected head.
- Repo record: `unstick` questions naming no issue, `divergenceRuled`, `cardBlocks`, `dependencyBatches` (the outcome of each dependency batch by PRs + head SHAs).
- Derived, never stored: `implemented` (labels and `selectWork`).

Local files are caches or logs only: `.github-state.json` (rebuildable snapshot), the metrics
SQLite file when `metrics.enabled`, the PID file, `logs/`. In memory only, reset on restart (safe:
it only retries sooner or repeats one note): `PhaseMemory` (`src/phase-memory.ts`), the upstream
back-off state, the locks.

**New per-daemon state is a field on `ForemanRuntime`** (`src/runtime.ts`), passed daemon → lane
pass → phase; only composition roots (cli, daemon, tests) import it as a value, the rest
`import type`. A module-level singleton needs a `Process-wide:` comment saying why.

## Branches

Each issue is built on `<branchPrefix><issue>-<slug>` (`foreman/` by default), cut from
`baseBranch`. `isForemanOwnedHead` (`src/foreman-branch.ts`) is the one ownership test; revise,
reconcile and branch deletion all use it, so never push to, revise or delete a head it rejects.
The legacy shared `featureBranch` is honored only to drain PRs open at the cutover.

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
(`src/config-schema/github.ts`), each defaulting to the name it always had. Phases pass
`repoConfig.github`; `src/github/*` functions take it as a trailing parameter defaulting
to `DEFAULT_GITHUB_CONVENTIONS`. Sessions get every label name as `FOREMAN_*_LABEL(S)`
env vars (`setLabelEnv` in `src/session/env.ts`), so no skill types one. **A new GitHub name is a
key there, never a literal.** The markers the Foreman and its skills talk through
(`FOREMAN_RESULT`, `FOREMAN_REVIEW`, `<!-- foreman-ci-gate -->`, "Related to #N") stay
fixed on purpose.

## Architecture

Layout, plugin model and boundary: `docs/architecture.md`. The modules a change usually touches:

- `plugins/` — `contract.ts` (roles), `registry.ts` (the core's only way in), `index.ts` (composition root), one file per plugin.
- `lifecycle.ts` (the state machine; generates `docs/lifecycle.md`), `work-source.ts` (`emit()`/`advance()`), `adapters.ts` (the data contract), `code-host.ts` (typed, no raw `gh`).
- `runtime.ts` + `phase-memory.ts`, `issue-records.ts` + `record-store.ts`, `profiles/`, `foreman-branch.ts`.
- `stages.ts`, `lanes.ts`, `orchestrator.ts`, `daemon.ts`, `phases/` (`*-workflow.ts` run the Claude session), `dependency-batch/`, `session/` (runner, env, secret-gate, protocol).
- Plugin code, off-limits to the core: `github.ts`, `github/`, `github-work-source.ts`, `github-state.ts`, `paperclip/`, `metrics/`.

## Setup

`docs/setup.md` is what a new install needs; the `setup-foreman` skill interviews the
user and writes the config. `npm run setup` builds, installs the labels and runs
`npm run doctor` (`scripts/doctor.mjs`, read-only PASS/WARN/FAIL per check). With no
config file and no `AI_AGENT_REPO_PATH` the daemon refuses to start rather than work
on its own checkout. **A new precondition the daemon needs is a doctor check.**
Tokens: `FOREMAN_GITHUB_TOKEN`; `TECHLEAD_GITHUB_KEY` for review and sync merges;
`SRE_GITHUB_KEY` with `srePath`.
Skill copies follow a golden via `skillSync` (`docs/skill-sync.md`): code syncs a stale
copy in the commit before an implement session, never a session, never all repos at once.

**Restart with `scripts/restart-drained.sh`, never by waiting for idle.** SIGTERM is the
restart: new sessions stop at once, work in flight gets up to 60 min to finish, and the
script exits 0 only on the new process's `Daemon starting`. A busy fleet is never idle.
The new process loads `dist/` when the drain ends, not when you ask: **never build during
a drain** (2026-10-16: a test build of an uncommitted edit made it refuse to start).

## Key design decisions

- **Skills own the workflow; the Foreman just triggers.** Implement/revise logic
  lives in the service repo's skills, review in the Tech Lead (reviewer plugin), not TypeScript. The daemon discovers work, spawns Claude on the right skill, and
  reconciles labels/state.
- **One state machine, one call.** Every state change is a named move in `src/lifecycle.ts`;
  the orchestrator calls `advance(item, "<move>")` and reports everything else with `emit()`.
  The work source (GitHub labels) records the event; observers (Paperclip, metrics, when enabled) get
  the same event. No core file imports plugin code or runs `gh`; it goes through
  `plugins/registry.ts` (`test/plugin-boundary.test.mjs`; its exception list is empty and stays
  empty). A new state change is a row in `MOVES`, never a `(from, to)` pair at a call site.
- **Every GitHub call is async** (`ghAsync`, `src/github/gh.ts`); the sync runner is gone. A sync
  child process on the event loop (`reconciler.ts`'s `git()` still is one) can freeze the daemon, as on 2026-11-06.
- **Concurrency is per (repo, lane)**, not one session at a time.
- **Phase order is the priority order** — reconcile and review settle prior-cycle state
  before new implementation starts. The default `stages` keeps it; a config that
  reorders the built-ins gives that up.
- **Additive, opt-in config** — new capabilities (e.g. Review) default off so existing
  `.ai-agent.json` files keep working unchanged. Every key is commented where it is
  declared; `docs/configuration.md` is generated from those comments and the generator
  fails on an uncommented key. `docs/README.md` is the docs index.
- **Profiles** — operator-specific values (logins, repo names, header names) live in `src/profiles/`, nowhere else in `src/`.
- **Metrics** — the opt-in `metrics` observer logs stage advances to SQLite; `npm run metrics:report` reads it (`docs/metrics.md`).
- **Persistence** — work-source records survive restarts; the daemon resumes where it left off.
