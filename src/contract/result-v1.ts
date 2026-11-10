import { z } from "zod";

/**
 * The agent result contract, version 1 (foreman#268; plan: EM repo
 * `docs/plans/foreman-agent-contract.md`).
 *
 * Every agent that answered the Foreman in prose (the Tech Lead, the SRE, and
 * the implement and revise sessions) also prints ONE line:
 *
 *   FOREMAN_RESULT_V1 {"schema":1,"role":"deployer","outcome":"held",...}
 *
 * Named, typed fields decide; prose rides in `*_text` fields and decides
 * nothing. A required field that is missing or malformed fails closed: the
 * caller holds the work for a person and names the field. It never guesses.
 *
 * Pure: no I/O. The schemas published under `schemas/` are generated from the
 * ones here (`scripts/contract/generate-schemas.mjs`), so they cannot drift.
 */

export const RESULT_V1_TOKEN = "FOREMAN_RESULT_V1";
/** The highest major this Foreman reads. A higher one fails closed (`contract-version-unsupported`). */
export const RESULT_V1_SCHEMA = 1;

export const ROLES = ["implementer", "reviser", "reviewer", "verifier", "deployer"] as const;
export type ResultRole = (typeof ROLES)[number];

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a lowercase slug ([a-z0-9-])");
const sha40 = z.string().regex(/^[0-9a-f]{40}$/, "40 hex characters");
const isoTime = z.iso.datetime({ offset: true });
const prose = (max: number) => z.string().max(max);
const issueRef = z.string().regex(/^(?:[\w.-]+\/[\w.-]+)?#\d+$/, "owner/repo#N or #N");
const posInt = z.number().int().positive();

/** Fields every role carries. Additive fields are allowed: an unknown key is ignored, never an error. */
const envelope = {
  schema: z.number().int().min(1),
  code: slug.nullable().optional(),
  reason_text: prose(300).optional(),
  evidence: z.array(z.string().url()).optional(),
};

/** How a hold clears: `time` by itself at `eligible_at`, `person` by a person or a new commit, `transient` on the retry back-off. */
export const HOLD_CLASSES = ["time", "person", "transient"] as const;
export type HoldClass = (typeof HOLD_CLASSES)[number];

const reviewer = z.looseObject({
  ...envelope,
  role: z.literal("reviewer"),
  outcome: z.enum(["approve", "request-changes", "none"]),
  pr: posInt,
  merged: z.boolean(),
  head_sha: sha40.nullable().optional(),
  hold: slug.nullable().optional(),
  eligible_at: isoTime.nullable().optional(),
  deploy: z.enum(["success", "failure", "na"]),
});

const unrelatedError = z.looseObject({
  /** Computed by the agent: the same error yields the same signature whatever ids, counts or times it carries. */
  signature: z.string().regex(/^[a-z0-9._:-]{3,80}$/, "a stable signature ([a-z0-9._:-], 3-80)"),
  class: slug.optional(),
  text: prose(500).optional(),
  first_seen: isoTime.optional(),
  count: z.number().int().nonnegative().optional(),
  evidence: z.string().url().optional(),
});

const verifier = z.looseObject({
  ...envelope,
  role: z.literal("verifier"),
  outcome: z.enum(["pass", "hold", "fail", "none"]),
  pr: posInt,
  hold: slug.nullable().optional(),
  eligible_at: isoTime.nullable().optional(),
  unrelated_errors: z.array(unrelatedError).optional(),
  acceptance: z.string().optional(),
  /** What the verifier could not check: real-defect, spec-defect, tooling-gap, window or none. */
  gap_class: z.string().optional(),
  gap_reason: z.string().optional(),
  /** Soak mode only: the soak's own verdict, apart from the acceptance row's. */
  soak_result: z.enum(["PASS", "FAIL", "NOT-VERIFIED"]).optional(),
}).superRefine((v, ctx) => {
  if (v.outcome === "hold" && !v.hold) ctx.addIssue({ code: "custom", path: ["hold"], message: "required when outcome is hold" });
  if (v.hold === "wait-until" && !v.eligible_at) ctx.addIssue({ code: "custom", path: ["eligible_at"], message: "required when hold is wait-until" });
});

const deployer = z.looseObject({
  ...envelope,
  role: z.literal("deployer"),
  outcome: z.enum(["merged", "held", "refused", "not-run"]),
  pr: posInt,
  merged: z.boolean(),
  merge_sha: sha40.nullable().optional(),
  verify: z.enum(["pass", "hold", "fail", "none"]),
  hold: slug.nullable().optional(),
  hold_class: z.enum(HOLD_CLASSES).nullable().optional(),
  eligible_at: isoTime.nullable().optional(),
  unrelated_errors: z.array(unrelatedError).optional(),
}).superRefine((v, ctx) => {
  if (v.hold && !v.hold_class) ctx.addIssue({ code: "custom", path: ["hold_class"], message: "required when hold is set" });
  if (v.hold_class === "time" && !v.eligible_at) ctx.addIssue({ code: "custom", path: ["eligible_at"], message: "required when hold_class is time" });
});

const implementer = z.looseObject({
  ...envelope,
  role: z.literal("implementer"),
  outcome: z.enum(["pr-opened", "skipped", "landed", "failed"]),
  pr: posInt.nullable().optional(),
  issues_named: z.array(posInt).optional(),
  skipped_issue: posInt.nullable().optional(),
  waiting_on: issueRef.nullable().optional(),
  landed_issue: posInt.nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.outcome === "pr-opened" && !v.pr) ctx.addIssue({ code: "custom", path: ["pr"], message: "required when outcome is pr-opened" });
  if (v.outcome === "pr-opened" && !v.issues_named?.length) ctx.addIssue({ code: "custom", path: ["issues_named"], message: "required when outcome is pr-opened" });
  if (v.outcome === "landed" && !v.landed_issue) ctx.addIssue({ code: "custom", path: ["landed_issue"], message: "required when outcome is landed" });
});

const reviser = z.looseObject({
  ...envelope,
  role: z.literal("reviser"),
  outcome: z.enum(["pushed", "no-commit", "reverted", "failed"]),
  changed: z.array(z.enum(["code", "tests", "docs", "revert"])).optional(),
  reverted_findings: z.array(posInt).optional(),
  pr_body_stale: z.boolean().optional(),
  head_sha: sha40.nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.outcome === "no-commit" && !v.reason_text) ctx.addIssue({ code: "custom", path: ["reason_text"], message: "required when outcome is no-commit" });
});

export const ROLE_SCHEMAS = { implementer, reviser, reviewer, verifier, deployer } as const;
export type RoleResult<R extends ResultRole> = z.infer<(typeof ROLE_SCHEMAS)[R]>;

/** What one read of an output found for a role. */
export type V1Read<R extends ResultRole> =
  | { status: "absent" }
  /** A v1 line for this role (or an unreadable one) that does not validate. `problem` names the field. */
  | { status: "invalid"; problem: string }
  | { status: "ok"; result: RoleResult<R> };

const LINE = new RegExp(`^[ \\t]*${RESULT_V1_TOKEN}[ \\t]+(.*?)[ \\t]*$`, "gm");

/**
 * The v1 result for `role` in `text`: the last line for that role (and, when
 * `pr` is given, that PR) wins. Read the plain text a CLI printed, or a
 * session's extracted final message; never escaped stream-JSON.
 *
 * Pass `extractStreamResult(stdout) ?? stdout`, so a stream-JSON envelope is
 * read as its result text.
 *
 * - No v1 line at all: `absent` (the caller reads the legacy trailer).
 * - A v1 line whose JSON does not parse, or whose `role` is missing or unknown, with no line for this role: `invalid`.
 * - A line for this role whose `pr` is not an integer is this read's (its schema rejects it), never skipped.
 * - The matching line fails its schema, or names a schema major above ours: `invalid`.
 */
export function readResultV1<R extends ResultRole>(text: string, role: R, pr?: number): V1Read<R> {
  let unparsable: string | null = null;
  let candidate: Record<string, unknown> | null = null;
  for (const m of text.matchAll(LINE)) {
    let obj: unknown;
    try {
      obj = JSON.parse(m[1]!);
    } catch {
      unparsable = `the ${RESULT_V1_TOKEN} line is not one JSON object`;
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      unparsable = `the ${RESULT_V1_TOKEN} line is not one JSON object`;
      continue;
    }
    const o = obj as Record<string, unknown>;
    // Only a well-formed routing field may route a line away: a missing or malformed `role` or `pr` is this
    // read's problem, never absence (absence would let a legacy trailer stand in for an invalid result).
    if (typeof o.role !== "string" || !(ROLES as readonly string[]).includes(o.role)) {
      unparsable = `contract-field-invalid: role: ${o.role === undefined ? "missing" : `not a known role (${JSON.stringify(o.role)})`}`;
      continue;
    }
    if (o.role !== role) continue;
    if (pr !== undefined && Number.isInteger(o.pr) && o.pr !== pr) continue;
    candidate = o;
  }
  if (!candidate) return unparsable ? { status: "invalid", problem: unparsable } : { status: "absent" };
  if (typeof candidate.schema === "number" && candidate.schema > RESULT_V1_SCHEMA) {
    return { status: "invalid", problem: `contract-version-unsupported: schema ${candidate.schema} (this Foreman reads ${RESULT_V1_SCHEMA})` };
  }
  const parsed = ROLE_SCHEMAS[role].safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0]!;
    const field = first.path.length ? first.path.join(".") : "(result)";
    return { status: "invalid", problem: `contract-field-invalid: ${field}: ${first.message}` };
  }
  return { status: "ok", result: parsed.data as RoleResult<R> };
}

/** Format one result as the line an agent prints. For agents written in TypeScript, and for tests. */
export function formatResultV1(result: { role: ResultRole } & Record<string, unknown>): string {
  return `${RESULT_V1_TOKEN} ${JSON.stringify({ schema: RESULT_V1_SCHEMA, ...result })}`;
}

/** Every role's JSON Schema, for `schemas/<role>.v1.json` and the conformance kit. */
export function roleJsonSchemas(): Record<ResultRole, unknown> {
  const out = {} as Record<ResultRole, unknown>;
  for (const r of ROLES) out[r] = z.toJSONSchema(ROLE_SCHEMAS[r], { io: "input", unrepresentable: "any" });
  return out;
}

/**
 * `wait-until-YYYYMMDDTHHMMZ`: the time-bearing hold slug the legacy trailer
 * carries (SRE verify.mjs `waitHold`). A v1 `hold: "wait-until"` with its
 * `eligible_at` is mapped to it, so the existing wait path reads both.
 */
export function parseWaitUntil(slug: string): number | null {
  const m = /^wait-until-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(slug);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
  return Number.isFinite(t) ? t : null;
}

/** Builds the slug `parseWaitUntil` reads. */
export function waitUntilSlug(eligibleAt: string): string {
  const d = new Date(eligibleAt);
  const p = (n: number) => String(n).padStart(2, "0");
  return `wait-until-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}
