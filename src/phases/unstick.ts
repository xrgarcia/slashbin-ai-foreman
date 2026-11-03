// The unstick stage (foreman#103): stuck work reaches the EM directly.
//
// Each pass reads what is stuck (src/unstick.ts: persisted state plus the
// `stuck` events that recorded the in-memory stops), calls
// `<emRepoPath>/bin/em.mjs unstick` once for each question not yet answered,
// and records the outcome in the issue's record (issue-records.ts; issue 0: the repo's record). It never clears a block (the
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
import { fieldTable } from "../issue-records.js";
import { isUpstreamBlocked } from "../upstream-backoff.js";
import { EVENT_KINDS, RELEASE_GATE_REASON, UNSTICK_MAX_ATTEMPTS, unstickGiveUpComment, derivedCandidates, needsCall, openEntry, unstickKey, type UnstickCandidate, type UnstickEntry } from "../unstick.js";
import { activeRuns, divergenceReason } from "./common.js";
import { isDeployFailureHold } from "./verify.js";
import { codeHost } from "../plugins/registry.js";
import type { CodeHost } from "../code-host.js";
import type { ForemanRuntime } from "../runtime.js";

function transcript(repoConfig: RepoConfig, what: string, cycleNumber: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(process.cwd(), "logs", "unstick", `${repoConfig.name}-${what}-cycle${cycleNumber}-${ts}.log`);
}

/**
 * Apply `fn` to the persisted questions about `issue` (its record's table; issue 0: the repo's own) and save them.
 * Resolves false when the record could not be read or saved, in which case nothing changed.
 */
async function mutate(rt: ForemanRuntime, repoConfig: RepoConfig, issue: number, fn: (table: Record<string, UnstickEntry>) => void): Promise<boolean> {
  if (issue <= 0) {
    return rt.records.updateRepoRecord(repoConfig, (d) => {
      const table = { ...(d.unstick ?? {}) };
      fn(table);
      d.unstick = table;
    });
  }
  return rt.records.updateIssueRecord(repoConfig, issue, (d) => {
    const table = { ...(d.unstick ?? {}) };
    fn(table);
    d.unstick = table;
  });
}

/** The standing question `key` about `issue`; undefined when there is none or the record cannot be read. */
async function entryOf(rt: ForemanRuntime, repoConfig: RepoConfig, issue: number, key: string): Promise<UnstickEntry | undefined> {
  if (issue <= 0) return (await rt.records.loadRepoRecord(repoConfig))?.unstick?.[key];
  return (await rt.records.loadIssueRecord(repoConfig, issue))?.unstick?.[key];
}

const toStatus = (o: UnstickOutcome): UnstickEntry["status"] => (o.kind === "failed" ? "failed" : o.kind);

/** Returns how many EM calls this pass made. Never throws. */
export async function tryUnstick(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  base: Logger,
  cycleNumber: number,
  deps: { comment?: CodeHost["commentOnIssue"] } = {},
): Promise<number> {
  const unsticker = roleFor("unstick", config);
  if (!unsticker) return 0;
  const repoName = repoConfig.name;
  const log = base.child({ cycle: cycleNumber, repo: repoName, phase: "unstick" });
  try {
    // The issues this pass looks at: the repo's open ones. When GitHub cannot be read there are none, and the
    // pass keeps to what is held in state (a branch divergence, the questions about no issue) and prunes nothing it cannot see.
    let issues: ReturnType<CodeHost["getOpenIssues"]> | null = null;
    if (!isUpstreamBlocked("github")) {
      try {
        issues = codeHost().getOpenIssues(repoConfig.githubRepo, repoConfig.repoPath, log);
      } catch (err) {
        log.warn(`Could not read open issues for the unstick pass: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const open = issues ? new Set(issues.map((i) => i.number)) : null;
    // An issue whose record cannot be read is not an issue with nothing stuck: it is left alone this pass.
    const loaded = await rt.records.loadIssueRecords(repoConfig, open ?? []);
    // The repo's own record holds the questions about no issue; unreadable, none of them is touched this pass.
    const repoRecord = await rt.records.loadRepoRecord(repoConfig);
    const standing = rt.divergence.standing(repoConfig);
    const candidates: UnstickCandidate[] = derivedCandidates({
      verifyHeld: fieldTable(loaded, "verifyHeld"),
      skipped: fieldTable(loaded, "skipped"),
      ...(standing ? {
        divergence: {
          reason: divergenceReason(standing),
          announced: [...loaded.records].filter(([, r]) => r.divergenceTold === standing.mergeBase).map(([n]) => n),
        },
      } : {}),
    }, {
      verifyMaxAttempts: config.backoff.verifyRetry.maxAttempts,
      isDeployFailureHold,
    });

    // The release gate is read off the board, not off state: an issue at
    // `pr approved` (and not yet `ready for prod release`) waits on the EM's
    // outcome gate.
    if (issues) {
      const { prApproved, readyForProd } = repoConfig.lifecycleLabels;
      for (const i of issues) {
        if (codeHost().hasLabel(i, prApproved) && !codeHost().hasLabel(i, readyForProd)) {
          candidates.push({ issue: i.number, kind: "release-gate", reason: RELEASE_GATE_REASON });
        }
      }
    }

    // Event-kind entries are candidates for as long as they stand.
    const standingQuestions = [...loaded.records.values()].flatMap((r) => Object.values(r.unstick ?? {})).concat(Object.values(repoRecord?.unstick ?? {}));
    for (const e of standingQuestions) {
      if (EVENT_KINDS.has(e.kind)) candidates.push({ issue: e.issue, kind: e.kind, reason: e.reason, ...(e.tag ? { tag: e.tag } : {}) });
    }

    const live = new Set(candidates.map((c) => unstickKey(c.issue, c.kind, c.tag)));
    const now = new Date().toISOString();
    // One write per issue (and one for the repo's own questions). A derived question ends with its condition;
    // an event question ends when its issue is no longer open, which a record of an open issue never shows.
    // Grouped once by issue: a scan of every candidate per issue is O(issues x candidates).
    const byIssue = new Map<number, UnstickCandidate[]>();
    for (const c of candidates) (byIssue.get(c.issue) ?? byIssue.set(c.issue, []).get(c.issue)!).push(c);
    const issuesInPlay = new Set<number>([0, ...loaded.records.keys(), ...byIssue.keys()]);
    for (const n of issuesInPlay) {
      if (n === 0 ? repoRecord === null : loaded.unavailable.has(n)) continue;
      const mine = byIssue.get(n) ?? [];
      await mutate(rt, repoConfig, n, (table) => {
        for (const [key, e] of Object.entries(table)) if (!EVENT_KINDS.has(e.kind) && !live.has(key)) delete table[key];
        for (const c of mine) {
          const key = unstickKey(c.issue, c.kind, c.tag);
          table[key] = openEntry(table[key], c, now);
        }
      });
    }

    let calls = 0;
    for (const c of candidates) {
      const key = unstickKey(c.issue, c.kind, c.tag);
      const entry = await entryOf(rt, repoConfig, c.issue, key);
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
      await mutate(rt, repoConfig, c.issue, (table) => {
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
      // Issue 0 is a repo-level hold with no issue to comment on. With no
      // `unstickEscalationOwner` there is nobody to mention: the entry stays
      // `failed` at the cap, as for a failed post, and the log says why.
      if (spent && c.issue > 0) {
        const owner = config.unstickEscalationOwner;
        if (!owner) {
          log.warn(`EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): EM unreachable after ${UNSTICK_MAX_ATTEMPTS} calls — no unstickEscalationOwner configured, so nobody is mentioned`);
        } else {
          try {
            (deps.comment ?? codeHost().commentOnIssue)(repoConfig, c.issue, unstickGiveUpComment(owner, spent));
            await mutate(rt, repoConfig, c.issue, (table) => {
              const cur = table[key];
              if (cur && cur.reason === c.reason) table[key] = { ...cur, status: "escalated" };
            });
            log.warn(`EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): EM unreachable after ${UNSTICK_MAX_ATTEMPTS} calls — escalated to @${owner}`);
          } catch (err) {
            log.warn(`Could not post the unstick give-up comment on #${c.issue}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
          }
        }
      }
    }
    return calls;
  } catch (err) {
    log.warn(`Unstick pass failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
