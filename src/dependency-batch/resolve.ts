// The call-site wiring for a landed result: build the landing from the runtime's
// ledger and the active code host. Kept apart from implement.ts so the phase
// names no Dependabot concept, and apart from dead-blocker.ts so that stays generic.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { codeHost } from "../plugins/registry.js";
import type { ForemanRuntime } from "../runtime.js";
import { DependencyDiscovery } from "./collaborators.js";
import { DependencyBatchLanding, type LandingResult } from "./landing.js";

/** `issue` ended as landed. If it is a dependency-batch issue, retire its PRs and record the outcome. Never throws. */
export async function resolveLandedDependencyBatch(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  issue: number,
  reason: string,
  logger: Logger,
): Promise<LandingResult | undefined> {
  try {
    const host = codeHost();
    return await new DependencyBatchLanding(rt.dependencyBatches, new DependencyDiscovery(host), host).resolve(repoConfig, issue, reason, logger);
  } catch (err) {
    logger.warn(`dependency batch for #${issue}: could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
