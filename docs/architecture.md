# Architecture

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

## Source layout

```
src/
├── cli.ts             # CLI entry point
├── config.ts          # Configuration loading + Zod validation
├── logger.ts          # Structured logging (JSON/text)
├── lifecycle.ts       # The state machine: stages and named moves (docs/lifecycle.md)
├── adapters.ts        # Data contract: WorkEvent, WorkSourceAdapter, WorkObserver
├── work-source.ts     # emit()/advance(): one event → work source + observers
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
import { startDaemon, loadConfig, createLogger } from "slashbin-ai-foreman";

const config = loadConfig();
const logger = createLogger({ format: "json", level: "info" });
const daemon = startDaemon(config, logger);

// Graceful shutdown
process.on("SIGINT", () => daemon.stop());
```

Everything the package exports is listed in `src/index.ts`: among others the lifecycle
table (`STAGES`, `MOVES`, `transition`), the work-source and observer types, the
`GitHubIssueConnector`, `runCycle` / `runLanePass`, and `DEFAULT_BACKOFF`.
