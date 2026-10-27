// Secret redaction: core, shared by the agent runner and any plugin that
// writes text somewhere a person reads it.

/** Replace every occurrence of each secret value with `[REDACTED:<NAME>]`. */
export function redactAll(text: string, secrets: ReadonlyArray<{ name: string; value: string }>): string {
  let out = text;
  for (const { name, value } of secrets) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
  }
  return out;
}
