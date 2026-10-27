/**
 * Claude Code workspace trust for every checkout the Foreman runs a session in.
 *
 * A headless `claude --print` session in a directory Claude Code has never been
 * told to trust ignores that repo's `.claude/settings.json` permissions and its
 * `.mcp.json` servers, and says so only on stderr ("this workspace has not been
 * trusted", "headersHelper not run — this workspace has no persisted trust").
 * Nothing fails: the session just runs without the repo's own tools and hooks.
 * An operator who has never opened Claude Code interactively in each checkout
 * cannot know to fix it, so the Foreman does: listing a repo in the config is
 * the operator's consent to run Claude sessions there, and trust is the flag
 * that lets those sessions see the repo's own settings. `trustManagedRepos:
 * false` turns this off for anyone who manages trust themselves.
 *
 * Trust lives in Claude Code's global config — `$CLAUDE_CONFIG_DIR/.claude.json`
 * when that is set, otherwise `~/.claude.json` — under
 * `projects[<absolute path>].hasTrustDialogAccepted`. Running Claude processes
 * rewrite that same file, so every write here is: read-check first (no write
 * when already trusted), re-read immediately before writing, keep every other
 * key, write a temp file with the original mode and rename it over atomically,
 * then read back to verify. A file that does not parse is never written — a
 * clobbered config would cost the operator their login and every project's
 * history. The file holds credentials: nothing here logs its contents.
 */
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "./logger.js";

export type TrustOutcome = "already" | "trusted" | "skipped" | "disabled";

// Off until the Foreman's entry point configures it from `trustManagedRepos`
// (the daemon on start and reload, `--once` before its cycle). Code that calls
// the phases directly — the test suite, a library consumer — never writes to the
// operator's Claude config unless it opts in here.
let enabled = false;
/** Paths already logged as trusted this process, so each is said once. */
const announced = new Set<string>();

/** Turn the feature on or off (config `trustManagedRepos`, default on). */
export function configureClaudeTrust(opts: { enabled: boolean }): void {
  enabled = opts.enabled;
}

export function claudeTrustEnabled(): boolean {
  return enabled;
}

/** Where the Claude Code process with this env reads its global config. */
export function claudeConfigPath(env: Record<string, string | undefined> = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir) return join(dir, ".claude.json");
  return join(env.HOME || homedir(), ".claude.json");
}

/** True when a stderr line is Claude Code saying the cwd is not trusted. */
export function isUntrustedWarning(line: string): boolean {
  return /has not been trusted|no persisted trust/i.test(line);
}

type Read =
  | { ok: true; cfg: Record<string, unknown>; mode: number | undefined }
  | { ok: false; reason: string };

function readConfig(file: string): Read {
  if (!existsSync(file)) return { ok: true, cfg: {}, mode: undefined };
  let text: string;
  let mode: number;
  try {
    text = readFileSync(file, "utf8");
    mode = statSync(file).mode & 0o777;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const cfg: unknown = JSON.parse(text);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      return { ok: false, reason: "top level is not an object" };
    }
    return { ok: true, cfg: cfg as Record<string, unknown>, mode };
  } catch {
    // Never echo the parse error: it can quote the file's contents.
    return { ok: false, reason: "does not parse as JSON" };
  }
}

function isTrusted(cfg: Record<string, unknown>, keys: readonly string[]): boolean {
  const projects = cfg.projects as Record<string, { hasTrustDialogAccepted?: unknown }> | undefined;
  return keys.every((k) => projects?.[k]?.hasTrustDialogAccepted === true);
}

/**
 * The keys Claude Code may look the checkout up by: the absolute path as
 * configured, and — when a symlink sits on the way — the real path, which is the
 * cwd a spawned process actually reports.
 */
function trustKeys(dir: string): string[] {
  const abs = resolve(dir);
  let real = abs;
  try { real = realpathSync(abs); } catch { /* not on disk yet */ }
  return real === abs ? [abs] : [abs, real];
}

/**
 * Make sure Claude Code trusts `dir`. Writes only when the flag is missing.
 * Never throws: a failure here must not stop a session, only leave it as it was.
 */
export function ensureClaudeTrust(
  dir: string,
  logger: Logger,
  env: Record<string, string | undefined> = process.env,
  reason = "managed repo",
): TrustOutcome {
  if (!enabled) return "disabled";
  const keys = trustKeys(dir);
  const path = keys[0];
  const file = claudeConfigPath(env);

  const first = readConfig(file);
  if (!first.ok) {
    logger.warn(`Claude Code trust: ${file} ${first.reason} — not touching it; ${path} stays untrusted`);
    return "skipped";
  }
  if (isTrusted(first.cfg, keys)) return "already";

  // Re-read right before the write: a running Claude process may have rewritten
  // the file since the check, and its change must survive ours.
  const fresh = readConfig(file);
  if (!fresh.ok) {
    logger.warn(`Claude Code trust: ${file} ${fresh.reason} — not touching it; ${path} stays untrusted`);
    return "skipped";
  }
  if (isTrusted(fresh.cfg, keys)) return "already";

  const cfg = fresh.cfg;
  const projects = (cfg.projects && typeof cfg.projects === "object" && !Array.isArray(cfg.projects)
    ? cfg.projects
    : {}) as Record<string, Record<string, unknown>>;
  for (const k of keys) projects[k] = { ...(projects[k] ?? {}), hasTrustDialogAccepted: true };
  cfg.projects = projects;

  const tmp = `${file}.trust-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: fresh.mode ?? 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    logger.warn(`Claude Code trust: could not write ${file} (${err instanceof Error ? err.message : String(err)}); ${path} stays untrusted`);
    return "skipped";
  }

  const check = readConfig(file);
  if (!check.ok || !isTrusted(check.cfg, keys)) {
    logger.warn(`Claude Code trust: wrote ${file} but ${path} does not read back as trusted — a concurrent writer may have replaced it; will retry before the next session`);
    return "skipped";
  }
  if (!announced.has(`${file}\0${path}`)) {
    announced.add(`${file}\0${path}`);
    logger.info(`trusted ${path} for Claude Code (${reason})`);
  }
  return "trusted";
}

/** Read-only: what Claude Code's config says about `dir` (the doctor's check). */
export function claudeTrustStatus(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): "trusted" | "untrusted" | "unreadable" {
  const r = readConfig(claudeConfigPath(env));
  if (!r.ok) return "unreadable";
  return isTrusted(r.cfg, trustKeys(dir)) ? "trusted" : "untrusted";
}

/** Trust every configured repo checkout (daemon start and each config reload). */
export function trustManagedRepos(
  repos: readonly { repoPath: string }[],
  logger: Logger,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!enabled) return;
  for (const r of repos) {
    if (!existsSync(r.repoPath)) continue; // not cloned yet; the pre-spawn check covers it
    ensureClaudeTrust(r.repoPath, logger, env);
  }
}

/** Test seam: forget which paths were announced and switch back off. */
export function resetClaudeTrustForTests(): void {
  announced.clear();
  enabled = false;
}
