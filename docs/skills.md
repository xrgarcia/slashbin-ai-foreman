# Skills: what a session is told to do

[Project README](../README.md) · [All documentation](README.md)

## Contents

- [Built-in skills](#built-in-skills)
- [Keeping skill copies in step](#keeping-skill-copies-in-step)
- [Prompt template variables](#prompt-template-variables)
- [Image handling in issue bodies](#image-handling-in-issue-bodies)
- [Skills in this repo](#skills-in-this-repo)

The Foreman delegates work by invoking Claude Code skills on each service repo. Two
skill paths per repo:

- **`skillPath`** — invoked during the Implementation phase (e.g.
  `.claude/skills/implement-approved-issues/SKILL.md`)
- **`revisionSkillPath`** — invoked during the Revision phase when a PR has review
  feedback (e.g. `.claude/skills/revise-pr-feedback/SKILL.md`)

The Foreman passes the issue context to Claude and instructs it to read and follow the
skill. The skill defines the repo-specific implementation workflow — how to branch,
test, and structure the PR.

The Foreman, not the skill, decides what to build. Its work source (`WorkSourceAdapter`
in `src/adapters.ts`; GitHub issues via `GitHubIssueConnector`) offers every eligible
item, and the implement prompt names all of them, less any the Foreman is backing off,
as `Implement exactly these work items, and no others: #<n>, …`. How many it hands one
session is `buildBatchSize` (default 1); the skill picks among them by priority. A
repo-local skill that runs its own `gh issue list` gets the same issues back; the
built-in skill takes its list from the prompt alone.

## Built-in skills

Set either field to `builtin:` to use the generic skills that ship with the Foreman
(`skills/implement/SKILL.md`, `skills/revise/SKILL.md`) instead of keeping a copy in
every repo. The built-in text is inlined into the prompt together with the repo's
feature and base branch. It never names a label: it reads the configured names from
`FOREMAN_TRIGGER_LABEL` and `FOREMAN_LIFECYCLE_LABELS`, which the Foreman sets on every
session.

To add repo-specific rules without forking the skill, point `skillOverlayPath` /
`revisionSkillOverlayPath` at a file in the repo; its contents are appended after the
skill. A configured overlay that cannot be read fails that run before Claude starts —
the skill is never run without it.

```json
{ "name": "api", "repoPath": "../my-api", "skillPath": "builtin:", "revisionSkillPath": "builtin:",
  "skillOverlayPath": "docs/foreman-overlay.md" }
```

## Keeping skill copies in step

When each repo keeps its own copy of a skill, skill sync keeps those copies on one
golden source, one repo at a time, as approved work comes through: see
[skill-sync.md](skill-sync.md).

## Prompt template variables

A full custom `prompt` (config key `prompt`, env `AI_AGENT_PROMPT`) replaces the
built-in one. It supports these placeholders:

- `{{issue_number}}` — GitHub issue number
- `{{issue_title}}` — Issue title
- `{{issue_body}}` — Issue body (markdown)

The Foreman adds nothing to a custom prompt — including the image handling below.

## Image handling in issue bodies

Claude is multimodal — when an issue body or PR review comment contains markdown image
references like `![alt](https://...)`, those images are part of the spec (mockups,
screenshots, walkthrough frames). The Foreman appends instructions to its default and
skill-driven prompts telling the agent to fetch each image to a temp file and `Read` it,
so the model can see image content.

For private-repo image URLs (e.g. `github.com/<owner>/<repo>/raw/<branch>/<path>`) the
fetch uses `GH_TOKEN`-authed `curl`. For public CDN URLs (e.g.
`github.com/user-attachments/...`) no auth is required.

This is automatic for the built-in prompts (`skillPath` and the default implement/revise
prompts). If you supply a fully custom `prompt` in config, include your own
image-handling guidance — the Foreman does not modify custom prompts.

## Skills in this repo

Besides the built-in `skills/implement` and `skills/revise`, the Foreman checkout carries
Claude Code skills for operating it — open Claude Code in the checkout and ask:

- `.claude/skills/setup-foreman` — "set up the Foreman": interviews you, writes the
  config, runs setup until the doctor says Ready ([setup.md](setup.md)).
- `.claude/skills/install-labels` — "install the labels": runs `labels:install`.
- `.claude/skills/setup-paperclip-integration` — walks through turning on the Paperclip
  mirror ([paperclip.md](paperclip.md)).
