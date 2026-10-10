# Foreman docs: where to look

Start here when you need to run, configure, change or debug the Foreman. Each question
points at the one place that answers it. The pages marked *generated* are built from the
code (`npm run build && npm run docs:generate`; `npm run docs:check` fails when one is
stale), so they describe what runs, not what was meant to.

| You want to… | Read |
|---|---|
| Know what the Foreman does and set it up | [../README.md](../README.md) — Quick start, Daemon management |
| Change any setting: what it does, its default, its env var | [configuration.md](configuration.md) *(generated)* |
| Make it retry sooner or later, or give up after more tries | [configuration.md#back-offs](configuration.md#back-offs) — the `backoff` block |
| Know which state an issue is in, what moves it, what each event means | [lifecycle.md](lifecycle.md) *(generated)* |
| Turn the Paperclip board mirror on, map its columns, check it | [paperclip.md](paperclip.md) *(generated)* |
| Reorder the pipeline or add a stage that runs your own skill | README "Pipeline stages" and "Custom stages"; `src/stages.ts` |
| Turn on review, the Tech Lead or the SRE | README "Review phase (opt-in)"; [configuration.md#review-phase](configuration.md#review-phase) |
| Understand the code: one file per concern | [../CLAUDE.md](../CLAUDE.md) "Architecture" and "Key design decisions" |
| Know why an issue is tracked as implemented when it is not | [implemented-cache-self-heal.md](implemented-cache-self-heal.md) |

## Commands

| Command | Does |
|---|---|
| `npm run build` | Compile `src/` to `dist/`. Every other command runs the built code. |
| `npm start` / `stop` / `restart` / `status` / `logs` | Manage the daemon in the background (`agent-manager.mjs`). |
| `npm run once` | One poll cycle in the foreground, then exit. Add `-- --repo <name>` for one repo. |
| `npm test` | Build, then run every test in `test/`. |
| `npm run labels:install` | Create any missing trigger or lifecycle label on every configured repo. Never changes an existing one. |
| `npm run paperclip:register` | Register the Foreman as a Paperclip agent and write its id into the config. |
| `npm run paperclip:doctor` | Read-only check of the Paperclip integration; exits non-zero on any FAIL. |
| `npm run docs:generate` / `docs:check` | Rebuild the generated docs, or fail when one is stale. |

The CLI itself: `node dist/cli.js [--config <path>] [--repo <name>] [--once]`, and `--help`.

## Skills in this repo

- `.claude/skills/install-labels` — "install the labels": runs `labels:install`.
- `.claude/skills/setup-paperclip-integration` — walks through turning on the Paperclip mirror.
- `skills/implement`, `skills/revise` — the built-in implement and revise skills a repo gets with
  `skillPath: "builtin:"` / `revisionSkillPath: "builtin:"`.

## Rules that hold everywhere

- Every state change is a named move in `src/lifecycle.ts`; nothing else writes lifecycle labels.
- Every retry wait comes from the `backoff` config block through one formula in `src/backoff.ts`;
  a new wait is a new group there, never a constant in a phase.
- Every setting is commented where it is declared; the config doc generator refuses an
  undocumented key.
