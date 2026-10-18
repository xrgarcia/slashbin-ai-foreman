# Session security

Every Claude session the Foreman starts runs unattended, with a GitHub token, in a
checkout of your repo. This page is what limits what a session holds and what it can
leak.

## Two GitHub identities

The Foreman uses a **dual-token model**: one GitHub token for its own operations
(creating PRs, managing labels) and a second token for the reviewer, the Tech Lead
(approving and merging PRs that require branch protection). This prevents the Foreman
from self-approving its own work.

| Env Var | Description |
|---|---|
| `FOREMAN_GITHUB_TOKEN` | The Foreman's own account: opens PRs, moves labels. Unset, gh's logged-in account is used |
| `TECHLEAD_GITHUB_KEY` | The reviewer's account: reviews and merges PRs, and merges sync PRs. Required when review is on |
| `SRE_GITHUB_KEY` | The verifier's account. Required when `srePath` is set |

Where to put them: [setup.md](setup.md#1-before-setup). Never paste a token into a
chat or into the config file.

## Token isolation and redaction

Sessions run with `--dangerously-skip-permissions`. Each receives one GitHub token as
`GH_TOKEN` — the Foreman token for implement, revise and custom stages, the Tech Lead
its own `TECHLEAD_GITHUB_KEY` — plus `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
`LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `TERM`, `XDG_RUNTIME_DIR`, `SSH_AUTH_SOCK` when
set, `FOREMAN_TRIGGER_LABEL`, `FOREMAN_LIFECYCLE_LABELS`, a custom stage's
`FOREMAN_STAGE_*`, and the names in the top-level `sessionEnv` list. `sessionEnv` may
not name a GitHub token. Values of `FOREMAN_GITHUB_TOKEN`, `TECHLEAD_GITHUB_KEY`,
`SRE_GITHUB_KEY` and `sessionEnv` names (8+ characters) are replaced by
`[REDACTED:<NAME>]` in the Foreman's own transcripts under `logs/`, its log lines and
the errors it returns. The Claude CLI's own session log under `~/.claude/projects/` is
not touched — that is where the 2026-10-01 leak landed, and the allowlist is what keeps
a token out of it. This narrows what a session holds in its environment; it does not
stop a session reading what `HOME` grants (`~/.ssh`, the Doppler CLI login,
`~/.claude`).

The Tech Lead hand-off gets the same essentials and `sessionEnv` names,
`TECHLEAD_GITHUB_KEY`, its own `TECH_LEAD_*` settings and the two label vars — never
`FOREMAN_GITHUB_TOKEN` or `GH_TOKEN`.

Code: `src/agent.ts`, `src/redact.ts`.

## The secret gate (PreToolUse hook)

Every Claude session the Foreman spawns runs under a PreToolUse hook,
`hooks/session-secret-gate.mjs`, passed with `--settings` (`src/agent.ts`). It blocks
Bash commands that would print an environment or credential *value*, and file-tool
calls (Read, Grep, Edit, notebooks) on a file whose content is a credential.

Why: every session holds `GH_TOKEN` and runs with `--dangerously-skip-permissions`, so
neither a permission prompt nor the service repo's own hooks stand between a session
and `env`. Whatever a command prints lands in the session's Claude transcript, a
permanent local log that the Foreman's own redaction never sees. Referencing a variable
is fine — `gh ...` reads `GH_TOKEN` itself, and `curl -H "Authorization: token $GH_TOKEN"`
sends it without printing it. Printing one is not. Unreadable hook input fails open: the
gate is a guard on top of the env allowlist, not the only one.

## Claude Code workspace trust

A headless Claude session in a directory Claude Code has never trusted ignores that
repo's `.claude/settings.json` and `.mcp.json` — no error, just a stderr warning and a
session without the repo's own tools and hooks. The Foreman marks every configured
checkout trusted in Claude Code's global config (`$CLAUDE_CONFIG_DIR/.claude.json`, else
`~/.claude.json`) on start, on each config reload and before every session, writing only
when the flag is missing and never touching a file it cannot parse. Listing a repo is
the consent; set `trustManagedRepos: false` to manage trust yourself
([configuration.md](configuration.md#trustmanagedrepos)).

**Troubleshooting:** a log line `Claude Code reports <path> is not trusted` means a
session ran without the repo's settings; the Foreman has trusted it for the next one. If
it repeats, the config the session reads is not the one being written — check `HOME` and
whether `CLAUDE_CONFIG_DIR` is in `sessionEnv`.

Code: `src/claude-trust.ts`.
