import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { pickEnv, SESSION_ENV_ESSENTIALS } from "../session/env.js";
import type { QaManifest, QaOutcome } from "../qa-report.js";
import { runAgentCli, type CliRun } from "./agent-cli.js";
import type { ForemanPlugin, QaRunner } from "./contract.js";

/**
 * slashbin_ai_qa (`<qaPath>/bin/qa.mjs check`) as the QA plugin (EM#1150 f3).
 * On when `qaPath` is set; it covers the repos in `qaRepos`. What the Foreman
 * does with an outcome (the gate, the report, QA before the merge) is core
 * (qa-report.ts); running QA and reading its exit and manifest is here.
 */

/**
 * Plugin config: the key the dev run's one secret is fetched under. The script that
 * fetches it is config `qaSecretsRunner` (an EM-checkout script that hands one named
 * key to one child, and nothing else).
 */
export interface QaPluginOptions {
  /** The secret key the dev run needs (project = the repo, config dev). */
  mintKey?: string;
}

/**
 * One QA run's ceiling; past it the child is killed and the PR gets an "errored" comment.
 * QA reviews serially, one Codex run per 4 shots (slashbin_ai_qa `lib/review.mjs` BATCH_SIZE)
 * plus a 2-run control, each allowed 900 s (`lib/review.mjs:113`, `lib/codex.mjs:49`), so its
 * own ceiling grows with the pages a PR touches. Slashbin-console PR #1518 (a `shared/schema.ts`
 * change fans out to all 18 routes, 72 shots, 18 batches) was still reviewing when 20 minutes
 * killed it (2026-10-29 21:03Z, capture had taken 4 min). 90 minutes covers that review; a
 * longer one is a tooling hold (`qa-errored`) that retries without charging (slashbin-ai-foreman#137).
 */
export const QA_MAX_DURATION_MS = 90 * 60_000;

/**
 * Which QA step a killed run was in, from its `[qa]` progress lines on stderr
 * (`lib/check.mjs`): "review" once it logged "captured N shots; reviewing", "capture"
 * once it resolved pages or took a shot, else "setup". Pure.
 */
export function qaStepOf(stderr: string): "setup" | "capture" | "review" {
  const lines = stderr.split("\n").filter((l) => l.startsWith("[qa] "));
  if (lines.some((l) => /\bcaptured \d+ shots; reviewing\b/.test(l))) return "review";
  if (lines.some((l) => /^\[qa\] (shot |resolved |affected pages)/.test(l))) return "capture";
  return "setup";
}

/**
 * The registry bearer's runner key (EM#794 C): QA reads the registry with it. Names only; the runner
 * hands the value to the QA child alone. Config `qaBearerKey` (a profile pins it to its one home).
 * The team bot's SLASHBIN_MCP_ROUTER_BEARER is retired (it answers 401) and is no longer asked for.
 */
export const qaBearerKeys = (config: AgentConfig): string[] => [config.qaBearerKey];

/** `covers` needs only the bearer, which lives only in `prd`: one config, one names call. */
const QA_COVERS_CONFIGS = "prd";

/** A settled covered / not-covered answer is kept this long; registry coverage changes by PR, not by poll. */
export const QA_COVERS_TTL_MS = 60 * 60 * 1000;

/** The runner's config search order for every QA call: the bearer lives only in `prd`, the mint key in `dev`. */
const QA_KEY_CONFIGS = "dev,prd";

/**
 * The QA hand-off's environment: essentials, `sessionEnv`, and the Foreman's own
 * token as GH_TOKEN (QA reads the PR with `gh pr view`; the Foreman is the reader
 * every Claude session already runs as). QA's secrets (the mint key, the registry
 * bearer) are NOT here and not in the daemon env: `qaSecretsRunner` in the EM
 * checkout fetches them for the QA child alone.
 */
export function buildQaEnv(agentConfig: AgentConfig): Record<string, string> {
  const env = pickEnv([...SESSION_ENV_ESSENTIALS, ...(agentConfig.sessionEnv ?? [])]);
  if (process.env.FOREMAN_GITHUB_TOKEN) env.GH_TOKEN = process.env.FOREMAN_GITHUB_TOKEN;
  return env;
}

/** Exit 0/1/3 with a readable manifest is a result; a timeout, any other exit or a missing manifest is an error. */
export function readOutcome(r: CliRun, out: string, logger: Logger): QaOutcome {
  if (r.timedOut) {
    const step = qaStepOf(r.stderr);
    const last = r.stderr.split("\n").filter((l) => l.startsWith("[qa] ")).pop() ?? "(no progress line)";
    logger.warn(`QA: killed at ${QA_MAX_DURATION_MS / 60_000} minutes during ${step}; last line: ${last.slice(0, 200)}`);
    return { kind: "errored", detail: `timed out after ${QA_MAX_DURATION_MS / 60_000} minutes during the ${step} step` };
  }
  if (![0, 1, 3].includes(r.code ?? -1)) {
    // stderr tail goes to the log only (already redacted of known secrets), never onto the PR.
    logger.warn(`QA: exit ${r.code}; tail: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    return { kind: "errored", detail: `exit code ${r.code}` };
  }
  try {
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as QaManifest;
    if (!manifest.verdict) return { kind: "errored", detail: "manifest.json has no verdict" };
    return { kind: "manifest", exitCode: r.code as number, manifest };
  } catch (e) {
    return { kind: "errored", detail: `exit ${r.code} but manifest.json is unreadable (${String(e).slice(0, 100)})` };
  }
}

export class QaPlugin implements ForemanPlugin {
  readonly id = "qa";
  readonly roles = ["qa"] as const;
  readonly qa: QaRunner;
  private readonly mintKey: string;
  /** Per repo: the coverage answer (or the one in flight) and when it was asked. */
  private readonly coverage = new Map<string, { at: number; ttl: number; answer: Promise<boolean | "unknown"> }>();

  constructor(opts: QaPluginOptions = {}) {
    this.mintKey = opts.mintKey ?? "DEV_SESSION_MINT_KEY";
    this.qa = {
      covers: (repo, config) => this.covers(repo.githubRepo, config),
      check: (_repo, config, args, logger) => (args.local ? this.checkLocal(config, args, logger) : this.checkDev(config, args, logger)),
    };
  }

  /**
   * Whether QA covers `repo` (EM#794 C). A `qaRepos` repo is covered with no spawn (the override: covered even
   * when QA says no). Otherwise QA answers: `qa.mjs covers --repo R` through the secrets runner, exit 0 =
   * covered, exit 1 = not. A missing runner or `emRepoPath`, or a QA with no `covers` subcommand (any other
   * exit), is not covered, so the Console stays covered and any other repo uncovered until QA can answer.
   * Output naming `registry-unavailable`, a timeout or a spawn error is "unknown". Memoized per repo for
   * `QA_COVERS_TTL_MS` once settled, "unknown" for `pollIntervalMs` (one shared in-flight promise); the spawn
   * is killed at `pollIntervalMs`. Never throws.
   */
  private covers(repo: string, config: AgentConfig): Promise<boolean | "unknown"> {
    if (config.qaRepos.includes(repo)) return Promise.resolve(true);
    const poll = config.pollIntervalMs;
    const hit = this.coverage.get(repo);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.answer;
    const entry = { at: Date.now(), ttl: poll, answer: Promise.resolve<boolean | "unknown">("unknown") };
    entry.answer = this.askQa(repo, config, poll)
      .catch((): "unknown" => "unknown")
      .then((a) => {
        if (a !== "unknown") entry.ttl = Math.max(poll, QA_COVERS_TTL_MS);
        return a;
      });
    this.coverage.set(repo, entry);
    return entry.answer;
  }

  private async askQa(repo: string, config: AgentConfig, maxMs: number): Promise<boolean | "unknown"> {
    const { emRepoPath: em, qaPath: qa, qaSecretsRunner: runner } = config;
    if (!em || !qa || !runner) return false;
    const args = ["--keys", qaBearerKeys(config).join(","), QA_COVERS_CONFIGS, "--", "node", join(qa, "bin/qa.mjs"), "covers", "--repo", repo];
    const r = await runAgentCli(em, runner, args, buildQaEnv(config), config, maxMs);
    if (r.timedOut) return "unknown";
    if (/registry-unavailable/.test(`${r.stdout}\n${r.stderr}`)) return "unknown";
    if (r.code === null || r.code < 0) return "unknown"; // killed by a signal, or never launched (ENOENT closes with a negative errno)
    return r.code === 0;
  }

  enabled(config: AgentConfig): boolean {
    return Boolean(config.qaPath);
  }

  /** On dev: `qa.mjs check` under `qaSecretsRunner` in the EM checkout, which gives the mint key to that child alone. */
  private async checkDev(config: AgentConfig, { repo, pr, out }: { repo: string; pr: number; out: string }, logger: Logger): Promise<QaOutcome> {
    const em = config.emRepoPath;
    const qa = config.qaPath;
    if (!em || !qa) return { kind: "errored", detail: "emRepoPath and qaPath must both be set" };
    const runner = config.qaSecretsRunner;
    if (!runner) return { kind: "errored", detail: "qaSecretsRunner is not set, so the dev run has no way to get its secret" };
    const keys = [`${this.mintKey}@${repo}`, ...qaBearerKeys(config)].join(",");
    const args = ["--keys", keys, QA_KEY_CONFIGS, "--", "node", join(qa, "bin/qa.mjs"), "check", "--repo", repo, "--pr", String(pr), "--out", out];
    const r = await runAgentCli(em, runner, args, buildQaEnv(config), config, QA_MAX_DURATION_MS);
    return readOutcome(r, out, logger);
  }

  /**
   * Locally, before the merge: `qa.mjs check --local` boots the PR itself and generates its own
   * mint key, so it needs only the registry bearer, which `qaSecretsRunner` hands it. It needs git,
   * npm, the network and GH_TOKEN, all in `buildQaEnv`. With no runner it is `errored`, as the dev run is.
   */
  private async checkLocal(config: AgentConfig, { repo, pr, out }: { repo: string; pr: number; out: string }, logger: Logger): Promise<QaOutcome> {
    const em = config.emRepoPath;
    const qa = config.qaPath;
    if (!em || !qa) return { kind: "errored", detail: "emRepoPath and qaPath must both be set" };
    const runner = config.qaSecretsRunner;
    if (!runner) return { kind: "errored", detail: "qaSecretsRunner is not set, so the local run has no way to get the registry bearer" };
    // A manifest left by an earlier run must never be read as this one's.
    rmSync(join(out, "manifest.json"), { force: true });
    const args = ["--keys", qaBearerKeys(config).join(","), QA_KEY_CONFIGS, "--", "node", join(qa, "bin/qa.mjs"), "check", "--local", "--repo", repo, "--pr", String(pr), "--out", out];
    const r = await runAgentCli(em, runner, args, buildQaEnv(config), config, QA_MAX_DURATION_MS);
    return readOutcome(r, out, logger);
  }
}
