# Foreman

**A software engineering team orchestrator for GitHub.** The Foreman runs a team of AI
agents — a builder, a reviewer (the Tech Lead), a verifier (the SRE) and a release
step — through your normal GitHub workflow: approved issue → pull request → review →
revision → merge → verification in dev → release to production. One process runs it
across every repo you own.

- **You approve, it delivers.** Label an issue `approved`; the Foreman builds it, opens
  the PR, answers review, and carries it to production. A person still authorizes each
  production release with one label.
- **No self-approval.** The builder and the reviewer act under separate GitHub accounts,
  and every PR goes through your branch protection.
- **No per-run fees.** Sessions run through the Claude Code CLI under your own Claude
  plan — no API charges, no SaaS subscription.
- **Many repos, one daemon.** Point it at your fleet and let it work overnight; each
  repo keeps its own branches, labels, skills and limits.

## Who this is for

The Foreman pays off when you have **more approved work than time to implement it**.

- **Consultancies and agencies** maintaining repos for several clients: one daemon
  polls every client's repo, each with its own trigger label, branches and skills.
  Your hours go to strategy and review; implementation ships overnight.
- **Operators of several businesses**, each with its own backlog: each business is an
  entry in the `repos` list, with its own review flow, skills and branch protection.
- **One business, many repos** — microservices, internal tools, a monolith with
  satellites: the Foreman picks up an approved issue in whichever repo it is labeled
  on and ships a PR there.
- **Solo developers** who want the backlog to shrink while they sleep, and anyone whose
  AI already does the planning and needs the execution done.

## What it does

Every feature, one line each. The link has the detail.

### The delivery pipeline

| Feature | What it does for you | Details |
|---|---|---|
| Pipeline of stages | Runs nine stages on every repo — reconcile, review, verify, promote, release, revise, implement, branch sync, dependency batches — in an order you can change. | [pipeline.md](docs/pipeline.md#the-stages) |
| Lanes in parallel | Stages are grouped into lanes that run side by side, so a 30-minute build never holds up a review or a release on the same repo. | [pipeline.md](docs/pipeline.md#lanes-stages-run-side-by-side) |
| Implement | Picks up approved issues by priority, then age, and has Claude Code build them on the feature branch and open a PR. | [pipeline.md](docs/pipeline.md#the-stages), [skills.md](docs/skills.md) |
| Review *(opt-in)* | Hands each open PR to a separate reviewer program, the Tech Lead, which reviews and merges under its own account. | [review.md](docs/review.md) |
| Revise loop | Answers review feedback on the PR, ahead of new work; a PR that keeps bouncing is held for a person's ruling. | [pipeline.md](docs/pipeline.md#the-stages) |
| Outcome-label repair and declared holds | If the reviewer merged but forgot the label, the Foreman sets it from the review's own report; a reviewer can declare a deliberate hold instead. | [review.md](docs/review.md#outcome-label-reconciliation) |
| Orphan recovery (reconcile) | Finds commits on the feature branch that no PR carries and opens one, so finished work is never stranded. | [pipeline.md](docs/pipeline.md#the-stages) |
| Dev verification (SRE) | Has a verifier check each merged change in the dev environment, retries a failure, and can hold the next build until the last one passes. | [pipeline.md](docs/pipeline.md#the-stages) |
| Promotion and release to production | Opens the promotion PR for authorized work; with the release stage, has it approved, deployed, verified in production, tagged and closed. | [lifecycle.md](docs/lifecycle.md#the-release-stage) |
| Branch sync | Merges the production branch back into the base branch after each release, so the two never drift. | [pipeline.md](docs/pipeline.md#the-stages) |
| Dependency batches | Gathers open Dependabot (or Renovate) PRs into one issue that goes through the normal build. | [pipeline.md](docs/pipeline.md#the-stages) |
| Custom stages | Adds a stage that runs your own skill, such as a security scan, and can block the rest of its lane until it passes. | [pipeline.md](docs/pipeline.md#custom-stages) |
| One state machine | Every issue is in one named state, moved only by named steps; the table of both is generated from the code. | [lifecycle.md](docs/lifecycle.md) |

### Repos, labels and configuration

| Feature | What it does for you | Details |
|---|---|---|
| Multi-repo or single-repo | One daemon manages one repo or many, each with its own branches, skills, model and time limits. | [config-guide.md](docs/config-guide.md#multi-repo-mode) |
| Repo onboarding | Before a repo's first piece of work, creates the labels the Foreman runs on that it is missing — never changing existing ones. Add a repo to the config and the running daemon picks it up. | [onboarding.md](docs/onboarding.md) |
| Your own labels and GitHub names | Every label, PR title, tag name and signature the Foreman writes is a setting, so it fits your conventions. | [config-guide.md](docs/config-guide.md#lifecycle-labels), [configuration.md](docs/configuration.md#github-conventions-github) |
| Retry back-offs | Every wait before a retry grows the same predictable way and is tunable, so a blip costs a short wait and only lasting trouble gets long ones. | [running.md](docs/running.md#back-offs) |
| GitHub API budget | Shares one issue snapshot per repo per cycle and logs its expected request rate, so a large fleet stays under GitHub's limits. | [running.md](docs/running.md#github-api-budget) |
| Full configuration reference | Every setting, its default and its environment variable, generated from the code. | [configuration.md](docs/configuration.md) |

### Setup and operation

| Feature | What it does for you | Details |
|---|---|---|
| Guided setup | `npm run setup` installs, builds, creates the labels and checks everything; or ask Claude Code to "set up the Foreman". | [setup.md](docs/setup.md) |
| Doctor | `npm run doctor` says, line by line and read-only, whether the Foreman is ready and what to fix. | [setup.md](docs/setup.md#3-run-setup) |
| Label install | `npm run labels:install` creates any missing label on every configured repo. | [config-guide.md](docs/config-guide.md#lifecycle-labels) |
| Daemon management | Start, stop, restart, status and logs, a single-instance guard, live config reload and a graceful stop that lets running work finish. | [running.md](docs/running.md#daemon-management) |

### Skills and sessions

| Feature | What it does for you | Details |
|---|---|---|
| Built-in skills | Ships generic implement and revise instructions, so a repo needs no skill files of its own; add repo rules with an overlay file. | [skills.md](docs/skills.md#built-in-skills) |
| Skill sync | Keeps each repo's copy of its skills on one golden source, updated one repo at a time as approved work comes through. | [skill-sync.md](docs/skill-sync.md) |
| Image handling | Images in an issue or review comment — mockups, screenshots — are fetched and read as part of the spec. | [skills.md](docs/skills.md#image-handling-in-issue-bodies) |
| Session security | Each session gets one token and an allowlisted environment, a hook blocks commands that would print a secret, and tokens are redacted from logs. | [security.md](docs/security.md) |
| Workspace trust | Marks every repo checkout trusted in Claude Code, so sessions get the repo's own settings, tools and hooks. | [security.md](docs/security.md#claude-code-workspace-trust) |

### Optional integrations and extending it

| Feature | What it does for you | Details |
|---|---|---|
| Paperclip board *(optional, off by default)* | Mirrors every issue as a card on a [Paperclip](https://github.com/paperclipai/paperclip) board — who holds it, which column, what happened. The Foreman runs fully without it. | [paperclip.md](docs/paperclip.md) |
| Discord *(not used by the daemon)* | The daemon sends no chat messages: what needs a person is a label and a comment on the issue. A Discord bridge client is exported for other agents. | [config-guide.md](docs/config-guide.md#discord-notifications) |
| Programmatic usage | Start the daemon, or one pass, from your own Node code. | [architecture.md](docs/architecture.md#programmatic-usage) |
| Architecture | How the Foreman fits a team of agents, and one source file per concern. | [architecture.md](docs/architecture.md) |

Every doc, by question: [docs/README.md](docs/README.md).

## Quick start

```bash
git clone https://github.com/xrgarcia/slashbin-ai-foreman.git
cd slashbin-ai-foreman
```

Then either open Claude Code here and say **"set up the Foreman"** — it asks which
repos, branches and labels to use, writes `.ai-agent.json` after showing it to you,
and runs setup — or do it by hand:

```bash
cp .ai-agent.example.json .ai-agent.json   # keep only your repos; see docs/setup.md
npm run setup                              # install, build, create the labels, run the doctor
npm start                                  # once the doctor says Ready
```

**[docs/setup.md](docs/setup.md)** lists what you need first (Node 22.12+, the `claude`
and `gh` CLIs, a checkout of each repo, three branches, the GitHub tokens) and the
smallest working config. Then label an issue `approved` and watch `npm run logs`.

## Built with

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — the AI implementation engine
- [GitHub CLI (gh)](https://cli.github.com/) — issue polling and PR management
- TypeScript + Zod — type-safe configuration

## License

MIT
