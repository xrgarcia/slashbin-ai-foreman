# EM coordination map

What the Engineering Manager must do, and must not do, at every state the Foreman can put
work in. Read it before acting on any Foreman card, label or hold. It is written from the
source (`src/`), not from the other docs; where they disagree, this file and the code win.

`test/em-coordination-map.test.mjs` fails when the Foreman gains a stage, lifecycle stage,
hold code, unstick kind or deploy stop this file does not name. Adding one means adding its
row here.

**The EM's whole input surface is seven things:** `approved` on an issue · a spec that clears
`## Pre-Flight` and `## Acceptance` · `ready for prod release` on each dev-verified issue ·
a PR comment opening `**EM scope ruling` · a PR comment opening `**EM QA re-run` · an issue
edit or a lifted `blocked` label · a new corrective issue. Everything else the Foreman, Tech Lead and SRE do by themselves. If the
action you are about to take is not one of these seven, you are doing someone else's stage.

Dependency-batch issues (Dependabot version and security updates) on a `dependencyPreApproved` repo are **filed by the Foreman
with both `approved` and `deliver-to-prod`** (Ray, 2026-11-06: standing production grant for dependency upgrades and security
patches). The release gate therefore finds the grant on the issue itself (check 0 passes); you still run checks 1-6 and sign
`ready for prod release` per issue, and the SRE verifies dev and prod. A batch on a repo that is not pre-approved is filed bare.
The Foreman only files with the label; it never decides a release.

`deliver-to-prod` on an epic is **not** an input the Foreman acts on: it never decides a release
from it. The Foreman knows nothing about where a grant lives: at the `release-gate` (§3) it asks the EM
(`em.mjs grant-state`) and carries the answer in the reason, so a grant that landed calls the EM again. The gate itself is the EM's (the deliver-to-prod skill) for applying
`ready for prod release`.

## 1. Lifecycle stages (GitHub labels; the Paperclip card when that plugin is on)

Every stage in `STAGES` (`src/lifecycle.ts`). "Wait" means the Foreman moves it on its own
poll (every 5 minutes); touching it cancels or duplicates a stage.

| Stage | Label | Foreman does by itself | EM input |
|---|---|---|---|
| `approved` | `approved` | builds on its next cycle, once Pre-Flight readiness, `## Acceptance` and every blocked-by issue is merged to the base branch or closed (a blocker at `pr merged`, `pr approved`, `ready for prod release`, `release pending`, `prod verification held` or `ready to close` counts; open and unmerged does not); one feature PR in flight per repo, and with `buildWaitsForDevVerify` the next build waits until the last merge is dev-verified | none — wait. To hold a dependent until its blocker is **closed** (not merely merged), put `issue_closed: owner/repo#N` in a ```` ```readiness ```` fence under `## Pre-Flight` (one fence per issue; `src/github/readiness.ts`) — a blocked-by link alone releases it at merge. A spec it refuses gets one comment per reason: fix the body |
| `implementing` | — | implement session opens a PR | none — wait |
| `inReview` | `pr under review` | starts the Tech Lead review | none — wait |
| `reviewing` | `pr under review` | Tech Lead review running | none — wait |
| `changesRequested` | `pr pending actions` | revise session addresses it | none — wait |
| `revising` | `pr pending actions` | pushes a revision, back to review | none — wait |
| `merged` | `pr merged` | starts SRE dev verification | none — wait |
| `verifying` | `pr merged` | SRE dev verification (and visual QA on QA repos) running | none — wait |
| `qaReviewing` | `pr merged` | QA running visual and behaviour checks. `qaBeforeMerge` on: locally on the Tech Lead-approved, unmerged PR (PASS merges it, FAIL goes back to the builder, HELD holds it unmerged). `qaGate` on: on dev after the SRE passed; pass advances, FAIL/HELD holds | none — wait |
| `pendingVerification` | `pr approved` | posts "Waiting on EM verification" hourly if develop is ahead and nothing is authorized; unstick raises `release-gate`; a `**EM QA re-run` comment on its merged PR, newer than every QA Report, moves it back to `pr merged` (move `qaRerun`) | **yours:** run the release gate (`/deliver-to-prod` 3a) and apply `ready for prod release`. Nothing reaches production until you do. Its QA evidence is void or stale → post a PR comment opening `**EM QA re-run` on the merged PR, never run `check` yourself |
| `releaseAuthorized` | `ready for prod release` | puts it in the release PR on the next promote pass, moves it to `release pending` | none — wait |
| `awaitingRelease` | — | nothing: the release PR is not one the release stage owns | **yours:** get that PR merged or close it |
| `releasing` | `release pending` | Tech Lead approves the release PR, SRE merges, deploys, prod-verifies, soaks, closes the issue | none — wait. A failing EM sign-off status moves the card to `awaitingSignoff` |
| `awaitingSignoff` | `release pending` (card Blocked on the EM) while the release PR's `foreman/em-sign-off` status fails | nothing: the Tech Lead's approval and the SRE's deploy wait for the sign-off; the card returns to `releasing` when the status turns green | **yours:** the card names the unsigned issues of the release (or the release PR when none is listed), run the release gate (`/deliver-to-prod` 3a) for each and apply `ready for prod release`, or take it out of the release |
| `prodVerifyHeld` | `prod verification held` | re-verifies on 10 min → 6 h back-off, uncapped; re-checks at once when production's head moves | **sort it:** read the newest prod-verification comment. A wait needs nothing. A check that cannot observe the outcome → file the verifier defect. Production broken → file a corrective issue. Never re-verify by hand |
| `needsRuling` | — | paused; the card stays Blocked on the EM, through a later "changes requested" update and a restart, until the ruling's revise starts | **yours:** `/rule-on-scope <repo> <pr>` and a PR comment opening `**EM scope ruling`; or, for a skip that spent its attempts, change the issue |
| `blocked` | `blocked` | paused: no build, and no review, QA-before-merge or revise of its open PR (foreman#167); the unstick stage calls the EM plugin (§3). The card's block (reason, holder, stage) survives a restart; a block a person or a seat's escalation put on the card is never undone while the issue stays at that stage | read the reason, fix what it names, then lift `blocked` or edit the issue — **on the issue, never the board** |

**QA before the merge (`qaBeforeMerge`, default off, EM#923).** For a `qaRepos` repo with the flag on, the order is review, QA, then SRE: the Tech Lead approves without merging (trailer `merged=no hold=qa-pending`, not a failure), QA runs `check --local` on that head (it boots the PR itself; it gets only the registry bearer), and only a PASS has the Tech Lead merge before the SRE's dev verify. The merge is `review-pr --merge-approved <the full sha QA passed>`: merge only, never a new judgment. Trailer `hold=head-moved` (the PR head changed after QA) means no merge, nothing charged, and the card goes back to review for the new head; `hold=not-approved` is a charged hold. Only a consistent result is remembered (PASS with exit 0, FAIL with exit 1, marker keyed by the full head sha); an inconsistent one posts `verdict=INCONSISTENT`, holds on every retry, and is not a review round. The card stays `inReview` and shows `qaReviewing` while QA runs. A QA FAIL moves it to `changesRequested`, counts as a review round toward the review-rounds alert (a FAIL that stands on an unmoved head posts a `foreman-qa-fail-stands` comment, so each send-back is a round), and the revise session is handed QA's failing lines; the SRE never sees it. **A FAIL that was QA's own defect (a QA fix has since merged) is cleared by a PR comment opening `**EM QA re-run` on the open PR:** when it is newer than the latest QA Report for that head, the next QA pass voids the reused verdict for that sha and runs `check --local` again instead of reusing the marker. It is spent by the fresh report it produces (so it runs once per comment; a later FAIL on the same sha stands again until you post another), and it is not a review round. **It works from `pr pending actions` too** (where the FAIL left the card, owned by the revise phase): before any revise gate or session, the revise phase sees the comment (newer than every QA Report for the current head), sends the card back to review (move `qaRerunRevise`, `changesRequested` → `inReview`), clears the no-commit streak and launches nothing; the next review/QA pass then runs `check --local`. Without it, an unmoved head keeps posting `foreman-qa-fail-stands` every round. The same comment on a merged PR is the post-merge re-run (`pendingVerification` → `qaRerun`). Holds `qa-held-qa-local-boot-failed` and `qa-held-qa-local-seed-missing` (owner QA / Console), `qa-held-worker-data-unavailable`, `qa-held-attribution-unavailable` and `qa-errored` are tooling holds: deferred, nothing charged, nothing merged. Flag off or repo QA does not cover: unchanged.

**QA coverage (EM#794 C, slashbin-ai-foreman#242).** A repo is covered when it is in `qaRepos` (the override: covered even when QA says no, no spawn) or when `bin/qa.mjs covers --repo R` exits 0, run through `qaSecretsRunner` with the registry bearer (`EM_SLASHBIN_MCP_ROUTER_BEARER`, else `SLASHBIN_MCP_ROUTER_BEARER`). Exit 1, an unset runner or a QA without `covers` is not covered. QA output `registry-unavailable`, or a timeout, is unknown: review of that repo waits, and a verify pass holds as `qa-coverage-unknown`, a tooling hold that charges nothing. Answers are cached per repo for `pollIntervalMs`.

**A void PASS is not a verdict (slashbin-ai-foreman#158).** A QA PASS with `Shots: 0` on a PR that changed `client/` code or a whole-app build input (`vite.config.*`, `package.json`, a lockfile, `tsconfig*.json`, `index.html`, …; the QA agent's `BUILD_INPUT` set) checked nothing. Before the merge it holds as `qa-held-page-unplaced` (charged), and a reused PASS marker of that kind is run again. After the merge, the verify stage runs the QA gate on dev, even with `qaBeforeMerge` on, whenever the PR has no real PASS newer than the EM's last `**EM QA re-run` request: a FAIL is `visual-qa-failed` and goes to `rework-decision` like any other.

Variant: **`deployFailed`** (a `blocked` card whose dev deploy failed) is the SRE's, not the
EM's: route it to the SRE, then release the hold.

Variant: **`verifyScheduled`** (a `merged` card whose dev verification the SRE held until a time, or could not run) is a scheduled wait, not a failure: the comment reads "Dev verification scheduled — PR #N resumes <Central time>" and nothing is needed from the card; the Foreman retries then.

**The card follows GitHub on its own (EM#1150 feature 6).** Each pass, the Foreman's mirror
places every card from GitHub: the column and the holder the stage calls for (a hand-off lost
to a Paperclip outage is re-made next pass), a card for any lifecycle issue that has none,
created at its stage, and done or cancelled, with no agent or person on it, for every card whose
issue is closed or released. A closed issue's card is terminal: no late or deferred stage update
moves it or assigns anyone, until GitHub reads the issue open again. A hold a person or a seat
put on the card after the last pass is read live before any stage move, a deferred one included,
so it is kept (a seat escalating during its own run stays Blocked), and a
ruling block a Paperclip outage lost is re-delivered on the next pass. Never fix a card by hand
that the next pass would place: fix the issue.

**Human-lane repos (`syncOnly`, stage `skill-deliver`).** Not a lifecycle stage: no card, label or PR. For each open
`approved-for-human` issue in a `syncOnly` repo the Foreman pushes the current golden skills as one commit on
`feature/<N>-<slug>` cut from `origin/<base>` (never when the base is current; an existing `feature/<N>-*` is left alone unless every commit on it is the Foreman's own delivery commit and no PR exists, then it is rebuilt on the current base), so the
person's direct-mode session resumes it. EM input: none. Adding a human-lane repo to the Foreman means a `syncOnly`
entry in `.ai-agent.json`, never an implement/review lane (`docs/skill-sync.md`).

## 2. Holds by code

A dev-verification hold is planned by `verifyHoldPlan` (`src/phases/verify.ts`) into one of
four kinds. **Charged** holds spend one of 3 attempts on `backoff.verifyRetry`: the retries
come at 10 minutes, then 20, then the issue goes `blocked` (verify-exhausted).

| Code | Kind | Foreman does by itself | EM input |
|---|---|---|---|
| `codex-unavailable`, `em-mirror-unavailable`, `registry-unavailable`, `tooling-unavailable`, `evidence-check-failed`, `no-evidence-comment`, `qa-errored`, `qa-coverage-unknown`, `qa-held-qa-local-boot-failed`, `qa-held-qa-local-seed-missing`, `qa-held-worker-data-unavailable`, `qa-held-attribution-unavailable`, `qa-held-dev-unreachable`, `qa-held-sign-in-failed`, `qa-held-review-unavailable`, `qa-held-pr-unreadable`, `qa-held-baseline-unreadable`, `qa-held-registry-unavailable` | defer (tooling) | retries on `backoff.agentUnavailable` (2 → 30 min), no attempt charged, silent | none — wait. Persisting for hours is a tooling defect: file it on the SRE or Foreman |
| `github-unavailable` (Tech Lead exit 3), or a Tech Lead exit 1 whose stderr is a transient GitHub transport error (TLS handshake timeout, ECONNRESET, ENOTFOUND, `dial tcp`, 502/503/504) | defer (tooling) | the review is retried on `backoff.agentUnavailable`, no failure charged, the card is **not** moved to Blocked, silent (foreman#180). Auth, 404, 422 and rate-limit errors are never treated this way | none — wait. Persisting for hours is a tooling defect: file it on the Foreman |
| `wait-until-YYYYMMDDTHHMMZ` | wait | retries at that time, no charge | none — wait |
| `visual-qa-failed` | decide | **files nothing and builds nothing.** Holds at its cap at once (retrying unchanged code cannot pass) and raises the unstick kind `rework-decision` in the same cycle, with the PR, the files it touched, the verdict and the evidence links (Ray, 2026-10-31; Slashbin-console#1538: an automatic rework changed `JourneyBar.tsx` while the cause was in `DashboardLayout.tsx`, and the release queue was held ~24h) | **yours — decide the fix, on the first FAIL.** Read the evidence, find the component that owns the defect (it may lie outside the PR's files), and file the corrective **linked to #N** (below) or edit the spec. The follow-up merging into base (`baseAdvanced`) or a spec edit (`specEdited`) releases the hold and re-verifies |
| every other `qa-held-*` (`unsafe-host`, `browser-crashed`, `nothing-captured`, `page-unplaced`), `qa-inconsistent` | charged | 10 min, 20 min, then `blocked` | after exhaustion: read the QA report, fix the spec or file the defect |
| `dev-verify-failed`, `deploy=…` | charged | blocked with owner SRE (`deployFailed`) | route to the SRE |
| `acceptance-not-verified` and every other code | charged | 10 min, 20 min, then `blocked`; the retries keep running, but the first failure also raises `rework-decision` (§3) | **yours — decide the fix, on the first failure; do not wait out the attempts.** Read the evidence and the touched files: edit the spec (`specEdited` releases it at once) or file the fix linked to the held issue (below). `baseAdvanced` does **not** release this one. Deploy failures (`dev-verify-failed`, `deploy=…`) and runs that returned no verdict raise nothing early; they stay with the SRE and `verify-exhausted` |

**A fix for a held verification jumps the queue only when it is linked to the issue it corrects.**
The Foreman knows one relation, *corrects* (`Relation`, `src/adapters.ts`): issue F corrects
issue N. While N's dev verification holds the repo, F builds at once, alone, ahead of the
queue (`correctionsToBuild`, `src/phases/verify.ts`). GitHub records the relation three ways,
read only by the GitHub plugin (`relationsOf`, `src/github/corrections.ts`): mark **N blocked
by F** (the exact link: N's verification does wait on F), make F a **sub-issue of N**, or end
F's title `— follow-up to #N` (optional; kept so everything already filed keeps working). The
core never reads a title. A corrective the EM files for an unmet outcome must carry a link;
without one, the fix queues behind the very verification it is meant to clear.

The Foreman never guesses the link. When nothing corrects N and an approved issue's body
mentions N (`#N`, `repo#N` or `owner/repo#N`, e.g. in `## References`), that issue stays
queued, the Foreman raises the unstick kind `unlinked-fix` once for it and N (§3), and posts
one comment on it: "This looks like the fix for #N; mark #N as blocked by this issue, or make
this a sub-issue of #N, or it queues behind #N." It moves no card and is not a block. Add the
link and the next pass builds the fix first.

**An orphan feature PR the Tech Lead asked changes of** (foreman#135). A feature PR that names no issue (a commit a person
pushed straight to the base branch, which the reconciler turned into a PR) holds the build queue, and no stage revises it: revise is
issue-driven. While it is under review the Tech Lead decides it and the queued issues wait. Once its current review verdict is
CHANGES_REQUESTED, the Foreman holds each queued issue Blocked (escalated at `approved`, so a lost first write is re-delivered) with the PR, its author and the verdict, once per head, and hands it to
you as the unstick kind `needs-ruling` (no new kind). Fix the PR by hand, close it, or rule on it: closing or merging it, or a new
head, lifts the block and the queue builds.

Blocks the build and release stages raise (`BlockKind`, `src/unblock.ts`; each releases
itself when its check turns true):

| Kind | Cause | Releases itself on | EM input |
|---|---|---|---|
| `skip` | the implementer declined (3 attempts) | `transientCauseGone`, `waitedOnDone`, `issueChanged` | change the issue so it can be built |
| `divergence` | retired (foreman#208): no shared branch to diverge; kept in the list so old records still read | none | none |
| `verify-no-pr` | `pr merged` with no merged PR closing the issue | `mergedPrFound` | link the PR or fix the label history |
| `verify-held` | dev verification failed, waiting out back-off | `specEdited` | none — wait |
| `verify-exhausted` | dev verification spent its attempts | `specEdited`, `baseAdvanced`, `holdNoLongerCharged`, and for a deploy failure (`dev-verify-failed`, `deploy=…`) `srePassedSince` (the SRE's newer PASS evidence for the merge: `pr approved` with no new run) and `deployRepaired` (a newer SUCCESS dev deployment on the merge SHA, or any status newer than the hold in the dev deployment's history showing a redeploy began (Railway reuses one GitHub deployment per SHA and can leave a stale `failure` as the newest status, SLA-4625): re-verifies, forcing the SRE, which reads Railway, to decide) | edit the spec or land the fix; a repaired environment needs nothing |
| `revision-exhausted` | revise failed twice | `prHeadMoved` | rule on scope or file the fix |
| `revision-stalemate` | revise made no commit twice on the same PR head (kept across restarts and idle passes; cleared by a push, the PR closing, or an `**EM scope ruling` PR comment newer than the last no-commit round, which buys one more revise) | `prHeadMoved`, `rulingPosted` | rule on scope |

Release-stage stops (`DEPLOY_STOPS`, `src/phases/release.ts`): **`predeploy-stop`,
`merge-refused-repeatedly`, `merge-blocked-check`** each label the release's issues
`blocked`. Read the SRE's reason, get it fixed, lift `blocked`. Every other deploy hold is
retried on `backoff.releaseRetry` (5 min → 2 h) — wait.

Build-side refusals (no card move; one comment each): a missing or invalid `## Acceptance`,
an unmet Pre-Flight readiness fence, an unmerged blocked-by link (silent), a dead blocker
(closed with no PR: dependents are blocked and the EM is told). Each needs the spec or the
blocker fixed, then nothing — the next poll picks it up.

## 3. Unstick: when the Foreman calls the EM

The `unstick` stage asks the EM plugin (`src/plugins/em.ts`, which runs `bin/em.mjs unstick`) about each stuck item, by kind (`UNSTICK_KINDS`,
`src/unstick.ts`): `skip`, `divergence`, `verify-held`, `verify-exhausted`, `verify-no-pr`,
`revision-exhausted`, `revision-stalemate`, `needs-ruling`, `dead-zone`, `deploy-failed`,
`release-gate`, `rework-decision`, `unrelated-error`, `epic-ready-to-close`, `dependency-batch-loop`, `unlinked-fix`. Verify holds become candidates only after their attempts are spent,
except `rework-decision`: the first visual QA FAIL, or the first charged verification failure that returned a
verdict, is called in the same cycle, with the PR, the files it touched, the verdict and the evidence links in
the reason. It is one call per failure (a retry that fails the same way keeps the first evidence); a charged
hold hands over to `verify-exhausted` when its retries run out. The Foreman never decides the fix itself.
`release-gate` fires on any open `pr approved` issue without `ready for prod release`. Its reason carries the issue's labels and the `deliver-to-prod` state of the issue, the epics its `## References` name, its sub-issue parent and its follow-up origin, so a grant that lands on any of them while it waits is a new question and calls the EM again at once (the Foreman does not decide the release; an unreadable place keeps the last reason); never schedule a re-check for a grant.
`unrelated-error` fires when a dev verification, a prod verification or the first prod deploy prints `Not caused by
this release, needs triage:` (the SRE passed the release and excluded the error). The reason carries the signature,
the repo and PR it was first seen on, and the SRE's evidence links. It is repo-level (issue 0), once per distinct signature
(numbers and long hex folded), never again for that signature from any PR, and it never holds the release.
The EM routes it to the owner: an issue on the owning repo, or an SRE change request for a credential or infra
fault (2026-10-31: an expired dev Stripe key was excluded for 8 days with no owner, SRE#369).
`epic-ready-to-close` fires when the release stage closes an issue after its production verification and that issue
names an epic (`<epicRefLabel> #N` in its body, `engineering-manager #N` in the `slashbin` profile; unset, this kind never fires; or in the body of the issue the issue it corrects names).
It is repo-level (issue 0), once per epic and closed issue, and never holds the release. The EM runs its READY TO
CLOSE check for the epic and closes it only if every child is done: closing is the hand-off to the PO, and nothing
else makes it (foreman#151).
`unlinked-fix` fires when a held dev verification #N holds the repo's queue, nothing corrects #N, and an approved
issue's body mentions #N (§2). Its subject is that issue, once per issue and #N (`dedupeKey` #N), standing until the
issue closes. The EM confirms it is the fix and adds the link (#N blocked by it, or it a sub-issue of #N), or rules it
is not and writes nothing.
`dependency-batch-loop` fires when the dependency sweep has filed the same batch (the same Dependabot PRs at the same head
commits) 3 times in 24 hours. The sweep then **holds that batch**: it files nothing more for those PRs and raises this kind once,
repo-level (issue 0). Each of those issues ended with no PR of its own (`landed`), so a Dependabot PR is almost certainly open
after its version reached the base branch and the Foreman's close of it failed (foreman#230: jerky-mcp-services #627, 397
sessions). The EM finds out why, closes or fixes the PR(s); a new Dependabot push is a new batch and is filed once. Never
file the batch by hand. A `landed` batch issue closes its Dependabot PRs itself (a comment naming why) and records the batch
as `landed`, after which the sweep never files that batch again.
`dead-zone` is an issue in a state reconcile cannot recover; a reviewer-declared hold is
never auto-recovered and goes to the EM as a message.

**How alerts reach the EM.** Every sender (release, verify, promote, the dependency sweep) hands the
outbox one typed `Alert` (`kind`, `subject`, `dedupeKey`, `reason`) through `EmHandoffs.raise`
(`src/unstick.ts`); there is no per-kind write path. The unstick stage delivers it. One rule re-arms
every kind in `nextStep`: a `failed` entry whose 3 attempts are spent is called again after an hour
(`SPENT_QUESTION_REARM_MS`) one call each time, the wait doubling (1 h, 2 h, 4 h, up to 24 h; `SPENT_QUESTION_REARM`), never a fresh burst of 3; the first burst running out gives one give-up notice. Delivered entries (`invoked`, `escalated`,
`declined`) are never re-armed this way.

**Kind contract.** At startup the Foreman runs `bin/em.mjs kinds --json` and compares it with
`UNSTICK_KINDS`; a kind the EM does not publish is logged as an error. If the EM rejects a kind
(`unknown kind '<kind>'; nothing written`, exit 3), the entry is recorded `failed`, not `declined`,
so it is retried once the EM is fixed. Any other exit 3 stays `declined`.

After 3 failed calls (`UNSTICK_MAX_ATTEMPTS`) the Foreman posts a give-up comment
@-mentioning `unstickEscalationOwner` (Ray, in the `slashbin` profile; unset, the give-up is only
logged). **That comment means the EM failed its stage** — a give-up is never the first Ray hears
of a stuck card.

**An `invoked` answer on an issue is a handoff, not a resolution** (a repo-level alert, issue 0, has no issue to watch: once the EM took it, it is delivered and never recalled). If the question still stands, the Foreman
calls `unstick` again after `backoff.handoff` (10 min, 30 min, 90 min), then posts a second kind of
give-up — "the EM took this hold but nothing moved" — @ the same owner, about 7 h after the first
call. So on a re-call, check whether the seat you handed to is still alive before handing again: a
seat that ran out of tokens leaves a blocked card and nothing else (SLA-3693, 2026-11-05).

**A refusal is not a failure.** When `em.mjs unstick`'s output ends in the runner's limit message
(out of tokens, rate-limited; the patterns are the Foreman's `runner` config), the outcome is
`refused`: no attempt is spent, the pass stops calling, and the call is made again once the stated
reset (or the upstream back-off window) has passed.

## 4. Release: how work reaches production

- **No timer.** Promote opens or updates the release PR on every poll when an issue is
  `ready for prod release` (or carried) and the base branch differs from production.
- **A release ships all of develop.** Every merged issue on develop that production lacks is
  carried into the release PR as *listed, not signed*.
- **The EM signs each listed issue.** While any listed issue lacks `ready for prod release`,
  the PR shows a failing EM sign-off status and the Tech Lead and SRE do nothing. The
  release waits on the EM, silently, until every carried issue is labelled.
- Then the Tech Lead approves, the SRE merges and deploys. **The Foreman never merges.**
- Prod verification follows; a pass closes the issue and schedules a soak re-verify 30
  minutes later. A hold is `prodVerifyHeld` (§1).
  A hold the soak raised (`soak:<slug>`) is re-verified by a fresh soak (`--mode soak --recheck`),
  never by prod verification: only a soak pass closes it. A soak NOT VERIFIED for a `tooling-gap`
  with no regression passes, the gap named in the close comment.
  A held release waits out its back-off, but a follow-up (a release whose issues correct the held
  one's) that passes its soak re-arms it: re-verified 10 minutes later, attempts reset. The
  head-moved probe waits one soak window (30 minutes) with attempts reset. A re-verify that holds
  for the same slug comments `Re-verified, still held`.

## 5. Self-healing limits (when "wait" stops being the answer)

| Loop | Limit, then |
|---|---|
| visual-QA FAIL | no loop: held at once, the EM decides (`rework-decision`) |
| dev-verify retries | 10 min, 20 min, then `blocked` |
| revise | 2 failures → `revision-exhausted`; 3 review rounds → `needsRuling` |
| skip hold | 3 attempts → `blocked` |
| tooling defer / prod-verify / release retries | uncapped back-offs |
| QA run | 90 minutes, then `qa-errored` (free retry) |
| unstick calls | 3, then the give-up comment to Ray |

A card past its limit is the EM's. A card inside its limit is not: wait for the loop.
