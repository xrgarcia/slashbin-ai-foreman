# Architecture

[Project README](../README.md) · [All documentation](README.md)

## Contents

- [How it fits together](#how-it-fits-together)
- [Two kinds of listener](#two-kinds-of-listener)
- [Plugins](#plugins)
- [Source layout](#source-layout)
- [Programmatic usage](#programmatic-usage)

How the Foreman fits into an AI engineering team, how its code is laid out, and how to
run it from your own code. The design decisions behind it are in
[../CLAUDE.md](../CLAUDE.md) ("Key design decisions").

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

## Two kinds of listener

Every state change is a named move in `src/lifecycle.ts`, emitted once through
`src/work-source.ts`. The **work source** (GitHub issues today) turns each move into its
labels; **observers** (the optional Paperclip board, the activity log) receive the same
events, best-effort, and an observer that fails never stops the Foreman. The full
picture: [lifecycle.md](lifecycle.md).

## Plugins

The core reaches every outside system through one contract, `src/plugins/contract.ts`
(EM#1150). A plugin declares the roles it fills (`workSource`, `codeHost`, `observer`,
`reviewer`, `verifier`, `deployer`, `qa`, `unstick`), whether a config enables it, and
`start` / `reconfigure` / `stop`. `src/plugins/registry.ts` starts the enabled ones once
at startup, hands them each config reload, and resolves each role; every enabled observer
hears every event. `src/plugins/index.ts` is the only file that names a plugin. Each
plugin, its roles and the key that turns it on: [README](../README.md#plugins).

Paperclip is an observer (`src/plugins/paperclip.ts`, delegating to `src/paperclip/mirror.ts`)
and is optional: off (`paperclip.enabled` false, or no `companyId` / `agentId`) it is never
started, and the core makes no Paperclip call and no observer-only GitHub read
(`observersWantSnapshot`, `observersWantSessionReports`). On, it is self-sufficient: each
pass's snapshot event carries the open issues' stages and live closed states, and the mirror
creates a missing card, moves each card to its stage, and closes a closed issue's card with
nobody holding it. A card's block is kept in the state file (`CardBlockStore`) so it survives
a restart. A plugin can add a CLI command (`paperclip:doctor`).

GitHub issues are the `workSource` plugin (`src/plugins/github.ts`), on unless the config's
`workSource` names another id. Selection, implement, review and every recorded move reach it
only through the registry (`workSourceFor`); the core never constructs `GitHubIssueConnector`,
which the ratchet enforces. With no work source enabled, startup refuses (exit 78).

GitHub is also the `codeHost` plugin, on unless the config's `codeHost` names another id.
`src/code-host.ts` is the interface: one typed method per PR, branch, merge, comment and
label operation, with no raw gh escape hatch. Every phase reaches it only through
`codeHost()` in the registry; the plugin delegates to `src/github/*`. With no code host
enabled, startup refuses (exit 78) and `npm run doctor` fails, as it does for the work source.

The agents are plugins too, each on when its path key is set: the Tech Lead is the
`reviewer` (`tech-lead.ts`, `techLeadPath`), the SRE the `verifier` and `deployer`
(`sre.ts`, `srePath`), slashbin_ai_qa the `qa` (`qa.ts`, `qaPath`, covering `qaRepos`)
and the EM the `unstick` (`em.ts`, `emRepoPath`); `agent-cli.ts` is the runner they
share. Phases resolve them only through `roleFor` / `qaFor`, and startup warnings read
`enabledFor`. The ratchet refuses any core file importing `src/plugins/<agent>.ts`.
With no reviewer enabled, a person reviews and merges; once the PR is on the base branch,
Reconcile moves the issue to `pr merged`, then (no verifier) `pr approved`, then (no
deployer and no promote path) comments and closes it, each a lifecycle move
(`humanMerged`, `humanMergedApproved`, `closedNoRelease`). Each pass re-reads the open
issues' labels and the recently merged PRs, so this works in any branch layout and resumes
where a failed write stopped; it never closes without its completion comment.

`test/plugin-boundary.test.mjs` fails the build when a core file imports
GitHub or Paperclip code directly (its list of exceptions is empty and must stay so) or runs
`gh`, which only `src/github*` and `src/plugins/github.ts` may.

## Source layout

```
src/
├── cli.ts             # CLI entry point
├── config.ts          # Configuration loading + Zod validation
├── logger.ts          # Structured logging (JSON/text)
├── lifecycle.ts       # The state machine: stages and named moves (docs/lifecycle.md)
├── adapters.ts        # Data contract: WorkEvent, WorkSourceAdapter, WorkObserver
├── work-source.ts     # emit()/advance(): one event → work source + observers
├── plugins/           # Plugin contract, registry, composition root, and plugin entries
├── code-host.ts       # The CodeHost interface and the PR, issue and branch types it speaks in
├── profiles/          # Named config defaults (`"profile"`); Slashbin's values live only here
├── config-schema/     # The github and paperclip config blocks (core: config.ts reads them)
├── github.ts          # GitHub plugin code: API surface (PRs, labels, dual-token ops); code in github/
├── github-work-source.ts # GitHub plugin code: issues as the work source, a move → its labels
├── agent.ts           # Claude Code CLI spawner (session env, secret gate, redaction)
├── stages.ts          # Stage schema, default order, dispatch loop
├── lanes.ts           # Stages grouped into lanes; checkout, lane and session locks
├── backoff.ts         # Every retry wait: the `backoff` config block and the one formula
├── onboarding.ts      # A repo's missing labels, created before its first lane pass
├── skill-sync.ts      # Each repo's skill copies kept on a golden source
├── claude-trust.ts    # Claude Code workspace trust for every checkout
├── redact.ts          # Secret redaction in transcripts, logs and errors
├── orchestrator.ts    # Lane pass per (repo, lane), failure cooldowns, shutdown drain
├── phases/            # One file per stage (reconcile, review, verify, promote, release, revise, implement, custom)
├── paperclip/         # Paperclip plugin code: the board mirror, client, doctor
├── state.ts           # Persistent state management (.agent-state.json)
├── daemon.ts          # One poll loop per (repo, lane), config hot-reload, graceful shutdown
├── bridge-client.ts   # WebSocket Discord client (exported; unused by the daemon)
└── index.ts           # Public API exports
```

Branch sync and dependency batches live in `phases/promote.ts`.

## Programmatic usage

```typescript
import { startDaemon, loadConfig, createLogger, registerBuiltinPlugins, startPlugins } from "slashbin-ai-agent";

const config = loadConfig();
const logger = createLogger({ format: "json", level: "info" });
registerBuiltinPlugins();
await startPlugins(config, { logger, configText: () => null }); // the work source and agents
const daemon = startDaemon(config, logger);

// Graceful shutdown
process.on("SIGINT", () => daemon.stop());
```

Everything the package exports is listed in `src/index.ts`: among others the lifecycle
table (`STAGES`, `MOVES`, `transition`), the work-source and observer types, the
`GitHubIssueConnector`, `runCycle` / `runLanePass`, and `DEFAULT_BACKOFF`.
