// The unstick stage (foreman#103): stuck work reaches the EM directly.
//
// Each pass reads what is stuck (src/unstick.ts: persisted state plus the
// `stuck` events that recorded the in-memory stops), calls
// `<emRepoPath>/bin/em.mjs unstick` once for each question not yet answered,
// and records the outcome in `RepoState.unstick`. It never clears a block (the
// unblock checks do, when the cause is gone), never writes Paperclip, and runs
// whether or not Paperclip is on. Without `emRepoPath` it does nothing.
//
// Retries: a failed call (any exit but 0/2/3, or the 20-minute timer) is made
// again on the next pass, up to UNSTICK_MAX_ATTEMPTS for one reason. An answer
// (invoked / escalated / declined) is final until the reason changes.

import { resolve } from "node:path";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { roleFor } from "../plugins/registry.js";
import type { UnstickOutcome } from "../plugins/contract.js";
import { commentOnIssue, getOpenIssues, hasLabel } from "../github.js";
import { loadRepoState, saveRepoState } from "../state.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import {
  EVENT_KINDS, RELEASE_GATE_REASON, UNSTICK_ESCALATION_OWNER, UNSTICK_MAX_ATTEMPTS, unstickGiveUpComment, derivedCandidates, needsCall, openEntry, unstickKey,
  type UnstickCandidate, type UnstickEntry,
} from "../unstick.js";
import { activeRuns, divergenceReason } from "./common.js";
import { isDeployFailureHold } from "./verify.js";

function transcript(repoConfig: RepoConfig, what: string, cycleNumber: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(process.cwd(), "logs", "unstick", `${repoConfig.name}-${what}-cycle${cycleNumber}-${ts}.log`);
}

/** Apply `fn` to the persisted table and save it (load and save are synchronous, so no other writer interleaves). */
function mutate(repoName: string, fn: (table: Record<string, UnstickEntry>) => void): void {
  const state = loadRepoState(repoName);
  const table = { ...(state.unstick ?? {}) };
  fn(table);
  saveRepoState(repoName, { ...state, unstick: table });
}

const toStatus = (o: UnstickOutcome): UnstickEntry["status"] => (o.kind === "failed" ? "failed" : o.kind);

/** Returns how many EM calls this pass made. Never throws. */
export async function tryUnstick(
  repoConfig: RepoConfig,
  config: AgentConfig,
  base: Logger,
  cycleNumber: number,
  deps: { comment?: typeof commentOnIssue } = {},
): Promise<number> {
  const unsticker = roleFor("unstick", config);
  if (!unsticker) return 0;
  const repoName = repoConfig.name;
  const log = base.child({ cycle: cycleNumber, repo: repoName, phase: "unstick" });
  try {
    const state = loadRepoState(repoName);
    const candidates: UnstickCandidate[] = derivedCandidates(state, {
      verifyMaxAttempts: config.backoff.verifyRetry.maxAttempts,
      isDeployFailureHold,
      divergenceReason,
    });

    // The release gate is read off the board, not off state: an issue at
    // `pr approved` (and not yet `ready for prod release`) waits on the EM's
    // outcome gate. When GitHub is unreachable the pass skips this kind and
    // prunes nothing it cannot see.
    let open: Set<number> | null = null;
    if (!isUpstreamBlocked("github")) {
      try {
        const issues = getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, log);
        open = new Set(issues.map((i) => i.number));
        const { prApproved, readyForProd } = repoConfig.lifecycleLabels;
        for (const i of issues) {
          if (hasLabel(i, prApproved) && !hasLabel(i, readyForProd)) {
            candidates.push({ issue: i.number, kind: "release-gate", reason: RELEASE_GATE_REASON });
          }
        }
      } catch (err) {
        log.warn(`Could not read open issues for the release gate: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Event-kind entries are candidates for as long as they stand.
    for (const e of Object.values(state.unstick ?? {})) {
      if (EVENT_KINDS.has(e.kind)) candidates.push({ issue: e.issue, kind: e.kind, reason: e.reason, ...(e.tag ? { tag: e.tag } : {}) });
    }

    const live = new Set(candidates.map((c) => unstickKey(c.issue, c.kind, c.tag)));
    const now = new Date().toISOString();
    mutate(repoName, (table) => {
      for (const [key, e] of Object.entries(table)) {
        // A derived question ends with its condition; an event question ends when its issue is no longer open.
        const derivedGone = !EVENT_KINDS.has(e.kind) && !live.has(key);
        const closed = EVENT_KINDS.has(e.kind) && open !== null && e.issue !== 0 && !open.has(e.issue);
        if (derivedGone || closed) delete table[key];
      }
      for (const c of candidates) {
        const key = unstickKey(c.issue, c.kind, c.tag);
        const next = openEntry(table[key], c, now);
        table[key] = next;
      }
    });

    let calls = 0;
    for (const c of candidates) {
      const key = unstickKey(c.issue, c.kind, c.tag);
      const entry = loadRepoState(repoName).unstick?.[key];
      if (!entry || !needsCall(entry, c)) continue;
      const ac = new AbortController();
      activeRuns.set(ac, repoName);
      let outcome: UnstickOutcome;
      try {
        outcome = await unsticker.unstick(repoConfig, config, c.issue, c.kind, c.reason, log, ac.signal,
          transcript(repoConfig, `${c.kind}-${c.issue}`, cycleNumber));
      } finally {
        activeRuns.delete(ac);
      }
      calls++;
      log.info(`EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): ${outcome.kind}${outcome.detail ? ` — ${outcome.detail.slice(0, 200)}` : ""}`);
      let spent: UnstickEntry | undefined;
      mutate(repoName, (table) => {
        const cur = table[key];
        // The reason changed while the call ran: it is a new question, answered next pass.
        if (!cur || cur.reason !== c.reason) return;
        table[key] = {
          ...cur,
          status: toStatus(outcome),
          attempts: cur.attempts + 1,
          lastCallAt: new Date().toISOString(),
          ...(outcome.detail ? { detail: outcome.detail.slice(0, 500) } : {}),
        };
        if (outcome.kind === "failed" && table[key]!.attempts >= UNSTICK_MAX_ATTEMPTS) spent = table[key];
      });
      // The attempt that spends the last call: say so once, on the issue. Stored
      // `escalated`, an unchanged reason never comments again; if the post
      // fails the entry stays `failed` at the cap (no retry, no throw).
      // Issue 0 is a repo-level hold with no issue to comment on.
      if (spent && c.issue > 0) {
        const owner = config.unstickEscalationOwner ?? UNSTICK_ESCALATION_OWNER;
        try {
          (deps.comment ?? commentOnIssue)(repoConfig, c.issue, unstickGiveUpComment(owner, spent));
          mutate(repoName, (table) => {
            const cur = table[key];
            if (cur && cur.reason === c.reason) table[key] = { ...cur, status: "escalated" };
          });
          log.warn(`EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): EM unreachable after ${UNSTICK_MAX_ATTEMPTS} calls — escalated to @${owner}`);
        } catch (err) {
          log.warn(`Could not post the unstick give-up comment on #${c.issue}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        }
      }
    }
    return calls;
  } catch (err) {
    log.warn(`Unstick pass failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
