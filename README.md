# slashbin-ai-foreman

**The autonomous engineering delegator behind [slashbin.io](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-foreman) — the webhook ETL gateway for engineers and AI agents. [Try slashbin.io free →](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-foreman)**

**Turn approved GitHub issues into shipped pull requests — autonomously, across every repo you own.**

- **Cost:** $0 marginal under your Claude Max plan. Runs through the Claude Code CLI — no API charges, no SaaS subscription, no per-run fees.
- **Safety:** Can't merge to `main` without approval. Every PR goes through branch protection; a reviewer — human, or an EM bot from [slashbin-ai-team](https://github.com/xrgarcia/slashbin-ai-team) — signs off before promotion.
- **Scale:** One daemon manages many repos. Point it at your fleet, let it work overnight.

The Foreman is an AI engineering agent that polls your repos for approved work, invokes a Claude Code skill (e.g. `/implement-approved-issues`) on each service repo, opens PRs, and revises based on reviewer feedback. Reviewers — human or AI — stay in the loop via PR reviews.

## Who this is for

The Foreman shines when you have **more approved work than time to implement**. Three patterns:

**1. Consulting / agency operators** — you maintain service repos for multiple clients. One daemon polls every client's repo with its own trigger label, base branch, and skill paths. Billable hours stay on strategy and review; implementation ships overnight.

**2. Multi-business operators** — you run several companies, each with its own engineering backlog. Each business is an entry in the `repos` array; review flows, skills, and branch protection stay per-business.

**3. Single business, many service repos** — microservices, internal tool sprawl, or a monolith plus satellites. The Foreman picks up an approved issue in whichever repo it's labeled on and ships a PR there.

**Also useful for:**

- **Solo developers** who want their backlog to shrink while they sleep
- **Vibe coders** whose AI handles the planning — the Foreman handles the execution
- **Teams running AI employees** via [slashbin-ai-team](https://github.com/xrgarcia/slashbin-ai-team) who need autonomous implementation behind the coordination layer

## What the Foreman does

Each poll cycle runs these stages, in this order, across every configured repo (the order is configurable — see [Pipeline stages](#pipeline-stages)):

```
Reconcile → Review → Revise → Implement → Branch Sync → Dependabot → Promote
```

1. **Reconcile** — detects orphaned commits on the features branch with no PR and creates one
2. **Review** *(opt-in)* — when `reviewEnabled` is set, invokes a review skill on open feature PRs awaiting review. The review skill runs in a **separate review repo** (`emRepoPath`) under a separate GitHub token, and owns its own merge + label decisions; its label side effects (approve → `pr approved`; request-changes → `pr pending actions`) feed the Promote and Revise phases, and the Foreman reconciles the outcome label from the run's trailer if the skill merged without setting it. Disabled by default — see [Review phase](#review-phase-opt-in)
3. **Revise** — finds PRs with pending review feedback and revises them (prioritized over new work)
4. **Implement** — picks up approved issues and invokes the repo's implementation skill via Claude Code (up to 3 issues per cycle; 1 in greenfield repos)
5. **Branch Sync** — merges main → develop to keep branches aligned after promotions
6. **Dependabot** — files one issue covering the open Dependabot PRs on the working branches, so they go through the implement session (filed with the trigger label when the repo sets `dependencyPreApproved`)
7. **Promote** — creates promotion PRs (develop → main) for issues labeled `ready for prod release`

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

This is the pattern behind [www.slashbin.io](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-foreman_body) — structured context in, autonomous execution out. The Foreman doesn't need to understand your business. It reads the issue, reads the repo's CLAUDE.md, and invokes the skill.

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

The daemon writes `.agent[-<repo>].pid` itself at startup, before it does any
work — not just when launched via `npm start`. A daemon started any other way
(`doppler run -- node dist/cli.js`, a detached shell, a supervisor) is therefore
still visible to `status`, `stop` and `restart`.

It also refuses to start when that PID file names a live process, so a second
daemon cannot end up reviewing and merging the same PRs as the first. A stale
file left by a killed daemon is taken over automatically.

## Configuration

Copy `.ai-agent.example.json` to `.ai-agent.json` and customize. Env vars override file values.

```bash
cp .ai-agent.example.json .ai-agent.json
# Edit .ai-agent.json with your repo paths, GitHub org, and any per-repo overrides
```

`.ai-agent.json` is gitignored — your runtime config stays local and never enters version control. Use the example file as a template; commit changes to it (not to your real `.ai-agent.json`) when you want to update the documented shape.

### Single-repo mode

For a single repo, set fields at the root level:

| Config Field | Env Var | Default | Description |
|---|---|---|---|
| `repoPath` | `AI_AGENT_REPO_PATH` | `.` | Path to local repo clone |
| `githubRepo` | `AI_AGENT_GITHUB_REPO` | *(from git remote)* | GitHub `owner/repo` |
| `triggerLabel` | `AI_AGENT_TRIGGER_LABEL` | `approved` | Label that triggers implementation |
| `pollIntervalMs` | `AI_AGENT_POLL_INTERVAL_MS` | `300000` (5 min) | Poll interval in milliseconds |
| `issueCacheTtlMs` | `AI_AGENT_ISSUE_CACHE_TTL_MS` | `30000` (30 s) | How long a repo's open-issue snapshot stays warm. Keep it **below** `pollIntervalMs`. `0` disables caching. See [GitHub API budget](#github-api-budget) |
| `upstreamBackoffBaseMs` | `AI_AGENT_UPSTREAM_BACKOFF_BASE_MS` | `120000` (2 min) | First window of the daemon-wide back-off when GitHub (rate limit) or Claude (session limit) refuses work. Doubles per consecutive window. Each transition is logged and sent once to Discord |
| `upstreamBackoffCapMs` | `AI_AGENT_UPSTREAM_BACKOFF_CAP_MS` | `3600000` (60 min) | Ceiling for that back-off window |
| `issueSnapshotLimit` | `AI_AGENT_ISSUE_SNAPSHOT_LIMIT` | `500` | Max open issues fetched per snapshot. Must exceed a repo's open-issue count; truncation is logged |
| `skillPath` | `AI_AGENT_SKILL_PATH` | — | Claude Code skill for implementation: a repo-relative path, or `builtin:` for the skill shipped in `skills/implement/` |
| `revisionSkillPath` | — | — | Claude Code skill for PR revision: a repo-relative path, or `builtin:` for `skills/revise/` |
| `skillOverlayPath` | — | — | Optional repo-relative file appended to the implement prompt after the skill. Configured but unreadable → the run is not started |
| `revisionSkillOverlayPath` | — | — | Same, for the revise prompt |
| `prompt` | `AI_AGENT_PROMPT` | *(built-in)* | Custom prompt template |
| `baseBranch` | `AI_AGENT_BASE_BRANCH` | `develop` | PR target branch |
| `productionBranch` | `AI_AGENT_PRODUCTION_BRANCH` | `main` | Branch promotion PRs target; sync PRs merge it back into `baseBranch` |
| `featureBranch` | `AI_AGENT_FEATURE_BRANCH` | `features` | Branch to commit to |
| `maxTurns` | `AI_AGENT_MAX_TURNS` | `30` | Max agent turns per issue |
| `maxDurationMs` | `AI_AGENT_MAX_DURATION_MS` | `1800000` (30 min) | Max implementation time |
| `model` | `AI_AGENT_MODEL` | CLI default | Model for implement/revise. Cascades to every repo that sets no `model` of its own |
| `allowedTools` | — | `["Read","Write","Edit","Bash","Glob","Grep"]` | Tools the CLI can use |
| `sessionEnv` | — | `[]` | Daemon env var names every Claude session inherits, on top of the essentials. Top-level only. May not name a GitHub token. See [Session security](#session-security) |
| `logFormat` | `AI_AGENT_LOG_FORMAT` | `text` | `json` or `text` |
| `logLevel` | `AI_AGENT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `lifecycleLabels` | — | see below | Names of the five labels that move a PR through its lifecycle. Top-level only — every repo shares one set |
| `paperclip` | `AI_AGENT_PAPERCLIP_ENABLED`, `_URL`, `_COMPANY_ID`, `_AGENT_NAME`, `_AGENT_ID`, `_IDENTITY_KEY_FORMAT` | `enabled: false`, `url: "http://127.0.0.1:3100"`, `agentName: "Foreman"`, `identityKeyFormat: "source: {repo}#{N}"` | Optional [Paperclip](https://github.com/paperclipai/paperclip) mirror. Off unless `enabled`; `companyId` is required once enabled. `{repo}` is the full `owner/name`. `statusMap` (no env var) renames any of the buckets `todo`, `in_progress`, `in_review`, `done`, `cancelled`. Top-level only. `npm run build && npm run paperclip:register [-- config-path]` registers the agent with every wake path off and writes `agentId` back into the file; `npm run paperclip:doctor [-- --config config-path]` then checks the integration read-only (health, company, agent-registered, wake-on-demand, heartbeat-enabled, config-complete) and exits non-zero on any FAIL |

#### Lifecycle labels

Set any subset; the rest keep their defaults. The five names must be distinct, and none may equal a repo's `triggerLabel` — the config fails to load otherwise.

```json
{
  "lifecycleLabels": {
    "prUnderReview": "pr under review",
    "prPendingActions": "pr pending actions",
    "prApproved": "pr approved",
    "readyForProd": "ready for prod release",
    "readyToClose": "ready to close"
  }
}
```

Every Claude session the daemon spawns (implement, revise, review) gets the names in its environment, so a skill can use the configured names in place of its own literals:

- `FOREMAN_TRIGGER_LABEL`: the repo's `triggerLabel`, e.g. for `gh issue list --label "$FOREMAN_TRIGGER_LABEL"`
- `FOREMAN_LIFECYCLE_LABELS`: the five names as a JSON object with the keys above

To create the labels on your repos, run `npm run build && npm run labels:install` (or ask Claude Code in this repo to "install the labels" — the `install-labels` skill runs the same thing). Per repo it creates whichever of the `triggerLabel` and five lifecycle names are missing, prints `<repo>: created N, present M`, and never changes or deletes an existing label. A failed repo is listed at the end and the exit code is 1.

### GitHub API budget

Each poll cycle spends **one GraphQL request per repo** for issue discovery. GitHub's GraphQL limit is **5,000 requests/hour per token**, so the discovery floor is:

```
repos × (3600000 / pollIntervalMs)   requests/hour
```

The daemon logs this as `estDiscoveryGraphQlPerHour` on startup — check it against 5,000 after adding repos or lowering the poll interval. 20 repos at a 60 s interval is 1,200/hour; the same 20 repos would need an interval under ~15 s before discovery alone threatened the ceiling. Merges, reviews, and promotions spend additional requests on top, but only when there is work.

This budget is why the discovery phases share **one open-issue snapshot per repo per cycle** rather than issuing a query per label. Before that change, six lookups each ran their own `gh issue list` — 20 repos on a 60 s interval came to ~7,200 requests/hour, which permanently exhausted the token and made roughly one lookup in six fail. A failed lookup silently skips that phase for that repo that cycle, so `approved` issues sat unimplemented with nothing but generic errors in the log.

Two consequences worth knowing:

- **Keep `issueCacheTtlMs` below `pollIntervalMs`**, or a cycle can be served entirely from the previous cycle's snapshot and an externally-applied `approved` label waits an extra cycle. The daemon warns at startup if you cross that line.
- **Rate-limit rejections are logged as `[gh] RATE LIMIT EXHAUSTED`** and are deliberately not retried — the budget is already spent. If you see them, raise `pollIntervalMs` or reduce the repo count.

### Multi-repo mode

Use the `repos` array to manage multiple repos in a single daemon. Each repo entry may override any of: `triggerLabel`, `baseBranch`, `featureBranch`, `productionBranch`, `skillPath`, `revisionSkillPath`, `prompt`, `model`, `maxTurns`, `maxDurationMs`. Anything not specified on the entry falls back to the top-level value (or its default).

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

In the example above, `console` and `api` get the top-level `maxTurns: 30` and `maxDurationMs: 1800000`. `big-feature-repo` overrides both to allow longer Claude sessions for larger features in that repo only.

**Resolution order** for `maxTurns` / `maxDurationMs` (and `triggerLabel`, `baseBranch`, `featureBranch`, `productionBranch`):

1. Per-repo entry value (most specific)
2. Top-level `.ai-agent.json` value (or `AI_AGENT_*` env var, which overrides the file value)
3. Built-in default

Existing configs that don't specify per-repo overrides continue to behave identically — the top-level values still apply to every repo. Per-repo overrides are additive and optional.

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

## Session security

Sessions run with `--dangerously-skip-permissions`. Each receives one GitHub token as `GH_TOKEN` — the Foreman token for implement, revise and custom stages, the EM token for review — plus `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `TERM`, `XDG_RUNTIME_DIR`, `SSH_AUTH_SOCK` when set, `FOREMAN_TRIGGER_LABEL`, `FOREMAN_LIFECYCLE_LABELS`, a custom stage's `FOREMAN_STAGE_*`, and the names in the top-level `sessionEnv` list. `sessionEnv` may not name a GitHub token. Values of `FOREMAN_GITHUB_TOKEN`, `EM_GITHUB_TOKEN` and `sessionEnv` names (8+ characters) are replaced by `[REDACTED:<NAME>]` in the Foreman's own transcripts under `logs/`, its log lines and the errors it returns. The Claude CLI's own session log under `~/.claude/projects/` is not touched — that is where the 2026-10-01 leak landed, and the allowlist is what keeps a token out of it. This narrows what a session holds in its environment; it does not stop a session reading what `HOME` grants (`~/.ssh`, the Doppler CLI login, `~/.claude`).

The Tech Lead hand-off gets the same essentials and `sessionEnv` names, `EM_GITHUB_TOKEN`, its own `TECH_LEAD_*` settings and the two label vars — never `FOREMAN_GITHUB_TOKEN` or `GH_TOKEN`.

## Using with skills

The Foreman delegates work by invoking Claude Code skills on each service repo. Two skill paths per repo:

- **`skillPath`** — invoked during the Implementation phase (e.g. `.claude/skills/implement-approved-issues/SKILL.md`)
- **`revisionSkillPath`** — invoked during the Revision phase when a PR has review feedback (e.g. `.claude/skills/revise-pr-feedback/SKILL.md`)

The Foreman passes the issue context to Claude and instructs it to read and follow the skill. The skill defines the repo-specific implementation workflow — how to branch, test, and structure the PR.

The Foreman, not the skill, decides what to build. Its work source (`WorkSourceAdapter`
in `src/adapters.ts`; GitHub issues via `GitHubIssueConnector`) offers every eligible item,
and the implement prompt names all of them, less any the Foreman is backing off, as
`Implement exactly these work items, and no others: #<n>, …`. The skill picks among them by
priority. A repo-local skill that runs its own `gh issue list` gets the same issues back; the
built-in skill takes its list from the prompt alone.

### Built-in skills

Set either field to `builtin:` to use the generic skills that ship with the Foreman
(`skills/implement/SKILL.md`, `skills/revise/SKILL.md`) instead of keeping a copy in
every repo. The built-in text is inlined into the prompt together with the repo's
feature and base branch. It never names a label: it reads the configured names from
`FOREMAN_TRIGGER_LABEL` and `FOREMAN_LIFECYCLE_LABELS`, which the Foreman sets on every
session.

To add repo-specific rules without forking the skill, point `skillOverlayPath` /
`revisionSkillOverlayPath` at a file in the repo; its contents are appended after the
skill. A configured overlay that cannot be read fails that run before Claude starts —
the skill is never run without it.

```json
{ "name": "api", "repoPath": "../my-api", "skillPath": "builtin:", "revisionSkillPath": "builtin:",
  "skillOverlayPath": "docs/foreman-overlay.md" }
```

## Pipeline stages

`stages` sets which stages a repo pass runs and in what order. Omitted, it is the
seven built-ins in the order above — an existing config runs unchanged:

```json
{ "stages": [
  { "type": "reconcile" }, { "type": "review" }, { "type": "revise" }, { "type": "implement" },
  { "type": "branch-sync" }, { "type": "dependabot" }, { "type": "promote" }
] }
```

Leave a built-in out and it never runs; reorder them and you give up what the
default order guarantees (review before implement, so review only sees PRs
labeled in an earlier pass; promote last, so it sees labels this pass just set).
Each stage may appear once. The review stage needs `reviewSkillPath` for every
`reviewEnabled` repo only when `review` is in `stages`.

### Custom stages

A custom stage is `{ "id": "<name>", "skillPath": "<SKILL.md>" }`. It is kept
deliberately small:

- **When it runs.** When the pass reaches it and the repo has an open
  `featureBranch → baseBranch` PR. No open PR: no session, and the pass continues.
- **What it gets.** One Claude session per repo, in the managed repo, under
  `FOREMAN_GITHUB_TOKEN`, with the implement session's model, tools, MCP config
  and budget. The prompt names the skill, the PR, its head and the issues it
  implements; the same facts arrive as env — `FOREMAN_STAGE_ID`,
  `FOREMAN_STAGE_REPO`, `FOREMAN_STAGE_BASE_BRANCH`, `FOREMAN_STAGE_FEATURE_BRANCH`,
  `FOREMAN_STAGE_PR`, `FOREMAN_STAGE_ISSUES` (JSON array), `FOREMAN_STAGE_HEAD_SHA` —
  next to `FOREMAN_TRIGGER_LABEL` / `FOREMAN_LIFECYCLE_LABELS`. A relative
  `skillPath` resolves against the repo. Anything the stage should change
  (comments, labels) its skill does; the Foreman does nothing with the work items.
- **What its outcome means.** The session ends with `FOREMAN_STAGE pass` or
  `FOREMAN_STAGE blocked reason="…"`. `pass` lets the later stages run. `blocked`,
  or a run with no verdict line (timed out, crashed, forgot), stops every later
  stage for that repo. The verdict holds until the feature branch head moves, so
  the same code is not re-checked every poll; a restart re-runs it once. A run
  refused by an upstream limit gives no verdict and is retried next pass, with
  later stages held meanwhile.

A blocking stage belongs **after** `revise` and `implement`: a fix pushed by
revise is what moves the head and re-runs the check.

```json
{ "stages": [
  { "type": "reconcile" }, { "type": "review" }, { "type": "revise" }, { "type": "implement" },
  { "id": "security", "skillPath": ".claude/skills/security-scan/SKILL.md" },
  { "type": "branch-sync" }, { "type": "dependabot" }, { "type": "promote" }
] }
```

## Review phase (opt-in)

The Review phase closes the loop between Implementation and Revision by invoking a
**review skill** on open feature PRs awaiting review — automating the human/agent
reviewer step. It is **disabled by default** (`reviewEnabled: false`); a vanilla
config keeps the original five-phase behavior unchanged.

It differs from Implementation/Revision in three ways, because review is a
decision-layer workflow rather than an in-repo edit:

- **Runs in a separate review repo — optionally.** With `emRepoPath` set, the review
  skill is invoked with its working directory set to that repo, not the service repo —
  so it has the reviewer's own tooling (MCP servers, verification scripts, context
  docs) available. Without it, the session runs in the repo's managed review checkout
  (`reviewCheckoutRoot/<name>`), so a review skill shipped inside the service repo
  needs no second repo.
- **Runs under a separate token.** Reviews and merges are attributed to the account
  behind `EM_GITHUB_TOKEN` (distinct from `FOREMAN_GITHUB_TOKEN`), keeping the
  reviewer identity separate from the implementer identity.
- **Owns its own outcomes.** The skill posts the verdict, merges approved PRs, and
  transitions issue labels itself. The label side effects feed the other phases:
  approve → `pr approved` (awaiting the human release gate); request-changes →
  `pr pending actions` (Revise). The Foreman reconciles the label as a backstop
  when the skill merged without setting it — see below.

### Outcome-label reconciliation

The merge is performed by code, but the *record* of what the merge meant used to be
left entirely to the review agent to remember to write. When a session ended after
merging but before labeling, the issue stayed at `pr under review` with its PR
already closed — invisible to every phase, since the review gate only matches OPEN
PRs. Measured over one week on a 20-repo fleet: **12 of 53 merges (~23%) stranded
their issue this way.**

The outcome was never actually unknown — it arrives in the `FOREMAN_REVIEW` trailer
the Foreman already parses. `reviewLabelReconcile` (default `true`) spends it: after
a run reports a merge, any linked issue still sitting at `pr under review` is moved
to the label its own trailer implies.

Four conditions gate every write, so the reconciler can only ever repair a missing
write — never invent one, never overrule anyone:

1. the issue is still at `pr under review` with no outcome label (a skill that
   labels correctly never reaches this code, so a healthy pipeline is unchanged);
2. a **merged** PR provably closed that issue, under the strict closing-keyword
   predicate (a bare "related to #N" never counts);
3. that PR emitted a trailer this run whose fields are unambiguous;
4. the reviewer did not declare a hold (below).

It never applies `ready for prod release`. That label authorizes production and
remains a human act.

Set `reviewLabelReconcile: false` (or `AI_AGENT_REVIEW_LABEL_RECONCILE=false`) to
keep labeling strictly agent-owned.

### Declaring a deliberate hold

A reviewer that merges but *intentionally* leaves the label unset — typically an
acceptance criterion that cannot be observed yet — appends an optional `hold=` field
to that PR's trailer:

```
FOREMAN_REVIEW pr=#100 verdict=APPROVE merged=yes deploy=SUCCESS hold=criterion-not-observable-until-0300z
```

The Foreman then neither sets the label nor re-verifies behind it, and surfaces the
issue as *held* rather than failed. The hold is persisted in `.agent-state.json`, so
it survives restarts, and clears automatically once the issue leaves the dead zone.

Without this, a deliberate hold and a dropped label are the same observation, and
automation has to guess — which means overwriting a correct judgment with a rubber
stamp.

The four-field trailer remains the contract: `hold=` is optional and trails the
original fields, so trailers written before it existed parse identically.

Every review run's full turn-by-turn interaction (`--output-format stream-json`) is
written verbatim to `logs/review/<repo>-cycle<N>-<timestamp>.log` for debugging.

A PR is gated into review only when its linked issue is labeled `pr under review`,
it has an open `featureBranch → baseBranch` PR, and there is no review by
`reviewerLogin` newer than the PR's latest commit (a freshness guard against
re-review loops).

Review config keys (global; `reviewEnabled`, `reviewSkillPath` and `reviewerLogin`
can also be set per repo, and a per-repo value wins):

| Key | Default | Description |
|---|---|---|
| `reviewEnabled` | `false` | Enable the Review phase (per-repo override supported) |
| `emRepoPath` | — | Working dir for the review skill (the review repo). Optional; unset = the repo's review checkout |
| `reviewSkillPath` | — | Review skill. **Required for every review-enabled repo** (startup fails otherwise). Absolute, `~/…`, or relative to the session's working dir (`emRepoPath` when set, else the repo's review checkout) |
| `reviewModel` | — | Model override for review runs (independent of `model`) |
| `reviewMaxTurns` | `200` | Max turns (review + verify is long-running) |
| `reviewMaxDurationMs` | `3600000` (60 min) | Max review duration |
| `reviewAllowedTools` | broad MCP + shell set | Tool surface for the review skill |
| `reviewerLogin` | — | GitHub login the review runs as (freshness guard). Unset = a verdict by any reviewer counts as current |
| `reviewLabelReconcile` | `true` | Set the outcome label from the run's own trailer when the skill merged without labeling. Env: `AI_AGENT_REVIEW_LABEL_RECONCILE` |

Requires `EM_GITHUB_TOKEN` in the environment when enabled.

## Image handling in issue bodies

Claude is multimodal — when an issue body or PR review comment contains markdown image references like `![alt](https://...)`, those images are part of the spec (mockups, screenshots, walkthrough frames). The Foreman appends instructions to its default and skill-driven prompts telling the agent to fetch each image to a temp file and `Read` it, so the model can see image content.

For private-repo image URLs (e.g. `github.com/<owner>/<repo>/raw/<branch>/<path>`) the fetch uses `GH_TOKEN`-authed `curl`. For public CDN URLs (e.g. `github.com/user-attachments/...`) no auth is required.

This is automatic for the built-in prompts (`skillPath` and the default implement/revise prompts). If you supply a fully custom `prompt` in config, include your own image-handling guidance — the Foreman does not modify custom prompts.

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
├── lifecycle.ts       # The state machine: stages and named moves (docs/lifecycle.md)
├── adapters.ts        # Data contract: WorkEvent, WorkSourceAdapter, WorkObserver
├── work-source.ts     # emit()/advance(): one event → work source + observers
├── github.ts          # GitHub API surface (polling, PRs, labels, dual-token ops); code in github/
├── github-work-source.ts # GitHub issues as the work source: a move → its labels
├── agent.ts           # Claude Code CLI spawner
├── reviewer.ts        # PR review feedback handler
├── stages.ts          # Stage schema, default order, dispatch loop
├── orchestrator.ts    # Stage pass per repo, failure cooldowns, session slot
├── phases/            # One file per stage (reconcile, implement, revise, verify, review, promote, custom)
├── paperclip/         # Optional Paperclip board plugin (a WorkObserver)
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
