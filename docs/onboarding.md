# Onboarding a repo

[Project README](../README.md) · [All documentation](README.md)

## Contents

- [Adding a repo](#adding-a-repo)
- [What the Foreman does before the first piece of work](#what-the-foreman-does-before-the-first-piece-of-work)

What happens when the Foreman first sees a repo, before it gives the repo any work.

## Adding a repo

Add an entry to `repos` in `.ai-agent.json` ([config-guide.md](config-guide.md#multi-repo-mode)).
The daemon re-reads the file every cycle, so a running daemon picks the new repo up
without a restart and logs it as added. Its lanes start on the next pass.

The repo still needs what [setup.md](setup.md#1-before-setup) lists: a local checkout on
the daemon's machine, its three branches, and write access for the Foreman's token.
`npm run doctor` checks all of it, per repo, read-only.

## What the Foreman does before the first piece of work

1. **Creates the labels it runs on** (`onboarding`, default on). Before the repo's
   first lane pass — at start-up for repos already in the config, and for any repo a
   reload adds — the Foreman reads the repo's labels and creates the ones that are
   missing: the trigger label, every `lifecycleLabels` value and `github.blockedLabel`,
   under the names in your config. This is the same set `npm run labels:install`
   creates.
   - Read, then create only: an existing label's colour, description and issues are
     never touched, and nothing is edited or deleted. New labels get GitHub's default
     grey.
   - No lane runs on the repo until every label exists. If GitHub refuses (no access,
     an outage), a warning is logged and the attempt is retried on the repo's next
     pass. Other repos are not held up.
   - Renaming a label in the config onboards the repo again under the new names.
   - Without this, the first sign of a missing label would be the first label write of
     an issue's life — mid-flow, with the issue already half-moved.
   - Set `onboarding: false` (or `AI_AGENT_ONBOARDING=false`) to manage the labels
     yourself ([configuration.md](configuration.md#onboarding)).
2. **Syncs its skills** (when `skillSync` is on). Before the implement session for the
   repo's first approved issue starts, the Foreman copies the golden skill files into
   the checkout and commits them on the feature branch, so the session runs on the
   current skill and the commit rides that issue's PR. Not repeated by onboarding: it
   already happens ahead of every build ([skill-sync.md](skill-sync.md)).
3. **Shows its cards on the board** (when Paperclip is on — optional, off by default).
   After every pass the Foreman publishes the repo's open work to the board, so the
   repo's issues appear there from its first pass ([paperclip.md](paperclip.md)).

Code: `src/onboarding.ts` (labels), `src/phases/implement.ts` and `src/skill-sync.ts`
(skills), `src/orchestrator.ts` `publishBoard` (board). Tests:
`test/onboarding.test.mjs`.
