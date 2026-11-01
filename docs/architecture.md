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
hears every event. `src/plugins/index.ts` is the only file that names a plugin. Paperclip
is the first (`src/plugins/paperclip.ts`); a plugin can add a CLI command (`paperclip:doctor`).

The agents are plugins too, each on when its path key is set: the Tech Lead is the
`reviewer` (`tech-lead.ts`, `techLeadPath`), the SRE the `verifier` and `deployer`
(`sre.ts`, `srePath`), slashbin_ai_qa the `qa` (`qa.ts`, `qaPath`, covering `qaRepos`)
and the EM the `unstick` (`em.ts`, `emRepoPath`); `agent-cli.ts` is the runner they
share. Phases resolve them only through `roleFor` / `qaFor`, and startup warnings read
`enabledFor`. The ratchet refuses any core file importing `src/plugins/<agent>.ts`.
With no reviewer enabled, a person reviews and merges; once the PR is on the base branch,
Reconcile moves the issue to `pr merged`, then (no verifier) `pr approved`, then (no
deployer and no promote path) comments and closes it, each a lifecycle move
(`humanMerged`, `humanMergedApproved`, `closedNoRelease`).

The move is in progress. `test/plugin-boundary.test.mjs` lists each core file that still
imports GitHub or Paperclip code directly, with its exact count. The list may only shrink:
a new import fails the build, and so does a removed one until its line is lowered.

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
├── github.ts          # GitHub API surface (polling, PRs, labels, dual-token ops); code in github/
├── github-work-source.ts # GitHub issues as the work source: a move → its labels
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
├── paperclip/         # Optional Paperclip board plugin (a WorkObserver)
├── state.ts           # Persistent state management (.agent-state.json)
├── daemon.ts          # One poll loop per (repo, lane), config hot-reload, graceful shutdown
├── bridge-client.ts   # WebSocket Discord client (exported; unused by the daemon)
└── index.ts           # Public API exports
```

Branch sync and dependency batches live in `phases/promote.ts`.

## Programmatic usage

```typescript
import { startDaemon, loadConfig, createLogger } from "slashbin-ai-agent";

const config = loadConfig();
const logger = createLogger({ format: "json", level: "info" });
const daemon = startDaemon(config, logger);

// Graceful shutdown
process.on("SIGINT", () => daemon.stop());
```

Everything the package exports is listed in `src/index.ts`: among others the lifecycle
table (`STAGES`, `MOVES`, `transition`), the work-source and observer types, the
`GitHubIssueConnector`, `runCycle` / `runLanePass`, and `DEFAULT_BACKOFF`.
