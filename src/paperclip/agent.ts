// Registers the Foreman, and every role configured in `paperclip.roles`, as an
// agent in its Paperclip company, with every wake path off. Used by
// `npm run paperclip:register` (scripts/paperclip/agent.mjs). Roles are agents
// that only hold cards (a reviewer, a verifier); the Foreman places the cards,
// and nothing here lets Paperclip start a run for any of them.
//
// Why the flags matter: the Foreman is registered with the `process` adapter
// only so it can hold Paperclip tasks; it is never meant to be started by
// Paperclip. Paperclip's wake-on-demand fires on task assignment and defaults
// ON, so a create alone is not enough. The flags are re-applied with a PATCH on
// every run, which also repairs an agent someone has since switched back on.

import { PAPERCLIP_FOREMAN_ROLE, type PaperclipConfig } from "../config.js";
import type { PaperclipAgent, PaperclipClient } from "./client.js";

export const PAPERCLIP_AGENT_ROLE = "engineer";
export const PAPERCLIP_AGENT_ADAPTER = "process";

/** The heartbeat flags that keep Paperclip from ever starting a run for the Foreman. */
export const WAKE_PATHS_OFF = Object.freeze({ enabled: false, wakeOnDemand: false });

export type PaperclipRegistration = {
  agent: PaperclipAgent;
  /** True when this call created the agent; false when one by that name existed. */
  created: boolean;
};

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * `runtimeConfig` with both wake flags off and every other setting kept.
 * Paperclip replaces `runtimeConfig` whole on PATCH, so the existing value is
 * the base, not an empty object.
 */
export function withWakePathsOff(runtimeConfig: unknown): Record<string, unknown> {
  const rc = asRecord(runtimeConfig);
  return { ...rc, heartbeat: { ...asRecord(rc.heartbeat), ...WAKE_PATHS_OFF } };
}

/** The one agent in `agents` named `name`, or undefined; throws when the name is ambiguous. */
function byName(agents: PaperclipAgent[], name: string, setting: string): PaperclipAgent | undefined {
  const matches = agents.filter((a) => a?.name === name);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} Paperclip agents are named "${name}" (${matches.map((a) => a.id).join(", ")}); ` +
        `rename or remove all but one, or set ${setting}`,
    );
  }
  return matches[0];
}

async function findOrCreate(
  client: PaperclipClient,
  agents: PaperclipAgent[],
  name: string,
  role: string,
  setting: string,
): Promise<PaperclipRegistration> {
  const existing = byName(agents, name, setting);
  if (existing) return { agent: existing, created: false };
  const made = await client.createAgent({
    name,
    role,
    adapterType: PAPERCLIP_AGENT_ADAPTER,
    runtimeConfig: { heartbeat: { ...WAKE_PATHS_OFF } },
  });
  if (!made?.id) throw new Error(`Paperclip created the agent "${name}" but returned no id`);
  agents.push(made);
  return { agent: made, created: true };
}

async function patchAgent(client: PaperclipClient, reg: PaperclipRegistration, extra: Record<string, unknown>): Promise<PaperclipRegistration> {
  const patched = await client.updateAgent(reg.agent.id, { runtimeConfig: withWakePathsOff(reg.agent.runtimeConfig), ...extra });
  return { agent: { ...reg.agent, ...asRecord(patched), id: reg.agent.id } as PaperclipAgent, created: reg.created };
}

/**
 * Find the company's agent named `agentName`, or create it, then PATCH both
 * wake flags off. Idempotent: a second run creates nothing. Throws (the
 * client's PaperclipClientError, or an Error on an ambiguous name) and leaves
 * any caller-side state for the caller to skip writing.
 */
export async function registerPaperclipAgent(
  client: PaperclipClient,
  agentName: string,
): Promise<PaperclipRegistration> {
  const agents = await client.listAgents();
  if (!Array.isArray(agents)) throw new Error("Paperclip agent list is not an array");
  const reg = await findOrCreate(client, agents, agentName, PAPERCLIP_AGENT_ROLE, "paperclip.agentName");
  return patchAgent(client, reg, {});
}

export type PaperclipTeamRegistration = {
  foreman: PaperclipRegistration;
  /** Role key → its agent. */
  roles: Record<string, PaperclipRegistration>;
};

/**
 * Register the Foreman and every configured role, each found by name or
 * created (never a second agent of one name), then PATCH each one: wake flags
 * off, and `title` / `reportsTo` where the config sets them. A reportsTo the
 * config leaves unset is left as Paperclip has it. Idempotent, and with no
 * roles and no `agentReportsTo` it sends exactly what `registerPaperclipAgent`
 * sends. Throws like it.
 */
export async function registerPaperclipTeam(
  client: PaperclipClient,
  cfg: Pick<PaperclipConfig, "agentName"> & Partial<Pick<PaperclipConfig, "agentReportsTo" | "roles">>,
): Promise<PaperclipTeamRegistration> {
  const agents = await client.listAgents();
  if (!Array.isArray(agents)) throw new Error("Paperclip agent list is not an array");
  const roles = Object.entries(cfg.roles ?? {});

  // Pass 1: every agent exists, so a reportsTo can name any of them.
  const foreman = await findOrCreate(client, agents, cfg.agentName, PAPERCLIP_AGENT_ROLE, "paperclip.agentName");
  const found: Record<string, PaperclipRegistration> = {};
  for (const [key, r] of roles) found[key] = await findOrCreate(client, agents, r.name, r.role ?? PAPERCLIP_AGENT_ROLE, `paperclip.roles.${key}.name`);
  const idOf = (key: string): string => {
    const id = key === PAPERCLIP_FOREMAN_ROLE ? foreman.agent.id : found[key]?.agent.id;
    if (!id) throw new Error(`reportsTo "${key}" is not "${PAPERCLIP_FOREMAN_ROLE}" or a configured role`);
    return id;
  };

  // Pass 2: flags, title, reporting line.
  const out: PaperclipTeamRegistration = {
    foreman: await patchAgent(client, foreman, cfg.agentReportsTo ? { reportsTo: idOf(cfg.agentReportsTo) } : {}),
    roles: {},
  };
  for (const [key, r] of roles) {
    out.roles[key] = await patchAgent(client, found[key], {
      ...(r.title ? { title: r.title } : {}),
      ...(r.reportsTo ? { reportsTo: idOf(r.reportsTo) } : {}),
    });
  }
  return out;
}
