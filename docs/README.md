# Foreman documentation

[Project README](../README.md)

Foreman turns approved GitHub issues into pull requests and carries review feedback
back to the builder. Start with one repo and a PR you can review. Add automated
review, verification, release, or a Paperclip board when you need them.

## Contents

- [Choose your next step](#choose-your-next-step)
- [All pages](#all-pages)
- [Commands](#commands)
- [Skills in this repo](#skills-in-this-repo)
- [Maintaining the references](#maintaining-the-references)

## Choose your next step

| You are here | Read next |
|---|---|
| Evaluating whether Foreman solves your problem | [README: what happens after approval](../README.md#what-happens-after-you-approve-an-issue) |
| Ready to get a first PR | [README: starter configuration](../README.md#start-with-one-repo), then [setup](setup.md) for prerequisites and checks |
| Already using Paperclip | [Paperclip setup](paperclip.md#set-up). GitHub remains the work source; the board mirrors it. |
| Ready to automate PR review | [Review](review.md). You supply a compatible Tech Lead program and a separate GitHub identity. |
| Ready to automate verification or release | [Pipeline stages](pipeline.md#the-stages), then the [release contract](lifecycle.md#the-release-stage). You supply the verifier and environment-specific procedures. |
| A card is Blocked and you want it moving | [Unblocking a card](lifecycle.md#unblocking-a-card). Release it on GitHub; moving the card does nothing. |
| Giving these docs to an LLM | Read [setup](setup.md), resolve exact keys in [configuration](configuration.md), and check stage requirements in [pipeline](pipeline.md). Keep credentials in the environment. |

## All pages

This is the table of contents for the documentation directory. Each page also has
its own section contents and links back here.

| Page | What it answers |
|---|---|
| [Setup](setup.md) | What tools, accounts, local checkouts, and branches do I need? How do I configure and check an install? |
| [Repo onboarding](onboarding.md) | What happens when I add a repo, and before its first build? |
| [Running the daemon](running.md) | How do I start, stop, inspect, and restart it? How do retries and GitHub API use work? |
| [Repos and labels](config-guide.md) | How do single-repo and multi-repo configs work? How do I use my own labels and branches? |
| [Configuration reference](configuration.md) *(generated)* | What does each setting mean, what is its default, and which environment variable overrides it? |
| [Pipeline](pipeline.md) | Which stages run, what do they require, and how do lanes and custom gates work? |
| [Review](review.md) | How does the Tech Lead review and merge? How are missing outcome labels and deliberate holds handled? |
| [Lifecycle reference](lifecycle.md) *(generated)* | What state is an issue in, what moves it, how is a Blocked card released, and what constitutes a verified release? |
| [EM coordination map](em-coordination.md) | What must the Engineering Manager do, or leave alone, at each stage and hold? (Test-checked against the source.) |
| [Paperclip](paperclip.md) *(generated)* | How do I enable the board mirror, map roles and stages, verify it, or remove it? |
| [Skills](skills.md) | What instructions does a session receive? How do built-ins, overlays, prompt variables, and images work? |
| [Skill sync](skill-sync.md) | How do repo skill copies pick up a shared version as approved work arrives? |
| [Session security](security.md) | Which credentials and files can a session access? What do the secret gate and log redaction cover? |
| [Architecture](architecture.md) | How do the work source, observers, and orchestrator fit together? What can I import? |
| [Cache self-heal design](implemented-cache-self-heal.md) | Why was the implemented-work cache changed? This is a historical design note. |

For contributor context, see [CLAUDE.md](../CLAUDE.md). For the included execution
instructions, see [implement](../skills/implement/SKILL.md) and
[revise](../skills/revise/SKILL.md).

## Commands

| Command | Does |
|---|---|
| `npm run setup` | Install, build, create missing labels, and run the doctor. Requires a config; safe to rerun. |
| `npm run doctor` | Read-only readiness check: tools, tokens, config, checkouts, branches, skills, and labels. Exits nonzero on a FAIL. |
| `npm run build` | Compile `src/` to `dist/`. Operational commands run the built code. |
| `npm start` / `npm stop` / `npm restart` | Manage the daemon in the background. |
| `npm run status` / `npm run logs` | Inspect the running daemon and its log. |
| `npm run once` | Run one poll cycle in the foreground, then exit. Add `-- --repo <name>` for one repo. This executes eligible work. |
| `npm run labels:install` | Create missing trigger, lifecycle, and blocked labels on configured repos; leave existing labels unchanged. |
| `npm run paperclip:register` | Register Foreman and configured roles in Paperclip; write their IDs into the local config. |
| `npm run paperclip:doctor` | Check the Paperclip integration read-only; exit nonzero on a FAIL. |
| `npm test` | Build, then run the tests in `test/`. |
| `npm run docs:generate` / `npm run docs:check` | Rebuild generated references, or check whether they are current. Build first. |

CLI: `node dist/cli.js [--config <path>] [--repo <name>] [--once]`; use `--help`
for usage. Repo and package names differ: the package and executable are
`slashbin-ai-agent`.

## Skills in this repo

Open Claude Code in the Foreman checkout and ask:

- **"Set up the Foreman"** — `.claude/skills/setup-foreman` gathers your repo
  configuration, shows it before writing, and runs setup.
- **"Install the labels"** — `.claude/skills/install-labels` runs `labels:install`.
- **"Integrate the Foreman into my Paperclip app"** —
  `.claude/skills/setup-paperclip-integration` configures the optional mirror.

The execution skills are `skills/implement` and `skills/revise`. Configure
`skillPath: "builtin:"` and `revisionSkillPath: "builtin:"` to use them, or point
those fields at your repo's own skills.

## Maintaining the references

Configuration, lifecycle, and Paperclip references are generated from source
declarations and prose templates in `scripts/docs/`. Change their templates
rather than editing the generated Markdown, including their navigation.

```bash
npm run build
npm run docs:generate
npm run docs:check
```

The code owns the contracts: named lifecycle moves in `src/lifecycle.ts`, retry
policies in `src/backoff.ts`, GitHub names in `src/config-schema/github.ts`, and
settings in `src/config.ts`. Each setting's description lives with its declaration;
the configuration generator rejects undocumented keys.
