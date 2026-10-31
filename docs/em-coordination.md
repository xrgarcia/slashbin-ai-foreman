# EM coordination map

What the Engineering Manager must do, and must not do, at every state the Foreman can put
work in. Read it before acting on any Foreman card, label or hold. It is written from the
source (`src/`), not from the other docs; where they disagree, this file and the code win.

`test/em-coordination-map.test.mjs` fails when the Foreman gains a stage, lifecycle stage,
hold code, unstick kind or deploy stop this file does not name. Adding one means adding its
row here.

**The EM's whole input surface is six things:** `approved` on an issue · a spec that clears
`## Pre-Flight` and `## Acceptance` · `ready for prod release` on each dev-verified issue ·
a PR comment opening `**EM scope ruling` · an issue edit or a lifted `blocked` label · a new
corrective issue. Everything else the Foreman, Tech Lead and SRE do by themselves. If the
action you are about to take is not one of these six, you are doing someone else's stage.

`deliver-to-prod` on an epic is **not** a Foreman input: `src/` never reads it. It is the
EM's own gate (the deliver-to-prod skill) for applying `ready for prod release`.

## 1. Lifecycle stages (the Paperclip card / GitHub labels)

Every stage in `STAGES` (`src/lifecycle.ts`). "Wait" means the Foreman moves it on its own
poll (every 5 minutes); touching it cancels or duplicates a stage.

| Stage | Label | Foreman does by itself | EM input |
|---|---|---|---|
| `approved` | `approved` | builds on its next cycle, once Pre-Flight readiness, `## Acceptance` and every blocked-by link clear; one feature PR in flight per repo, and with `buildWaitsForDevVerify` the next build waits until the last merge is dev-verified | none — wait. A spec it refuses gets one comment per reason: fix the body |
| `implementing` | — | implement session opens a PR | none — wait |
| `inReview` | `pr under review` | starts the Tech Lead review | none — wait |
| `reviewing` | `pr under review` | Tech Lead review running | none — wait |
| `changesRequested` | `pr pending actions` | revise session addresses it | none — wait |
| `revising` | `pr pending actions` | pushes a revision, back to review | none — wait |
| `merged` | `pr merged` | starts SRE dev verification | none — wait |
| `verifying` | `pr merged` | SRE dev verification (and visual QA on QA repos) running | none — wait |
| `qaReviewing` | `pr merged` | QA running visual and behaviour checks. `qaBeforeMerge` on: locally on the Tech Lead-approved, unmerged PR (PASS merges it, FAIL goes back to the builder, HELD holds it unmerged). `qaGate` on: on dev after the SRE passed; pass advances, FAIL/HELD holds | none — wait |
| `pendingVerification` | `pr approved` | posts "Waiting on EM verification" hourly if develop is ahead and nothing is authorized; unstick raises `release-gate` | **yours:** run the release gate (`/deliver-to-prod` 3a) and apply `ready for prod release`. Nothing reaches production until you do |
| `releaseAuthorized` | `ready for prod release` | puts it in the release PR on the next promote pass, moves it to `release pending` | none — wait |
| `awaitingRelease` | — | nothing: the release PR is not one the release stage owns | **yours:** get that PR merged or close it |
| `releasing` | `release pending` | Tech Lead approves the release PR, SRE merges, deploys, prod-verifies, soaks, closes the issue | none — wait. If the PR shows a failing EM sign-off status, an issue it carries lacks your label (§4) |
| `prodVerifyHeld` | `prod verification held` | re-verifies on 10 min → 6 h back-off, uncapped; re-checks at once when production's head moves | **sort it:** read the newest prod-verification comment. A wait needs nothing. A check that cannot observe the outcome → file the verifier defect. Production broken → file a corrective issue. Never re-verify by hand |
| `needsRuling` | — | paused | **yours:** `/rule-on-scope <repo> <pr>` and a PR comment opening `**EM scope ruling`; or, for a skip that spent its attempts, change the issue |
| `blocked` | `blocked` | paused; the unstick stage calls the EM wrapper (§3) | read the reason, fix what it names, then lift `blocked` or edit the issue — **on the issue, never the board** |

**QA before the merge (`qaBeforeMerge`, default off, EM#923).** For a `qaRepos` repo with the flag on, the order is review, QA, then SRE: the Tech Lead approves without merging (trailer `merged=no hold=qa-pending`, not a failure), QA runs `check --local` on that head (no secret, it boots the PR itself), and only a PASS has the Tech Lead merge before the SRE's dev verify. The merge is `review-pr --merge-approved <the full sha QA passed>`: merge only, never a new judgment. Trailer `hold=head-moved` (the PR head changed after QA) means no merge, nothing charged, and the card goes back to review for the new head; `hold=not-approved` is a charged hold. Only a consistent result is remembered (PASS with exit 0, FAIL with exit 1, marker keyed by the full head sha); an inconsistent one posts `verdict=INCONSISTENT`, holds on every retry, and is not a review round. The card stays `inReview` and shows `qaReviewing` while QA runs. A QA FAIL moves it to `changesRequested`, counts as a review round toward the review-rounds alert, and the revise session is handed QA's failing lines; the SRE never sees it. Holds `qa-held-qa-local-boot-failed` and `qa-held-qa-local-seed-missing` (owner QA / Console), `qa-held-worker-data-unavailable`, `qa-held-attribution-unavailable` and `qa-errored` are tooling holds: deferred, nothing charged, nothing merged. Flag off or repo outside `qaRepos`: unchanged.

Variant: **`deployFailed`** (a `blocked` card whose dev deploy failed) is the SRE's, not the
EM's: route it to the SRE, then release the hold.

## 2. Holds by code

A dev-verification hold is planned by `verifyHoldPlan` (`src/phases/verify.ts`) into one of
four kinds. **Charged** holds spend one of 3 attempts on `backoff.verifyRetry`: the retries
come at 10 minutes, then 20, then the issue goes `blocked` (verify-exhausted).

| Code | Kind | Foreman does by itself | EM input |
|---|---|---|---|
| `codex-unavailable`, `em-mirror-unavailable`, `registry-unavailable`, `tooling-unavailable`, `evidence-check-failed`, `no-evidence-comment`, `qa-errored`, `qa-held-qa-local-boot-failed`, `qa-held-qa-local-seed-missing`, `qa-held-worker-data-unavailable`, `qa-held-attribution-unavailable`, `qa-held-dev-unreachable`, `qa-held-sign-in-failed`, `qa-held-review-unavailable`, `qa-held-pr-unreadable`, `qa-held-baseline-unreadable` | defer (tooling) | retries on `backoff.agentUnavailable` (2 → 30 min), no attempt charged, silent | none — wait. Persisting for hours is a tooling defect: file it on the SRE or Foreman |
| `wait-until-YYYYMMDDTHHMMZ` | wait | retries at that time, no charge | none — wait |
| `visual-qa-failed` | decide | **files nothing and builds nothing.** Holds at its cap at once (retrying unchanged code cannot pass) and raises the unstick kind `rework-decision` in the same cycle, with the PR, the files it touched, the verdict and the evidence links (Ray, 2026-10-31; Slashbin-console#1538: an automatic rework changed `JourneyBar.tsx` while the cause was in `DashboardLayout.tsx`, and the release queue was held ~24h) | **yours — decide the fix, on the first FAIL.** Read the evidence, find the component that owns the defect (it may lie outside the PR's files), and file the corrective titled "… — follow-up to #N" or edit the spec. The follow-up merging into base (`baseAdvanced`) or a spec edit (`specEdited`) releases the hold and re-verifies |
| every other `qa-held-*` (`unsafe-host`, `browser-crashed`, `nothing-captured`), `qa-inconsistent` | charged | 10 min, 20 min, then `blocked` | after exhaustion: read the QA report, fix the spec or file the defect |
| `dev-verify-failed`, `deploy=…` | charged | blocked with owner SRE (`deployFailed`) | route to the SRE |
| `acceptance-not-verified` and every other code | charged | 10 min, 20 min, then `blocked`; the retries keep running, but the first failure also raises `rework-decision` (§3) | **yours — decide the fix, on the first failure; do not wait out the attempts.** Read the evidence and the touched files: edit the spec (`specEdited` releases it at once) or file the fix as a follow-up (below). `baseAdvanced` does **not** release this one. Deploy failures (`dev-verify-failed`, `deploy=…`) and runs that returned no verdict raise nothing early; they stay with the SRE and `verify-exhausted` |

**A fix for a held verification jumps the queue only by its title.** An issue whose title
contains `follow-up to #N` builds at once, alone, ahead of the repo's queue, while #N's
verification waits on it (`followUpsOf`, `src/phases/verify.ts`). A corrective the EM files
for an unmet outcome must end its title `— follow-up to #<parent>`; without it, the fix
queues behind the very verification it is meant to clear.

Blocks the build and release stages raise (`BlockKind`, `src/unblock.ts`; each releases
itself when its check turns true):

| Kind | Cause | Releases itself on | EM input |
|---|---|---|---|
| `skip` | the implementer declined (3 attempts) | `transientCauseGone`, `waitedOnDone`, `issueChanged` | change the issue so it can be built |
| `divergence` | feature branch diverged | `divergenceCleared` | none unless it persists |
| `verify-no-pr` | `pr merged` with no merged PR closing the issue | `mergedPrFound` | link the PR or fix the label history |
| `verify-held` | dev verification failed, waiting out back-off | `specEdited` | none — wait |
| `verify-exhausted` | dev verification spent its attempts | `specEdited`, `baseAdvanced`, `holdNoLongerCharged` | edit the spec or land the fix |
| `revision-exhausted` | revise failed twice | `prHeadMoved` | rule on scope or file the fix |
| `revision-stalemate` | revise made no commit twice running | `prHeadMoved` | rule on scope |

Release-stage stops (`DEPLOY_STOPS`, `src/phases/release.ts`): **`predeploy-stop`,
`merge-refused-repeatedly`, `merge-blocked-check`** each label the release's issues
`blocked`. Read the SRE's reason, get it fixed, lift `blocked`. Every other deploy hold is
retried on `backoff.releaseRetry` (5 min → 2 h) — wait.

Build-side refusals (no card move; one comment each): a missing or invalid `## Acceptance`,
an unmet Pre-Flight readiness fence, an unmerged blocked-by link (silent), a dead blocker
(closed with no PR: dependents are blocked and the EM is told). Each needs the spec or the
blocker fixed, then nothing — the next poll picks it up.

## 3. Unstick: when the Foreman calls the EM

The `unstick` stage runs `em.mjs unstick` for each stuck item, by kind (`UNSTICK_KINDS`,
`src/unstick.ts`): `skip`, `divergence`, `verify-held`, `verify-exhausted`, `verify-no-pr`,
`revision-exhausted`, `revision-stalemate`, `needs-ruling`, `dead-zone`, `deploy-failed`,
`release-gate`, `rework-decision`, `unrelated-error`, `epic-ready-to-close`. Verify holds become candidates only after their attempts are spent,
except `rework-decision`: the first visual QA FAIL, or the first charged verification failure that returned a
verdict, is called in the same cycle, with the PR, the files it touched, the verdict and the evidence links in
the reason. It is one call per failure (a retry that fails the same way keeps the first evidence); a charged
hold hands over to `verify-exhausted` when its retries run out. The Foreman never decides the fix itself.
`release-gate` fires on any open `pr approved` issue without `ready for prod release`.
`unrelated-error` fires when a dev verification, a prod verification or the first prod deploy prints `Not caused by
this release, needs triage:` (the SRE passed the release and excluded the error). The reason carries the signature,
the repo and PR it was first seen on, and the SRE's evidence links. It is repo-level (issue 0), once per distinct signature
(numbers and long hex folded), never again for that signature from any PR, and it never holds the release.
The EM routes it to the owner: an issue on the owning repo, or an SRE change request for a credential or infra
fault (2026-10-31: an expired dev Stripe key was excluded for 8 days with no owner, SRE#369).
`epic-ready-to-close` fires when the release stage closes an issue after its production verification and that issue
names an epic (`engineering-manager #N` in its body, or in the body of the issue a "follow-up to #N" title names).
It is repo-level (issue 0), once per epic and closed issue, and never holds the release. The EM runs its READY TO
CLOSE check for the epic and closes it only if every child is done: closing is the hand-off to the PO, and nothing
else makes it (foreman#151).
`dead-zone` is an issue in a state reconcile cannot recover; a reviewer-declared hold is
never auto-recovered and goes to the EM as a message.

After 3 failed calls (`UNSTICK_MAX_ATTEMPTS`) the Foreman posts a give-up comment
@-mentioning Ray. **That comment means the EM failed its stage** — a give-up is never the
first Ray hears of a stuck card.

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
