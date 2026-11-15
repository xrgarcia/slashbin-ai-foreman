# OpenTelemetry traces

The optional `otel` observer exports one trace per agent session to any OpenTelemetry-compatible
tool over OTLP/HTTP. It is off by default, never decides anything, and never stalls the Foreman:
an export failure is logged and dropped.

## Enable it

```json
{ "otel": { "enabled": true, "serviceName": "foreman" } }
```

The destination and credentials come only from the standard environment variables, never this file:

| Variable | Use |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full traces URL (used as given). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; `/v1/traces` is appended. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,...` request headers (for example an API key). |

Enabled with no endpoint set, the Foreman logs one warning and exports nothing. Disabled, no `OTEL_*`
variable is read and nothing touches the network. To undo, set `enabled` to `false`.

## What is exported

One span per session, named `foreman.session.<phase>`. A `started` event records the start; `finished`
or `failed` ends the span (status ERROR on `failed`); a `handoff` is a span event. A session whose
`started` was never seen (a daemon restart) is exported with its end time as start and
`foreman.start_missing=true`.

| Attribute | Meaning |
|---|---|
| `foreman.phase` | `implement`, `revise`, `review`, `verify`, `qa` |
| `foreman.status` | `finished`, `failed`, `handoff` |
| `foreman.repo` | `owner/name` |
| `foreman.pr` | Pull request number, when there is one |
| `foreman.items` | Issue numbers the session was about |
| `foreman.items.worked` | The subset an implement session actually built; outcomes attach only to these |
| `foreman.items.candidates` | `true` on an implement session that did not report `worked`: `foreman.items` are candidates with no outcome |
| `foreman.reviewer` | Reviewer, on a review |
| `foreman.start_missing` | `true` when no `started` was seen |

Lifecycle events outside a session (`claim`, `transition`, `blocked`, `unblocked`, `escalated`, `merged`,
`promoted`, `release`) are each a separate zero-length trace named `foreman.item.<kind>`, with
`foreman.repo` and `foreman.item` (issue number). No trace stays open across sessions.

## What is never exported

The session `report` (goals, final message, review text), `detail`, prompts, issue titles and bodies,
endpoint userinfo, and header values.

## Failure

The first failed export logs `otel: export failed: ...` at warn level, once per outage; recovery logs
`otel: export recovered`. Look for `otel: export failed` in the daemon log.
