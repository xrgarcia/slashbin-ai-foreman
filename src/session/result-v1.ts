// The session's agent-contract v1 line (foreman#268). Kept apart from ./protocol.ts, which parses the
// legacy trailers and imports nothing: this module adds the schema read on top of it. A valid v1 line
// decides; null means "no valid v1 line", and the caller reads the legacy trailer (the skills print both).
import { readResultV1, type V1Read } from "../contract/result-v1.js";
import { extractStreamResult } from "./protocol.js";

/** The session's v1 result for `role`, read from the extracted result text so a stream-JSON envelope is never read escaped. */
export function sessionResultV1<R extends "implementer" | "reviser">(stdout: string, role: R): V1Read<R> {
  return readResultV1(extractStreamResult(stdout) ?? stdout, role);
}

/** The reason a v1 reviser line gives for a deliberate no-commit, or null (the caller then reads REVISION_NO_COMMIT). */
export function declaredNoCommitV1(stdout: string): string | null {
  const v1 = sessionResultV1(stdout, "reviser");
  return v1.status === "ok" && v1.result.outcome === "no-commit" && v1.result.reason_text ? v1.result.reason_text : null;
}

/** A v1 implementer line's skip, in detectDeclaredSkip's shape; `waiting_on` is the same typed wait the legacy line carries. */
export function declaredSkipV1(stdout: string): { skipped: boolean; reason?: string; issue?: number; waitingOn?: string } | null {
  const v1 = sessionResultV1(stdout, "implementer");
  if (v1.status !== "ok") return null;
  const r = v1.result;
  if (r.outcome !== "skipped") return { skipped: false };
  return { skipped: true, reason: r.reason_text ?? "no reason given", issue: r.skipped_issue ?? undefined, waitingOn: r.waiting_on ?? undefined };
}

/** A v1 implementer line's "already landed", in detectDeclaredLanded's shape. */
export function declaredLandedV1(stdout: string): { landed: boolean; issue?: number; reason?: string } | null {
  const v1 = sessionResultV1(stdout, "implementer");
  if (v1.status !== "ok") return null;
  const r = v1.result;
  return r.outcome === "landed" && r.landed_issue ? { landed: true, issue: r.landed_issue, reason: r.reason_text ?? "no evidence given" } : { landed: false };
}
