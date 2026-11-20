// CheckDefect: one check that defers two different PRs is the checker's fault, not either PR's
// (slashbin-ai-foreman#366). The Foreman recognises it and raises one `check-defect` hand-off; the EM files the defect
// and links each affected issue to it as a blocker. The Foreman files and links nothing.
//
// Dark behind `FOREMAN_CHECK_DEFECT`: unset, nothing here writes a record or raises anything. Nothing here converts a
// defer or a failure into a pass: it only records, raises, and frees the repo's next build of a listed issue.

import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ForemanRuntime } from "../runtime.js";
import { codeHost } from "../plugins/registry.js";
import { HandoffNotSaved } from "../unstick.js";

export type CheckDefectState = "suspected" | "filed" | "closed";
export interface CheckDefect {
  /** `<owner/repo>:<slug>`; the key of `RepoRecord.checkDefects`. */
  checkId: string;
  canonicalRepo: string;
  /** The tooling-hold slug (`VerifyResult.reason`). */
  check: string;
  state: CheckDefectState;
  /** ISO-8601 UTC ms, written once. */
  suspectedAt: string;
  /** Distinct PRs; sorted by issue. */
  affected: Array<{ repo: string; issue: number; pr: number }>;
  /** Null at "filed" (the EM files it later); set once a verify pass finds it. */
  defect: { repo: string; issue: number } | null;
  filedAt: string | null;
  closedAt: string | null;
}

/** Whether the dark flag is on. Process-wide: read from the environment at each call, so a restart is the switch. */
export function checkDefectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.FOREMAN_CHECK_DEFECT ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

type Affected = CheckDefect["affected"][number];
const byIssue = (a: Affected, b: Affected): number => a.issue - b.issue || a.pr - b.pr || a.repo.localeCompare(b.repo);

/** The dedupe key of a raise: the check and the sorted affected list, so a newly affected issue is a new question. Pure, exported for tests. */
export function defectDedupeKey(checkId: string, affected: readonly Affected[]): string {
  return `${checkId}|${[...affected].sort(byIssue).map((a) => `${a.repo}#${a.issue}@${a.pr}`).join(",")}`;
}

/** The `--reason` JSON of the EM's `check-defect` kind (no timestamps: one would change the question). Pure, exported for tests. */
export function defectReason(d: CheckDefect): string {
  const affected = [...d.affected].sort(byIssue);
  return JSON.stringify({
    checkId: d.checkId,
    canonicalRepo: d.canonicalRepo,
    check: d.check,
    affected,
    firstFailure: { issue: affected[0]!.issue, pr: affected[0]!.pr },
  });
}

const distinctPrs = (d: CheckDefect): number => new Set(d.affected.map((a) => `${a.repo}#${a.pr}`)).size;

/**
 * A dev verification of `pr` (issue `issue`) deferred on tooling hold `check`. The first such defer on a SECOND,
 * different PR with the same checkId moves the record suspected -> filed and raises one `check-defect` hand-off
 * (subject: the lowest affected issue). A repeat on the same PR files nothing. Off, or when the record cannot be
 * written, it does nothing and answers `{ defect: null, filedNow: false }`. A HandoffNotSaved leaves it `suspected`;
 * the next failure retries.
 */
export async function recordCheckFailure(
  rt: ForemanRuntime, repoConfig: RepoConfig,
  input: { repo: string; check: string; issue: number; pr: number; at: string },
): Promise<{ defect: CheckDefect | null; filedNow: boolean }> {
  const none = { defect: null, filedNow: false };
  if (!checkDefectEnabled()) return none;
  const canonical = await codeHost().canonicalRepoOf(repoConfig);
  const checkId = `${canonical}:${input.check}`;
  const entry: Affected = { repo: input.repo, issue: input.issue, pr: input.pr };

  let current: CheckDefect | null = null;
  let grew = false;
  const wrote = await rt.records.updateRepoRecord(repoConfig, (draft) => {
    const table = { ...(draft.checkDefects ?? {}) };
    let d = table[checkId];
    grew = false;
    if (!d || d.state === "closed") {
      d = { checkId, canonicalRepo: canonical, check: input.check, state: "suspected", suspectedAt: input.at, affected: [entry], defect: null, filedAt: null, closedAt: null };
    } else if (!d.affected.some((a) => a.repo === entry.repo && a.issue === entry.issue && a.pr === entry.pr)) {
      d = { ...d, affected: [...d.affected, entry].sort(byIssue) };
      grew = true;
    } else {
      current = d;
      return;
    }
    table[checkId] = d;
    draft.checkDefects = table;
    current = d;
  });
  if (!wrote || !current) return none;
  const d: CheckDefect = current;

  const raiseNow = (d.state === "suspected" && distinctPrs(d) >= 2) || (d.state === "filed" && grew);
  if (!raiseNow) return { defect: d, filedNow: false };

  try {
    await rt.handoffs.raise(repoConfig, {
      kind: "check-defect",
      subject: [...d.affected].sort(byIssue)[0]!.issue,
      dedupeKey: defectDedupeKey(checkId, d.affected),
      reason: defectReason(d),
    });
  } catch (err) {
    if (err instanceof HandoffNotSaved) return { defect: d, filedNow: false };
    throw err;
  }
  if (d.state === "filed") return { defect: d, filedNow: false };

  let filed: CheckDefect | null = null;
  await rt.records.updateRepoRecord(repoConfig, (draft) => {
    const live = draft.checkDefects?.[checkId];
    if (!live) return;
    filed = live.state === "suspected" ? { ...live, state: "filed", filedAt: input.at } : live;
    draft.checkDefects = { ...draft.checkDefects, [checkId]: filed };
  });
  return filed ? { defect: filed, filedNow: true } : { defect: d, filedNow: false };
}

/**
 * A passing verdict for `pr`: drop it from every `suspected` record's `affected`; a record left empty is deleted. A
 * `filed` record is untouched (its state changes only through its defect). Off: nothing. Resolves true when it wrote.
 */
export async function clearCheckPass(rt: ForemanRuntime, repoConfig: RepoConfig, pr: number): Promise<boolean> {
  if (!checkDefectEnabled()) return false;
  let changed = false;
  await rt.records.updateRepoRecord(repoConfig, (draft) => {
    const table = { ...(draft.checkDefects ?? {}) };
    changed = false;
    for (const [id, d] of Object.entries(table)) {
      if (d.state !== "suspected" || !d.affected.some((a) => a.pr === pr)) continue;
      const left = d.affected.filter((a) => a.pr !== pr);
      if (left.length === 0) delete table[id]; else table[id] = { ...d, affected: left };
      changed = true;
    }
    if (changed) draft.checkDefects = table;
  });
  return changed;
}

/**
 * The verify pass's read-back: for each `filed` record, find its defect (the blocker of an affected issue whose body
 * carries `checkId: <id>`) and store it; once it is stored and that issue is closed, write `closed` and `closedAt`.
 * Returns the records as they stand. Off, an unreadable record or an unreadable link leaves everything as it was.
 */
export async function syncCheckDefects(
  rt: ForemanRuntime, repoConfig: RepoConfig, logger: Logger, now: string = new Date().toISOString(),
): Promise<Record<string, CheckDefect>> {
  if (!checkDefectEnabled()) return {};
  const repo = await rt.records.loadRepoRecord(repoConfig);
  const table = repo?.checkDefects ?? {};
  for (const d of Object.values(table)) {
    if (d.state !== "filed") continue;
    let found: { repo: string; issue: number; closed: boolean } | null;
    try {
      found = await codeHost().checkDefectOf(repoConfig, d.affected.map((a) => a.issue), d.checkId);
    } catch (err) {
      logger.warn(`${d.checkId}: its defect could not be read (${(err instanceof Error ? err.message : String(err)).split("\n")[0]}); left as it was`);
      continue;
    }
    if (!found) continue;
    if (d.defect && (d.defect.repo !== found.repo || d.defect.issue !== found.issue) && !found.closed) continue;
    const defect = { repo: found.repo, issue: found.issue };
    const next: CheckDefect = { ...d, defect, ...(found.closed ? { state: "closed" as const, closedAt: now } : {}) };
    const ok = await rt.records.updateRepoRecord(repoConfig, (draft) => {
      if (draft.checkDefects?.[d.checkId]?.state === "filed") draft.checkDefects = { ...draft.checkDefects, [d.checkId]: next };
    });
    if (ok) table[d.checkId] = next;
  }
  return table;
}

/**
 * True when `issue` is listed by a `filed` check-defect whose check is the very one it is held on: its defect blocks
 * it, so it no longer holds the repo's next build. Any other hold on it stands. Pure, exported for tests.
 */
export function releasedByDefect(checkDefects: Readonly<Record<string, CheckDefect>> | undefined, issue: number, heldOn: string | undefined): boolean {
  return heldOn !== undefined && Object.values(checkDefects ?? {}).some((d) => d.state === "filed" && d.check === heldOn && d.affected.some((a) => a.issue === issue));
}
