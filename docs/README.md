# Foreman docs: where to look

Start here when you need to run, configure, change or debug the Foreman. Each question
points at the one place that answers it. The pages marked *generated* are built from the
code (`npm run build && npm run docs:generate`; `npm run docs:check` fails when one is
stale), so they describe what runs, not what was meant to.

| You want to… | Read |
|---|---|
| Know what the Foreman does, feature by feature | [../README.md](../README.md) — the feature map |
| Set up a new install: what you need, the smallest config, `npm run setup` | [setup.md](setup.md) — or ask Claude to "set up the Foreman" |
| Add a repo, and know what happens before its first piece of work | [onboarding.md](onboarding.md) |
| Start, stop and watch the daemon; tune retries; stay inside GitHub's API budget | [running.md](running.md) |
| Configure repos, branches and labels: single-repo and multi-repo mode, lifecycle labels | [config-guide.md](config-guide.md) |
| Change any setting: what it does, its default, its env var | [configuration.md](configuration.md) *(generated)* |
| Make it retry sooner or later, or give up after more tries | [running.md#back-offs](running.md#back-offs); every key in [configuration.md#back-offs](configuration.md#back-offs) |
| Rename the blocked or priority labels, or change the PR titles and signature the Foreman writes | [configuration.md#github-conventions-github](configuration.md#github-conventions-github) — the `github` block |
| Know what each stage does, how lanes run side by side, reorder the pipeline or add a stage that runs your own skill | [pipeline.md](pipeline.md); `src/stages.ts` |
| Turn on review (the Tech Lead), outcome-label reconciliation, declared holds | [review.md](review.md); [configuration.md#review-phase](configuration.md#review-phase) |
| Turn on dev verification (the SRE) and the release stage | [pipeline.md#the-stages](pipeline.md#the-stages); [lifecycle.md#the-release-stage](lifecycle.md#the-release-stage) |
| Know which state an issue is in, what moves it, what each event means | [lifecycle.md](lifecycle.md) *(generated)* |
| Know what a session is told: skill paths, built-in skills, overlays, prompt variables, images | [skills.md](skills.md) |
| Keep each repo's skill copies on a golden source, one approved issue at a time | [skill-sync.md](skill-sync.md) |
| Know what a session can see and leak: tokens, the secret gate, redaction, workspace trust | [security.md](security.md) |
| Turn the Paperclip board mirror on (optional), map its columns, check it | [paperclip.md](paperclip.md) *(generated)* |
| Understand the code, or run the Foreman from your own code | [architecture.md](architecture.md); [../CLAUDE.md](../CLAUDE.md) "Architecture" and "Key design decisions" |
| Know why an issue is tracked as implemented when it is not | [implemented-cache-self-heal.md](implemented-cache-self-heal.md) |

## Commands

| Command | Does |
|---|---|
| `npm run setup` | Install, build, create any missing label, then run the doctor. Needs a config; safe to re-run. |
| `npm run doctor` | Read-only: is the Foreman ready? Tools, tokens, config, and per repo the checkout, branches, skills and labels. Exits non-zero on any FAIL. |
| `npm run build` | Compile `src/` to `dist/`. Every other command runs the built code. |
| `npm start` / `stop` / `restart` / `status` / `logs` | Manage the daemon in the background (`agent-manager.mjs`). |
| `npm run once` | One poll cycle in the foreground, then exit. Add `-- --repo <name>` for one repo. |
| `npm test` | Build, then run every test in `test/`. |
| `npm run labels:install` | Create any missing trigger, lifecycle or blocked label on every configured repo. Never changes an existing one. |
| `npm run paperclip:register` | Register the Foreman as a Paperclip agent and write its id into the config. |
| `npm run paperclip:doctor` | Read-only check of the Paperclip integration; exits non-zero on any FAIL. |
| `npm run docs:generate` / `docs:check` | Rebuild the generated docs, or fail when one is stale. |

The CLI itself: `node dist/cli.js [--config <path>] [--repo <name>] [--once]`, and `--help`.

## Skills in this repo

- `.claude/skills/setup-foreman` — "set up the Foreman": interviews the user, writes the config, runs setup until the doctor says Ready.
- `.claude/skills/install-labels` — "install the labels": runs `labels:install`.
- `.claude/skills/setup-paperclip-integration` — walks through turning on the Paperclip mirror.
- `skills/implement`, `skills/revise` — the built-in implement and revise skills a repo gets with
  `skillPath: "builtin:"` / `revisionSkillPath: "builtin:"`.

## Rules that hold everywhere

- Every state change is a named move in `src/lifecycle.ts`; nothing else writes lifecycle labels.
- Every retry wait comes from the `backoff` config block through one formula in `src/backoff.ts`;
  a new wait is a new group there, never a constant in a phase.
- Every GitHub name the Foreman reads or writes is a config key: the trigger label, `lifecycleLabels`,
  or the `github` block (`src/github/conventions.ts`); a new one goes there, never a literal in a phase.
- Every setting is commented where it is declared; the config doc generator refuses an
  undocumented key.
