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

The Foreman runs these stages on every configured repo. Omitted, `stages` is the ten
built-ins in this order (`src/stages.ts`):

```
Reconcile → Review → Verify → Promote → Release → Revise → Implement → Branch Sync → Dependabot → Unstick
```

1. **Reconcile** — finds commits on the feature branch that no PR carries (orphaned
   work) and opens a PR for them. The PR titles are `github.reconcileTitle` /
   `github.reconcileBatchTitle` ([configuration.md](configuration.md#github-conventions-github)).
2. **Review** *(opt-in)* — when `reviewEnabled` is set, hands each open feature PR
   awaiting review to the **Tech Lead** (`techLeadPath`), which reviews under its own
   GitHub token and owns its own merge and label decisions. Its label side effects
   (approve → `pr approved`; request changes → `pr pending actions`) feed the Promote
   and Revise stages, and the Foreman reconciles the outcome label from the run's
   trailer if the reviewer merged without setting it. Off by default — see
   [review.md](review.md).
3. **Verify** *(on when `srePath` is set)* — once review has merged a PR (issue at
   `pr merged`), the SRE (`bin/sre.mjs verify`) checks the merged work in the dev
   environment and moves its issues to `pr approved`. A failed verification is retried
   on the `backoff.verifyRetry` schedule (3 attempts by default, then it waits on a
   person). Unset, there is no verify stage and the review run verifies and labels as
   before. With `buildWaitsForDevVerify` (default on) a repo's next build waits until
   its last merge has passed dev verification, so one issue is in flight per repo from
   build to verified on dev.
   **QA report (report-only, on when `qaPath` is set):** after a pass on a `qaRepos` repo
   (the Console), the Foreman runs `qa.mjs check` once for that PR, in the background, and
   posts `## QA Report (report-only)` on it. Nothing waits on it and it never holds or
   reworks the card; a crash or a 10-minute timeout becomes an "errored" comment. Once per
   PR: an existing comment with the heading ends it. `DEV_SESSION_MINT_KEY` reaches only
   the QA child, through the EM checkout's `doppler-run.mjs` (needs `emRepoPath`).
   **With `qaGate: true`** QA runs *before* the advance: PASS advances; FAIL (a regression,
   or a defect with no baseline) takes the visual-QA rework path (`hold=visual-qa-failed`,
   the rework issue carrying QA's regression lines and shot names); HELD, a crash or a
   timeout holds the card as `qa-*` (stays `pr merged`, Blocked, retried on
   `backoff.verifyRetry`). The comment is `## QA Report`, keyed by head SHA and verdict so
   a re-run after a restart does not double-post. Default false = the report-only step above.
4. **Promote** — opens or updates the promotion PR (base branch → production branch,
   `develop` → `main` by default) for issues labeled `ready for prod release`, moving
   them to `release pending`. `ready for prod release` is the one lifecycle label a
   person writes: it is the authorization to go to production.
5. **Release** *(on when both `srePath` and `techLeadPath` are set)* — no Claude
   session. The Tech Lead approves the promotion PR at its head, the SRE merges, deploys
   and verifies it in production, the Foreman tags the merge commit (an annotated tag,
   never a GitHub Release; name from `github.releaseTagFormat`) and closes each issue on
   a passed prod verification, or labels it `prod verification held` and re-verifies on
   the `backoff.prodVerifyRetry` schedule. It also adopts promotion PRs merged by anyone
   else in the last 48 hours. Full flow: [lifecycle.md](lifecycle.md#the-release-stage).
   One deploy may run up to `sreDeployMaxDurationMs` (2 h by default).
6. **Revise** — finds PRs with pending review feedback (`pr pending actions`) and
   revises them, ahead of new work. A PR that keeps being sent back is held for a
   person's scope ruling instead of being revised forever (`needsRuling` in
   [lifecycle.md](lifecycle.md#stages)).
7. **Implement** — picks up approved issues and runs the repo's implementation skill
   through Claude Code. The Foreman picks the issues before the session — priority tier
   (`github.priorityLabels`), then oldest — and hands it `buildBatchSize` of them
   (default 1). Issues the session declined on purpose are backed off
   (`backoff.skip`). See [skills.md](skills.md) for what the session is told.
8. **Branch Sync** — merges the production branch back into the base branch
   (`main` → `develop`) through a sync PR, to keep them aligned after promotions. The
   sync PR is merged under `TECHLEAD_GITHUB_KEY`; without it, the PR opens but does not
   merge.
9. **Dependabot** — files one issue covering the open Dependabot **security** PRs on the working
   branches, so the updates go through the implement session like any other work. A PR is a
   security update iff a package it bumps has an open Dependabot alert on the repo (grouped PRs: the
   packages are read from the title and body; unreadable means non-security). Other version-update
   PRs are left alone — not batched, merged or closed. If the alerts API cannot be read (404 when
   alerts are disabled, a network error) the cycle batches nothing. `dependabot.securityOnly: false`
   restores batching every Dependabot PR. It is
   filed with the trigger label when the repo sets `dependencyPreApproved` (the owner's standing authorization, 2026-10-24,
   covers every Foreman-managed repo for slashbin.io, jerky.com and cmneb; the flag stays
   opt-in per repo and default off, so a newly onboarded repo needs a deliberate edit). Renovate
   instead of Dependabot: `github.dependencyBranchPrefixes: ["renovate/"]`.
10. **Unstick** *(on when `emRepoPath` is set; independent of `paperclip.enabled`)* — no
    Claude session. For each stuck issue it runs `node <emRepoPath>/bin/em.mjs unstick
    --repo <owner/name> --issue <N> --kind <kind> --reason <text>` (cwd `emRepoPath`,
    `EM_GITHUB_TOKEN`, killed after 20 minutes). Kinds: skip, divergence, verify-held,
    verify-exhausted, verify-no-pr, revision-exhausted, revision-stalemate,
    needs-ruling, dead-zone, deploy-failed, release-gate (`src/unstick.ts`). A hold with
    retries left is not called for. Divergence is repo-level, so it is called once per
    issue the Foreman announced it on, or with issue 0 when it announced none. Outcomes
    are kept in `RepoState.unstick`, keyed `<issue>:<kind>`: exit 0 `invoked`, 2
    `escalated` (no retry until the reason changes), 3 `declined`, anything else
    `failed` (retried to 3 attempts). The Foreman never clears a block on exit 0 and
    never writes Paperclip; the EM releases the hold on GitHub and the unblock checks
    see it. A comment opening `**EM unstick` does not count as the issue changing.

Other behaviour of the loop:

- **Poll interval is configurable** — default 5 minutes (`pollIntervalMs`).
- **Multi-repo** — one daemon manages many repos, each with its own skill paths and
  settings ([config-guide.md](config-guide.md#multi-repo-mode)).
- **Persists state across restarts** — in `.agent-state.json`; it picks up where it
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
  { "type": "dependabot" }
] }
```

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
  `featureBranch → baseBranch` PR. No open PR: no session, and the pass continues.
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
