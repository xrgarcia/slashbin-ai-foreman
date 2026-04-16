# slashbin-ai-foreman

*The autonomous engineering delegator behind [www.slashbin.io](https://www.slashbin.io). Picks up approved issues, invokes implementation skills on service repos, ships PRs, and responds to review feedback.*

**Turn approved GitHub issues into shipped pull requests — autonomously.**

The Foreman is an AI engineering agent that polls your repos for approved work, invokes a Claude Code skill (e.g. `/implement-approved-issues`) on each service repo, opens PRs, and revises based on reviewer feedback. Reviewers — human or AI — stay in the loop via PR reviews. Uses your CLI subscription — no per-run API costs.

## Who this is for

- **Engineering teams** that want an AI teammate picking up approved issues overnight
- **Solo developers** who want their backlog to shrink while they sleep
- **Vibe coders** whose AI handles the planning — the Foreman handles the execution
- **Teams running AI employees** via [slashbin-ai-team](https://github.com/xrgarcia/slashbin-ai-team) who need autonomous implementation behind the coordination layer

## What the Foreman does

Each poll cycle runs five phases across every configured repo:

```
Reconciliation → Revision → Implementation → Branch Sync → Promotion
```

1. **Reconcile** — detects orphaned commits on the features branch with no PR and creates one
2. **Revise** — finds PRs with pending review feedback and revises them (prioritized over new work)
3. **Implement** — picks up approved issues and invokes the repo's implementation skill via Claude Code (up to 3 issues per cycle; 1 in greenfield repos)
4. **Branch Sync** — merges main → develop to keep branches aligned after promotions
5. **Promote** — creates promotion PRs (develop → main) for issues labeled `ready for prod release`

- **Poll interval is configurable** — default 5 minutes (`pollIntervalMs` in config)
- **Multi-repo** — manages multiple repos in a single daemon, each with its own skill paths and config
- **Persists state across restarts** — picks up where it left off
- **Failure cooldown** — after 2 consecutive failures on a repo, skips it for 3 cycles before retrying
- **Graceful shutdown** — waits for in-progress work before stopping (60-second timeout)
- **Discord notifications** — optional; posts status updates to a Discord channel via WebSocket bridge. The Foreman runs without Discord — set `DISCORD_BOT_ID` and `DISCORD_STATUS_CHANNEL` to enable

## How it fits together

The Foreman is one layer in an AI engineering pipeline:

1. **Product Owner** defines what to build (issues in GitHub)
2. **Engineering Manager** decomposes epics into implementation tasks, approves them with the trigger label
3. **Foreman** picks up approved issues, invokes the implementation skill on each service repo, and opens PRs
4. **Reviewers** (human or AI) provide feedback on PRs — Foreman revises automatically
5. **Foreman** promotes merged work from develop → main via promotion PRs

The Foreman uses a **dual-token model**: one GitHub token for its own operations (creating PRs, managing labels) and a second token for the Engineering Manager (approving and merging PRs that require branch protection). This prevents the Foreman from self-approving its own work.

This is the pattern behind [www.slashbin.io](https://www.slashbin.io) — structured context in, autonomous execution out. The Foreman doesn't need to understand your business. It reads the issue, reads the repo's CLAUDE.md, and invokes the skill.

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/xrgarcia/slashbin-ai-foreman.git
cd slashbin-ai-foreman
npm install && npm run build

# 2. Ensure claude and gh CLIs are installed and authenticated
claude --version
gh auth status

# 3. Start the daemon
npm start
```

## Daemon management

```bash
npm start          # Start daemon in background
npm stop           # Graceful stop (waits for in-progress work)
npm restart        # Stop + start
npm run status     # Show running state, uptime, recent logs
npm run logs       # Show last 30 lines of agent.log
npm run logs -- 100 # Show last 100 lines

# Foreground / debugging
npm run start:fg   # Run in foreground (ctrl+c to stop)
npm run once       # Run one poll cycle and exit
npm run dev        # Watch mode (auto-reload on source changes)
```

## Configuration

Create `.ai-agent.json` in your repo root, or use environment variables. Env vars take precedence.

### Single-repo mode

For a single repo, set fields at the root level:

| Config Field | Env Var | Default | Description |
|---|---|---|---|
| `repoPath` | `AI_AGENT_REPO_PATH` | `.` | Path to local repo clone |
| `githubRepo` | `AI_AGENT_GITHUB_REPO` | *(from git remote)* | GitHub `owner/repo` |
| `triggerLabel` | `AI_AGENT_TRIGGER_LABEL` | `approved` | Label that triggers implementation |
| `pollIntervalMs` | `AI_AGENT_POLL_INTERVAL_MS` | `300000` (5 min) | Poll interval in milliseconds |
| `skillPath` | `AI_AGENT_SKILL_PATH` | — | Claude Code skill for implementation |
| `revisionSkillPath` | — | — | Claude Code skill for PR revision |
| `prompt` | `AI_AGENT_PROMPT` | *(built-in)* | Custom prompt template |
| `baseBranch` | `AI_AGENT_BASE_BRANCH` | `develop` | PR target branch |
| `featureBranch` | `AI_AGENT_FEATURE_BRANCH` | `features` | Branch to commit to |
| `maxTurns` | `AI_AGENT_MAX_TURNS` | `30` | Max agent turns per issue |
| `maxDurationMs` | `AI_AGENT_MAX_DURATION_MS` | `1800000` (30 min) | Max implementation time |
| `allowedTools` | — | `["Read","Write","Edit","Bash","Glob","Grep"]` | Tools the CLI can use |
| `logFormat` | `AI_AGENT_LOG_FORMAT` | `text` | `json` or `text` |
| `logLevel` | `AI_AGENT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Multi-repo mode

Use the `repos` array to manage multiple repos in a single daemon. Each repo can override `skillPath`, `revisionSkillPath`, `baseBranch`, and `featureBranch`:

```json
{
  "repos": [
    {
      "name": "console",
      "repoPath": "../my-console",
      "githubRepo": "org/my-console",
      "skillPath": ".claude/skills/implement-approved-issues/SKILL.md",
      "revisionSkillPath": ".claude/skills/revise-pr-feedback/SKILL.md"
    },
    {
      "name": "api",
      "repoPath": "../my-api",
      "githubRepo": "org/my-api",
      "skillPath": ".claude/skills/implement-approved-issues/SKILL.md",
      "revisionSkillPath": ".claude/skills/revise-pr-feedback/SKILL.md"
    }
  ],
  "triggerLabel": "approved",
  "pollIntervalMs": 120000,
  "maxTurns": 50
}
```

### Discord notifications (optional)

Set these environment variables to enable status updates in Discord. The Foreman runs without them.

| Env Var | Description |
|---|---|
| `DISCORD_BOT_ID` | Your Discord bot's application ID |
| `DISCORD_STATUS_CHANNEL` | Channel ID for status messages |
| `DISCORD_BRIDGE_URL` | WebSocket bridge URL (default: `ws://127.0.0.1:9800`) |

### GitHub tokens

| Env Var | Description |
|---|---|
| `FOREMAN_GITHUB_TOKEN` | Token for Foreman operations (create PRs, manage labels) |
| `EM_GITHUB_TOKEN` | Token for Engineering Manager operations (approve/merge PRs behind branch protection) |

### Prompt template variables

The prompt supports these placeholders:

- `{{issue_number}}` — GitHub issue number
- `{{issue_title}}` — Issue title
- `{{issue_body}}` — Issue body (markdown)

## Using with skills

The Foreman delegates work by invoking Claude Code skills on each service repo. Two skill paths per repo:

- **`skillPath`** — invoked during the Implementation phase (e.g. `.claude/skills/implement-approved-issues/SKILL.md`)
- **`revisionSkillPath`** — invoked during the Revision phase when a PR has review feedback (e.g. `.claude/skills/revise-pr-feedback/SKILL.md`)

The Foreman passes the issue context to Claude and instructs it to read and follow the skill. The skill defines the repo-specific implementation workflow — how to branch, test, and structure the PR.

## Programmatic usage

```typescript
import { startDaemon, loadConfig, createLogger } from "slashbin-ai-foreman";

const config = loadConfig();
const logger = createLogger({ format: "json", level: "info" });
const daemon = startDaemon(config, logger);

// Graceful shutdown
process.on("SIGINT", () => daemon.stop());
```

## Architecture

```
src/
├── cli.ts             # CLI entry point
├── config.ts          # Configuration loading + Zod validation
├── logger.ts          # Structured logging (JSON/text)
├── github.ts          # GitHub API (polling, PRs, labels, dual-token ops)
├── agent.ts           # Claude Code CLI spawner
├── reviewer.ts        # PR review feedback handler
├── orchestrator.ts    # 5-phase cycle, failure cooldowns, state tracking
├── state.ts           # Persistent state management
├── daemon.ts          # Poll loop, graceful shutdown, Discord bridge
├── bridge-client.ts   # WebSocket client for Discord notifications
└── index.ts           # Public API exports
```

## Built with

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — AI implementation engine
- [GitHub CLI (gh)](https://cli.github.com/) — issue polling and PR management
- TypeScript + Zod — type-safe configuration

## License

MIT
