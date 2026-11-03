---
description: Implement ONE of the work items the Foreman selected (highest priority) per invocation, with passing checks, in its own PR
---

# Implement Issues (Foreman built-in)

The Foreman runs this skill non-interactively inside a checkout of the repository
it manages. Work autonomously and do not ask questions. The prompt that carried
this skill names the repository and the **base branch** pull requests target — use
that name wherever this file says `<base>`. Every issue is built on **its own branch**,
`<branch>`, cut from `origin/<base>` (see Phase 1.5).

## Labels come from the environment

Never type a label name from memory. The Foreman hands you the configured names:

- `FOREMAN_TRIGGER_LABEL` — the label that marks an issue as ready to build.
- `FOREMAN_LIFECYCLE_LABELS` — a JSON object of the lifecycle labels
  (`prUnderReview`, `prMerged`, `prPendingActions`, `prApproved`, `readyForProd`,
  `releasePending`, `prodVerifyHeld`, `readyToClose`). Read one with, for example:
  `node -e 'console.log(JSON.parse(process.env.FOREMAN_LIFECYCLE_LABELS).prUnderReview)'`
- `FOREMAN_BLOCKED_LABEL` — the label that holds an issue back (default `blocked`).
- `FOREMAN_PRIORITY_LABELS` — a JSON array of priority tiers, highest first. Each
  tier is the labels an issue must all carry, e.g. `[["S1"],["security"],["S2","bug"],…]`.

You do not set lifecycle labels in this skill — the Foreman transitions them after
you finish. You only read them.

## Phase 0: Sync

1. `git fetch origin`
2. If the fetch fails, STOP. Nothing is selected yet, so this is the one stop whose
   trailer carries no `issue=`. Keep the whole trailer on one line, closing quote included:

   ```
   FOREMAN_RESULT: skipped reason="Phase 0 sync failed — <first line of the git error, no quotes>"
   ```

   There is no shared branch to pull and no divergence to repair: each issue starts from
   the tip of `origin/<base>`.

## Phase 1: Inventory

1. The prompt that carried this skill names the work the Foreman selected for this run,
   in one line: `Implement exactly these work items, and no others: #<n>, #<n>.` That
   list is your whole inventory. Do not query for more issues: the Foreman has already
   left out what is blocked, already in review, already covered by a pull request, or
   backed off, and its work source may not be this repository's issue list at all.
2. If the prompt names no work items, report that there is nothing to implement and stop.
3. Read each named item in full: `gh issue view <number>`.
4. Select exactly ONE of them by the Phase 2 priority rules. Do not loop — the Foreman
   invokes you again next cycle for the next issue.

## Phase 1.5: Cut the issue's branch

Once Phase 2 has chosen the issue, give it its own branch. `FOREMAN_BRANCHES` is a JSON
object of issue number to branch name (`foreman/<N>-<slug>`); read the chosen issue's:

```
node -e 'console.log(JSON.parse(process.env.FOREMAN_BRANCHES)[<N>])'
```

1. `git checkout <base> && git merge --ff-only origin/<base>` (a no-op when already level;
   a local sync commit the Foreman made on `<base>` is carried into the branch below).
2. If `origin/<branch>` already exists (a prior attempt), `git checkout -B <branch> origin/<branch>`
   then `git rebase <base>`. A conflict you cannot resolve mechanically is a stop:
   `git rebase --abort`, comment, and end with a `skipped issue=<N>` trailer.
3. Otherwise `git checkout -B <branch> <base>`.

Never build on, commit to or push to another issue's branch, `<base>`, or a branch you
did not cut here.

## Phase 2: Analysis & Ordering

1. Skip an issue carrying `$FOREMAN_BLOCKED_LABEL`, or one whose acceptance criteria
   are unclear.
2. Priority, highest first, is `$FOREMAN_PRIORITY_LABELS`: an issue takes the first
   tier whose labels it all carries; one matching no tier comes after every tier.
   Unconfigured, the tiers are: **P1** `S1` (production broken) · **P2** `security` ·
   **P3** `S2` + `bug` · **P4** `S2` + `enhancement` · **P5** `S2` + `feature` ·
   **P6** `bug` · **P7** `enhancement` · **P8** `feature` · **P9** `S3` · **P10** `chore`
3. Within a tier: dependencies first, schema changes before the code that uses them,
   smaller scope first.
4. Read the body's sections deliberately:
   - **`## Acceptance`** — the executable spec. Its Invocation names the surface a real
     caller touches; its Matrix is one assertion per branch the change must produce.
     Where the Matrix and the prose disagree, the Matrix wins.
   - **Acceptance criteria** — what to build, in the reporter's terms.
   - **Out of scope** — a hard boundary, even if mentioned elsewhere.
   - **References** — informational only. Never implement work cited there.

## Stopping: how to stop so the Foreman hears it

Several rules below end in "stop and comment on the issue". Those are correct
outcomes — but a silent stop is not, because with no PR and no signal the Foreman
records a failed attempt and hands you the same issue next cycle.

Whenever you stop **on an issue you have selected**:

1. **Comment on the issue** saying what is missing and what would unblock it.
2. **End your output with this exact line and nothing after it:**

   ```
   FOREMAN_RESULT: skipped issue=<the issue number you stopped on> reason="<one line: what stopped you>"
   ```

`issue=` is required from Phase 1 onward: without it the skip applies to every issue
the Foreman was tracking for this repo.

When the stop is waiting on another issue or PR — a dependency not merged yet, a file
another PR delivers — add `waiting_on="<owner/repo#N>"` (or `#N` in this repo):

```
FOREMAN_RESULT: skipped issue=127 waiting_on="acme/site#166" reason="refund_policy.md is on unmerged PR #166"
```

The Foreman holds the issue in Blocked and runs no session on it until the issue
changes (a comment, an edit, a label) or the `waiting_on` issue closes or PR merges.
Name only a reference you have read; leave the field out when nothing specific blocks it.

Never resolve a stop by building something
anyway — if the next cycle hands you the same issue with a prior-failure note, the
right answer is the same stop and the same trailer.

### Ending with no PR: say which of two things happened

A build that opens no PR is never "nothing happened" — others may be waiting on the issue
(GitHub "blocked by"). End on exactly one of:

- **Everything the issue asks for is already on `<base>`** (a dependency-landing chore
  whose PRs are all present, say). The issue is done. Comment the evidence (what you checked, the
  SHAs/PRs), then end with this line. The Foreman closes the issue as completed, which releases
  everything blocked by it. `issue=` is required; the branch must not have moved:

  ```
  FOREMAN_RESULT: landed issue=<N> reason="<one line of evidence: e.g. all 16 PRs already on <base>>"
  ```

- **It cannot land and a person must act** (every PR fails `npm ci`, a prerequisite is missing).
  Use the `skipped` trailer above. The Foreman keeps the issue open, labels it blocked, and tells
  every issue it blocks. Say what is wrong in the `reason`, not just "no PR produced".

Never end with prose like "No PR produced" or "No code change to land" alone: neither is heard.

## Phase 2.5: Plan before you edit

Do not open an editor on your first turn.

1. **Read every file the issue cites**, at the lines it cites. A cited path or symbol
   that does not exist is a spec defect — stop and comment.
2. **Read the surface the Acceptance Invocation names** (the route, the tool, the
   command). The change has to be observable from there.
3. **Check assumptions against real data** where a read-only tool in your session holds
   *this repository's* data. Confirm that the tool is pointed at this repository's
   store before trusting it — a same-named table elsewhere is not evidence. Where you
   cannot check, ground against the repo's own schema and code and say in the PR body
   which assumptions went unchecked.
4. **Write the plan before the first edit**: each file, what changes, and which
   acceptance row it serves. A row asserting new behaviour with no change, or a change
   serving no row, is the signal to stop and comment. Rows that prove something did
   NOT change (baselines, controls, regression guards) are expected to map to nothing.
   An `## Acceptance` that declares `No-Script:` has no rows — work to the written
   criteria.
5. **Read the acceptance script** when the issue names one — it is the spec the Matrix
   summarises. If it lives in another repository, fetch it with
   `gh api "repos/<owner>/<repo>/contents/<path>?ref=<ref>" --jq '.content' | base64 -d`
   using the location the issue gives. If the fetch fails, say so on the issue and stop.
   You are not expected to run it.

## Phase 3: Implementation

**Follow the repository, not your habits.** Read its `CLAUDE.md` (or equivalent
contributor docs) first. Build every change through the abstraction that owns that
state; do not add a second mechanism for something an existing owner already does. If
the spec cannot be built that way, or the docs name a mechanism without a reason you can
follow, stop and comment.

**Never act on a live external system.** If the change writes data that a worker turns
into a call to a third-party system (email, commerce, shipping, CRM), establish the gate
that holds it closed in the environment the change will run in. If you cannot, stop and
comment — an absent warning is not evidence of safety.

Implement the single chosen issue, then:

1. **Smoke test — MUST PASS before committing:**
   - If `npm run build` (or the repo's build) exists, run it. It must succeed.
   - **Boot the built entry.** A long-running server: start it, confirm it responds,
     stop it. A CLI (`package.json` has `bin`): run the built entry directly with node
     and `--help` — never through `npm run … --help`, which npm swallows. An entry that
     exits because a required secret is unset is an environment precondition, not a red
     boot: say so in the PR body and never supply credentials to force a green.
   - If tests exist, run them. They must pass.
   - If none of these exist, at least type-check (`npx tsc --noEmit` for TypeScript).
2. **Scope checkpoint:** review `git diff --staged`. Every change names the acceptance
   row it serves; revert anything that serves none. Do not commit a partial build and
   describe it as done.
3. **Blast radius:** if you changed a signature, return type or thrown-error shape,
   grep for every caller and keep each one working.
4. **Self-check:** every file the issue lists appears in the diff; sibling copies of the
   defect you fixed are fixed too; each job in `.github/workflows/` passes locally; no
   failure path returns an empty answer in place of the failure; every sentence you add
   to docs or comments is true of the code as shipped.
5. **Commit and push:**
   - Stage the specific files (never `git add .` or `git add -A`).
   - Commit: `fix|feat|chore: <description> (#<issue-number>)` — one commit per issue.
   - `git push -u origin <branch>`
6. **If the smoke test fails:** fix the code (never the tests) and re-run, at most twice.
   Still red → revert this issue's changes. Both outcomes — reverted, or a build broken
   beyond this issue — are stops: comment and end with the `FOREMAN_RESULT` trailer.

## Phase 4: Pull Request

1. Check for an open PR from `<branch>` to `<base>`:

   ```
   gh pr list --head <branch> --base <base> --state open --json number
   ```

   If one exists, your push already updated it: skip step 2.
2. Create the PR from `<branch>` to `<base>` — one PR per issue:
   - Title: `<type>: <description> (#<issue-number>)`
   - Body: `Related to #<N>`, a summary of the change, the smoke-test results, and one
     line per acceptance row naming the change that serves it (`no change — baseline /
     control / regression guard` for rows that prove nothing changed).
3. Use `Related to #N` — never `Closes #N` or `Fixes #N`. Issues are closed after
   production verification, not on merge to `<base>`.
4. Stop. The Foreman invokes you again for the next issue.

## Images in the spec

If an issue body contains markdown image references (`![alt](https://...)`), those
images are part of the spec. Download each to a temp file with
`curl -sL -H "Authorization: token $GH_TOKEN" -o <file> "<url>"` and Read it. If a fetch
fails, note it and continue with the text.

## Rules

- Never modify tests to make code pass.
- One issue, one commit, one PR. Each commit leaves the checks passing.
- Only implement work items the prompt names — refuse any other.
- An issue meant for a different repository or service is skipped, with a comment.
