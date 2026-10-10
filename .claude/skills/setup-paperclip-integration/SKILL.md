---
name: setup-paperclip-integration
description: Integrate the Foreman into a Paperclip company — configuration only, verified by paperclip:doctor
match_triggers:
  - integrate the Foreman into my Paperclip app
  - connect the Foreman to Paperclip
  - set up Paperclip for the Foreman
  - set up the Paperclip integration
# required: this registers an agent in Paperclip and writes the operator's config,
# so a false-positive match must not run it.
match_strength: required
---

# Integrate the Foreman into a Paperclip company

Turns on the Foreman's Paperclip mirror: each GitHub issue the Foreman builds gets a
Paperclip task, held by whichever agent owns its next step (the Foreman, unless the user
adds roles), with a stage label and a note at every step. What the mirror
does, field by field, is in `docs/paperclip.md`.

This is configuration only. It never edits Foreman source, never files or labels an
issue, never starts or restarts the daemon, and starts no build. The only things it
writes are the `paperclip` block of the config file (after the user confirms the diff)
and, through `npm run paperclip:register`, the Foreman's agent (and any role agents the
user chose) in Paperclip.

Run every command from the Foreman repo root. The config file is `.ai-agent.json`
(or `ai-agent.config.json` if that is the one present; use the same path in every
step). If neither exists, stop: the Foreman itself is not configured yet — point the
user to the README.

Do the steps in order. A step that fails stops the skill: report what failed, in the
command's own words, and do not work around it.

## 1. Paperclip is reachable

Ask for the Paperclip URL. Default `http://127.0.0.1:3100` (the config's default; the
user may say `localhost`). Strip any trailing `/`.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "<url>/api/health"
```

Anything but `200` → stop and say Paperclip is not reachable at `<url>`.

## 2. Pick the company

```bash
curl -sS "<url>/api/companies"
```

Show the companies by name (one per line, numbered) and let the user pick one. Keep its
`id` as `<companyId>`. No companies → stop and say to create one in Paperclip first.

## 3. Show the config diff, then write the `paperclip` block

Build the new file in a temp path: the current config with only its `paperclip` block
changed to `enabled: true`, `url`, `companyId` and `agentName` (keep an existing
`agentName`, else `Foreman`). Every other key of the block (`identityKeyFormat`,
`statusMap`, `comments`) is kept. `agentId` is kept only when the company is unchanged — an agent id
from another company would point at the wrong agent. No other top-level key changes.

```bash
node -e '
const fs = require("fs");
const [src, out, url, companyId] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(src, "utf8"));
const prev = cfg.paperclip && typeof cfg.paperclip === "object" ? cfg.paperclip : {};
const next = { ...prev, enabled: true, url, companyId, agentName: prev.agentName || "Foreman" };
if (prev.companyId !== companyId) delete next.agentId;
cfg.paperclip = next;
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
' .ai-agent.json /tmp/ai-agent.paperclip.json "<url>" "<companyId>"
diff -u .ai-agent.json /tmp/ai-agent.paperclip.json
```

Show the user the diff exactly as printed and ask them to confirm. Write only after a
clear yes:

```bash
mv /tmp/ai-agent.paperclip.json .ai-agent.json
```

On no, delete the temp file and stop; nothing has been written.

## 4. Choose who holds each card

Ask: "Should the Foreman hold every card, or do other agents own some stages — say a
reviewer for code review, or a lead who verifies and releases?" Show the stage table from
`docs/paperclip.md` → "Board stages" (stage, meaning, default owner, status, stage label).

- **The Foreman holds every card** (the default) → skip to step 5; the block needs no
  `roles` or `board`.
- **Other agents own stages** → for each one ask a role key (a short word, e.g.
  `reviewer`), its Paperclip agent name (an existing agent of that name is reused, never
  duplicated), an optional title, and whom it reports to (another role key, or
  `foreman`). Then ask which stages it owns, and whether any stage should use a different
  status than its default. Ask too whom the Foreman reports to (`agentReportsTo`), if
  anyone.

Build `roles`, `board` (only the stages that change, only the fields that change) and
`agentReportsTo` into the same temp file as step 3, show the diff, and write only after a
clear yes — exactly as in step 3. Do not add `id`s; registration writes them.

## 4b. Choose what each card's thread says

Ask: "Each card's thread gets a short summary per session — the goal when a build
starts; the PR, diff stat and the agent's own summary when it ends; the review verdict
and findings; what a revision addressed. Keep that, or post only the one-line note per
step? And is any kind of comment unwanted?" Show the event table from
`docs/paperclip.md` → "Session summaries".

- **Keep the defaults** → nothing to write; the block needs no `comments`.
- **Otherwise** → build `comments` with only what changes: `enabled: false` for the
  one-line notes, `events.<key>: false` for each unwanted kind (the card still moves),
  `maxLength` (200–20000, default 3000), `includeDiffStat: false` to drop the diff stat.

Write it into the same temp file as step 3, show the diff, and write only after a clear
yes — exactly as in step 3. Every comment is redacted and capped whatever is chosen;
there is no setting that turns redaction off, and none should be offered.

## 5. Register the Foreman agent and its roles

```bash
npm run build && npm run paperclip:register
```

Registers (or finds, by name) the agent named `agentName` and each role in the company,
switches their heartbeat and wake-on-demand off, applies titles and reporting lines, and
writes `paperclip.agentId` and each `paperclip.roles.<key>.id` into the config — diff
printed. Report its output verbatim. Do not create, edit or delete agents any other
way.

## 6. Install the labels

```bash
npm run labels:install
```

Every configured repo gets the trigger label and the lifecycle labels it is missing.
Report the per-repo lines verbatim.

## 7. Verify with the doctor

```bash
npm run paperclip:doctor
```

(Same as `node dist/cli.js paperclip:doctor`; add `--config <path>` for a config other
than `.ai-agent.json`.) It is read-only and prints one `PASS` / `FAIL` line per check.
It must exit 0. On a non-zero exit, report each `FAIL` line and stop — the integration is
not done. Do not patch Paperclip or the config to make a check pass; re-run the step the
failing check points at.

## 8. Tell the user how to see it work

Print, without doing any of it:

- The daemon reads the `paperclip` block once at startup, so restart the Foreman
  (`npm run restart`, or however it is run here) for the mirror to start.
- Give a GitHub issue in a configured repo its trigger label (`approved` unless the
  config says otherwise).
- When the Foreman picks it up, its Paperclip task appears, titled `owner/name#N`
  (`taskTitleFormat` changes it; `projectId` files it in one project; `repos` limits which
  repos get cards — `docs/paperclip.md` "Configuration", "Projects", "Scope"),
  in progress and assigned to the Foreman, with a `Foreman started implementing` comment
  naming the goal (`picked up by Foreman` with `comments.enabled` off). At each step after
  it gains a summary or note, and moves to the agent, status and stage label its stage
  maps to (`docs/paperclip.md` → "Board stages", "Notes per step" and "Session summaries").
- To turn it off later: set `paperclip.enabled` to `false` and restart.
