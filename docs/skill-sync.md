# Skill sync

A session runs the skill file in the repo it works in (`.claude/skills/<name>/SKILL.md`).
Skill sync keeps those copies on one golden source. The copies are updated one repo
at a time, as approved work comes through, not all at once.

**Why.** Before skill sync, a skill change was pushed to every repo at once, with one
PR per repo. On 2026-10-15 a single publish put 26 cards in the board's Review column.
Now a rollout spreads at the pace of the work itself. A repo picks up the new skill
with its next approved issue, in that issue's own PR.

## What it does

- **Notices.** On each implement pass, the Foreman compares every carried skill by
  content: each file's path and bytes, on `origin/<featureBranch>`.
  - A changed byte makes the copy stale.
  - So does a missing file, or a file the golden doesn't have.
  - Drift is logged once per repo for each golden version, not on every poll.
- **Syncs at implement time.** When an approved issue is picked up for a stale repo,
  the Foreman's code (never the session) copies the golden files byte for byte into
  the checkout, under the checkout lock.
  - It commits them on the feature branch:
    `chore(skills): sync <names> from <source>@<version> (#<issue>)`.
  - The session then runs on the fresh skill, and the commit is pushed with the
    session's work. So it rides the issue's PR.
  - `(#<issue>)` appears only when the session was handed exactly one issue.
- **Never blocks an issue.** In each of these cases the sync is skipped, logged, and
  the issue is built on the skill already there:
  - the golden can't be read
  - the checkout has uncommitted changes, or local commits that origin doesn't have
  - any git step fails
- **Leaves no strays.** If the session pushes nothing, the sync commit is taken back
  off the local branch, and the next issue syncs again.
- **Not in revise.** A revision answers review using the skill it was built with.
- **Doctor.** `npm run doctor` shows WARN for each repo whose copy is behind, reading
  refs as last fetched.

Only the skills the golden has are touched. A skill that exists only in the repo is
left alone.

## Config

Global `skillSync` block. It is off unless `enabled` is set.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Env `AI_AGENT_SKILL_SYNC_ENABLED`. |
| `source` | `"builtin"` | `"builtin"`: this package's `skills/`. `"git"`: a committed ref in another checkout. |
| `repoPath` | none | The git source's checkout. Env `AI_AGENT_SKILL_SYNC_REPO_PATH`. |
| `ref` | `"origin/develop"` | The golden is read from this ref, after a fetch, and never from the working tree. |
| `dirs` | `[]` | Directories under `ref`. Each holds one sub-directory per skill, and a sub-directory counts only if it has a `SKILL.md`. Required for `"git"`. |
| `skills` | `[]` | The skills a repo carries. An empty list means every skill the source has. |
| `targetDir` | `".claude/skills"` | Where a repo keeps its skills. |
| `label` | the checkout's dir name | The source name used in the commit subject. |
| `refreshMs` | `300000` | How long one read of the golden is reused. |

Per repo, `skillSyncSkills` replaces `skills`, and `[]` opts that repo out.

Example: a git source that serves the Foreman-lane and shared skills.

```json
"skillSync": {
  "enabled": true,
  "source": "git",
  "repoPath": "../slashbin-engineering-manager",
  "ref": "origin/develop",
  "dirs": [".claude/skill-templates/foreman-lane", ".claude/skill-templates/shared"]
}
```

Code: `src/skill-sync.ts`. Tests: `test/skill-sync.test.mjs`.
