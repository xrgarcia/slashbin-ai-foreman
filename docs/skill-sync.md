# Skill sync

[Project README](../README.md) · [All documentation](README.md)

## Contents

- [What it does](#what-it-does)
- [Human lane: sync-only repos](#human-lane-sync-only-repos)
- [Config](#config)

A session runs the skill file in the repo it works in (`.claude/skills/<name>/SKILL.md`).
Skill sync keeps those copies on one golden source. The copies are updated one repo
at a time, as approved work comes through, not all at once.

**Why.** Before skill sync, a skill change was pushed to every repo at once, with one
PR per repo. On 2026-10-15 a single publish put 26 cards in the board's Review column.
Now a rollout spreads at the pace of the work itself. A repo picks up the new skill
with its next approved issue, in that issue's own PR.

## What it does

- **Notices.** On each implement pass, the Foreman compares every carried skill by
  content: each file's path and bytes, on `origin/<baseBranch>`.
  - A changed byte makes the copy stale.
  - So does a missing file, or a file the golden doesn't have.
  - Drift is logged once per repo for each golden version, not on every poll.
- **Syncs at implement time.** When an approved issue is picked up for a stale repo,
  the Foreman's code (never the session) copies the golden files byte for byte into
  the checkout, under the checkout lock.
  - It commits them on the local base branch; the issue's own branch is cut from it, and the base is moved back once the session ends:
    `chore(skills): sync <names> from <source>@<version> (#<issue>)`.
  - Skill files are added with `git add --force`, so a repo that ignores `.claude/` still gets
    them, and a file the golden no longer has is removed. The commit skips repo hooks
    (`--no-verify`): it is a reviewed copy, and CI still runs on the PR.
  - The session then runs on the fresh skill, and the commit is pushed with the
    session's work. So it rides the issue's PR.
  - `(#<issue>)` appears only when the session was handed exactly one issue.
- **Never blocks an issue.** In each of these cases the sync is skipped, logged, and
  the issue is built on the skill already there:
  - the golden can't be read
  - the checkout has uncommitted changes, or local commits that origin doesn't have
  - any git step fails (a warning is logged; the index and the skill files are put back exactly
    as found, so a failed sync never leaves uncommitted changes that would block the next one)
- **Leaves no strays.** If the session pushes nothing, the sync commit is taken back
  off the local branch, and the next issue syncs again.
- **Not in revise.** A revision answers review using the skill it was built with.
- **Doctor.** `npm run doctor` shows WARN for each repo whose copy is behind, reading
  refs as last fetched.

Only the skills the golden has are touched. A skill that exists only in the repo is
left alone.

## Human lane: sync-only repos

A repo the registry puts in the `human` lane is built by a person running the unified
`implement-approved-issues` skill directly (direct mode, branch `feature/<N>-<slug>`). The Foreman
builds nothing there, but it keeps the skills that person runs current. Register the repo in
`.ai-agent.json` with `"syncOnly": true` (and its `baseBranch`: the branch PRs merge into, `develop`
or else `main`); it then runs only the `skill-deliver` stage (`src/phases/skill-deliver.ts`) and
no implement, review, revise, reconcile, release, verify, unstick or board mirror. It is not
onboarded, so no label is created.

For each open `approved-for-human` issue (lowest number first), `SkillSync.deliverSkillsForIssue`:

1. fetches `origin/<base>` and compares the carried skills by content. Current: nothing is done.
2. looks for `feature/<N>-*` on origin. Present (the person started it, or an earlier delivery):
   nothing is done, except in the one case below. The direct-mode skill resumes that branch, and a
   second push would diverge it.
3. otherwise builds one `chore(skills): sync ... (#N)` commit on `origin/<base>` and pushes it as
   `feature/<N>-<slug>` (same slug rule as the skill: lower-case, non-alphanumerics to `-`, 40
   characters). The person's session finds the branch, checks it out and merges `origin/<base>`.

It uses git plumbing and a throwaway index, so the clone's working tree, index and branches are never
touched (the clone may be someone's own) and there is no sync commit to settle afterwards. It opens no
PR, comments, labels or implements. Once the person's PR merges, the base is current and the repo is
quiet until the golden changes.

**Refreshing an untouched delivery.** An earlier delivery otherwise goes stale: the base still lacks the
new golden, the branch exists, and step 2 would leave it on the old template for ever (jerky_com_marketing,
2026-11-03 to 11-11: four branches missing `ship` and carrying an old `pre-pr-check`). So when exactly one
`feature/<N>-*` exists, the base is stale, and **all** of these hold, the branch is rebuilt as one fresh
sync commit on the current `origin/<base>` and force-updated (status `refreshed`):

- every commit beyond `origin/<base>` is a Foreman delivery commit: subject `chore(skills): sync ... (#N)`,
  the delivery marker line in the body (`DELIVERY_MARKER`), and the author the Foreman commits as
  (`git var GIT_AUTHOR_IDENT` in its clone), and none is a merge (a merge means the person brought the base in);
- no PR from the branch exists, open, merged or closed (`allPrsForBranch`; an unreadable list, or none supplied, means no refresh);
- the skills it carries differ from the golden.

**Why the force is safe.** The only writer of such a branch is the Foreman, and the history it discards is one
generated commit that the new one reproduces from the newer golden. The push is `--force-with-lease` on the
sha just read, so a commit pushed in the meantime wins and the push fails (the branch is left as is). Any
other commit, any merge, any PR, a second `feature/<N>-*` branch or any failed read leaves the branch alone, as before.
The one residual risk: a person who already fetched the untouched branch locally, without committing, finds
it rewritten; their next `git fetch` and checkout of it resolves it, and nothing of theirs was on it.

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

Per repo, `skillSyncSkills` replaces `skills`, and `[]` opts that repo out. Per repo, `syncOnly: true` makes it a human-lane repo (above).

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
