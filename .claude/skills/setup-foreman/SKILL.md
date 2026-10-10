---
name: setup-foreman
description: Set up a fresh Foreman checkout — interview the user, write .ai-agent.json, install the labels, and run the doctor until it reports Ready
match_triggers:
  - set up the Foreman
  - set up your settings for the Foreman
  - configure the Foreman
  - install the Foreman
  - help me set up the Foreman
  - the Foreman won't start
# required: this writes the operator's config and creates labels on their repos,
# so a false-positive match must not run it.
match_strength: required
---

# Set up the Foreman

Takes a fresh (or half-set-up) Foreman checkout to the point where `npm run doctor`
ends with **Ready**: the config written, the labels on every repo, every check passing.
`docs/setup.md` is the same procedure for a person; `docs/configuration.md` is every key.

This is configuration only. It never edits Foreman source, never starts or restarts the
daemon, never files, labels or approves an issue, and never creates a branch or repo on
GitHub. It writes two things: `.ai-agent.json` (only after the user confirms the diff)
and, through `npm run setup`, any missing labels on the configured repos.

**Tokens never enter the conversation.** Ask the user to put them in the daemon's
environment (shell profile, systemd `EnvironmentFile`, or their secret manager) and
check them only with `npm run doctor`, which reports each as set or unset. If the user
pastes a token into the chat, stop, tell them it is now in the transcript and must be
revoked and replaced, and do not use it. Never echo, print or write a token value,
and never put one in the config file.

Run every command from the Foreman repo root. Ask one short question at a time, offer
the default, and accept "default" or an empty answer as the default.

## 1. Where things stand

```bash
node --version; claude --version; gh --version
ls .ai-agent.json ai-agent.config.json 2>/dev/null
```

- A missing tool → say which and how to get it (Node 18+, Claude Code logged in, the
  GitHub CLI), and stop until it is there.
- **A config already exists** → do not interview from scratch. Run `npm run build &&
  npm run doctor`, show the result, and go to step 5 to fix what it reports. Change the
  config only for what the user asks or a FAIL needs, through the diff in step 4.
- **No config** → step 2.

## 2. The repos

For each repo the Foreman should work on, ask:

1. **GitHub repo** (`owner/repo`). Check it is readable and writable:
   `gh api repos/<owner/repo> --jq .permissions.push` — `true` is good; `false` or an
   error → tell the user the account `gh` uses cannot push there.
2. **Local checkout** — where it is cloned on this machine. Check
   `git -C <path> rev-parse --is-inside-work-tree`. Not cloned → offer the command
   (`gh repo clone <owner/repo> <path>`) for the user to run, or run it on their yes.
   Keep the path relative to the Foreman directory when the user gives it that way.
3. **A short name** — default: the repo name.
4. **Skills** — "Does this repo have its own build and revise instructions (skills), or
   use the Foreman's built-in ones?" Built-in → `"builtin:"` for both. Own → ask the
   repo-relative paths and check each file exists.

Then ask once for all repos (each answer may differ per repo — if so, set it on that
repo's entry instead of the top level):

5. **Branches** — "The Foreman works on three branches: it commits to a feature branch
   (default `features`), merges into a base branch (`develop`), and promotes to
   production (`main`). Same names for you?" Check each exists:
   `gh api repos/<owner/repo>/branches/<name> --jq .name`. A missing one → tell the
   user; offer to use a different existing branch name. Do not create branches.

## 3. The labels and the options

6. **The trigger label** — "Which label means 'build this'? Default `approved`."
7. **Progress labels** — "The Foreman moves an issue through these labels: `pr under
   review`, `pr pending actions`, `pr merged`, `pr approved`, `ready for prod release`,
   `ready to close`. Keep those names, or rename any?" Renamed ones go in
   `lifecycleLabels` under their keys (`prUnderReview`, `prPendingActions`, `prMerged`,
   `prApproved`, `readyForProd`, `readyToClose`).
8. **Hold and priority** — "An issue labelled `blocked` is never built. And when several
   issues are approved, the Foreman builds by priority labels: `S1`, then `security`,
   then `S2`+`bug`… down to `chore`. Do you use different labels for either?" Changes go
   in the `github` block (`blockedLabel`, `priorityLabels` — tiers, highest first, each
   a list of labels an issue must all carry).
9. **Dependency PRs** — "Do dependency updates come from Dependabot (default) or
   Renovate?" Renovate → `github.dependencyBranchPrefixes: ["renovate/"]`.
10. **Review** — "Should each PR be reviewed by a second agent before it merges?" Review
    runs only through the Tech Lead: yes → ask for its checkout path (`techLeadPath`)
    and set `reviewEnabled: true`; it needs `TECHLEAD_GITHUB_KEY`. No checkout → leave
    review off and say PRs will wait for a human merge.
11. **Model and limits** — offer the defaults (`docs/configuration.md`); set only what
    the user changes.

## 4. Write the config — diff first

Build the file in a temp path with **only the repos and the answers that differ from
the defaults** — a key at its default is left out, so a later default change reaches
this install. Every name the user kept as the default stays out of the file.

```bash
node -e '
const fs = require("fs");
const cfg = JSON.parse(process.argv[1]);
fs.writeFileSync(process.argv[2], JSON.stringify(cfg, null, 2) + "\n");
' '<the config as JSON>' /tmp/ai-agent.setup.json
diff -u .ai-agent.json /tmp/ai-agent.setup.json 2>/dev/null || cat /tmp/ai-agent.setup.json
```

Show it exactly as printed and ask the user to confirm. Write only after a clear yes:

```bash
mv /tmp/ai-agent.setup.json .ai-agent.json
```

On no, ask what to change, rebuild, and show the diff again.

## 5. The tokens, then setup

Tell the user which variables to set, by name only, and where (their shell profile,
service `EnvironmentFile`, or secret manager):

- `FOREMAN_GITHUB_TOKEN` — the Foreman's own account, write access to every repo.
  Recommended; without it the Foreman acts as whoever `gh` is logged in as.
- `TECHLEAD_GITHUB_KEY` — when review is on (required), or to merge sync PRs automatically.
- `SRE_GITHUB_KEY` — only when `srePath` is set.

Wait until they say it is done (a new shell, or `doppler run -- …`), then:

```bash
npm run setup
```

It installs, builds, creates any missing label under the configured names, and runs
the doctor. For each FAIL, do what its line says — fix the config through step 4's
diff, or tell the user the one thing only they can do (create a branch, grant access,
set a token). Run `npm run doctor` again until it ends with **Ready**. A WARN is fine
to leave; say what it means in one line.

## 6. Done

Tell the user it is ready and how to start it: `npm start` (background; `npm run
status`, `npm run logs`), or `npm run once` to watch one cycle first. To give it work:
label an issue on a configured repo with the trigger label. Do not start it yourself.
