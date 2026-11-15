import { randomUUID } from "node:crypto";
import type { SessionEvent, SessionOutcome, WorkItem } from "./adapters.js";
import type { Logger } from "./logger.js";
import { emitProcessEvent } from "./work-source.js";

/** How a phase's session ended: the status observers act on, and the outcome the run ledger bills on. */
export interface SessionEnd {
  status: "finished" | "failed";
  detail: string;
  outcome: SessionOutcome;
}

/** A session that ended without anything setting its end: the run did not come back. */
export const NO_RESULT: Pick<SessionEnd, "status" | "outcome"> = { status: "failed", outcome: "failed" };

/** A new run id, one per agent run. */
export const newRunId = (): string => randomUUID();

/** The ISO UTC time a start or end is stamped with. */
export const stamp = (): string => new Date().toISOString();

/** The session's identity fields, minus what each event of it adds. */
export type RunBase = Omit<SessionEvent, "status" | "runId" | "outcome" | "workedItems" | "at" | "detail">;

/**
 * One agent run that has no session of its own to extend (the SRE's production verification, the EM seat): emit its
 * `started`, run it, emit its end with the outcome `end` reads from the result. A throw is a `failed` end and rethrows.
 * Delivered off the repo path (`emitProcessEvent`): no record is written and no handoff is touched.
 */
export async function recordRun<T>(
  base: RunBase,
  logger: Logger,
  run: () => Promise<T>,
  end: (result: T) => SessionEnd & { workedItems: readonly WorkItem[] },
): Promise<T> {
  const runId = newRunId();
  await emitProcessEvent({ kind: "session", session: { ...base, runId, status: "started", at: stamp() } }, logger);
  let result: T;
  try {
    result = await run();
  } catch (err) {
    await emitProcessEvent({
      kind: "session",
      session: { ...base, runId, ...NO_RESULT, detail: err instanceof Error ? err.message : String(err), workedItems: [], at: stamp() },
    }, logger);
    throw err;
  }
  await emitProcessEvent({ kind: "session", session: { ...base, runId, ...end(result), at: stamp() } }, logger);
  return result;
}
