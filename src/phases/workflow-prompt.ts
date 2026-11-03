import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoConfig } from "../config.js";

// Claude is multimodal — when issue bodies or PR review comments include
// markdown image references like ![alt](url), the agent must fetch each image
// to a local file and Read it. Without this, the model sees only the URL string
// and is blind to visual specs (mockups, screenshots, walkthrough frames).
//
// Authorization header is required for private-repo URLs
// (e.g. github.com/<owner>/<repo>/raw/<branch>/<path>) and harmless for public
// CDN URLs (e.g. github.com/user-attachments/...).
export const IMAGE_HANDLING_INSTRUCTIONS = `IMAGE HANDLING: If an issue body or PR review comment contains markdown image references like \`![alt](https://...)\`, those images are part of the spec. Fetch each image to a temp file and Read it so you can see it:

  curl -sL -H "Authorization: token $GH_TOKEN" -o /tmp/foreman-image-<n>.png "<url>"
  Then call the Read tool on /tmp/foreman-image-<n>.png — the multimodal model will see the image content.

The Authorization header is required for private-repo URLs (github.com/.../raw/...) and harmless for public CDN URLs (github.com/user-attachments/...). If a fetch fails, log a warning and proceed with the text spec — do not abort the implementation.`;

/**
 * The generic skills shipped with the Foreman, selected per repo with
 * `skillPath: "builtin:"` / `revisionSkillPath: "builtin:"`. Resolved from this
 * file's own location (like FOREMAN_OVERRIDES), never from cwd — the session
 * runs inside the managed repo, where `skills/` means something else or nothing.
 * Kept out of `.claude/skills/` so Claude Code does not offer them as
 * user-invocable skills in a session opened on the Foreman itself.
 */
export const BUILTIN_SKILL = "builtin:";
const FOREMAN_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");


export type PromptPart = { ok: true; text: string } | { ok: false; error: string };

/**
 * The opening instruction for a skill-mode prompt. A repo-local path is handed
 * to the session to read, exactly as before. `builtin:` inlines the bundled
 * SKILL.md instead of pointing at it: the text the session follows is then the
 * text this Foreman build shipped with, wherever the package is installed.
 */
export function skillInstruction(config: RepoConfig, skillPath: string, builtin: "implement" | "revise"): PromptPart {
  if (skillPath !== BUILTIN_SKILL) return { ok: true, text: `Read and follow the skill at ${skillPath}.` };
  const file = join(FOREMAN_SKILLS_DIR, builtin, "SKILL.md");
  try {
    const body = readFileSync(file, "utf8").trim();
    // The built-in skill is the same text for every repo, so the per-repo
    // facts it cannot carry are stated here. Labels are not among them: they
    // reach the session as FOREMAN_TRIGGER_LABEL / FOREMAN_LIFECYCLE_LABELS /
    // FOREMAN_BLOCKED_LABEL / FOREMAN_PRIORITY_LABELS.
    return {
      ok: true,
      text: `Follow the skill below — the Foreman's built-in skills/${builtin}/SKILL.md.\n\n` +
        `Repository: ${config.githubRepo}. Feature branch: ${config.featureBranch}. ` +
        `Pull requests target: ${config.baseBranch}.\n\n` +
        `===== SKILL =====\n${body}\n===== END SKILL =====`,
    };
  } catch (err) {
    return { ok: false, error: `built-in ${builtin} skill unreadable at ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * A configured overlay, read relative to the managed repo. Configured but
 * unreadable is a failure for this work item — running the skill without the
 * operator's rules would be a partial application, so the caller does not
 * launch Claude at all.
 */
export function readOverlay(config: RepoConfig, overlayPath: string | undefined, field: string): PromptPart {
  if (!overlayPath) return { ok: true, text: "" };
  const file = resolve(config.repoPath, overlayPath);
  try {
    const body = readFileSync(file, "utf8").trim();
    return { ok: true, text: `\n\n===== REPO OVERLAY (${overlayPath}) — applies on top of the skill above =====\n${body}\n===== END OVERLAY =====` };
  } catch (err) {
    return { ok: false, error: `${field} ${overlayPath} unreadable at ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
