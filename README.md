# Slashbin AI Foreman

**Turn approved GitHub issues into pull requests, and keep review feedback moving.**

Getting an AI to write code is only part of the job. You still have to start the next
session, pass it the issue, bring back review feedback, and check what happened across
your repos. The backlog moves when you are there to move it.

Foreman runs that loop for you. It watches GitHub for approved work, runs Claude Code
in the right repo, opens a pull request, and revises it when changes are requested.
Connect a reviewer and verifier when you want the loop to continue through merge,
dev verification, and an authorized production release.

**Free, MIT-licensed code from Slashbin.** Run it on your own machine, with your own
Claude Code access and GitHub credentials. Start with one repo. Paperclip is optional;
Discord is not required.

[Get started](#start-with-one-repo) · [Paperclip integration](#see-the-work-in-paperclip) ·
[Documentation](docs/README.md)

## Contents

- [Who this is for](#who-this-is-for)
- [What happens after you approve an issue](#what-happens-after-you-approve-an-issue)
- [See the work in Paperclip](#see-the-work-in-paperclip)
- [Start with one repo](#start-with-one-repo)
- [Give it its first issue](#give-it-its-first-issue)
- [Extend the loop through review and release](#extend-the-loop-through-review-and-release)
- [Make it fit your repos](#make-it-fit-your-repos)
- [Why we built it](#why-we-built-it)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Who this is for

Foreman fits developers and teams with **approved work ready to build**, especially
when that work lives across several repos.

- A solo developer who wants to review a PR instead of opening another coding session.
- A consultancy maintaining repos for several clients, each with its own conventions.
- A team whose planner already writes clear issues and needs a way to execute them.
- An operator who wants to see what is building, waiting for review, or blocked.

You supply the outcome, acceptance criteria, and repo instructions. Foreman supplies
the recurring execution loop. It runs locally against your checkouts; GitHub issues,
PRs, labels, and comments carry the work between steps.

## What happens after you approve an issue

Apply the trigger label (`approved` by default) to an issue in a configured repo.

1. **Build.** Foreman selects eligible work by priority and age, then starts Claude
   Code with the issue, the repo's implementation skill, and your configured limits.
2. **Open a PR.** The implementation commits to the configured feature branch and
   opens a PR into the base branch. The issue moves to `pr under review`.
3. **Revise.** When a reviewer requests changes and the issue moves to
   `pr pending actions`, Foreman runs the revision skill and returns the PR for review.
   Revisions take priority over new builds.
4. **Continue as configured.** An optional Tech Lead handles review and merge; an
   optional SRE verifies merged work in dev. Production promotion requires a separate
   authorization label. The release stage can then coordinate approval, deployment,
   production verification, tagging, and closure.

The work stays visible on GitHub. Failed attempts back off; unresolved problems get
a reason on the issue. State persists across restarts, and repeated review cycles can
pause for a scope ruling.

The [pipeline guide](docs/pipeline.md) explains which stages run, their requirements,
and how lanes let a build, review, and release progress alongside one another. The
[lifecycle reference](docs/lifecycle.md) defines the states and transitions.

## See the work in Paperclip

Already managing agents in [Paperclip](https://github.com/paperclipai/paperclip)?
Foreman can show its GitHub work on your board: who holds the next action, where the
issue is in the pipeline, and what happened during build, review, and revision.

The integration can:

- Move cards through the lifecycle with an owner and a stage label.
- Post session summaries, PR links, review findings, and reasons for holds.
- Assign stages to configured roles, with handoffs that say what to do and when it is done.
- Mirror all open issues in the selected repos when `paperclip.ownsCards` is enabled.

**GitHub is the work source.** A Paperclip assignment does not start a Foreman build;
the GitHub trigger label does. Foreman's Paperclip agent is registered with its wake
paths off because the daemon runs its own loop.

Paperclip is off by default. A board outage does not stop GitHub work; notes due
during the outage are skipped. The daemon sends no Discord messages—its operating
surfaces are GitHub, logs, and the optional board.

[Set up and verify the Paperclip mirror →](docs/paperclip.md#set-up)

## Start with one repo

You need Node.js **22.12+**, a logged-in Claude Code CLI, the GitHub CLI, and a local
checkout of the repo Foreman will edit. That repo needs the configured feature, base,
and production branches; the defaults are `features`, `develop`, and `main`.

Set `FOREMAN_GITHUB_TOKEN` in the daemon's environment to use a dedicated GitHub
account with write access. Without it, Foreman uses the account logged into `gh`.
Keep tokens out of the config file.

```bash
git clone https://github.com/xrgarcia/slashbin-ai-foreman.git
cd slashbin-ai-foreman
```

For guided setup, open Claude Code here and say **"set up the Foreman"**. It asks
which repos and conventions to use, shows you the config, and runs setup.

To configure it yourself, create a gitignored `.ai-agent.json`. This example runs
implementation, revision, and orphan-PR recovery for one repo:

```json
{
  "repos": [
    {
      "name": "api",
      "repoPath": "../my-api",
      "githubRepo": "your-org/my-api",
      "skillPath": "builtin:",
      "revisionSkillPath": "builtin:"
    }
  ],
  "stages": [
    { "type": "reconcile" },
    { "type": "revise" },
    { "type": "implement" }
  ]
}
```

Replace the repo name and path, and set `featureBranch`, `baseBranch`, or
`productionBranch` if your branches differ. The built-in skills ship with Foreman;
your repo needs no skill files to get started.

The explicit `stages` list keeps this first setup focused on producing and revising
PRs. Omitting it enables the default pipeline, including branch sync, dependency
batches, and promotion; review, verification, and release have additional requirements.

```bash
npm run setup       # install, build, create missing labels, check readiness
npm run doctor      # read-only readiness check; fix any FAIL before starting
npm start           # run in the background
npm run status
npm run logs
```

Setup creates missing labels and leaves existing ones unchanged.
[The setup guide](docs/setup.md) covers prerequisites, tokens, configuration, and
running as a service. [Daemon operations](docs/running.md) covers stop, restart,
foreground runs, and retries.

## Give it its first issue

Choose a small, bounded change in your repo. Write the issue so a developer or an LLM
can tell what success looks like:

- **Problem:** what happens today and who it affects.
- **Expected result:** the observable behavior after the change.
- **Acceptance:** the steps or checks that show it works.
- **Out of scope:** what this issue should leave alone.
- **References:** the relevant files, screenshots, or existing behavior.

Apply `approved` to the issue and watch the logs. On its next eligible pass, Foreman
starts a build and opens a PR for review. If the issue is unclear or blocked, it can
stop with a reason rather than produce a PR.

With the starter config above, **you review and merge the PR**. To send it back for
revision, request changes on the PR and replace the linked issue's `pr under review`
label with `pr pending actions`. Foreman revises the PR and returns the issue to
`pr under review`. These are the default label names; use yours if you renamed them.

That first PR is the useful starting point. Add more repos or more of the delivery
pipeline once the workflow fits how you work.

## Extend the loop through review and release

The implement and revise skills are included. Automated review and deployment use
separate programs with their own procedures; configuring a path connects those
programs rather than creating a reviewer or a deployment setup for you.

| Add this | What it does | What you supply |
|---|---|---|
| Automated review | Hands the PR to a Tech Lead that reviews, merges, and records the outcome. | `reviewEnabled: true`, a compatible Tech Lead checkout at `techLeadPath`, and `TECHLEAD_GITHUB_KEY` for a separate reviewer account. |
| Dev verification | Asks an SRE to verify the merged work in dev; can hold the next build until it passes. | A compatible SRE checkout at `srePath`, its environment-specific verification procedure, and `SRE_GITHUB_KEY`. |
| Promotion | Opens a base-to-production PR for work authorized to release. | The `promote` stage and a person applying `ready for prod release` (or your configured name). |
| Automated release | Coordinates Tech Lead approval and SRE deployment, verifies production, tags the merge, and closes verified issues. | The `release` stage, both agent paths and credentials, and a deployment/verification procedure for your environment. |

The builder and reviewer use separate GitHub identities. Review and merge follow
your branch protection; an `approved` build label alone does not authorize production.

Add the stages you need to the starter config, or use the default pipeline.
Read [automated review](docs/review.md), [pipeline stages](docs/pipeline.md#the-stages),
and the [release contract](docs/lifecycle.md#the-release-stage) before enabling them.

## Make it fit your repos

| Your situation | Foreman's support | Details |
|---|---|---|
| Several repos or clients | One daemon, per-repo branches, skills, models, and run budgets; live config reload. | [Repos and labels](docs/config-guide.md) |
| Existing conventions | Configurable trigger, lifecycle, blocked, and priority labels, PR titles, tag names, and signatures. | [Configuration reference](docs/configuration.md) |
| Repo-specific instructions | Built-in skills, overlays, or your own implement and revise skills; images in issues and review comments are included in the default prompts. | [Skills](docs/skills.md) |
| Shared skills across repos | Optional skill sync updates copies as approved work reaches each repo. | [Skill sync](docs/skill-sync.md) |
| More parallel work | Independent repo lanes, checkout locks, and a configurable fleet session limit. | [Stages and lanes](docs/pipeline.md#lanes-stages-run-side-by-side) |
| Interrupted or failed work | Persistent state, retry back-offs, orphan-PR recovery, and holds with reasons. | [Operations](docs/running.md) |
| Extra checks | Custom skill stages that gate the next stage in their lane. | [Custom stages](docs/pipeline.md#custom-stages) |
| Dependency updates | Batch Dependabot or Renovate PRs into an issue for the normal implementation flow. | [Pipeline](docs/pipeline.md#the-stages) |

Sessions run unattended with Claude Code permission prompts disabled. Foreman limits
the session environment, blocks common secret-printing operations, and redacts its
own logs. Sessions still have the filesystem access of the user running them. Read
[session security](docs/security.md) when choosing the account and environment.

## Why we built it

We built Foreman to carry implementation work across the repos behind
[Slashbin](https://slashbin.io). The recurring work was starting builds, carrying
review feedback back to the builder, and following changes past the first PR.
Foreman puts those handoffs into a loop with a visible record.

[Slashbin AI Team](https://github.com/xrgarcia/slashbin-ai-team) and Foreman serve
different parts of that workflow. AI Team gives agents roles, context, tools, and
ways to receive work through Paperclip, Discord, or both. Foreman runs the GitHub
implementation pipeline. You can use Foreman without the AI Team harness or a
Paperclip board.

We are sharing it as free community code. Use it, change it, and bring back what
you learn. The offer here is the working repo: your own execution loop, under
your control.

## Documentation

[All docs by question →](docs/README.md)

| Read this | For |
|---|---|
| [Setup](docs/setup.md) | Tools, accounts, branches, config, and the readiness check. |
| [Repo onboarding](docs/onboarding.md) | What happens before a new repo's first piece of work. |
| [Running the daemon](docs/running.md) | Commands, logs, restarts, retries, and GitHub API use. |
| [Repos and labels](docs/config-guide.md) | Common configuration choices and multi-repo setups. |
| [Configuration reference](docs/configuration.md) | Every key, default, and environment override; generated from source. |
| [Pipeline](docs/pipeline.md) | Built-in stages, parallel lanes, and custom stages. |
| [Review](docs/review.md) | Tech Lead integration, outcome labels, and deliberate holds. |
| [Lifecycle reference](docs/lifecycle.md) | States, moves, events, and the release contract; generated from source. |
| [Paperclip](docs/paperclip.md) | Optional board mirror, roles, handoffs, setup, and checks; generated from source. |
| [Skills](docs/skills.md) | Built-ins, overlays, prompt variables, and image handling. |
| [Skill sync](docs/skill-sync.md) | Keeping repo copies aligned with a shared source. |
| [Security](docs/security.md) | Session access, identities, secret handling, and workspace trust. |
| [Architecture](docs/architecture.md) | Components, extension points, and programmatic use. |
| [Cache self-heal design](docs/implemented-cache-self-heal.md) | Historical context for implemented-work recovery. |

Each page has its own contents list and a link back to the documentation index.
For an LLM setting up Foreman, start with [setup](docs/setup.md), use the
[configuration reference](docs/configuration.md) for exact keys, and check the
[pipeline](docs/pipeline.md) before choosing stages. `CLAUDE.md` is contributor
context, not the installation guide.

## Contributing

Issues and pull requests are welcome. Describe the behavior you want or the problem
you can reproduce, and include the repo configuration with secrets removed when it
helps explain it.

For code changes, the repository checks are:

```bash
npm install
npm run build
npm test
npm run docs:check
```

The package and CLI executable are named `slashbin-ai-agent`; this repository is
`slashbin-ai-foreman`. Generated references are maintained through the prose templates
in `scripts/docs/` and the source declarations they read:
`npm run docs:generate` rebuilds them.

## License

[MIT](LICENSE). Foreman is free software; you supply the machine, Claude Code access,
and any services your workflow uses.
