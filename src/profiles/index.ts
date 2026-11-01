// Config profiles (EM#1150 f7): a named set of config defaults an operator selects
// with `"profile": "<name>"` in `.ai-agent.json`. Resolution, in src/config.ts:
// the schema's neutral default < the profile < the file < the env. A profile is
// a plain object shaped like the config file, so its values are parsed and
// checked exactly as a file's are. Operator-specific values (logins, repo names,
// MCP server names, fork headers) live here and nowhere else in src/.
import { slashbinProfile } from "./slashbin.js";

/**
 * The keys a profile may set, as the config file spells them. A nested block
 * (`paperclip`) is merged one level deep: the file's block wins key by key.
 */
export interface ConfigProfile {
  readonly unstickEscalationOwner?: string;
  readonly qaRepos?: readonly string[];
  readonly qaSecretsRunner?: string;
  readonly reviewAllowedTools?: readonly string[];
  readonly divergenceRulerLogin?: string;
  readonly epicRefLabel?: string;
  readonly paperclip?: { readonly commentAuthorHeader?: string };
}

/** Every profile, by the name `.ai-agent.json` selects it with. */
export const PROFILES: Readonly<Record<string, ConfigProfile>> = Object.freeze({
  slashbin: slashbinProfile,
});

/** The profile named `name`. Throws naming the valid ones when there is none. */
export function profileNamed(name: string): ConfigProfile {
  const profile = Object.hasOwn(PROFILES, name) ? PROFILES[name] : undefined;
  if (!profile) {
    throw new Error(`Unknown config profile "${name}". Valid profiles: ${Object.keys(PROFILES).join(", ")}.`);
  }
  return profile;
}

const isBlock = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The config file with `profile`'s values under it: a key the file omits takes
 * the profile's value, a block both set is merged with the file's keys winning,
 * and every other key the file sets is kept as written. Pure.
 */
export function applyProfile(file: Record<string, unknown>, profile: ConfigProfile): Record<string, unknown> {
  const out: Record<string, unknown> = { ...file };
  for (const [key, value] of Object.entries(profile)) {
    if (value === undefined) continue;
    const own = file[key];
    if (own === undefined) out[key] = isBlock(value) ? { ...value } : Array.isArray(value) ? [...value] : value;
    else if (isBlock(own) && isBlock(value)) out[key] = { ...value, ...own };
  }
  return out;
}
