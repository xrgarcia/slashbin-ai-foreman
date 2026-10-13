// An approved issue waits for every issue GitHub records as blocking it, until
// that blocker has merged to the base branch.
//
// Origin: jerky_service #108 → #109 (2026-10-12). The order was agreed with the
// customer and written into both issue bodies as prose, and the EM told him the
// builder "handles the dependency automatically". Nothing did: the build ran in
// order only because the lower number happened to be the prerequisite and a
// skill happened to pick it first. Order is now a GitHub issue dependency
// ("blocked by"), a structured link, read here — never parsed out of prose.

import type { LifecycleLabels } from "../config.js";
import { gh } from "./gh.js";

/** A blocking issue, as `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` returns it. */
export interface Blocker {
  number: number;
  state: string;
  labels: { name: string }[];
  repository_url?: string;
}

/** The lifecycle labels that mean the issue's PR has merged to the base branch, or gone further. */
export function mergedOrLater(labels: LifecycleLabels): string[] {
  return [labels.prMerged, labels.prApproved, labels.readyForProd, labels.releasePending, labels.prodVerifyHeld, labels.readyToClose];
}

/** The blockers still in the way: open and not yet merged. A closed blocker, for any reason, no longer holds anything. */
export function unmetBlockers(blockers: Blocker[], labels: LifecycleLabels): Blocker[] {
  const done = new Set(mergedOrLater(labels));
  return blockers.filter((b) => b.state !== "closed" && !b.labels.some((l) => done.has(l.name)));
}

/** `#108`, or `owner/repo#108` for a blocker in another repo. */
export function blockerRef(b: Blocker, repo: string): string {
  const other = b.repository_url?.match(/repos\/([^/]+\/[^/]+)$/)?.[1];
  return other && other !== repo ? `${other}#${b.number}` : `#${b.number}`;
}

/** Every issue recorded as blocking `issue`. Throws on a gh failure. */
export function blockersOf(repo: string, issue: number, cwd: string): Blocker[] {
  return JSON.parse(gh(["api", `repos/${repo}/issues/${issue}/dependencies/blocked_by`], cwd) || "[]");
}
