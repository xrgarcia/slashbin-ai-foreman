---
name: install-labels
description: Install the configured Foreman labels on every repo listed in the configuration
match_triggers:
  - install labels
  - install the labels
  - install the labels on the service repos
  - set up labels
# required: this writes labels to remote repos, so a false-positive match must not run it.
match_strength: required
---

# Install the Foreman's labels

Creates, on every repo in the Foreman config, each label the daemon runs on that the
repo does not have yet: the repo's `triggerLabel` plus the five `lifecycleLabels`.
The names come from the config through `loadConfig`, never from this file. Existing
labels are never changed or deleted, and a second run creates nothing.

From the Foreman repo root, run:

```bash
npm run build && npm run labels:install
```

To use a config other than `.ai-agent.json`, append its path:
`npm run labels:install -- path/to/config.json`.

Report the script's output verbatim: one `<repo>: created N, present M` line per
repo, then the failure summary if there is one. A non-zero exit means at least one
repo or label failed; the summary names each one.

Do not create, rename or delete labels any other way — not with `gh label`, not with
`gh api`, not by hand. If the script fails, report the failure; do not work around it.
