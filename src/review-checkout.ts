/**
 * The service-repo working copy a review session reads the code from.
 *
 * ## Why this file exists
 *
 * A review session's cwd is the EM repo, so it does not have the code it is
 * reviewing, and nothing in the prompt or the skill ever said where to get it.
 * Left to improvise, every run invented its own answer: `git clone` into /tmp
 * under a name it made up — `sbc1006`, `js520`, `jerky_shipping_rev`,
 * `cli-review`, then `cli-review-2` when it wanted a second one — and never
 * removed any of them.
 *
 * /tmp on this host is a tmpfs with a HARD CAP of 1,048,576 inodes. A repo plus
 * its node_modules is 40k-95k of them. On 2026-09-12, 140 accumulated review
 * clones exhausted the cap at 84% of BYTES used, so every `df -h` read healthy
 * while the box was out of files. Claude Code creates an output file before
 * every command, so once that happens no agent can run anything at all — not
 * `rm`, not `df`, not `true`. Two Foreman runs failed that morning for no
 * reason other than being unable to write.
 *
 * ## The fix, and the rule
 *
 * One checkout per repo, owned by the Foreman: predictable path, on the root
 * filesystem (66M inodes) rather than the tmpfs, created before the review
 * session and named to it so it never clones anything itself.
 *
 * It is KEPT while the repo still has queued work, because the expensive part
 * is `npm install`, not the clone, and a repo with three approved issues will
 * be reviewed again within minutes. It is DELETED when the queue empties —
 * "this was the last one" is exactly when nobody is coming back for it.
 *
 * A checkout is a cache, never state: everything in it is either pushed or
 * discardable, so deleting one can lose nothing but time.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";

export function checkoutPathFor(config: AgentConfig, repoConfig: RepoConfig): string {
  return join(config.reviewCheckoutRoot, repoConfig.name);
}

function git(args: string[], cwd: string, timeoutMs = 300_000) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs });
}

/**
 * Ensure the repo's review checkout exists and is current.
 *
 * Never fatal. A review that cannot get a fresh checkout is still better run
 * than skipped — the session has `gh` and can fall back — so every failure
 * here returns null and is logged, rather than taking the phase down.
 */
export function prepareReviewCheckout(
  config: AgentConfig,
  repoConfig: RepoConfig,
  logger: Logger,
): string | null {
  const path = checkoutPathFor(config, repoConfig);
  const slug = repoConfig.githubRepo;
  if (!slug) return null;

  try {
    mkdirSync(config.reviewCheckoutRoot, { recursive: true });

    if (existsSync(join(path, ".git"))) {
      // Reuse. `--prune` matters: without it, branches deleted upstream linger
      // and a stale ref can be checked out as though it were live.
      const fetched = git(["fetch", "--all", "--prune", "--quiet"], path);
      if (fetched.status === 0) {
        logger.debug(`Review checkout refreshed: ${path}`);
        return path;
      }
      // A corrupt or half-written checkout is not worth diagnosing in-flight.
      logger.warn(`Review checkout at ${path} could not fetch — recloning`, {
        stderr: (fetched.stderr || "").slice(0, 400),
      });
      rmSync(path, { recursive: true, force: true });
    }

    // No token in the URL. A clone URL with a credential in it is written
    // verbatim into .git/config, which leaves the token sitting at rest in a
    // world-readable directory for as long as the checkout lives. gh's
    // credential helper covers auth for a public-or-permitted clone.
    const cloned = git(["clone", "--quiet", `https://github.com/${slug}.git`, path], config.reviewCheckoutRoot);
    if (cloned.status !== 0) {
      logger.warn(`Review checkout clone failed for ${slug} — the session will have to fetch its own code`, {
        stderr: (cloned.stderr || "").slice(0, 400),
      });
      return null;
    }
    logger.info(`Review checkout created: ${path}`);
    return path;
  } catch (err) {
    logger.warn(`Review checkout unavailable for ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Delete the checkout when the repo has nothing else queued.
 *
 * `queuedWork` is the count of things that would bring a session straight back
 * to this repo — approved issues waiting to be built, and open PRs waiting to
 * be reviewed. Above zero we keep the checkout and its node_modules; at zero
 * this was the last one and the disk goes back.
 */
export function releaseReviewCheckout(
  config: AgentConfig,
  repoConfig: RepoConfig,
  queuedWork: number,
  logger: Logger,
): void {
  const path = checkoutPathFor(config, repoConfig);
  if (!existsSync(path)) return;

  if (queuedWork > 0) {
    logger.debug(`Keeping review checkout for ${repoConfig.name} — ${queuedWork} item(s) still queued`);
    return;
  }

  try {
    rmSync(path, { recursive: true, force: true });
    logger.info(`Review checkout released for ${repoConfig.name} — queue empty, reclaimed ${path}`);
  } catch (err) {
    logger.warn(`Could not remove review checkout ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
