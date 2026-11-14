# External plugins and the change signal

[Documentation index](README.md)

Foreman loads plugins that are not part of this repo, and offers a `changeSignal` role that lets a
plugin cut idle GitHub polling.

## Contents

- [Loading an external plugin](#loading-an-external-plugin)
- [The change signal](#the-change-signal)
- [Per-lane poll intervals](#per-lane-poll-intervals)
- [Deploy step for a config](#deploy-step-for-a-config)

## Loading an external plugin

List module paths under `plugins` in `.ai-agent.json`:

```json
{ "plugins": ["~/code/my-plugins/change-signal.mjs"] }
```

A path starting with `~/`, `/`, `./` or `../` is imported as a file (relative paths resolve against
the config file's directory); anything else is a package name. The module's `default` (or `plugin`)
export is a `ForemanPlugin`, an array of them, or a factory `({ config, logger }) => plugin`. Each one
is registered through the same registry as the built-ins, after them and before startup. A module
that is missing, throws, or exports the wrong shape is logged and skipped; Foreman runs without it.

## The change signal

A plugin that fills the `changeSignal` role implements:

```ts
changeSignal: {
  changedSince(cursor: string | null, repos: readonly string[]): Promise<{ changed: readonly string[] | "all"; cursor: string }>;
}
```

`cursor` is `null` on the first call and otherwise the cursor the last report returned. `changed`
names the repos (`owner/name`) with news since the cursor, or `"all"` when the plugin cannot say
(always the right answer for the first call, and for a repo it has no feed for). Foreman asks about
every watched repo at once and at most every 5 seconds.

With a signal installed, a repo that has not changed skips its fleet-state refresh and the lane
passes listed in `changeSignal.lanes` (default `branch-sync`, `dependabot`). Every repo is still
checked in full at least every `changeSignal.forceCheckMs` (default 300000, 5 minutes), so a missed
event costs minutes, never correctness. A signal that throws makes every repo due until it answers
again. Foreman's own writes still invalidate the fleet state immediately. With no signal installed
the behaviour is identical to before.

## Per-lane poll intervals

`laneIntervalsMs` maps a lane name (`reconcile`, `review`, `verify`, `release`, `build`,
`branch-sync`, `dependabot`, `unstick`, `skill-deliver`) to its own sleep between passes. A lane not
listed uses `pollIntervalMs`.

## Deploy step for a config

`.ai-agent.json` is not tracked, so this is applied by hand, with a backup, then a restart:

```
cp .ai-agent.json .ai-agent.json.bak-$(date +%Y%m%d-%H%M)
```

then add:

```json
"laneIntervalsMs": { "branch-sync": 300000, "dependabot": 300000, "unstick": 300000, "skill-deliver": 300000 },
"plugins": ["<path to the change-signal module>"]
```
