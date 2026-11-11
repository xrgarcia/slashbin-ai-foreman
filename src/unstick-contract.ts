// The startup check of the alert-kind contract (foreman#232): the receiver publishes the kinds it accepts, and the
// Foreman fails loudly, at start, when one of its own UNSTICK_KINDS is not among them. Before this the two lists were
// hand-kept copies and a kind shipped on one side only reached no one (2026-11-06, dependency-batch-loop).
import type { AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { roleFor } from "./plugins/registry.js";
import { missingKinds, UNSTICK_KINDS } from "./unstick.js";

export type KindContractResult =
  | { status: "ok" }
  | { status: "missing"; missing: string[] }
  /** No unstick agent, or it could not say. Not a contract break: nothing is claimed either way. */
  | { status: "unchecked"; why: string };

/**
 * Ask the configured unstick agent which kinds it accepts and compare. A break is logged at error level, which is the
 * Foreman's one notification channel (what needs a person is a label and comment on an issue; a contract break has
 * no issue). Never throws.
 */
export async function checkKindContract(config: AgentConfig, logger: Logger, ours: readonly string[] = UNSTICK_KINDS): Promise<KindContractResult> {
  const unsticker = roleFor("unstick", config);
  if (!unsticker) return { status: "unchecked", why: "no unstick agent configured" };
  if (!unsticker.publishedKinds) return { status: "unchecked", why: "the unstick agent publishes no kind list" };
  let published: readonly string[] | null = null;
  try { published = await unsticker.publishedKinds(config, logger); } catch { /* contract: never throws; treat as unreadable */ }
  if (!published) {
    logger.warn("EM kind contract unchecked: the EM did not publish its kinds (is the EM checkout older than `kinds --json`?)");
    return { status: "unchecked", why: "the agent could not be read" };
  }
  const missing = missingKinds(published, ours);
  if (missing.length === 0) return { status: "ok" };
  logger.error(`EM kind contract BROKEN: the EM does not accept ${missing.join(", ")}. Alerts of ${missing.length === 1 ? "that kind" : "those kinds"} will fail (retried, then re-armed hourly) until the EM checkout knows ${missing.length === 1 ? "it" : "them"}. Update the EM (emRepoPath) to a version that lists ${missing.length === 1 ? "it" : "them"} in \`bin/em.mjs kinds --json\`.`);
  return { status: "missing", missing };
}
