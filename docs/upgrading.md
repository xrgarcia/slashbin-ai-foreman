# Upgrading to this release

[Project README](../README.md) · [All documentation](README.md)

## Contents

- [What changed](#what-changed)
- [Required actions before restart](#required-actions-before-restart)
- [What happens to existing state on first start](#what-happens-to-existing-state-on-first-start)
- [New opt-in features](#new-opt-in-features)
- [Removed features](#removed-features)
- [How to roll back](#how-to-roll-back)

For an install running the previous release (`main`). A fresh install needs none of this:
start at [setup.md](setup.md).

## What changed

The Foreman no longer keeps its memory in a local `.agent-state.json`. Per-item state now
lives on GitHub, in a comment on each issue or PR and in one bookkeeping issue per repo;
the first pass over each repo imports the old file once. Every issue is now built on its
own branch (`foreman/<issue>-<slug>`, cut from the base branch) instead of a shared
`features` branch. Deployment-specific defaults (who an unstick give-up mentions, the QA
repo, the review MCP tools, the Paperclip credit header) are no longer built in: they
come from a named `profile`. New in this release: the plugin architecture (`workSource`,
`codeHost`), the metrics log, the QA stage, the `skill-deliver` stage for sync-only
repos, a sign-off commit status on release PRs, and new back-off groups.

## Required actions before restart

1. **Back up the state file.** Copy `.agent-state.json` out of the daemon's working
   directory (or `FOREMAN_STATE_DIR`). The first start moves its contents into GitHub and
   deletes it, and the previous release cannot read them there
   ([How to roll back](#how-to-roll-back)).
2. **Add `"profile": "slashbin"` to `.ai-agent.json` if this is Slashbin's fleet.** Without
   it these now resolve to their neutral values (`src/profiles/slashbin.ts`):

   | Key | Previous release | Without the profile |
   |---|---|---|
   | `unstickEscalationOwner` | always `xrgarcia` | unset: a give-up is logged, nobody is mentioned |
   | `epicRefLabel` | always `engineering-manager` | unset: issue bodies are not read for an epic |
   | `paperclip.commentAuthorHeader` | `x-slashbin-comment-author` | unset: no credit header is sent |
   | `reviewAllowedTools` | base tools plus the MCP servers | base tools plus `WebFetch` |
   | `qaRepos`, `qaSecretsRunner`, `qaBearerKey` | n/a (QA is new) | `[]`, unset, `EM_SLASHBIN_MCP_ROUTER_BEARER` |

   An unknown profile name stops startup and lists the valid ones. An explicit key in
   `.ai-agent.json` still beats the profile.
3. **Check the tokens.** `FOREMAN_GITHUB_TOKEN` is required: with it unset every Foreman
   GitHub call fails (`src/github/gh.ts`). This is unchanged from the previous release;
   older docs wrongly described a fallback to `gh`'s login. The token must be able to
   comment on and open issues in every managed repo, because the record store does both.
   If the `unstick` stage runs, also set `EM_GITHUB_TOKEN` and `emRepoPath` (or
   `AI_AGENT_EM_REPO_PATH`). Then run `npm run doctor`: it now fails on a missing
   `FOREMAN_GITHUB_TOKEN`.
4. **Node.** Unchanged: `engines.node` is `>=22.12`. Only the opt-in metrics log needs
   `node:sqlite`, which 22.12 ships behind a flag ([metrics.md](metrics.md#requirements)).
   No dependency changed, but `dist/` must be rebuilt: `npm run build`. A daemon started
   from an uncommitted build refuses to start (exit 78).
5. **Labels.** The lifecycle label names and defaults are unchanged. One label is new:
   `deliver-to-prod`, needed only on repos with `dependencyPreApproved: true`. Onboarding
   creates it with the rest (`onboarding` is on by default); with onboarding off, run
   `npm run labels:install`.
6. **Branches for managed repos.** `featureBranch` (default `features`) is legacy: nothing
   is pushed to it any more, and new work goes to `<branchPrefix><issue>-<slug>` (default
   `foreman/`). Leave the `features` branch in place.
   - Open PRs whose head is `features` still work. A head is Foreman-owned when it starts
     with `branchPrefix` or equals `featureBranch` (`src/foreman-branch.ts`), and revision,
     reconciliation and branch deletion all use that test. They drain as they merge.
   - The reconciler still scans `origin/<featureBranch>`.
   - Do not rename `featureBranch` while old PRs are open. `AI_AGENT_FEATURE_BRANCH` still works.
   - `npm run doctor` no longer requires a `features` branch; it checks base and production.
   - If a repo has a branch protection rule or ruleset that restricts which branches the
     Foreman's token may push, allow `foreman/*`. The code cannot tell whether yours does.
7. **Config keys.** Nothing needs renaming. `reviewSkillPath` was already ignored and is
   gone from the schema; unknown keys are dropped silently, so an old file still loads.
   Remove it for tidiness. `docs/config-guide.md` lists everything else.
8. **Restart through the drain.** `scripts/restart-drained.sh` (systemd user unit) lets
   in-flight work finish, up to 60 minutes by default, and exits 0 only after the new
   process logs `Daemon starting` ([running.md](running.md)).

## What happens to existing state on first start

On the first pass over each repo (after onboarding, once per process per repo), the
Foreman reads `.agent-state.json` from the state directory (`FOREMAN_STATE_DIR`, else the
daemon's working directory, the same place the previous release wrote it)
and moves it onto GitHub (`src/legacy-records.ts`):

- **Entries for closed issues are dropped.** Closed work holds nothing.
- **Live entries are saved** into the issue's, the PR's or the repo's record, merged under
  anything the store already holds: failures, skips, holds, verify holds, unstick
  questions, prod-verified marks, promotion-stall notices, rejected branches, the release
  tracker and previous prod releases, no-commit streaks and the branch block.
  An entry leaves the file only after its save succeeded.
- **Dead fields are dropped**: `implemented`, `promotionHeldNoted`, `trackedPRs`, and any
  repo entry no configured repo matches.
- **Card blocks** (they name no repo) move into the first configured repo's record.
- **An issue with an entry not yet imported is withheld**, never read as having no state.
  An incomplete import is retried after 5 minutes.
- **The file is deleted when nothing is left.** A file that cannot be parsed is left
  alone, with a warning.
- Repos with `syncOnly: true` skip the import. It is idempotent: a second run finds
  nothing.

What appears on GitHub: one comment per issue or PR, written by the Foreman's login,
starting `<!-- foreman:record v1 -->`; and, per repo, a closed issue titled "Foreman repo
records (bookkeeping, do not close or edit)", created on first save. Leave both alone.
`.github-state.json` in the state directory is a rebuildable cache and can be deleted.

## New opt-in features

| Feature | Key (env) | Default |
|---|---|---|
| Profile | `profile` | unset (neutral) |
| Metrics log | `metrics.enabled`, `metrics.path`, `metrics.retentionDays` | `false`, `foreman-metrics.db` in the state dir, `90` |
| Metrics report | `npm run metrics:report` | works with the plugin off once the file exists |
| Work source / code host | `workSource`, `codeHost` | `github`; any other value stops the daemon (exit 78) |
| Branch prefix | `branchPrefix` (`AI_AGENT_BRANCH_PREFIX`), also per repo | `foreman/` |
| QA stage | `qaPath` (`AI_AGENT_QA_PATH`), `qaRepos`, `qaGate`, `qaBeforeMerge`, `qaSecretsRunner`, `qaBearerKey` | unset, `[]`, `false`, `false`, unset, `EM_SLASHBIN_MCP_ROUTER_BEARER` |
| Sync-only repos | `repos[].syncOnly` | off. Such a repo runs only the new `skill-deliver` stage |
| Sign-off status | `github.signoffStatusContext` | `foreman/em-sign-off`, a commit status on release PR heads, failing while an issue lacks EM sign-off. Add it to the production branch's required checks to hold a human merge too |
| Pre-approved dependencies | `repos[].dependencyPreApproved`, label `deliver-to-prod` | off |
| Epic reads | `epicRefLabel` | unset |
| Runner refusals | `runner` (`refusalPatterns`, `refusalExitCodes`, `resetPattern`) | see [configuration.md](configuration.md) |
| Paperclip registry and credit header | `paperclip.registryUrl`, `registryApiKey`, `commentAuthorHeader` (`AI_AGENT_PAPERCLIP_REGISTRY_URL`, `_REGISTRY_API_KEY`, `_COMMENT_AUTHOR_HEADER`) | unset |
| Back-off groups | `backoff.handoff` (10 min to 24 h, 3 recalls), `backoff.paperclip`, `backoff.registry` (0.5 s to 5 s, 3 attempts) | as shown |
| Drain and unit | `AI_AGENT_SHUTDOWN_DRAIN_MS`, `FOREMAN_SYSTEMD_UNIT`, `FOREMAN_STATE_DIR` | longest run budget, `slashbin-foreman.service`, working directory |

The default `stages` list is now eleven built-ins; the new one, `skill-deliver`, runs only
for `syncOnly` repos. A disabled or invalid `paperclip` block no longer stops startup.

## Removed features

- **The shared `features` branch as a build target** (see above), and the doctor's
  requirement that it exist.
- **Divergence repair** (`src/divergence-repair.ts`), the EM-ruled repair of a diverged
  shared branch. Its `divergence` unstick kind is still listed but never raised.
- **`.agent-state.json`** and the code that read it (`src/state.ts`, `src/closed-holds.ts`,
  `src/agent.ts`), replaced by the record store.
- **`reviewSkillPath`**, already ignored.

## How to roll back

Rolling back means checking out the previous release's commit, running `npm ci && npm run build`
and restarting. The previous release has no record-store code and reads only
`.agent-state.json`, so whatever this release moved to GitHub (holds, skips, verify holds,
prod-verified marks, release trackers) is invisible to it, and anything the new release
recorded after the import is not in the file at all.

1. Stop the daemon through the drain.
2. Restore the `.agent-state.json` you backed up in step 1, to the daemon's working directory.
3. Check out the previous release, rebuild and start.

State changed between the backup and the rollback is lost to the old release. The record
comments and the bookkeeping issues stay on GitHub; the old release ignores them and a
later upgrade reads them again. Whether the previous release treats open
`foreman/*` PRs as its own is not established here; merge or close them first.
