// Custom (configured) stages: run a skill per stage, remember its verdict per head.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { emit } from "../work-source.js";
import { runCustomStage } from "./custom-workflow.js";
import { type CustomStage, type StageResult } from "../stages.js";
import { isUpstreamBlocked, tryAcquire, reportClaudeResult } from "../upstream-backoff.js";
import { CycleEvent, activeRuns, itemOf } from "./common.js";
import { reportLaunchThrew } from "./implement.js";
import { codeHost } from "../plugins/registry.js";
import type { CodeHost } from "../code-host.js";
import type { ForemanRuntime } from "../runtime.js";

/**
 * Run one custom stage for one repo: a single Claude session on the stage's
 * skill (runCustomStage), against the open feature PR. Nothing in flight → `ok`
 * with no session, so a pass with no open PR reaches the stages after it.
 *
 * Goes through the same gates as the other Claude phases: the upstream
 * back-off (`tryAcquire` / `reportClaudeResult`), the per-repo abort
 * controller, and the shutdown check in the dispatch loop. A run the upstream
 * refused is `blocked` without a verdict (not remembered, retried next pass).
 */
export async function tryCustomStage(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  stage: CustomStage,
  logger: Logger,
  events: CycleEvent[],
): Promise<StageResult & { ran: boolean }> {
  const stageLogger = logger.child({ phase: `stage:${stage.id}` });
  if (isUpstreamBlocked("github") || isUpstreamBlocked("claude")) {
    return { outcome: "blocked", reason: "upstream back-off", ran: false };
  }

  let pr: ReturnType<CodeHost["findOpenFeaturePR"]>;
  try {
    pr = codeHost().findOpenFeaturePR(repoConfig);
  } catch (err) {
    // Could not look is not "nothing to check": hold the later stages this pass.
    return { outcome: "blocked", reason: `work in flight unreadable: ${err instanceof Error ? err.message : String(err)}`, ran: false };
  }
  if (!pr) return { outcome: "ok", ran: false };

  const key = `${repoConfig.name}\0${stage.id}`;
  const prior = rt.memory.customStageVerdicts.get(key);
  if (prior && prior.headSha === pr.headSha) {
    return { outcome: prior.outcome, reason: prior.reason, ran: false };
  }

  if (!tryAcquire("claude")) return { outcome: "blocked", reason: "upstream back-off", ran: false };
  const runAbort = new AbortController();
  activeRuns.set(runAbort, repoConfig.name);
  try {
    const result = await runCustomStage(
      rt.trust, repoConfig, stage,
      { prNumber: pr.number, issueNumbers: pr.issueNumbers, headSha: pr.headSha },
      stageLogger, runAbort.signal,
    ).catch(reportLaunchThrew);
    reportClaudeResult(!!result.upstreamLimit, result.upstreamLimit?.reason, result.upstreamLimit?.resetAtMs);
    if (result.upstreamLimit) return { outcome: "blocked", reason: result.upstreamLimit.reason, ran: false };

    const outcome = result.verdict === "pass" ? "ok" : result.verdict;
    rt.memory.customStageVerdicts.set(key, { headSha: pr.headSha, outcome, reason: result.reason });
    const where = `${repoConfig.githubRepo} PR #${pr.number}`;
    if (outcome === "ok") {
      stageLogger.info(`Stage "${stage.id}" passed on ${where}`);
      events.push({ message: `Stage "${stage.id}" passed on ${where}`, level: "info" });
    } else {
      stageLogger.warn(`Stage "${stage.id}" ${outcome} on ${where}: ${result.reason ?? "no reason given"} — later stages held until ${repoConfig.featureBranch} moves`);
      events.push({
        message: `${outcome === "blocked" ? "⛔" : "⚠️"} Stage "${stage.id}" ${outcome} on ${where}: ${result.reason ?? "no reason given"}. Later stages are held for this repo until \`${repoConfig.featureBranch}\` moves.`,
        level: outcome === "blocked" ? "warn" : "error",
      });
      const why = `stage "${stage.id}" ${outcome} on PR #${pr.number}: ${result.reason ?? "no reason given"}`;
      for (const n of pr.issueNumbers) await emit(rt, { kind: "blocked", item: itemOf(repoConfig, n), reason: why }, repoConfig, stageLogger);
    }
    return { outcome, reason: result.reason, ran: true };
  } finally {
    activeRuns.delete(runAbort);
  }
}

