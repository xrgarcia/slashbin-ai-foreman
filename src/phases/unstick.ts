// The unstick stage (foreman#103): stuck work reaches the EM directly.
//
// Each pass reads what is stuck (src/unstick.ts: persisted state plus the
// `stuck` events that recorded the in-memory stops), calls
// `<emRepoPath>/bin/em.mjs unstick` once for each question not yet answered,
// and records the outcome in the issue's record (issue-records.ts; issue 0: the repo's record). It never clears a block (the
// unblock checks do, when the cause is gone), never writes Paperclip, and runs
// whether or not Paperclip is on. Without `emRepoPath` it does nothing.
//
// Follow-up, per question (src/unstick.ts `nextStep`):
//  - failed (any exit but 0/2/3, or the timer): called again next pass, up to
//    UNSTICK_MAX_ATTEMPTS for one reason, then the escalation owner is told.
//  - refused (the EM's runner was out of tokens or rate-limited): costs no
//    attempt; called again once the limit lifts (the stated reset, else the
//    `backoff.upstream` window, longer each refusal in a row). The refusal also
//    pauses the EM's runner daemon-wide (upstream "EM"): no other question, in
//    this repo or another, is put to it until the limit lifts.
//  - invoked: a handoff, not a resolution. While the question still stands it
//    is called again after `backoff.handoff` (2 h, then 4 h, ...), up to
//    `maxRecalls`; then the escalation owner is told, once.
//  - escalated / declined: final until the reason changes. A decline on a
//    recall (the EM's "already answered this reason") is the handoff still
//    standing, not a decision: it counts as a recall, so the watch goes on.

import { resolve } from "node:path";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { roleFor } from "../plugins/registry.js";
import type { UnstickOutcome } from "../plugins/contract.js";
import { fieldTable } from "../issue-records.js";
import { isUpstreamBlocked, reportRunResult, tryAcquire } from "../upstream-backoff.js";
import { backoffDelay } from "../backoff.js";
import { EVENT_KINDS, GRANT_LABEL, GRANT_FOLLOW_UP_DEPTH, followUpOrigin, referencedEmIssues, releaseGateReason, type GrantState, UNSTICK_MAX_ATTEMPTS, handoffGiveUpComment, unstickGiveUpComment, derivedCandidates, nextStep, openEntry, unstickKey, type UnstickCandidate, type UnstickEntry } from "../unstick.js";
import { activeRuns } from "./common.js";
import { isDeployFailureHold } from "./verify.js";
import { codeHost } from "../plugins/registry.js";
import type { CodeHost } from "../code-host.js";
import type { ForemanRuntime } from "../runtime.js";

/**
 * Whether each place the EM's gate looks for a grant carries `deliver-to-prod` (epic_grant.py): the issue, the EM
 * issues its `## References` name, its GitHub sub-issue parent, and, for "— follow-up to #N", #N and what #N
 * resolves to (depth bounded). A place that cannot be read is null; it never throws.
 */
export function readGrantState(repoConfig: RepoConfig, number: number, title: string, labels: readonly string[], host: CodeHost): GrantState {
  const out: Record<string, boolean | null> = {};
  const cwd = repoConfig.repoPath;
  const visit = (repo: string, n: number, ttl: string, lbls: readonly string[] | null, depth: number): void => {
    const key = `${repo}#${n}`;
    let facts: { body: string; labels: string[] } | null = null;
    try {
      facts = lbls ? { body: host.readIssueFacts(repo, n, cwd).body, labels: [...lbls] } : host.readIssueFacts(repo, n, cwd);
    } catch {
      out[key] = null;
      return;
    }
    out[key] = facts.labels.includes(GRANT_LABEL);
    const { emRepo, epicRefLabel } = repoConfig;
    for (const ref of emRepo && epicRefLabel ? referencedEmIssues(facts.body, emRepo, epicRefLabel) : []) {
      const [er, en] = [ref.slice(0, ref.indexOf("#")), Number(ref.slice(ref.indexOf("#") + 1))];
      if (out[ref] !== undefined) continue;
      try {
        const e = host.readIssueFacts(er, en, cwd);
        // A closed epic is history to the gate: it is left out, so closing one changes the reason too.
        if (e.state !== "closed") out[ref] = e.labels.includes(GRANT_LABEL);
      } catch {
        out[ref] = null;
      }
    }
    try {
      const p = host.readSubIssueParent(repo, n, cwd);
      if (p) out[`${p.repo}#${p.number}`] = p.labels.includes(GRANT_LABEL);
    } catch {
      out[`${key}/parent`] = null;
    }
    const origin = followUpOrigin(ttl);
    if (origin !== null && depth < GRANT_FOLLOW_UP_DEPTH && out[`${repo}#${origin}`] === undefined) {
      try {
        const o = host.readIssueFacts(repo, origin, cwd);
        visit(repo, origin, o.title, o.labels, depth + 1);
      } catch {
        out[`${repo}#${origin}`] = null;
      }
    }
  };
  visit(repoConfig.githubRepo, number, title, labels, 0);
  return out;
}

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

const toStatus = (o: UnstickOutcome): UnstickEntry["status"] => o.kind;

/** The EM's own runner, as an upstream: one refusal pauses every EM call daemon-wide until the limit lifts. */
export const EM_UPSTREAM = "EM";

/** The entry an outcome leaves: what each kind spends, and when a refusal may be called again. Pure, exported for tests. */
export function applyOutcome(cur: UnstickEntry, o: UnstickOutcome, nowMs: number, upstream: { baseMs: number; capMs: number; factor: number }): UnstickEntry {
  const at = new Date(nowMs).toISOString();
  // The recalls made on a standing handoff; undefined when none was handed off. An `invoked` entry written before
  // `recalls` existed is a handoff too, with none made yet.
  const handedOff = cur.recalls ?? (cur.status === "invoked" ? 0 : undefined);
  const { waitUntil: _w, ...rest } = cur;
  if (o.kind === "refused") {
    const refusals = (cur.refusals ?? 0) + 1;
    const until = o.resetAtMs !== undefined && o.resetAtMs > nowMs ? o.resetAtMs : nowMs + backoffDelay(refusals, upstream);
    // A refusal is not an answer: the prior status's recall count is kept, the attempt is not spent.
    return { ...rest, ...(handedOff !== undefined ? { recalls: handedOff } : {}), status: "refused", refusals, waitUntil: new Date(until).toISOString(), lastCallAt: at, detail: o.detail.slice(0, 500) };
  }
  const { refusals: _r, ...clean } = rest;
  // A recall the EM declines as already answered: the handoff stands and the watch goes on (a decline is final
  // only for a question never handed off). `recalls` is set exactly while a handoff is being watched.
  if (o.kind === "declined" && handedOff !== undefined) {
    return { ...clean, status: "invoked", attempts: cur.attempts + 1, lastCallAt: at, recalls: handedOff + 1, ...(o.detail ? { detail: o.detail.slice(0, 500) } : {}) };
  }
  // `recalls` starts at 0 with the first handoff; every later handoff for the same reason is a recall.
  return {
    ...clean,
    status: toStatus(o),
    attempts: cur.attempts + 1,
    lastCallAt: at,
    ...(o.kind === "invoked" ? { recalls: handedOff === undefined ? 0 : handedOff + 1 } : {}),
    ...(o.detail ? { detail: o.detail.slice(0, 500) } : {}),
  };
}

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
    // pass keeps to what is held in state (the questions about no issue) and prunes nothing it cannot see.
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
    const candidates: UnstickCandidate[] = derivedCandidates({
      verifyHeld: fieldTable(loaded, "verifyHeld"),
      skipped: fieldTable(loaded, "skipped"),
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
          const names = i.labels.map((l) => l.name);
          const grants = readGrantState(repoConfig, i.number, i.title, names, codeHost());
          let reason = releaseGateReason(names, grants);
          // A place that could not be read this pass keeps the last reason, so a flaky read is not a new question.
          const prior = loaded.records.get(i.number)?.unstick?.[unstickKey(i.number, "release-gate")];
          if (prior && Object.values(grants).includes(null)) reason = prior.reason;
          candidates.push({ issue: i.number, kind: "release-gate", reason });
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
    const policy = { maxAttempts: UNSTICK_MAX_ATTEMPTS, handoff: config.backoff.handoff };
    for (const c of candidates) {
      const key = unstickKey(c.issue, c.kind, c.tag);
      const entry = await entryOf(rt, repoConfig, c.issue, key);
      if (!entry) continue;
      const step = nextStep(entry, c, Date.now(), policy);
      if (step === "wait") continue;
      if (step === "give-up") {
        await giveUpHandoff(rt, repoConfig, config, log, c, key, entry, deps);
        continue;
      }
      // The EM's runner is paused by a refusal (this pass, an earlier one, another repo's): no call until it lifts.
      if (!tryAcquire(EM_UPSTREAM)) continue;
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
      const refused = outcome.kind === "refused" ? outcome : undefined;
      reportRunResult(EM_UPSTREAM, !!refused, refused?.detail, refused?.resetAtMs);
      log.info(`EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): ${outcome.kind}${outcome.detail ? ` — ${outcome.detail.slice(0, 200)}` : ""}`);
      let spent: UnstickEntry | undefined;
      await mutate(rt, repoConfig, c.issue, (table) => {
        const cur = table[key];
        // The reason changed while the call ran: it is a new question, answered next pass.
        if (!cur || cur.reason !== c.reason) return;
        table[key] = applyOutcome(cur, outcome, Date.now(), config.backoff.upstream);
        if (outcome.kind === "failed" && table[key]!.attempts >= UNSTICK_MAX_ATTEMPTS) spent = table[key];
      });
      // The runner is out of tokens or rate-limited: reportRunResult paused it, so the calls left wait for the reset.
      if (refused) {
        log.warn(`EM unstick refused by its runner — no attempt spent; EM calls paused until the limit lifts`);
        continue;
      }
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

/**
 * A handoff made again and again that never moved the issue: tell the
 * escalation owner once (stored `escalated`, so an unchanged reason never
 * comments again). Issue 0 has nowhere to comment and, like no configured
 * owner, is only logged; `gaveUpAt` stops it being reported every pass.
 */
async function giveUpHandoff(
  rt: ForemanRuntime, repoConfig: RepoConfig, config: AgentConfig, log: Logger,
  c: UnstickCandidate, key: string, entry: UnstickEntry, deps: { comment?: CodeHost["commentOnIssue"] },
): Promise<void> {
  const owner = config.unstickEscalationOwner;
  const what = `EM unstick ${repoConfig.githubRepo}#${c.issue} (${c.kind}): handed off ${entry.attempts} times since ${entry.since} and still stuck`;
  const mark = (fields: Partial<UnstickEntry>) => mutate(rt, repoConfig, c.issue, (table) => {
    const cur = table[key];
    if (cur && cur.reason === c.reason) table[key] = { ...cur, ...fields };
  });
  if (!owner || c.issue <= 0) {
    log.warn(`${what} — ${owner ? "no issue to comment on" : "no unstickEscalationOwner configured, so nobody is mentioned"}`);
    await mark({ gaveUpAt: new Date().toISOString() });
    return;
  }
  try {
    (deps.comment ?? codeHost().commentOnIssue)(repoConfig, c.issue, handoffGiveUpComment(owner, entry));
    await mark({ status: "escalated" });
    log.warn(`${what} — escalated to @${owner}`);
  } catch (err) {
    // Not marked: the next pass tries the comment again.
    log.warn(`Could not post the handoff give-up comment on #${c.issue}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}
