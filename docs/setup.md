# Setting up the Foreman

[Project README](../README.md) · [All documentation](README.md)

## Contents

- [1. Before setup](#1-before-setup)
- [2. The config](#2-the-config)
- [3. Run setup](#3-run-setup)
- [Giving it work](#giving-it-work)

Three steps: have the tools and tokens, write a config, run `npm run setup`. Setup
installs the labels on every repo and finishes with a check that says, line by line,
whether the Foreman is ready to start and what to fix if not.

The fast path: open Claude Code in the Foreman checkout and say **"set up the
Foreman"**. It asks the questions below, writes the config for you after showing it,
and runs setup. This page is the same thing by hand.

## 1. Before setup

**Tools**, on the machine that will run the daemon:

| Tool | Check |
|---|---|
| Node.js 22.12 or newer (the handoff-contract client is an ES module loaded with `require`). The optional metrics log also needs `node:sqlite`, which Node 22.12 ships only behind a flag; without it the daemon still starts and logs a warning ([metrics.md](metrics.md#requirements)) | `node --version` |
| Claude Code, logged in | `claude --version` |
| GitHub CLI | `gh --version` |

**A checkout of every repo the Foreman will work on**, on the same machine. The
Foreman edits code in that checkout and pushes from it.

**Three branches on each repo** (the names are yours; these are the defaults):

| Branch | Default | What it is |
|---|---|---|
| work | `foreman/<issue>-<slug>` | One branch per issue, cut from base and deleted after merge (`branchPrefix`) |
| base | `develop` | Where finished work is merged and tested |
| production | `main` | What is live; the Foreman opens promotion PRs into it |

**GitHub tokens**, in the daemon's environment — your shell profile, a systemd
`EnvironmentFile`, or your secret manager (`doppler run -- npm start`). Never paste a
token into a chat or into the config file.

| Variable | Needed when | What it is |
|---|---|---|
| `FOREMAN_GITHUB_TOKEN` | Always | The Foreman's own account: it opens PRs and moves labels. Needs write access to every repo. Unset or rejected by GitHub (401), the daemon refuses to start (exit 78): there is no fallback to `gh`'s login. |
| `TECHLEAD_GITHUB_KEY` | Review is on, or you want sync PRs merged automatically | A second account that reviews and merges, so the Foreman never approves its own work. |
| `SRE_GITHUB_KEY` | `srePath` is set | The account that verifies merged work in dev. |
| `EM_GITHUB_TOKEN` | The `unstick` stage runs (see [pipeline.md](pipeline.md)) | The Engineering Manager's account, handed to the unstick session. Also needs `emRepoPath` (the EM checkout). Required once `emRepoPath` is set: unset or rejected, the daemon refuses to start. |

The Foreman's token also writes its records: one comment per issue or PR, and one closed
bookkeeping issue per repo, created on first use. It needs permission to comment on and
open issues in every managed repo. See [upgrading.md](upgrading.md#what-happens-to-existing-state-on-first-start).

## 2. The config

The config is `.ai-agent.json` in the Foreman checkout (gitignored). Only the repos are
required; everything else has a default, listed in
[configuration.md](configuration.md).

[The README's starter config](../README.md#start-with-one-repo) explicitly selects
implementation, revision, and orphan-PR recovery. The example below leaves
`stages` unset, so it uses the default pipeline: branch sync, dependency batches,
and promotion are included; automated review, verification, and release require
the additional configuration described in [pipeline.md](pipeline.md).

The core ships neutral. Slashbin's own deployment defaults (who an unstick give-up
mentions, the QA repo, the review MCP tools) come from `"profile": "slashbin"`; see
[Profiles](config-guide.md#profiles). Other deployments leave `profile` unset.

The smallest working config using those defaults:

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
  ]
}
```

- `name` — a short name for logs and `--repo`.
- `repoPath` — the local checkout, relative to the Foreman directory or absolute.
- `githubRepo` — `owner/repo` on GitHub.
- `skillPath` / `revisionSkillPath` — the instructions a build or a revision follows.
  `"builtin:"` uses the ones shipped in `skills/`; a path such as
  `.claude/skills/implement/SKILL.md` uses the repo's own.

Add only what differs from the defaults:

| If… | Set |
|---|---|
| Your branches are not `develop` / `main`, or you want another branch prefix | `baseBranch`, `productionBranch`, `branchPrefix` (top level, or per repo) |
| Work should start on a label other than `approved` | `triggerLabel` |
| You want different names for the progress labels | `lifecycleLabels` — [configuration.md](configuration.md) |
| Your "on hold" label or your priority labels differ | the `github` block: `blockedLabel`, `priorityLabels` |
| Dependency PRs come from Renovate, not Dependabot | `github.dependencyBranchPrefixes: ["renovate/"]` |
| Each repo needs a different model or longer runs | `model`, `maxTurns`, `maxDurationMs` per repo |
| You want automated PR review | `reviewEnabled: true` and `techLeadPath` — [review.md](review.md) |

`.ai-agent.example.json` shows a fuller config with comments.

## 3. Run setup

```bash
npm run setup
```

It installs and builds, then creates every missing label on every repo — the trigger
label, the progress labels and the blocked label, under the names in your config — and
runs the doctor. Existing labels are never changed. Safe to re-run.

The doctor (`npm run doctor`, read-only) prints one line per check:

```
PASS  config — /srv/foreman/.ai-agent.json loads: 2 repo(s)
WARN  TECHLEAD_GITHUB_KEY — unset — branch-sync PRs will open but not merge; …
FAIL  api: branches — missing on GitHub: base "develop". Create them, or set …
```

Fix each FAIL as it says and run it again. WARNs are things that will not work but
do not stop the Foreman. When it ends with **Ready**, start the daemon:

```bash
npm start          # background; npm run status / npm run logs to watch it
npm run once       # or: one cycle in the foreground, to see it work first
```

To run it as a service that survives reboots, see
`deploy/slashbin-foreman.service.example`.

## Giving it work

Label an issue on a configured repo with the trigger label (`approved` by default).
On its next cycle the Foreman builds it on its own branch, opens a PR, and moves
the issue through the progress labels — [lifecycle.md](lifecycle.md) shows each one.
