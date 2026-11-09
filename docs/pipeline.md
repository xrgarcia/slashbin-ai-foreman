# The pipeline: stages and lanes

[Project README](../README.md) · [All documentation](README.md)

## Contents

- [The stages](#the-stages)
- [Lanes: stages run side by side](#lanes-stages-run-side-by-side)
- [Pipeline stages (`stages`)](#pipeline-stages-stages)
- [Custom stages](#custom-stages)

What the Foreman does on every configured repo, stage by stage, how the stages run side
by side, and how to reorder them or add your own. The state each issue is in, and every
move between states, is in [lifecycle.md](lifecycle.md) *(generated)*.

## The stages

The Foreman runs these stages on every configured repo. Omitted, `stages` is the eleven
built-ins in this order (`src/stages.ts`):

```
Reconcile → Review → Verify → Promote → Release → Revise → Implement → Branch Sync → Dependabot → Unstick → Skill Deliver
```

1. **Reconcile** — finds commits on a Foreman branch that no PR carries (orphaned
   work) and opens a PR for them. The PR titles are `github.reconcileTitle` /
   `github.reconcileBatchTitle` ([configuration.md](configuration.md#github-conventions-github)).
   It also prunes: a `foreman/` branch with no open PR that still sits exactly at the head a
   merged PR delivered is deleted from origin. A branch that moved on, or has an open PR,
   is never touched. **Per-issue branches:** every issue is built on its own branch
   `<branchPrefix><issue>-<slug>` (default prefix `foreman/`, env `AI_AGENT_BRANCH_PREFIX`;
   the slug is the issue title, lowercase, at most 40 characters), cut from `baseBranch`.
   There is no shared build branch. An `origin/` branch that already exists for the issue is
   resumed by merging, never rebased. A branch is the Foreman's if it starts with the prefix
   (or is the legacy shared `featureBranch`, so old PRs still resolve).
2. **Review** *(opt-in)* — when `reviewEnabled` is set, hands each open feature PR
   awaiting review to the **Tech Lead** (`techLeadPath`), which reviews under its own
   GitHub token and owns its own merge and label decisions. Its label side effects
   (approve → `pr approved`; request changes → `pr pending actions`) feed the Promote
   and Revise stages, and the Foreman reconciles the outcome label from the run's
   trailer if the reviewer merged without setting it. Off by default — see
   [review.md](review.md). With no reviewer plugin enabled the PR is left for a person;
   once it is merged to the base branch, Reconcile moves the issue to `pr merged`, on to
   `pr approved` when no verifier is enabled, and comments and closes it when no deployer
   or promote path is left to release it (marker `<!-- foreman:human-merge-close -->`).
   It works in any branch layout and resumes on the next pass if a write fails.
3. **Verify** *(on when `srePath` is set)* — once review has merged a PR (issue at
   `pr merged`), the SRE plugin (`src/plugins/sre.ts`, running `bin/sre.mjs verify`) checks the merged work in the dev
   environment and moves its issues to `pr approved`. A failed verification is retried
   on the `backoff.verifyRetry` schedule (3 attempts by default, then it waits on a
   person). Unset, there is no verify stage and the review run verifies and labels as
   before. With `buildWaitsForDevVerify` (default on) a repo's next build waits until
   its last merge has passed dev verification, so one issue is in flight per repo from
   build to verified on dev.
   **QA report (report-only, on when `qaPath` is set):** after a pass on a `qaRepos` repo
   (none by default; the Console in the `slashbin` profile), the QA plugin (`src/plugins/qa.ts`) runs `qa.mjs check` once for that PR, in the background, and
   posts `## QA Report (report-only)` on it. Nothing waits on it and it never holds or
   reworks the card; a crash or a 90-minute timeout (`QA_MAX_DURATION_MS`) becomes an "errored" comment. Once per
   PR: an existing comment with the heading ends it. `DEV_SESSION_MINT_KEY` reaches only
   the QA child, through `qaSecretsRunner` in the EM checkout (needs `emRepoPath`; unset, a dev QA run reports errored).
   **With `qaGate: true`** QA runs *before* the advance: PASS advances; FAIL (a regression,
   or a defect with no baseline) holds the card as `visual-qa-failed` and calls the EM
   (`rework-decision`) on the first FAIL, because the fix is a technical decision. The Foreman
   files no rework issue and retries nothing on unchanged code (the hold sits at its cap at once);
   the PR re-verifies when the EM's follow-up merges or the spec is edited. HELD or an
   inconsistent verdict holds the card as `qa-held-*` / `qa-inconsistent` (stays `pr merged`,
   Blocked, charged on `backoff.verifyRetry`); a crash or the 90-minute timeout is `qa-errored`,
   a tooling hold that retries on `backoff.agentUnavailable` without charging an attempt.
   The comment is `## QA Report`, keyed by head SHA and verdict so a re-run after a restart does
   not double-post. Default false = the report-only step above.
   **A void PASS is not a PASS.** A PASS with `Shots: 0` on a PR that changed client code
   (`client/...`, or a whole-app build input such as `package.json`, `vite.config.*`, a lockfile)
   checked nothing, so it counts as HELD. A comment opening `**EM QA re-run` on a merged PR,
   newer than every QA report, sends it back for a fresh run (`qaRerun`).
   **QA before the merge (`qaBeforeMerge: true`, needs `qaPath` and `techLeadPath`)** supersedes both
   modes for a `qaRepos` repo: development, code review, then QA, and only then the SRE. The Tech Lead
   approves with `--no-merge`; QA runs `check --local` on the approved head (it boots the PR
   itself); a PASS has the Tech Lead merge on that approval and dev verification follows; a FAIL goes
   back to the builder (it counts as a review round, so three of them raise `needsRuling`); a run with no verdict holds the PR unmerged and retries.
   Code: `src/phases/qa-before-merge.ts`.
   **Holds that are not failures.** A tooling hold (the SRE or QA could not run) is asked again
   shortly and charges no attempt. A hold the SRE names `wait-until-YYYYMMDDTHHMMZ` means the rest
   becomes observable at that time: no attempt is charged, the PR is not picked again before it, the
   repo's next build is freed, and the card shows a scheduled verify with the resume time.
4. **Promote** — opens or updates the promotion PR (base branch → production branch,
   `develop` → `main` by default) for issues labeled `ready for prod release`, moving
   them to `release pending`. `ready for prod release` is the one lifecycle label a
   person writes: it is the authorization to go to production.
5. **Release** *(on when both `srePath` and `techLeadPath` are set)* — no Claude
   session. The Tech Lead approves the promotion PR at its head, the SRE merges, deploys
   and verifies it in production, the Foreman tags the merge commit (an annotated tag,
   never a GitHub Release; name from `github.releaseTagFormat`) and closes each issue on
   a passed prod verification, or labels it `prod verification held` and re-verifies on
   the `backoff.prodVerifyRetry` schedule. Thirty minutes after the merge the SRE soaks the
   release once more; a soak hold reopens the issues the same way. It also adopts promotion PRs
   merged by anyone else in the last 48 hours. Full flow: [lifecycle.md](lifecycle.md#the-release-stage).
   One deploy may run up to `sreDeployMaxDurationMs` (2 h by default).
   **The release carries all of the base branch.** Every issue whose merge sits in
   `production..base` is adopted into the release PR: listed in its body, so the SRE verifies it in production,
   with merges that name no issue listed by PR number (the sync PR and dependency-bot PRs are not
   listed). Adoption lists, it does not sign: only issues the EM marked `ready for prod release` move
   to `release pending`; the Foreman never applies that label to an adopted one.
   **The EM's sign-off gate.** While any listed issue lacks `ready for prod release` (or a label a signed
   issue moves on to: `release pending`, `prod verification held`, `ready to close`), the
   Foreman puts a failing status `github.signoffStatusContext` (default `foreman/em-sign-off`) on
   the release PR head with one comment naming the unsigned issues, and asks neither the Tech Lead to
   approve nor the SRE to merge. Every pass recomputes it, so it turns green once the last issue is
   signed. Make that context a required check on the production branch to hold a human merge too.
   Code: `src/phases/release.ts`, `src/github/release-carry.ts`, `src/github/release-signoff.ts`.
6. **Revise** — finds PRs with pending review feedback (`pr pending actions`) and
   revises them, ahead of new work. A PR that keeps being sent back is held for a
   person's scope ruling instead of being revised forever (`needsRuling` in
   [lifecycle.md](lifecycle.md#stages)).
7. **Implement** — picks up approved issues and runs the repo's implementation skill
   through Claude Code. The Foreman picks the issues before the session — priority tier
   (`github.priorityLabels`), then oldest — and hands it `buildBatchSize` of them
   (default 1). Issues the session declined on purpose are backed off
   (`backoff.skip`). See [skills.md](skills.md) for what the session is told.
   One open Foreman PR is in flight per repo. A build waits while a PR awaits revision, and
   (`buildWaitsForDevVerify`, default on) until the repo's last merge has passed dev verification;
   a merge whose attempts are spent, or that waits on a named time, frees the repo. A
   title saying "follow-up to #N" builds first. The session is told its branch and where
   it starts (`FOREMAN_BRANCHES`, `FOREMAN_BRANCH_PREFIX`, `FOREMAN_START_REF`).
   An `approved` issue is held, not built, while a prerequisite is unmet: a GitHub "blocked by"
   issue not yet merged, a Pre-Flight `readiness` block not satisfied, or no `## Acceptance`
   section naming a committed `scripts/...` path or a `**No-Script:** <category> — <reason>` (category one of
   docs-only, config-only, ci-only, dependency-bump, dead-code-deletion; reason at least 40 characters, not
   describing a caller-observable check and not saying the builder writes it; an acceptance script path
   anywhere in the body must sit inside `## Acceptance` and not be repo-prefixed) (the EM's `approved` rule, enforced again here because a customer can apply the
   label themselves; `src/github/acceptance-gate.ts`). A held issue gets one comment per
   reason (hidden marker `<!-- foreman:readiness-hold KEY -->`) and becomes eligible by
   itself once the body is fixed. The acceptance hold is also emitted in the cycle's waiting set (with its
   reason) every held cycle, so a board shows it; fixing the body clears it. Issues already carrying a
   lifecycle label are not judged. Generated rework issues state a `**No-Script:**` reason (their parent's
   dev verification is re-run) so they pass the same rule.
8. **Branch Sync** — merges the production branch back into the base branch
   (`main` → `develop`) through a sync PR, to keep them aligned after promotions. The
   sync PR is merged under `TECHLEAD_GITHUB_KEY`; without it, the PR opens but does not
   merge. Skipped when `baseBranch` equals `productionBranch`.
9. **Dependabot** — files one issue covering the open Dependabot **security** PRs on the working
   branches, so the updates go through the implement session like any other work. A PR is a
   security update iff a package it bumps has an open Dependabot alert on the repo (grouped PRs: the
   packages are read from the title and body; unreadable means non-security). Other version-update
   PRs are left alone — not batched, merged or closed. If the alerts API cannot be read (404 when
   alerts are disabled, a network error) the cycle batches nothing. `dependabot.securityOnly: false`
   restores batching every Dependabot PR. It is
   filed with the trigger label and the production grant label `deliver-to-prod` (`PROD_GRANT_LABEL`; owner decision 2026-11-06) when the repo sets `dependencyPreApproved` (opt-in per repo, default off, so a newly onboarded repo needs a deliberate edit). Renovate
   instead of Dependabot: `github.dependencyBranchPrefixes: ["renovate/"]`.
   **A batch is its PRs at their head commits, and the repo record remembers what became of it** (`dependencyBatches`,
   `src/dependency-batch/`; foreman#230). A batch that ended is never filed again; a new Dependabot push is a new batch and is
   filed once; the same batch filed 3 times in 24 h is held and raised to the EM as `dependency-batch-loop`. When the implement
   session answers `landed` for a batch issue, the Foreman closes each Dependabot PR in the batch (`CodeHost.retireDependencyPR`,
   a comment naming why) and records the batch as `landed`; if a close fails the batch is not recorded, and the 3-in-24 h cap is
   the backstop.
10. **Unstick** *(on when `emRepoPath` is set; independent of `paperclip.enabled`)* — no
    Claude session. For each stuck issue the EM plugin (`src/plugins/em.ts`) runs `node <emRepoPath>/bin/em.mjs unstick
    --repo <owner/name> --issue <N> --kind <kind> --reason <text>` (cwd `emRepoPath`,
    `EM_GITHUB_TOKEN`, killed after 20 minutes, 40 for `rework-decision`). Kinds: skip, verify-held,
    verify-exhausted, verify-no-pr, revision-exhausted, revision-stalemate,
    needs-ruling, dead-zone, deploy-failed, release-gate, rework-decision, unrelated-error, dependency-batch-loop,
    epic-ready-to-close (`UNSTICK_KINDS`, `src/unstick.ts`; `divergence` is also listed but retired, never raised, since there is no shared
    branch to diverge). A hold with
    retries left is not called for. Outcomes
    are kept in the issue's record (the repo's, for issue 0), keyed `<issue>:<kind>`: exit 0 `invoked` (a handoff: while the question stands it is called again after `backoff.handoff`, 10 minutes doubling, up to 3 recalls, then the escalation owner is told once), 2
    `escalated` (no retry until the reason changes), 3 `declined`, `refused` (the EM's runner was out of tokens or rate-limited: no attempt spent, called again when the limit lifts, and the EM is not called for anything else until then), anything else
    `failed` (retried to 3 attempts, then re-armed on a 1 h to 24 h back-off, one call each; an exit 3 `unknown kind` rejection is `failed`, not `declined`). The Foreman never clears a block on exit 0 and
    never writes Paperclip; the EM releases the hold on GitHub and the unblock checks
    see it. A comment opening `**EM unstick` does not count as the issue changing.
    Three kinds are not holds. `unrelated-error`: errors the SRE excluded from a verification
    as not this release's never hold it; each distinct error signature is raised to the EM once, to route. `epic-ready-to-close`: an issue closed after its
    production verification that belongs to an epic tells the EM to close the epic if it was the
    last open child. `dependency-batch-loop`: see Dependabot above. The kinds with no issue use
    issue 0 and live in the repo's own record.
11. **Skill Deliver** *(only on `syncOnly` human-lane repos)* — no Claude session, no PR, no label,
    no comment. For each open `approved-for-human` issue it puts a skill-sync commit on
    `feature/<N>-<slug>`, cut from fresh `origin/<base>`, for the person's direct-mode skill to
    resume. Nothing happens when `origin/<base>` already carries the current skills.
    See [skill-sync.md](skill-sync.md#human-lane-sync-only-repos).

Other behaviour of the loop:

- **Poll interval is configurable** — default 5 minutes (`pollIntervalMs`).
- **Multi-repo** — one daemon manages many repos, each with its own skill paths and
  settings ([config-guide.md](config-guide.md#multi-repo-mode)).
- **Persists state across restarts** — in the work source's records; it picks up where it
  left off.
- **Failure cooldown** — after `maxFailures` (2) failed sessions in a row on a repo,
  it waits before retrying it, 5 min doubling to 1 h (`backoff.repoFailure`,
  [running.md](running.md#back-offs)).
- **Graceful shutdown** — waits for in-progress work before stopping, up to the longest
  run any repo is budgeted (`maxDurationMs` / `reviewMaxDurationMs`); override with
  `AI_AGENT_SHUTDOWN_DRAIN_MS` ([running.md](running.md#daemon-management)).
- **No Discord** — what needs a person is a label and a comment on the GitHub issue,
  which also moves its Paperclip card when the board is on; everything else is the
  daemon log ([config-guide.md](config-guide.md#discord-notifications)).

## Lanes: stages run side by side

The stages do not wait on each other. They are grouped into **lanes**, and every
(repo, lane) pair runs its own loop at `pollIntervalMs`: one item per repo per lane at
a time, every lane of a repo side by side, every repo at once. Two lanes join stages
that must stay in order: **build** = revise then implement, and **release** = promote
then release. The rest are a lane each. So a 30-minute build on a repo does not hold
that repo's release, verify or review. Stages that change the repo's working clone
(reconcile, revise, implement, custom stages) take turns on a per-repo checkout lock;
review works in its own clone, and the others only call GitHub or hand off to the
Tech Lead and SRE, so they never wait on a build. Work moves between lanes by label,
so one lane picks up what another just finished on its next pass.

`maxConcurrentSessions` (default 0, no ceiling) caps how many session stages run at
once across the fleet, for a host that cannot carry every busy lane's session at once
([configuration.md](configuration.md#maxconcurrentsessions)).

Code: `src/lanes.ts`, `src/orchestrator.ts`, `src/daemon.ts`.

## Pipeline stages (`stages`)

`stages` sets which stages a repo pass runs and in what order. Omitted, it is the
built-ins in the order above (verify only with `srePath`; release only with both
`srePath` and `techLeadPath`, otherwise skipped with a startup warning):

```json
{ "stages": [
  { "type": "reconcile" }, { "type": "review" }, { "type": "verify" }, { "type": "promote" },
  { "type": "release" }, { "type": "revise" }, { "type": "implement" }, { "type": "branch-sync" },
  { "type": "dependabot" }, { "type": "unstick" }, { "type": "skill-deliver" }
] }
```

`skill-deliver` runs only on `syncOnly` (human-lane) repos, which run nothing else ([skill-sync.md](skill-sync.md#human-lane-sync-only-repos)).
Leave a built-in out and it never runs. Order matters only inside a lane: revise
runs before implement in the build lane, promote before release in the release lane
(so release acts on the PR promote just opened or updated), and a custom stage runs
in front of the built-in after it. Across lanes, order sets nothing — each lane polls
on its own. Lanes are listed in the order their first stage appears; the daemon logs
them at startup (`lanes`), and every log line from a pass carries `lane=`.
Each stage may appear once. A `reviewEnabled` repo needs `techLeadPath` only when
`review` is in `stages`. An explicit `release` needs both `srePath` and `techLeadPath`;
the config is refused at startup otherwise.

## Custom stages

A custom stage is `{ "id": "<name>", "skillPath": "<SKILL.md>" }`. It is kept
deliberately small:

- **When it runs.** When the pass reaches it and the repo has an open
  Foreman-owned PR (a `foreman/…` head, or the legacy shared head) into `baseBranch`. No open PR: no session, and the pass continues.
- **What it gets.** One Claude session per repo, in the managed repo, under
  `FOREMAN_GITHUB_TOKEN`, with the implement session's model, tools, MCP config
  and budget. The prompt names the skill, the PR, its head and the issues it
  implements; the same facts arrive as env — `FOREMAN_STAGE_ID`,
  `FOREMAN_STAGE_REPO`, `FOREMAN_STAGE_BASE_BRANCH`, `FOREMAN_STAGE_FEATURE_BRANCH`,
  `FOREMAN_STAGE_PR`, `FOREMAN_STAGE_ISSUES` (JSON array), `FOREMAN_STAGE_HEAD_SHA` —
  next to `FOREMAN_TRIGGER_LABEL` / `FOREMAN_LIFECYCLE_LABELS`. A relative
  `skillPath` resolves against the repo. Anything the stage should change
  (comments, labels) its skill does; the Foreman does nothing with the work items.
- **What its outcome means.** The session ends with `FOREMAN_STAGE pass` or
  `FOREMAN_STAGE blocked reason="…"`. `pass` lets the rest of its lane run.
  `blocked`, or a run with no verdict line (timed out, crashed, forgot), stops the
  rest of **its lane** for that repo — other lanes carry on. The verdict holds until
  the feature branch head moves, so the same code is not re-checked every poll; a
  restart re-runs it once. A run refused by an upstream limit gives no verdict and
  is retried next pass, with the rest of its lane held meanwhile.
- **Which lane it joins.** The lane of the built-in listed right after it, so it
  gates exactly that stage. With nothing after it, it is a lane of its own, named
  by its `id`. It takes the repo's checkout lock: its session runs in the clone.

A blocking stage belongs **after** `revise` and `implement` and **in front of** the
stage it gates: a fix pushed by revise is what moves the head and re-runs the check.
In the example it sits in front of `promote`, so it joins the release lane and a
blocked scan holds promotion and release — builds, review and branch sync go on.
(Before lanes, a custom stage held every stage after it; a config that relied on that
must now put the gate in front of the stage it means to hold.)

```json
{ "stages": [
  { "type": "reconcile" }, { "type": "review" }, { "type": "revise" }, { "type": "implement" },
  { "id": "security", "skillPath": ".claude/skills/security-scan/SKILL.md" },
  { "type": "promote" }, { "type": "branch-sync" }, { "type": "dependabot" }
] }
```

Code: `src/stages.ts`, `src/phases/custom.ts`.
