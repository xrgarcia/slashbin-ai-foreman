# Configuring repos and labels

A guide to the common settings. **[configuration.md](configuration.md) is the complete
reference** *(generated)*: every key, its default, its env override and what it does,
built from the code so it cannot fall behind. The smallest working config is in
[setup.md](setup.md#2-the-config).

Copy `.ai-agent.example.json` to `.ai-agent.json` and customize. Env vars override file
values. The daemon re-reads the file every cycle, so most edits apply without a restart.

```bash
cp .ai-agent.example.json .ai-agent.json
# Edit .ai-agent.json with your repo paths, GitHub org, and any per-repo overrides
```

`.ai-agent.json` is gitignored — your runtime config stays local and never enters
version control. Use the example file as a template; commit changes to it (not to your
real `.ai-agent.json`) when you want to update the documented shape.

## Single-repo mode

For a single repo, set fields at the root level:

| Config Field | Env Var | Default | Description |
|---|---|---|---|
| `repoPath` | `AI_AGENT_REPO_PATH` | `.` | Path to local repo clone |
| `githubRepo` | `AI_AGENT_GITHUB_REPO` | *(from git remote)* | GitHub `owner/repo` |
| `triggerLabel` | `AI_AGENT_TRIGGER_LABEL` | `approved` | Label that triggers implementation |
| `pollIntervalMs` | `AI_AGENT_POLL_INTERVAL_MS` | `300000` (5 min) | Poll interval in milliseconds |
| `issueCacheTtlMs` | `AI_AGENT_ISSUE_CACHE_TTL_MS` | `30000` (30 s) | How long a repo's open-issue snapshot stays warm. Keep it **below** `pollIntervalMs`. `0` disables caching. See [GitHub API budget](running.md#github-api-budget) |
| `backoff` | `AI_AGENT_BACKOFF_<GROUP>_<FIELD>` | see [Back-offs](running.md#back-offs) | Every wait before the Foreman retries something, each exponential and tunable |
| `issueSnapshotLimit` | `AI_AGENT_ISSUE_SNAPSHOT_LIMIT` | `500` | Max open issues fetched per snapshot. Must exceed a repo's open-issue count; truncation is logged |
| `skillPath` | `AI_AGENT_SKILL_PATH` | — | Claude Code skill for implementation: a repo-relative path, or `builtin:` for the skill shipped in `skills/implement/` ([skills.md](skills.md)) |
| `revisionSkillPath` | — | — | Claude Code skill for PR revision: a repo-relative path, or `builtin:` for `skills/revise/` |
| `skillOverlayPath` | — | — | Optional repo-relative file appended to the implement prompt after the skill. Configured but unreadable → the run is not started |
| `revisionSkillOverlayPath` | — | — | Same, for the revise prompt |
| `prompt` | `AI_AGENT_PROMPT` | *(built-in)* | Custom prompt template ([variables](skills.md#prompt-template-variables)) |
| `baseBranch` | `AI_AGENT_BASE_BRANCH` | `develop` | PR target branch |
| `productionBranch` | `AI_AGENT_PRODUCTION_BRANCH` | `main` | Branch promotion PRs target; sync PRs merge it back into `baseBranch` |
| `featureBranch` | `AI_AGENT_FEATURE_BRANCH` | `features` | Branch to commit to |
| `maxTurns` | `AI_AGENT_MAX_TURNS` | `30` | Max agent turns per issue |
| `maxDurationMs` | `AI_AGENT_MAX_DURATION_MS` | `1800000` (30 min) | Max implementation time |
| `model` | `AI_AGENT_MODEL` | CLI default | Model for implement/revise. Cascades to every repo that sets no `model` of its own |
| `allowedTools` | — | `["Read","Write","Edit","Bash","Glob","Grep"]` | Tools the CLI can use |
| `sessionEnv` | — | `[]` | Daemon env var names every Claude session inherits, on top of the essentials. Top-level only. May not name a GitHub token. See [security.md](security.md#token-isolation-and-redaction) |
| `logFormat` | `AI_AGENT_LOG_FORMAT` | `text` | `json` or `text` |
| `logLevel` | `AI_AGENT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `lifecycleLabels` | — | see below | Names of the labels that move a PR through its lifecycle. Top-level only — every repo shares one set |
| `github` | — | today's names (see [configuration.md](configuration.md#github-conventions-github)) | Every other GitHub name the Foreman reads or writes: `blockedLabel`, `priorityLabels` (the tiers the implement skill picks by), `dependencyBranchPrefixes` (`["renovate/"]` for Renovate), the promotion, sync, dependency-batch and reconcile titles, and the PR-body `signature`. Set any subset; the rest keep their defaults. Sessions get `FOREMAN_BLOCKED_LABEL` and `FOREMAN_PRIORITY_LABELS`. Top-level only |
| `onboarding` | `AI_AGENT_ONBOARDING` | `true` | Create a repo's missing labels before its first piece of work ([onboarding.md](onboarding.md)) |
| `paperclip` | `AI_AGENT_PAPERCLIP_ENABLED`, `_URL`, `_COMPANY_ID`, `_AGENT_NAME`, `_AGENT_ID`, `_API_KEY`, `_IDENTITY_KEY_FORMAT`, `_TASK_TITLE_FORMAT`, `_PROJECT_ID` | `enabled: false`, `url: "http://127.0.0.1:3100"`, `agentName: "Foreman"`, `identityKeyFormat: "source: {repo}#{N}"`, `taskTitleFormat: "{repo}#{N}"`, `projects: false` | Optional [Paperclip](https://github.com/paperclipai/paperclip) mirror. Off unless `enabled`; `companyId` is required once enabled. `{repo}` is the full `owner/name`. `projectId` files every new task in one project; `repos` limits the mirror to some repos; `board`, `roles`, `stageLabels` and `comments` set who holds each card, its column and label, and what its thread says — every key in [paperclip.md](paperclip.md). `statusMap` (no env var) renames any of the buckets `todo`, `in_progress`, `in_review`, `done`, `cancelled`. Top-level only. `npm run build && npm run paperclip:register [-- config-path]` registers the agent with every wake path off and writes `agentId` back into the file; `npm run paperclip:doctor [-- --config config-path]` then checks the integration read-only (health, company, agent-registered, wake-on-demand, heartbeat-enabled, config-complete) and exits non-zero on any FAIL |

## Lifecycle labels

Set any subset; the rest keep their defaults. The names must be distinct, and none may
equal a repo's `triggerLabel` — the config fails to load otherwise.

```json
{
  "lifecycleLabels": {
    "prUnderReview": "pr under review",
    "prMerged": "pr merged",
    "prPendingActions": "pr pending actions",
    "prApproved": "pr approved",
    "readyForProd": "ready for prod release",
    "releasePending": "release pending",
    "prodVerifyHeld": "prod verification held",
    "readyToClose": "ready to close"
  }
}
```

Every Claude session the daemon spawns (implement, revise, review) gets the names in its
environment, so a skill can use the configured names in place of its own literals:

- `FOREMAN_TRIGGER_LABEL`: the repo's `triggerLabel`, e.g. for
  `gh issue list --label "$FOREMAN_TRIGGER_LABEL"`
- `FOREMAN_LIFECYCLE_LABELS`: the names as a JSON object with the keys above

To create the labels on your repos, run `npm run build && npm run labels:install` (or
ask Claude Code in this repo to "install the labels" — the `install-labels` skill runs
the same thing). Per repo it creates whichever of the `triggerLabel`, lifecycle and
blocked label names are missing, prints `<repo>: created N, present M`, and never
changes or deletes an existing label. A failed repo is listed at the end and the exit
code is 1. The daemon also does this itself for each repo before its first piece of
work ([onboarding.md](onboarding.md)).

What each label means and what moves an issue between them: [lifecycle.md](lifecycle.md).

## Multi-repo mode

Use the `repos` array to manage multiple repos in a single daemon. Each repo entry may
override any of: `triggerLabel`, `baseBranch`, `featureBranch`, `productionBranch`,
`skillPath`, `revisionSkillPath`, `prompt`, `model`, `maxTurns`, `maxDurationMs` (every
per-repo key: [configuration.md](configuration.md#per-repo-entries-repos)). Anything not
specified on the entry falls back to the top-level value (or its default).

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
    },
    {
      "name": "big-feature-repo",
      "repoPath": "../my-monolith",
      "githubRepo": "org/my-monolith",
      "skillPath": ".claude/skills/implement-approved-issues/SKILL.md",
      "revisionSkillPath": ".claude/skills/revise-pr-feedback/SKILL.md",
      "maxTurns": 60,
      "maxDurationMs": 3000000
    }
  ],
  "triggerLabel": "approved",
  "pollIntervalMs": 120000,
  "maxTurns": 30,
  "maxDurationMs": 1800000
}
```

In the example above, `console` and `api` get the top-level `maxTurns: 30` and
`maxDurationMs: 1800000`. `big-feature-repo` overrides both to allow longer Claude
sessions for larger features in that repo only.

**Resolution order** for `maxTurns` / `maxDurationMs` (and `triggerLabel`, `baseBranch`,
`featureBranch`, `productionBranch`):

1. Per-repo entry value (most specific)
2. Top-level `.ai-agent.json` value (or `AI_AGENT_*` env var, which overrides the file value)
3. Built-in default

Existing configs that don't specify per-repo overrides continue to behave identically —
the top-level values still apply to every repo. Per-repo overrides are additive and
optional.

## GitHub tokens

`FOREMAN_GITHUB_TOKEN`, `TECHLEAD_GITHUB_KEY` and `SRE_GITHUB_KEY`, and why there are
separate accounts: [security.md](security.md#two-github-identities).

## Discord notifications

The daemon sends no Discord messages: what needs a person is a label and a comment on
the GitHub issue (which also moves its Paperclip card when the board is on), and
everything else is the daemon log. `src/bridge-client.ts`, a WebSocket client for a
Discord bridge, is still exported from the package for other agents to use; the daemon
does not use it, and no environment variable turns it on.
