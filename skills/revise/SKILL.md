---
description: Revise a PR with pending review feedback — read the review, fix every finding, push, and hand back for re-review
---

# Revise PR Feedback (Foreman built-in)

The Foreman runs this skill non-interactively inside a checkout of the repository it
manages, after a review asked for changes. Work autonomously and do not ask questions.
The prompt that carried this skill names the repository, its **feature branch**, the
**base branch**, and normally the PR number and linked issues — use those.

## Labels come from the environment

Never type a label name from memory. `FOREMAN_LIFECYCLE_LABELS` holds the configured
lifecycle labels as JSON; the one that marks a PR's linked issue as waiting on
revision is `prPendingActions` (labels are on issues, never on the PR):

```
node -e 'console.log(JSON.parse(process.env.FOREMAN_LIFECYCLE_LABELS).prPendingActions)'
```

**Do not change any labels.** The Foreman transitions them after you finish, based on
whether you pushed.

## Phase 0: Inventory

1. If the prompt names a PR number, that is the PR to revise.
2. Otherwise find the issues waiting on revision, then the open feature PR:

   ```
   PENDING=$(node -e 'console.log(JSON.parse(process.env.FOREMAN_LIFECYCLE_LABELS).prPendingActions)')
   gh issue list --label "$PENDING" --state open --json number,title
   gh pr list --head <feature> --base <base> --state open --json number,title,url,headRefName,body
   ```

3. If either list is empty, report that nothing is pending revision and stop.

## Phase 1: Read Feedback

1. Read the review and conversation comments:

   ```
   gh pr view <number> --comments --json comments,reviews
   ```

2. Read the inline (code-level) comments:

   ```
   gh api repos/{owner}/{repo}/pulls/<number>/comments --jq '.[] | {path, line, body}'
   ```

3. Build a checklist of every requested change, ordered by severity (S1, S2, S3).
4. **A comment starting `<!-- foreman-ci-gate -->` is a CI send-back, not a review.** The
   PR's own CI is red. The checklist is: make each named failing check pass. Read
   `.github/workflows/` for the exact command each check runs, reproduce it locally, fix
   the code (never the test), and confirm it passes before pushing.
5. **Build to the required outcome, not the suggested route.** If a finding states the
   result the next review checks, aim at that result. A suggested route the reviewer did
   not verify is a hint — if the code shows it would not produce the outcome, reach the
   outcome another way and say why in your PR comment.
6. **Fix the class, not the instance.** For each finding, grep the repository for every
   other site with the same defect and fix them all in this revision.

## Phase 2: Implement Fixes

1. Check out the PR's head branch and update it:

   ```
   git checkout <headRefName>
   git pull origin <headRefName>
   ```

2. If the pull fails on conflicts, STOP and report it. Do not resolve merge conflicts
   automatically.
3. Implement each change on the checklist, S1 first.
4. **Smoke test — the same one the implementer runs, build first:**
   - If `npm run build` (or the repo's build) exists, run it. It must succeed. Some test
     suites run the built artifact, so testing without building can pass against the
     previous build.
   - **Boot the built entry.** A long-running server: start it, confirm it responds, stop
     it. A CLI (`package.json` has `bin`): run the built entry directly with node and
     `--help`; it must print usage and exit 0. An entry that exits because a required
     secret is unset is an environment precondition — note it in the PR comment, never
     supply credentials to force a green.
   - If tests exist, run them. They must pass.
   - If none of these exist, at least type-check (`npx tsc --noEmit` for TypeScript).
5. Green → stage the specific files (never `git add .` or `git add -A`) and commit:
   `fix: address review feedback (#<PR-number>)`. Several commits are fine when the
   changes are logically separate.
6. Red → fix the code (never the tests) and re-run, at most twice. Still red → STOP and
   report which fixes were applied and which failed.

## Phase 3: Push & Report

1. `git push origin <headRefName>`
2. Comment on the PR summarising what was fixed, finding by finding:

   ```
   gh pr comment <number> --body "Addressed review feedback: <summary>"
   ```

3. **If no code change is needed** — the review asked for none, or the branch already
   satisfies every finding — do not invent one. End your output with the no-commit
   trailer the prompt describes. Without it, a run that pushes nothing is treated as a
   failed revision.

## Images in the feedback

If a review comment contains markdown image references (`![alt](https://...)`), those
images are part of the feedback. Download each to a temp file with
`curl -sL -H "Authorization: token $GH_TOKEN" -o <file> "<url>"` and Read it. If a fetch
fails, note it and continue with the text.

## Rules

- Never modify tests to make code pass.
- Address every finding — S2 and S3 included.
- Each commit leaves the checks passing.
- Revise only the PR you were given, or PRs carrying the pending-revision label from
  `FOREMAN_LIFECYCLE_LABELS`.
- A fix that needs changes outside this repository is skipped and noted in the PR comment.
