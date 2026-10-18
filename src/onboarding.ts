// Repo onboarding: what a repo needs before the Foreman gives it any work.
//
// A repo enters the Foreman two ways — in the config at start-up, or added to
// it while the daemon runs (daemon.ts hot-reload). Either way its lanes start
// on the next pass, and the first label write of an issue's life (`gh issue
// edit --add-label "pr under review"`) is the first thing that would notice a
// missing label: mid-flow, with the issue already half-moved. So before a
// repo's first lane pass, the labels the Foreman runs on are created where
// missing, and no lane runs on the repo until that has succeeded.
//
// The other two things a new repo needs already happen ahead of its first
// piece of work, so they are not repeated here: skill sync commits the repo's
// skills onto the feature branch before the implement session starts
// (phases/implement.ts), and the board mirror publishes the repo's cards after
// every pass (orchestrator.ts publishBoard).
//
// Read, then create only — the same contract as scripts/install-labels.mjs:
// one paginated GET, one POST per missing name, never a PATCH or DELETE, so an
// existing label's colour, description and issues are never touched.

import { formatGhError } from "./github/cache.js";
import { gh } from "./github/gh.js";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** GitHub's own default label colour; colour is not configurable. */
const COLOR = "ededed";

/** A failed onboarding is retried no sooner than this, however often the lanes poll. */
export const ONBOARD_RETRY_MS = 60_000;

/** The labels a repo must carry: its trigger, every lifecycle label, the blocked label. */
export function labelsFor(repo: RepoConfig): string[] {
  return [...new Set([repo.triggerLabel, ...Object.values(repo.lifecycleLabels), repo.github.blockedLabel])];
}

type Entry = { done: true } | { done: false; inFlight?: Promise<boolean>; retryAt: number };

// Keyed by repo and label set, so renaming a label in the config onboards again.
const onboarded = new Map<string, Entry>();

function keyOf(repo: RepoConfig): string {
  return `${repo.githubRepo}\n${labelsFor(repo).join("\n")}`;
}

/** Test hook: forget every repo onboarded in this process. */
export function resetOnboarding(): void {
  onboarded.clear();
}

/**
 * True once `repo` carries every label it needs. The first call does the work;
 * later calls answer from memory, and every lane of the repo shares one attempt.
 * After a failure, false until ONBOARD_RETRY_MS has passed, then one more try.
 */
export async function onboardRepo(repo: RepoConfig, logger: Logger, now = Date.now()): Promise<boolean> {
  const key = keyOf(repo);
  const entry = onboarded.get(key);
  if (entry?.done) return true;
  if (entry?.inFlight) return entry.inFlight;
  if (entry && now < entry.retryAt) return false;

  const log = logger.child({ repo: repo.name, phase: "onboard" });
  const attempt = Promise.resolve().then(() => installLabels(repo, log));
  onboarded.set(key, { done: false, inFlight: attempt, retryAt: 0 });
  const ok = await attempt;
  onboarded.set(key, ok ? { done: true } : { done: false, retryAt: now + ONBOARD_RETRY_MS });
  return ok;
}

function firstLine(err: unknown): string {
  const { message, stderr } = formatGhError(err);
  return (stderr || message).split("\n")[0];
}

function installLabels(repo: RepoConfig, log: Logger): boolean {
  const wanted = labelsFor(repo);
  let existing: Set<string>;
  try {
    const out = gh(["api", "-X", "GET", `repos/${repo.githubRepo}/labels`, "--paginate", "--jq", ".[].name"], repo.repoPath);
    existing = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch (err) {
    log.warn(`Onboarding: could not read ${repo.githubRepo}'s labels — no work starts on this repo until it can (${firstLine(err)})`);
    return false;
  }

  const missing = wanted.filter((name) => !existing.has(name));
  if (missing.length === 0) {
    log.debug(`Onboarding: all ${wanted.length} labels present`);
    return true;
  }

  const failed: string[] = [];
  for (const name of missing) {
    try {
      gh(["api", "-X", "POST", `repos/${repo.githubRepo}/labels`, "-f", `name=${name}`, "-f", `color=${COLOR}`], repo.repoPath);
    } catch (err) {
      // Created by someone else between the read and this write: present, so fine.
      const { message, stderr } = formatGhError(err);
      if (/already_exists/i.test(`${stderr} ${message}`)) continue;
      failed.push(`"${name}" (${firstLine(err)})`);
    }
  }
  if (failed.length) {
    log.warn(`Onboarding: could not create ${failed.join(", ")} on ${repo.githubRepo} — no work starts on this repo until they exist`);
    return false;
  }
  log.info(`Onboarding: created ${missing.map((n) => `"${n}"`).join(", ")} on ${repo.githubRepo}`);
  return true;
}
