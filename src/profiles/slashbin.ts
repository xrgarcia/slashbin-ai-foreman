import type { ConfigProfile } from "./index.js";

/**
 * Slashbin's fleet: the defaults the Foreman shipped with before profiles
 * (EM#1150 f7). Selected with `"profile": "slashbin"` in `.ai-agent.json`; with
 * it, every value below resolves exactly as it did when it was a literal in the
 * core. Anything the file sets explicitly still wins.
 */
export const slashbinProfile: ConfigProfile = {
  // The person the unstick stage @-mentions when every EM call for a hold failed.
  unstickEscalationOwner: "xrgarcia",
  // QA supports only the Console today.
  qaRepos: ["xrgarcia/Slashbin-console"],
  // The EM checkout's wrapper that hands QA's dev run its one Doppler key.
  qaSecretsRunner: "scripts/secrets/doppler-run.mjs",
  // The registry bearer QA reads with, pinned to its one Doppler home so the runner lists that
  // project alone. Unpinned, every `covers` spawn listed every project; on 2026-11-07 that hit
  // Doppler's 240-a-minute account limit and took every agent's secrets down.
  qaBearerKey: "EM_SLASHBIN_MCP_ROUTER_BEARER@xrgarcia/slashbin-engineering-manager",
  // The review session's MCP servers, as Slashbin's fleet names them.
  reviewAllowedTools: [
    "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch",
    "mcp__github__*",
    "mcp__pg-dev-console__*", "mcp__pg-dev-worker__*",
    "mcp__pg-prod-console__*", "mcp__pg-prod-worker__*",
    "mcp__redis-dev-console__*", "mcp__redis-dev-ingest__*", "mcp__redis-dev-worker__*",
    "mcp__redis-prod-console__*", "mcp__redis-prod-ingest__*", "mcp__redis-prod-worker__*",
    "mcp__railway__*",
    "mcp__slashbin-ai-knowledge__*",
  ],
  // Issue bodies name their epic as `engineering-manager #N` under `## References`.
  epicRefLabel: "engineering-manager",
  // The epics live in the EM repo; one closed there is not asked about.
  epicRepo: "xrgarcia/slashbin-engineering-manager",
  // Slashbin's Paperclip fork credits a write to an agent through this header.
  paperclip: { commentAuthorHeader: "x-slashbin-comment-author" },
};
