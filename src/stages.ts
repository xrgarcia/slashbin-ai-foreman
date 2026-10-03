import { z } from "zod";

// --- The stage pipeline: what runs in a repo pass, and in what order ---
//
// A pass used to be seven phases called one after another by name inside
// runRepoCycle, so adding one meant editing TypeScript. The order now comes from
// `stages` in .ai-agent.json; runRepoCycle owns what each built-in DOES, this
// file owns which run and when.

/**
 * The built-in stages, in the order a config without `stages` runs them. The
 * order is load-bearing (see runRepoCycle): review runs before implement so it
 * only acts on PRs labeled in a PRIOR pass, verify right after review so a PR
 * merged this pass is verified in the same pass (the verifier waits on the
 * deploy itself), and promote runs last so it sees the labels this pass just set. A config that reorders them accepts the
 * consequence; nothing here forbids it.
 */
export const BUILTIN_STAGES = [
  "reconcile",
  "review",
  "verify",
  "revise",
  "implement",
  "branch-sync",
  "dependabot",
  "promote",
] as const;

export const stageTypeSchema = z.enum(BUILTIN_STAGES);
export type StageType = z.infer<typeof stageTypeSchema>;

// Strict on both arms: an entry with a typo'd key, or both `type` and
// `skillPath`, is refused at startup rather than silently read as one or the other.
const builtinStageSchema = z.object({ type: stageTypeSchema }).strict();
const customStageSchema = z.object({
  // Names the stage in logs, in FOREMAN_STAGE_ID, and in the verdict cache.
  id: z.string().regex(/^[A-Za-z0-9][\w-]*$/, "a stage id is letters, digits, '-' and '_'"),
  // The skill the stage's Claude session reads. Relative paths resolve against
  // the managed repo, which is the session's cwd — same as `skillPath`.
  skillPath: z.string().min(1),
}).strict();

export const stageEntrySchema = z.union([builtinStageSchema, customStageSchema]);
export type StageEntry = z.infer<typeof stageEntrySchema>;
export type CustomStage = z.infer<typeof customStageSchema>;

/** A fresh copy of the default sequence — the eight built-ins, in order. */
export function defaultStages(): StageEntry[] {
  return BUILTIN_STAGES.map((type) => ({ type }));
}

/** `stages` as configured: an ordered list, each stage at most once. */
export const stagesSchema = z.array(stageEntrySchema).superRefine((stages, ctx) => {
  const seen = new Set<string>();
  for (const s of stages) {
    const name = stageName(s);
    if (seen.has(name)) {
      ctx.addIssue({ code: "custom", message: `stage "${name}" appears more than once in stages` });
    }
    seen.add(name);
    if ("id" in s && (BUILTIN_STAGES as readonly string[]).includes(s.id)) {
      ctx.addIssue({ code: "custom", message: `custom stage id "${s.id}" is a built-in stage name; pick another id` });
    }
  }
}).default(defaultStages);

export function isCustomStage(s: StageEntry): s is CustomStage {
  return "skillPath" in s;
}

/** The name a stage goes by: its built-in type, or a custom stage's id. */
export function stageName(s: StageEntry): string {
  return isCustomStage(s) ? s.id : s.type;
}

/** True when the resolved stages include the given built-in. */
export function hasStage(stages: readonly StageEntry[], type: StageType): boolean {
  return stages.some((s) => !isCustomStage(s) && s.type === type);
}

/**
 * What one stage reports back to the dispatch loop.
 *
 *  - `ok`      — ran (or had nothing to do); the pass continues.
 *  - `blocked` — the stage decided work must not go further this pass (a custom
 *                stage's declared verdict, or a session the upstream back-off
 *                refused). Later stages do not run.
 *  - `failed`  — the stage could not produce a verdict. Later stages do not run.
 *  - `stop`    — the pass ends with no verdict (shutdown under way). Not a
 *                failure; recorded only so the log says why the pass ended.
 *
 * Built-in stages return `ok` (or `stop` on shutdown): they report their own
 * failures through their own counters and cooldowns, exactly as before, and a
 * failed review has never kept revise from running. Only custom stages gate.
 */
export type StageOutcome = "ok" | "blocked" | "failed" | "stop";

export interface StageResult {
  outcome: StageOutcome;
  /** Why, for the log line, when the outcome ends the pass. */
  reason?: string;
}

export interface DispatchResult {
  /** Names of the stages that ran, in order. */
  ran: string[];
  /** The stage that ended the pass early, and why; absent when every stage ran. */
  stoppedAt?: { stage: string; outcome: Exclude<StageOutcome, "ok">; reason?: string };
}

/**
 * Run `stages` in order, handing each to `run`, and stop at the first stage
 * that does not return `ok`. A thrown error propagates — callers that want a
 * stage's throw contained catch inside `run`, as the reconcile stage does.
 */
export async function dispatchStages(
  stages: readonly StageEntry[],
  run: (stage: StageEntry) => Promise<StageResult>,
): Promise<DispatchResult> {
  const ran: string[] = [];
  for (const stage of stages) {
    const name = stageName(stage);
    const result = await run(stage);
    ran.push(name);
    if (result.outcome !== "ok") {
      return { ran, stoppedAt: { stage: name, outcome: result.outcome, reason: result.reason } };
    }
  }
  return { ran };
}

/**
 * A custom stage's declared verdict: the LAST `FOREMAN_STAGE pass` or
 * `FOREMAN_STAGE blocked reason="…"` line in its output. None → undefined, which
 * the caller records as `failed` — a session that ends without a verdict looks
 * the same from outside as one that died halfway.
 */
export function parseStageTrailer(text: string): { verdict: "pass" | "blocked"; reason?: string } | undefined {
  const re = /FOREMAN_STAGE\s+(pass|blocked)\b(?:\s+reason="([^"\n]*)")?/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return undefined;
  const verdict = last[1].toLowerCase() as "pass" | "blocked";
  return last[2] ? { verdict, reason: last[2] } : { verdict };
}
