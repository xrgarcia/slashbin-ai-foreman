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
Paperclip task, assigned to a Foreman agent, with a note at every step. What the mirror
does, field by field, is in `docs/paperclip.md`.

This is configuration only. It never edits Foreman source, never files or labels an
issue, never starts or restarts the daemon, and starts no build. The only things it
writes are the `paperclip` block of the config file (after the user confirms the diff)
and, through `npm run paperclip:register`, the Foreman's agent in Paperclip.

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
`statusMap`) is kept. `agentId` is kept only when the company is unchanged — an agent id
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

## 4. Register the Foreman agent

```bash
npm run build && npm run paperclip:register
```

Registers (or finds) the agent named `agentName` in the company, switches its heartbeat
and wake-on-demand off, and writes `paperclip.agentId` into the config — that one key,
diff printed. Report its output verbatim. Do not create, edit or delete agents any other
way.

## 5. Install the labels

```bash
npm run labels:install
```

Every configured repo gets the trigger label and the lifecycle labels it is missing.
Report the per-repo lines verbatim.

## 6. Verify with the doctor

```bash
npm run paperclip:doctor
```

(Same as `node dist/cli.js paperclip:doctor`; add `--config <path>` for a config other
than `.ai-agent.json`.) It is read-only and prints one `PASS` / `FAIL` line per check.
It must exit 0. On a non-zero exit, report each `FAIL` line and stop — the integration is
not done. Do not patch Paperclip or the config to make a check pass; re-run the step the
failing check points at.

## 7. Tell the user how to see it work

Print, without doing any of it:

- The daemon reads the `paperclip` block once at startup, so restart the Foreman
  (`npm run restart`, or however it is run here) for the mirror to start.
- Give a GitHub issue in a configured repo its trigger label (`approved` unless the
  config says otherwise).
- When the Foreman picks it up, its Paperclip task appears, titled `owner/name#N`,
  assigned to the Foreman, with a `picked up by Foreman` note, and gains a note at each
  step after (`docs/paperclip.md` → "Notes per step").
- To turn it off later: set `paperclip.enabled` to `false` and restart.
