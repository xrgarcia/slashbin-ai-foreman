// Registers the Foreman as an agent in its Paperclip company, with every wake
// path off. Used by `npm run paperclip:register` (scripts/paperclip/agent.mjs).
//
// Why the flags matter: the Foreman is registered with the `process` adapter
// only so it can hold Paperclip tasks; it is never meant to be started by
// Paperclip. Paperclip's wake-on-demand fires on task assignment and defaults
// ON, so a create alone is not enough. The flags are re-applied with a PATCH on
// every run, which also repairs an agent someone has since switched back on.

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
  const matches = agents.filter((a) => a?.name === agentName);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} Paperclip agents are named "${agentName}" (${matches.map((a) => a.id).join(", ")}); ` +
        "rename or remove all but one, or set paperclip.agentName",
    );
  }

  let existing = matches[0];
  const created = !existing;
  if (!existing) {
    existing = await client.createAgent({
      name: agentName,
      role: PAPERCLIP_AGENT_ROLE,
      adapterType: PAPERCLIP_AGENT_ADAPTER,
      runtimeConfig: { heartbeat: { ...WAKE_PATHS_OFF } },
    });
    if (!existing?.id) throw new Error("Paperclip created the agent but returned no id");
  }

  const patched = await client.updateAgent(existing.id, { runtimeConfig: withWakePathsOff(existing.runtimeConfig) });
  return { agent: { ...existing, ...asRecord(patched), id: existing.id } as PaperclipAgent, created };
}
