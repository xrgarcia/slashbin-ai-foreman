# Conformance kit: agent contract v1

Any agent that answers the Foreman (a reviewer, verifier, deployer, or an
implement or revise session) ends its output with one line:

```
FOREMAN_RESULT_V1 {"schema":1,"role":"deployer","outcome":"held","pr":12,"merged":false,"verify":"hold","hold":"predeploy-stop","hold_class":"time","eligible_at":"2026-11-10T14:00:00Z"}
```

Typed fields decide. Prose goes only in `*_text` fields and decides nothing. A
required field that is missing or malformed fails closed: the Foreman holds the
work for a person and names the field. The schemas are in `schemas/<role>.v1.json`.

## Prove your agent conforms

```bash
# C1 (the line is valid for its role) and C2 (two runs agree on every deciding field)
npx foreman-conformance run --role deployer --pr 12 --runs 2 --cmd "./my-deployer --pr 12 --dry-run"

# C1 against output you already captured
npx foreman-conformance check --role reviewer --pr 12 --file review.log
```

## Prove the Foreman conforms to itself

```bash
npx foreman-conformance foreman-self-check
```

- **F1:** every title the Foreman writes for a PR that delivers one issue is
  found by its own strict parser (foreman#239).
- **F2:** every `FOREMAN_RESULT_V1` example in the shipped skills parses.

## Which agents still answer on the legacy trailer

```bash
npx foreman-conformance usage
```

Each `agent:role` shows how many answers came by v1, by the legacy trailer,
and as an invalid v1 line. A legacy trailer is retired for one `agent:role`
only when its last legacy answer is more than 30 days old ("legacy reads zero").

Exit codes: 0 every check passed, 1 a check failed, 2 bad arguments.
