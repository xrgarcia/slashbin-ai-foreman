// Startup credential preflight (Foreman #43).
//
// Without it the daemon started, printed its banner, claimed the PID file and
// polled with no GitHub token: every Foreman call then threw
// "FOREMAN_GITHUB_TOKEN not set" inside a phase, per repo, per cycle, and from
// outside that looked like a quiet backlog (2026-09-26, a start that bypassed
// the secrets wrapper). The per-call guards in src/github/gh.ts stay as the
// backstop; this makes a missing or rejected token stop the process once, at
// startup, saying which token and why.

import type { TokenProbe } from "./code-host.js";
import { unstickStageReady, type AgentConfig } from "./config.js";
import { BASE_URL_ENV, KEY_ENV, WATERMARK_KEY_ENV } from "./metrics/ship.js";

/** The GitHub tokens this config needs: the Foreman's always, the EM's when the unstick stage runs. */
export function requiredCredentials(config: AgentConfig): string[] {
  return ["FOREMAN_GITHUB_TOKEN", ...(unstickStageReady(config) ? ["EM_GITHUB_TOKEN"] : [])];
}

/** The required tokens that are unset or empty in `env`. */
export function missingCredentials(config: AgentConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  return requiredCredentials(config).filter((name) => !env[name]?.trim());
}

export interface CredentialCheck {
  /** Set when startup must stop: the message to print. */
  refusal: string | null;
  /** Tokens GitHub could not be asked about; startup goes on and the per-call guards decide. */
  unverified: string[];
}

/**
 * The startup credential check: a missing required token refuses, and so does one GitHub
 * answers 401 for (a rotated or revoked token). A token that cannot be checked (GitHub
 * unreachable) does not stop startup: a network blip is not a credential fault.
 * `probe` is the code host's (`codeHost().probeToken`). Token values never appear in the result.
 */
export async function checkCredentials(
  config: AgentConfig,
  probe: (token: string) => Promise<TokenProbe>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialCheck> {
  const missing = missingCredentials(config, env);
  if (missing.length) {
    return {
      refusal:
        `missing required GitHub token${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        `Start the daemon through its service unit, which supplies the tokens, or set ` +
        `${missing.length > 1 ? "them" : "it"} in its environment (docs/setup.md, "GitHub tokens"); ` +
        `there is no fallback to gh's own login.`,
      unverified: [],
    };
  }
  const rejected: string[] = [];
  const unverified: string[] = [];
  for (const name of requiredCredentials(config)) {
    const result = await probe(env[name]!.trim());
    if (result === "rejected") rejected.push(name);
    else if (result === "unknown") unverified.push(name);
  }
  if (rejected.length) {
    return {
      refusal:
        `GitHub rejected ${rejected.join(", ")} (HTTP 401: expired, revoked or rotated). ` +
        `Replace ${rejected.length > 1 ? "them" : "it"} in the daemon's environment (docs/setup.md, "GitHub tokens").`,
      unverified,
    };
  }
  return { refusal: null, unverified };
}

/**
 * The daemon's company-record shipper config (EM#2104). Without it spawnShipAfterRun returns silently, so the
 * daemon ran for days shipping nothing and every invoice week read partial (2026-11-17: the unit's Doppler key
 * list never carried these). The daemon refuses to start without them; --once runs do not ship and are exempt.
 */
export function shipConfigRefusal(config: { metrics?: { enabled?: boolean } }, env: NodeJS.ProcessEnv = process.env): string | null {
  // Only the metrics observer ships (spawnShipAfterRun runs from it); a disabled one needs none of this.
  if (config.metrics?.enabled !== true) return null;
  const missing = [BASE_URL_ENV, KEY_ENV, WATERMARK_KEY_ENV].filter((name) => !env[name]?.trim());
  if (!missing.length) return null;
  return (
    `missing company-record shipper config: ${missing.join(", ")}. Without ${missing.length > 1 ? "them" : "it"} no ` +
    `foreman-session event reaches the receiver and every invoice week reads partial. Add ` +
    `${missing.length > 1 ? "them" : "it"} to the service unit's Doppler --keys list (prd).`
  );
}
