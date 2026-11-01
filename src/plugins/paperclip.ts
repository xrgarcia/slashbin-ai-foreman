import type { AgentConfig } from "../config.js";
import { secretValues } from "../agent.js";
import { PaperclipClient } from "../paperclip/client.js";
import { PaperclipMirror } from "../paperclip/mirror.js";
import { runDoctor } from "../paperclip/doctor.js";
import type { ForemanPlugin, PluginContext } from "./contract.js";

/**
 * The session secrets plus the Paperclip key, so a refused response that echoes
 * the key is logged redacted. The key is kept out of `sessionEnv`, which would
 * hand it to agent sessions. Same 8-character floor and longest-first order as
 * secretValues.
 */
export function mirrorSecrets(sessionEnv: readonly string[], apiKey: string | undefined): Array<{ name: string; value: string }> {
  const out = secretValues(sessionEnv);
  if (apiKey && apiKey.length >= 8 && !out.some((s) => s.value === apiKey)) {
    out.push({ name: "AI_AGENT_PAPERCLIP_API_KEY", value: apiKey });
  }
  return out.sort((a, b) => b.value.length - a.value.length);
}

/**
 * Paperclip (EM#417): an observer of the Foreman's steps, never a work source.
 * Enabled once at startup; a config reload does not add or drop it, but its
 * board mapping follows the reload, and the file it runs is published on its
 * agent for anything else that places the same cards.
 */
export class PaperclipPlugin implements ForemanPlugin {
  readonly id = "paperclip";
  readonly roles = ["observer"] as const;
  readonly commands = {
    "paperclip:doctor": (config: AgentConfig) => runDoctor(config),
  };
  private mirror: PaperclipMirror | null = null;
  private mirroredText: string | null = null;

  get observer(): PaperclipMirror | undefined {
    return this.mirror ?? undefined;
  }

  enabled(config: AgentConfig): boolean {
    return config.paperclip.enabled && !!config.paperclip.agentId && !!config.paperclip.companyId;
  }

  disabledReason(config: AgentConfig): string | undefined {
    return config.paperclip.enabled ? "paperclip mirror enabled but no agentId configured; run npm run paperclip:register" : undefined;
  }

  start(config: AgentConfig, ctx: PluginContext): void {
    const { logger } = ctx;
    this.mirror = new PaperclipMirror(
      new PaperclipClient({
        url: config.paperclip.url,
        companyId: config.paperclip.companyId!,
        apiKey: config.paperclip.apiKey,
        warn: (m) => logger.warn(m),
        // The activity feed names the Foreman for its own writes, not the key's user.
        actingAs: config.paperclip.agentId ? `agent:${config.paperclip.agentId}` : undefined,
      }),
      config.paperclip,
      mirrorSecrets(config.sessionEnv, config.paperclip.apiKey),
      logger,
      config.lifecycleLabels,
    );
    // Housekeeping off the observer queue: project backfill, retiring the old live task.
    this.mirror.start();
    this.mirroredText = ctx.configText();
    if (this.mirroredText !== null) void this.mirror.publishConfig(this.mirroredText);
    logger.info(`Paperclip mirror on: ${config.paperclip.url}`);
  }

  /** A reload whose file changed hands the mirror the new mapping, then publishes it. */
  reconfigure(fresh: AgentConfig, ctx: PluginContext): void {
    if (!this.mirror) return;
    const text = ctx.configText();
    if (text === null || text === this.mirroredText) return;
    this.mirroredText = text;
    if (this.mirror.reconfigure(fresh.paperclip)) void this.mirror.publishConfig(text);
  }
}
