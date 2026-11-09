# Architecture

[Project README](../README.md) · [All documentation](README.md)

## Contents

- [How it fits together](#how-it-fits-together)
- [The core and its plugins](#the-core-and-its-plugins)
- [Plugins](#plugins)
- [Where state lives](#where-state-lives)
- [The runtime](#the-runtime)
- [Branches](#branches)
- [Config profiles](#config-profiles)
- [Source layout](#source-layout)
- [Programmatic usage](#programmatic-usage)

How the Foreman fits into an AI engineering team, how its code is laid out, and how to
run it from your own code. The rules for changing the code are in
[../CLAUDE.md](../CLAUDE.md).

## How it fits together

The Foreman is one layer in an AI engineering pipeline:

1. **Product Owner** defines what to build (issues in GitHub)
2. **Engineering Manager** decomposes epics into implementation tasks, approves them
   with the trigger label
3. **Foreman** picks up approved issues, invokes the implementation skill on each
   service repo, and opens PRs
4. **Reviewers** (human or AI — the Tech Lead) provide feedback on PRs — the Foreman
   revises automatically
5. **SRE** (optional) verifies merged work in dev, and with the release stage deploys
   and verifies it in production
6. **Foreman** promotes merged work from develop → main via promotion PRs, and (with
   the release stage) has it approved, deployed, verified in production and closed

The Foreman uses a **dual-token model**: one GitHub token for its own operations and a
second for the reviewer, so it never approves its own work
([security.md](security.md#two-github-identities)).

The Foreman doesn't need to understand your business. It reads the issue, reads the
repo's `CLAUDE.md`, and invokes the skill — structured context in, autonomous execution
out.

## The core and its plugins

The **core** is the lifecycle (`src/lifecycle.ts`), the stages and lanes, the
orchestrator and phases, the Claude session code and the config. It knows no outside
system by name. Every system it touches (GitHub, Paperclip, the Tech Lead, the SRE, QA,
the EM) is a **plugin** behind one contract, `src/plugins/contract.ts`.

Every state change is a named move in `src/lifecycle.ts`, emitted once through
`src/work-source.ts`. The **work source** (GitHub issues today) turns each move into its
labels; every enabled **observer** (the optional Paperclip board, the metrics log) hears
the same event, best-effort, and an observer that fails never stops the Foreman. The
full picture: [lifecycle.md](lifecycle.md).

## Plugins

A plugin implements `ForemanPlugin`: an `id`, the `roles` it fills, `enabled(config)`
(whether this config turns it on), optional `start` / `reconfigure` / `stop`, optional
CLI `commands`, and one field per role it fills. `src/plugins/registry.ts` is the core's
only way in. At startup it starts every enabled plugin once, in registration order. A
config reload starts a plugin it newly enables, stops one it disables and hands the new
config to one that stays on; one plugin's failure never stops the rest.
`src/plugins/index.ts` is the composition root and the only core file that names a
plugin. Each plugin, its roles and the key that turns it on: [README](../README.md#plugins).

| Role | What it does | How the core reaches it | Needed? |
|---|---|---|---|
| `workSource` | Selects approved work, records each move, loads and saves the durable records | `workSourceFor()` in `work-source.ts` | Required |
| `codeHost` | Every PR, branch, merge, comment, check and label operation | `codeHost()` in the registry | Required |
| `observer` | Hears every event; every enabled observer is called | `emit()` / `advance()` in `work-source.ts` | Optional |
| `reviewer` | Reviews and merges a PR; approves a release PR | `roleFor("reviewer", config)` | Optional |
| `verifier` | Verifies a merge in dev and in production | `roleFor("verifier", config)` | Optional |
| `deployer` | Merges and deploys a release PR | `roleFor("deployer", config)` | Optional |
| `qa` | Checks a change before or after merge, for the repos it covers | `qaFor(repo, config)` | Optional |
| `unstick` | Takes stuck work to someone who can move it | `roleFor("unstick", config)` | Optional |

With no work source or no code host, startup refuses (exit 78) and `npm run doctor`
fails. A stage whose agent role has no plugin does not run, and startup warnings read
`enabledFor`. The unfilled roles degrade like this:

- No reviewer: a person reviews and merges. Once the PR is on the base branch, Reconcile
  moves the issue to `pr merged`, then (no verifier) `pr approved`, then (no deployer and
  no promote path) comments and closes it. Each is a lifecycle move (`humanMerged`,
  `humanMergedApproved`, `closedNoRelease`). Each pass re-reads the open issues' labels
  and the recently merged PRs, so this works in any branch layout and resumes where a
  failed write stopped; it never closes without its completion comment.
- No verifier or deployer: the Verify and Release stages do not run (Release needs both
  agents).
- No observer: nothing else changes. The core makes no observer-only GitHub read
  (`observersWantSnapshot`, `observersWantSessionReports`).

The built-in plugins:

- **GitHub** (`github.ts`) is the `workSource` and the `codeHost`, each on unless the
  config's `workSource` or `codeHost` names another id. As work source it wraps
  `GitHubIssueConnector` (`src/github-work-source.ts`). As code host it implements the
  `CodeHost` interface in `src/code-host.ts`: one typed method per operation, no raw gh
  escape hatch, delegating to `src/github/*`. Only this plugin imports that code.
- **Paperclip** (`paperclip.ts`) is an observer, optional and off by default: with
  `paperclip.enabled` false, or no `companyId` / `agentId`, it is never started and the
  core makes no Paperclip call. It delegates to `src/paperclip/mirror.ts`, a facade over
  five collaborators (card index, placement, session lease, snapshot sync, thread notes;
  none imports another). On, it is self-sufficient: each pass's snapshot event carries
  the open issues' stages and live closed states, and the mirror creates a missing card,
  moves each card to its stage, and closes a closed issue's card with nobody holding it.
  A card's block is kept in its repo's record (below), so it survives a restart. It adds
  the CLI command `paperclip:doctor`.
- **Metrics** (`metrics.ts`) is an observer, off unless `metrics.enabled`. It logs each
  work item's events to a local SQLite file, and adds `metrics:report`
  ([metrics.md](metrics.md)).
- **Agents**, each on when its path key is set: the Tech Lead is the `reviewer`
  (`tech-lead.ts`, `techLeadPath`), the SRE the `verifier` and `deployer` (`sre.ts`,
  `srePath`), slashbin_ai_qa the `qa` (`qa.ts`, `qaPath`, covering `qaRepos`) and the EM
  the `unstick` (`em.ts`, `emRepoPath`). `agent-cli.ts` is the runner they share: each
  agent is a `node <checkout>/<script>` CLI, run with its own environment, a timeout, and
  the session secrets redacted. How an agent is run and how its exit code and trailers
  are read stay inside its plugin; the phases see only the typed outcomes in the
  contract.

### The boundary

`test/plugin-boundary.test.mjs` (logic in `test/plugin-boundary-check.mjs`) fails the
build when a core file:

- imports plugin code: `src/github/`, `src/github.ts`, `src/github-work-source.ts`,
  `src/github-state.ts`, `src/paperclip/`, or any `src/plugins/` file other than
  `contract.ts`, `registry.ts` and `index.ts`;
- constructs `GitHubIssueConnector`;
- runs `gh` (only `src/github*` and `src/plugins/github.ts` may).

The list of allowed exceptions is empty and must stay so. `contract.ts` and `registry.ts`
import no plugin, so a plugin can import the contract alone. To replace a system, write a
plugin that fills the role; the core does not change.

## Where state lives

There is no local state file. What the Foreman must remember across restarts is kept
**in the work source**, as records, and only through `src/issue-records.ts`:

- One record per issue, one per PR, and one per repo (the facts no issue or PR owns:
  EM questions that name no issue, Paperclip card blocks, dependency-batch outcomes).
  The fields are in `src/issue-records.ts` (`IssueRecord`, `PrRecord`, `RepoRecord`).
- The `WorkSourceAdapter` contract (`src/adapters.ts`) has `loadRecord` and `saveRecord`.
  A load answers `found`, `absent` or `unavailable`, and `unavailable` is never read as
  `absent`: the caller leaves that item alone this pass (fail closed), so a GitHub outage
  never re-runs a failed or held issue.
- On GitHub (`src/github/record-store.ts`), a record is one marker comment
  (`<!-- foreman:record v1 -->`, JSON inside) written by the Foreman's own login and
  edited in place. A repo's record sits on one closed anchor issue the Foreman creates.
  `src/record-store.ts` holds the source-neutral pieces and an in-memory store.
- `src/legacy-records.ts` is a one-time import: a leftover `.agent-state.json` from an
  older install is moved into records on a repo's first pass and then deleted.

No step runs twice on the same input (`src/step-attempts.ts`). Every stage declares in
`STEP_INPUTS` the input it acts on and the guard that stops it running again on that input
unchanged; `test/step-inputs.test.mjs` fails when a stage in `src/stages.ts` has no
declaration or its guard is gone. A step with no richer record of its own (review) uses
`InputAttempts`: attempts per PR and step on the PR record (`attempts`), recorded before the
step runs. At the cap it becomes a hold with a named owner (an unstick kind), never another
retry; a new input (a push) or an EM scope ruling after the last attempt resumes it. A record
that cannot be read or saved admits nothing.

Derived each pass, never stored: whether an issue is implemented (its labels), the work
to select, the stage an item is in.

Local files are caches or logs, safe to delete: the GitHub snapshot cache
(`.github-state.json`), the metrics database when metrics is on, `logs/`.

In memory only, reset on restart (safe: it only retries sooner or repeats one note): the
per-phase memory (`src/phase-memory.ts`: failure counts, waits, "already announced" sets),
the upstream back-off state, and the locks.

## The runtime

`ForemanRuntime` (`src/runtime.ts`) is the one object a daemon builds. It owns every store
(the record store and the release, no-commit-streak, EM-hand-off and dependency-batch
stores on top of it, onboarding, workspace trust, skill sync, QA reports, builds in
flight) and `PhaseMemory`. `cli.ts` builds it; the daemon passes it to each lane pass,
and the lane pass to the phases. A test builds its own and starts empty. Only the
composition roots (CLI, daemon, tests) import it as a value; everything else uses
`import type`, so it never becomes an import cycle.

A few things are process-wide on purpose, each marked `Process-wide:` in its source: the
plugin registry, the lane, checkout and session locks (`lanes.ts`), the shutdown flag
and lanes in flight, the gh usage counters, the state directory, the back-off config.

Two rules keep the event loop free. Every GitHub call goes through the async runner
(`ghAsync`, `src/github/gh.ts`): `execFile` plus a timer between retries, so a GitHub
that is not answering cannot starve the observers. Every `git` call goes through
`src/git-exec.ts`, also async with a timeout; `test/no-sync-subprocess.test.mjs` fails the
build if `spawnSync`, `execFileSync` or `execSync` appears anywhere in `src/` (empty
allow-list). Work runs in lanes: each (repo, lane)
pair has its own poll loop, one item at a time, and a repo's checkout lock serializes
only the stages that touch its clone ([pipeline.md](pipeline.md#lanes-stages-run-side-by-side)).

## Branches

Each issue is built on its own branch, `<branchPrefix><issue>-<slug>` (`foreman/` by
default), cut from the base branch. `src/foreman-branch.ts` is the one ownership test:
a PR is the Foreman's when its head starts with `branchPrefix` (or equals the legacy
shared `featureBranch`, kept only so PRs open at the cutover drain). Revise, reconcile
and branch deletion all go through it, so a head with a human's name is never pushed to,
revised or deleted. There is no shared build branch.

## Config profiles

A profile (`src/profiles/`) is a named set of config defaults, selected with
`"profile": "<name>"`. Each key resolves as the schema's neutral default, then the
profile, then `.ai-agent.json`, then the environment. An operator's own values (logins,
repo names, MCP tool lists, header names) live in a profile and nowhere else in `src/`.
The only shipped profile is `slashbin`. See [config-guide.md](config-guide.md#profiles).

## Source layout

```
src/
├── cli.ts             # CLI entry point; builds the ForemanRuntime, starts plugins
├── config.ts          # Configuration loading + Zod validation (profile, file, env)
├── logger.ts          # Structured logging (JSON/text)
├── runtime.ts         # ForemanRuntime: the stores and PhaseMemory, one per daemon
├── phase-memory.ts    # What the phases remember between passes (in memory only)
├── lifecycle.ts       # The state machine: stages and named moves (docs/lifecycle.md)
├── adapters.ts        # Data contract: WorkEvent, WorkSourceAdapter, WorkObserver, records
├── work-source.ts     # emit()/advance(): one event → work source + observers
├── plugins/           # contract.ts, registry.ts, index.ts (composition root), one file per plugin,
│                      #   agent-cli.ts (the runner the agent plugins share)
├── code-host.ts       # The CodeHost interface and the PR, issue and branch types it speaks in
├── profiles/          # Named config defaults (`"profile"`); Slashbin's values live only here
├── config-schema/     # The github and paperclip config blocks (core: config.ts reads them)
├── record-store.ts    # Source-neutral record helpers and the in-memory store
├── issue-records.ts   # Issue, PR and repo records, read and written through the work source
├── legacy-records.ts  # One-time import of a leftover .agent-state.json
├── state-dir.ts       # Where the local cache files sit
├── github.ts          # GitHub plugin code: API surface (PRs, labels, dual-token ops); code in github/
├── github/            # GitHub plugin code: gh runner, caches, discovery, review queue, CI gate,
│                      #   promotion, release, lifecycle scans, the record store
├── github-work-source.ts # GitHub plugin code: issues as the work source, a move → its labels
├── github-state.ts    # GitHub plugin code: the bulk snapshot of open issues and PRs
├── paperclip/         # Paperclip plugin code: the mirror facade and its collaborators, client, doctor
├── metrics/           # Metrics plugin code: the SQLite recorder and the report
├── session/           # The Claude session: runner.ts (spawn), env.ts (allowlist, redaction),
│                      #   secret-gate.ts, protocol.ts (parses what a session printed; no I/O)
├── stages.ts          # Stage schema, default order, dispatch loop
├── lanes.ts           # Stages grouped into lanes; checkout, lane and session locks
├── orchestrator.ts    # Lane pass per (repo, lane), failure cooldowns, shutdown drain
├── phases/            # One file per stage (reconcile, review, verify, promote, release, revise,
│                      #   implement, unstick, skill-deliver, custom); *-workflow.ts build the prompt
│                      #   and run the session; common.ts holds what they share
├── dependency-batch/  # The dependency sweep's collaborators (batch, ledger, policy, landing)
├── foreman-branch.ts  # Per-issue branch naming and the one ownership test
├── backoff.ts         # Every retry wait: the `backoff` config block and the one formula
├── upstream-backoff.ts # Daemon-wide GitHub / Claude limit back-off
├── onboarding.ts      # A repo's missing labels, created before its first lane pass
├── skill-sync.ts      # Each repo's skill copies kept on a golden source
├── claude-trust.ts    # Claude Code workspace trust for every checkout
├── redact.ts          # Secret redaction in transcripts, logs and errors
├── daemon.ts          # One poll loop per (repo, lane), config hot-reload, graceful shutdown
├── bridge-client.ts   # WebSocket Discord client (exported; unused by the daemon)
└── index.ts           # Public API exports
```

Branch sync lives in `phases/promote.ts`. The dependency sweep is orchestration there over the collaborators in `src/dependency-batch/` (batch value object, ledger, filing policy, landing).

## Programmatic usage

```typescript
import {
  startDaemon, loadConfig, createLogger, ForemanRuntime, registerBuiltinPlugins, startPlugins,
} from "slashbin-ai-agent";

const config = loadConfig();
const logger = createLogger({ format: "json", level: "info" });
const rt = new ForemanRuntime();
registerBuiltinPlugins(rt);
await startPlugins(config, { logger, configText: () => null }); // the work source and agents
const daemon = startDaemon(rt, config, logger);

// Graceful shutdown
process.on("SIGINT", () => daemon.stop());
```

Everything the package exports is listed in `src/index.ts`: among others the lifecycle
table (`STAGES`, `MOVES`, `transition`), the work-source and observer types, the
`GitHubIssueConnector`, `runCycle` / `runLanePass` (both take the runtime first), and
`DEFAULT_BACKOFF`.
