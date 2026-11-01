// The QA report: after the SRE's dev verify passes, run `qa.mjs check` once for the
// merged PR and say what it found on the PR. Report-only: nothing here moves a label,
// holds a card or waits (the caller does not await `reportQaAfterVerify`'s work).
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { buildQaEnv, runAgentCli, type CliRun, type VerifyResult } from "./agent.js";
import { commentBodies, hasCommentContaining, hasCommentStartingWith, commentOnPr } from "./github/pr-comments.js";
import { prChangedFiles } from "./github/reports.js";

/** The heading the comment opens with; also the idempotency key. */
export const QA_HEADING = "## QA Report (report-only)";

/**
 * One QA run's ceiling; past it the child is killed and the PR gets an "errored" comment.
 * QA reviews serially, one Codex run per 4 shots (slashbin_ai_qa `lib/review.mjs` BATCH_SIZE)
 * plus a 2-run control, each allowed 900 s (`lib/review.mjs:113`, `lib/codex.mjs:49`), so its
 * own ceiling grows with the pages a PR touches. Slashbin-console PR #1518 (a `shared/schema.ts`
 * change fans out to all 18 routes, 72 shots, 18 batches) was still reviewing when 20 minutes
 * killed it (2026-10-29 21:03Z, capture had taken 4 min). 90 minutes covers that review; a
 * longer one is a tooling hold (`qa-errored`) that retries without charging (slashbin-ai-foreman#137).
 */
export const QA_MAX_DURATION_MS = 90 * 60_000;

/**
 * Which QA step a killed run was in, from its `[qa]` progress lines on stderr
 * (`lib/check.mjs`): "review" once it logged "captured N shots; reviewing", "capture"
 * once it resolved pages or took a shot, else "setup". Pure.
 */
export function qaStepOf(stderr: string): "setup" | "capture" | "review" {
  const lines = stderr.split("\n").filter((l) => l.startsWith("[qa] "));
  if (lines.some((l) => /\bcaptured \d+ shots; reviewing\b/.test(l))) return "review";
  if (lines.some((l) => /^\[qa\] (shot |resolved |affected pages)/.test(l))) return "capture";
  return "setup";
}

/** The EM script that hands a named Doppler key to one child, and nothing else. */
const DOPPLER_RUN = "scripts/secrets/doppler-run.mjs";
const MINT_KEY = "DEV_SESSION_MINT_KEY";

/** What `manifest.json` carries that the report reads. */
export interface QaManifest {
  verdict: string;
  reason?: string | null;
  hold?: string | null;
  sha?: string | null;
  pages?: Array<{ route: string; why?: string }>;
  shots?: Array<{ file?: string; route?: string }>;
  /** Per shot: where, and each criterion with QA's reason. regressions + noBaseline fail; preExisting is listed only. */
  regressions?: QaFinding[];
  noBaseline?: QaFinding[];
  preExisting?: QaFinding[];
}

export interface QaFinding {
  route: string;
  viewport?: string | { name?: string };
  items?: Array<{ criterion: string; reason?: string }>;
}

export type QaOutcome =
  | { kind: "manifest"; exitCode: number; manifest: QaManifest }
  | { kind: "errored"; detail: string };

/** Injected edges, so the decision is testable without a browser, Codex or GitHub. */
export interface QaDeps {
  /** Gate only: is a comment carrying this marker already on the PR? */
  hasMarker?(pr: number, marker: string): Promise<boolean>;
  run(args: { repo: string; pr: number; out: string }): Promise<QaOutcome>;
  hasReport(pr: number): Promise<boolean>;
  post(pr: number, body: string): Promise<void>;
  /** The files PR `pr` changes. Absent: the zero-shot rule (`withVoidPassHeld`) is not applied. */
  changedFiles?(pr: number): Promise<string[]>;
  /** The newest comment on `pr` carrying `marker`, or undefined: how a reused PASS is checked for shots. */
  reportBody?(pr: number, marker: string): Promise<string | undefined>;
}

const NOT_A_GATE =
  "This result does not gate delivery yet: the card has already moved on, and pre-existing defects on pages " +
  "this PR touched still count as failures until slashbin_ai_qa#2 separates them from the PR's own.";

/** The comment body for a QA outcome. Pure. */
export function qaReportBody(pr: number, outcome: QaOutcome): string {
  const head = `${QA_HEADING}\n\n`;
  if (outcome.kind === "errored") {
    return `${head}**QA errored** on PR #${pr}: ${outcome.detail}. No verdict was produced.\n\n${NOT_A_GATE}`;
  }
  const m = outcome.manifest;
  const lines = [`**Verdict: ${m.verdict}**`, `Reason: ${m.reason ?? "(none recorded)"}`];
  if (m.hold) lines.push(`Hold: ${m.hold}`);
  const pages = m.pages ?? [];
  lines.push("", "Pages checked:");
  if (pages.length === 0) lines.push("- none");
  for (const p of pages) lines.push(`- \`${p.route}\`${p.why ? ` — ${p.why}` : ""}`);
  lines.push("", `Shots: ${(m.shots ?? []).length}`, "", NOT_A_GATE);
  return head + lines.join("\n");
}

const inFlight = new Set<string>();

/**
 * The one way every QA caller runs it: make the cache directory, run, and turn a throw into an `errored`
 * outcome (the checker failing, never a verdict). Each caller keeps its own posting and decision.
 */
export async function executeQa(repo: string, pr: number, deps: Pick<QaDeps, "run">): Promise<QaOutcome> {
  try {
    const out = join(homedir(), ".cache", "foreman-qa", repo.replace("/", "__"), String(pr));
    mkdirSync(out, { recursive: true });
    return await deps.run({ repo, pr, out });
  } catch (e) {
    return { kind: "errored", detail: `the run threw (${String(e).slice(0, 200)})` };
  }
}

/**
 * Check PR `pr` once and post the report. Never throws and never rejects: a failed
 * read, run, parse or post is a log line (and, where the PR can still be told, an
 * "errored" comment). At most one report per PR: an existing comment with the heading,
 * or a run already in flight in this process, ends it.
 */
export async function runQaReport(repo: string, pr: number, deps: QaDeps, logger: Logger): Promise<void> {
  const key = `${repo}#${pr}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  // Yield first: the caller's turn ends before any of this work starts.
  await new Promise<void>((r) => setImmediate(r));
  try {
    if (await deps.hasReport(pr)) {
      logger.info(`QA: ${key} already has a report; not running again`);
      return;
    }
    const outcome = await executeQa(repo, pr, deps);
    if (outcome.kind === "errored") logger.warn(`QA: ${key} errored: ${outcome.detail}`);
    else logger.info(`QA: ${key} ${outcome.manifest.verdict} (report-only)`);
    await deps.post(pr, qaReportBody(pr, outcome));
  } catch (e) {
    logger.warn(`QA: ${key} report not posted: ${String(e).slice(0, 300)}`);
  } finally {
    inFlight.delete(key);
  }
}

/** Whether QA applies to `repoConfig` on this install. */
export function qaApplies(repoConfig: RepoConfig, agentConfig: AgentConfig): boolean {
  return Boolean(agentConfig.qaPath) && agentConfig.qaRepos.includes(repoConfig.githubRepo);
}

/**
 * Whether QA runs BEFORE the merge for `repoConfig` (config.qaBeforeMerge): the flag, a QA repo, and the
 * Tech Lead that does the merge. When true the post-merge QA (gate and report-only) does not run for it.
 */
export function qaBeforeMergeApplies(repoConfig: RepoConfig, agentConfig: AgentConfig): boolean {
  return agentConfig.qaBeforeMerge && Boolean(agentConfig.techLeadPath) && qaApplies(repoConfig, agentConfig);
}

/**
 * The real edges: `qa.mjs check` run under the EM's doppler-run.mjs, which gives
 * DEV_SESSION_MINT_KEY (project = the repo, config dev) to that child alone.
 */
export function realQaDeps(repoConfig: RepoConfig, agentConfig: AgentConfig, logger: Logger): QaDeps {
  return {
    hasMarker: (pr, marker) => hasCommentContaining(repoConfig, pr, marker),
    hasReport: (pr) => hasCommentStartingWith(repoConfig, pr, QA_HEADING),
    post: (pr, body) => commentOnPr(repoConfig, pr, body),
    changedFiles: async (pr) => prChangedFiles(repoConfig.githubRepo, pr, repoConfig.repoPath, logger),
    reportBody: async (pr, marker) => (await commentBodies(repoConfig, pr)).filter((b) => b.includes(marker)).pop(),
    async run({ repo, pr, out }) {
      const em = agentConfig.emRepoPath;
      const qa = agentConfig.qaPath;
      if (!em || !qa) return { kind: "errored", detail: "emRepoPath and qaPath must both be set" };
      const args = ["--keys", `${MINT_KEY}@${repo}`, "dev", "--", "node", join(qa, "bin/qa.mjs"), "check", "--repo", repo, "--pr", String(pr), "--out", out];
      const r: CliRun = await runAgentCli(em, DOPPLER_RUN, args, buildQaEnv(agentConfig), agentConfig, QA_MAX_DURATION_MS);
      return readOutcome(r, out, logger);
    },
  };
}

/** Exit 0/1/3 with a readable manifest is a result; a timeout, any other exit or a missing manifest is an error. */
export function readOutcome(r: CliRun, out: string, logger: Logger): QaOutcome {
  if (r.timedOut) {
    const step = qaStepOf(r.stderr);
    const last = r.stderr.split("\n").filter((l) => l.startsWith("[qa] ")).pop() ?? "(no progress line)";
    logger.warn(`QA: killed at ${QA_MAX_DURATION_MS / 60_000} minutes during ${step}; last line: ${last.slice(0, 200)}`);
    return { kind: "errored", detail: `timed out after ${QA_MAX_DURATION_MS / 60_000} minutes during the ${step} step` };
  }
  if (![0, 1, 3].includes(r.code ?? -1)) {
    // stderr tail goes to the log only (already redacted of known secrets), never onto the PR.
    logger.warn(`QA: exit ${r.code}; tail: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    return { kind: "errored", detail: `exit code ${r.code}` };
  }
  try {
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as QaManifest;
    if (!manifest.verdict) return { kind: "errored", detail: "manifest.json has no verdict" };
    return { kind: "manifest", exitCode: r.code as number, manifest };
  } catch (e) {
    return { kind: "errored", detail: `exit ${r.code} but manifest.json is unreadable (${String(e).slice(0, 100)})` };
  }
}

// --- The gate (config.qaGate) ---

/** The heading of the gating report; the report-only one is QA_HEADING. */
export const QA_GATE_HEADING = "## QA Report";

const vpName = (f: QaFinding) => (typeof f.viewport === "string" ? f.viewport : f.viewport?.name) ?? "?";
const findingLine = (f: QaFinding) =>
  `- \`${f.route}\` ${vpName(f)}: ${(f.items ?? []).map((i) => `${i.criterion}${i.reason ? ` (${i.reason})` : ""}`).join(", ") || "defect"}`;

/** The hidden marker that keys a gating report to a head SHA and verdict; one comment per marker. */
export function qaGateMarker(outcome: QaOutcome): string {
  // An errored run is keyed by its detail too, so a timeout in a different step still posts.
  return outcome.kind === "errored"
    ? `<!-- foreman-qa sha=none verdict=ERROR detail=${outcome.detail.replace(/[^\w.-]+/g, "-").slice(0, 80)} -->`
    : `<!-- foreman-qa sha=${outcome.manifest.sha ?? "unknown"} verdict=${outcome.manifest.verdict} -->`;
}

/** The gating report: regressions first, then what was already there. Pure. */
export function qaGateBody(pr: number, outcome: QaOutcome, marker: string = qaGateMarker(outcome)): string {
  const head = `${QA_GATE_HEADING}\n${marker}\n\n`;
  if (outcome.kind === "errored") {
    return `${head}**QA errored** on PR #${pr}: ${outcome.detail}. No verdict was produced, so the card is held and the check retries.`;
  }
  const m = outcome.manifest;
  const lines = [`**Verdict: ${m.verdict}**`, `Reason: ${m.reason ?? "(none recorded)"}`];
  if (m.hold) lines.push(`Hold: ${m.hold}`);
  const bad = [...(m.regressions ?? []), ...(m.noBaseline ?? [])];
  if (bad.length) lines.push("", "Regressions (this PR made these worse; blocking):", ...(m.regressions ?? []).map(findingLine),
    ...(m.noBaseline?.length ? ["", "Defects with no baseline to compare against (blocking, fail closed):", ...m.noBaseline.map(findingLine)] : []));
  if (m.preExisting?.length) lines.push("", "Already there before this PR (not blocking):", ...m.preExisting.map(findingLine));
  const pages = m.pages ?? [];
  lines.push("", "Pages checked:");
  if (pages.length === 0) lines.push("- none");
  for (const p of pages) lines.push(`- \`${p.route}\`${p.why ? ` — ${p.why}` : ""}`);
  lines.push("", `Shots: ${(m.shots ?? []).length}`);
  return head + lines.join("\n");
}

/** What the gate tells the verify stage: QA's regression lines, then the shot names (capped). Pure. */
export function qaFailSummary(m: QaManifest): string {
  const out = [`QA verdict ${m.verdict}: ${m.reason ?? ""}`, ""];
  if (m.regressions?.length) out.push("Regressions (worse than the baseline):", ...m.regressions.map(findingLine));
  if (m.noBaseline?.length) out.push("Defects with no baseline (fail closed):", ...m.noBaseline.map(findingLine));
  const shots = (m.shots ?? []).map((s) => s.file).filter((f): f is string => Boolean(f));
  if (shots.length) out.push("", `Shots (${shots.length}): ${shots.slice(0, 40).join(", ")}${shots.length > 40 ? ", ..." : ""}`);
  return out.join("\n");
}

// --- A PASS that checked nothing (slashbin-ai-foreman#158) ---

/** The hold a zero-shot PASS on a client change becomes: QA's `page-unplaced`, the Foreman-side twin of its fail-closed fix. */
export const PAGE_UNPLACED_HOLD = "page-unplaced";
const isClientCode = (f: string): boolean => f.startsWith("client/");

/**
 * The one rule: a PASS with no shots on a PR that changes `client/` code checked no page, so it is not a verdict
 * (Slashbin-console#1589: a PASS with 0 pages, 0 shots on `client/src/App.tsx` was reused forever). Pure.
 */
export function isVoidPass(shots: number, files: readonly string[]): boolean {
  return shots === 0 && files.some(isClientCode);
}

/** The shot count a posted gating report states (`Shots: N`), or undefined when it states none. Pure. */
export function reportShots(body: string): number | undefined {
  const m = /^Shots: (\d+)\s*$/m.exec(body);
  return m ? Number(m[1]) : undefined;
}

/**
 * `outcome`, with a void PASS (see `isVoidPass`) turned into the HELD `page-unplaced` that QA would now report,
 * so the decision, the posted report and its marker all say HELD. Anything else is returned unchanged. Pure.
 */
export function withVoidPassHeld(outcome: QaOutcome, files: readonly string[]): QaOutcome {
  if (outcome.kind !== "manifest" || outcome.manifest.verdict !== "PASS" || outcome.exitCode !== 0) return outcome;
  if (!isVoidPass((outcome.manifest.shots ?? []).length, files)) return outcome;
  const changed = files.filter(isClientCode).slice(0, 5).join(", ");
  return {
    kind: "manifest",
    exitCode: 3,
    manifest: {
      ...outcome.manifest,
      verdict: "HELD",
      hold: PAGE_UNPLACED_HOLD,
      reason: `QA passed with 0 shots, but the PR changes client code (${changed}): no page was checked, so this is not a PASS`,
    },
  };
}

/** `executeQa`, then `withVoidPassHeld` over the PR's changed files when the deps can name them. */
async function executeQaChecked(repo: string, pr: number, deps: QaDeps): Promise<QaOutcome> {
  const outcome = await executeQa(repo, pr, deps);
  if (!deps.changedFiles || outcome.kind !== "manifest" || outcome.manifest.verdict !== "PASS") return outcome;
  return withVoidPassHeld(outcome, await deps.changedFiles(pr).catch(() => []));
}

// --- The EM's QA rerun on a merged PR (slashbin-ai-foreman#158) ---

/** A PR comment that opens with this is the EM's request for a fresh QA run on the merged PR. */
export const QA_RERUN_PATTERN = /^\s*\*\*EM QA rerun/;
const QA_REPORT_KEY = /^## QA Report\n<!-- foreman-qa sha=(\S+) verdict=(\S+?)(?: req=(\d+))? -->/;

/** A PR comment as the requirement reads it, oldest first. */
export interface QaComment { id: number; body: string; at: string }

/** What a merged PR's EM rerun requests demand of its card. */
export interface QaRequirement {
  /** A request exists and no PASS answers the newest one: post-merge QA must pass before the card may be `pr approved`. */
  required: boolean;
  /** The newest request has no terminal verdict (PASS or FAIL) yet: it needs a fresh QA run. A HELD report keeps it open. */
  fresh: boolean;
  /** The newest request's comment id and time (keys the report and tells a hold older than the request). */
  reqId: number | null;
  reqAt: string | null;
}

/**
 * The one owner of "is post-merge QA satisfied for this card" (slashbin-ai-foreman#158). Once a merged PR carries any
 * `**EM QA rerun` request, QA is required: only a PASS keyed to `mergeSha` and to the newest request, posted after it,
 * satisfies it. A FAIL answers the request (no automatic rerun) but leaves QA required, so a released hold still needs
 * a fresh PASS; a HELD or errored run answers nothing. Reports carry `req=<comment id>`. Pure.
 */
export function postMergeQaRequirement(comments: readonly QaComment[], mergeSha: string): QaRequirement {
  const asked = comments.map((c, i) => (QA_RERUN_PATTERN.test(c.body) ? i : -1)).filter((i) => i >= 0).pop();
  if (asked === undefined) return { required: false, fresh: false, reqId: null, reqAt: null };
  const req = comments[asked]!;
  const verdicts = comments.slice(asked + 1).flatMap((c) => {
    const m = QA_REPORT_KEY.exec(c.body);
    return m && sameSha(m[1]!, mergeSha) && m[3] === String(req.id) ? [m[2]!] : [];
  });
  return { required: !verdicts.includes("PASS"), fresh: !verdicts.some((v) => v === "PASS" || v === "FAIL"), reqId: req.id, reqAt: req.at };
}

/**
 * Post the gating report unless a comment with the same marker (head SHA + verdict)
 * is already there, so a re-run after a restart does not double-post. A failed
 * lookup or post is logged and never changes the gate's decision.
 */
async function postGateReport(pr: number, marker: string, body: string, deps: QaDeps, check: (pr: number, marker: string) => Promise<boolean>, logger: Logger): Promise<void> {
  try {
    if (await check(pr, marker)) {
      logger.info(`QA: PR #${pr} already has this report; not posting again`);
      return;
    }
    await deps.post(pr, body);
  } catch (e) {
    logger.warn(`QA: PR #${pr} report not posted: ${String(e).slice(0, 300)}`);
  }
}

/**
 * The gate: given an SRE pass, run QA and return what the verify stage acts on.
 * PASS returns the SRE result untouched. FAIL becomes the existing visual-QA
 * rework hold (`visual-qa-failed`, with QA's regressions and shots). HELD, a
 * crash, a timeout, an unreadable manifest or an exit that disagrees with its
 * verdict becomes a `qa-*` hold: never an advance on an unknown. An errored run
 * (`qa-errored`) is a tooling hold that charges no attempt (`TOOLING_HOLDS`,
 * slashbin-ai-foreman#137). Never throws.
 */
export async function applyQaGate(
  sre: Extract<VerifyResult, { kind: "verdict" }>,
  repo: string,
  pr: number,
  deps: QaDeps,
  logger: Logger,
  opts: { markerSha?: string; reqId?: number } = {},
): Promise<VerifyResult> {
  const outcome = await executeQaChecked(repo, pr, deps);
  // `markerSha`/`reqId`: a rerun on a merged PR keys its report to the merge sha and the request's comment id, so each
  // request gets exactly one fresh report per verdict, whatever sha QA names and whatever earlier requests said.
  const marker = opts.markerSha && outcome.kind === "manifest"
    ? `<!-- foreman-qa sha=${opts.markerSha} verdict=${outcome.manifest.verdict}${opts.reqId !== undefined ? ` req=${opts.reqId}` : ""} -->`
    : qaGateMarker(outcome);
  await postGateReport(pr, marker, qaGateBody(pr, outcome, marker), deps, deps.hasMarker ?? (async () => false), logger);
  const hold = (reason: string, summary: string): VerifyResult => ({ ...sre, pass: false, reason, summary, by: "QA" });
  if (outcome.kind === "errored") {
    logger.warn(`QA gate: PR #${pr} errored: ${outcome.detail}`);
    return hold("qa-errored", `QA errored: ${outcome.detail}`);
  }
  const { manifest: m, exitCode } = outcome;
  if (m.verdict === "PASS" && exitCode === 0) return sre;
  if (m.verdict === "FAIL" && exitCode === 1) return hold("visual-qa-failed", qaFailSummary(m));
  if (m.verdict === "HELD" && exitCode === 3) return hold(`qa-held-${m.hold ?? "unknown"}`, `QA could not check: ${m.reason ?? ""}`);
  return hold("qa-inconsistent", `QA exit ${exitCode} disagrees with verdict ${m.verdict}`);
}

// --- QA before the merge (config.qaBeforeMerge) ---

/**
 * The local run: `qa.mjs check --local` boots the PR itself and generates its own mint key, so it
 * takes no secret and does not go through doppler-run (the gate's `run` above does). It needs git,
 * npm, the network and GH_TOKEN, all in `buildQaEnv`.
 */
export function realQaLocalDeps(repoConfig: RepoConfig, agentConfig: AgentConfig, logger: Logger): QaDeps {
  return {
    ...realQaDeps(repoConfig, agentConfig, logger),
    async run({ repo, pr, out }) {
      const qa = agentConfig.qaPath;
      if (!qa) return { kind: "errored", detail: "qaPath must be set" };
      // A manifest left by an earlier run must never be read as this one's.
      rmSync(join(out, "manifest.json"), { force: true });
      const args = ["check", "--local", "--repo", repo, "--pr", String(pr), "--out", out];
      const r: CliRun = await runAgentCli(qa, "bin/qa.mjs", args, buildQaEnv(agentConfig), agentConfig, QA_MAX_DURATION_MS);
      return readOutcome(r, out, logger);
    },
  };
}

/** The marker a gating report for `verdict` on head `sha` carries (see qaGateMarker). */
export const qaVerdictMarker = (sha: string, verdict: "PASS" | "FAIL"): string => `<!-- foreman-qa sha=${sha} verdict=${verdict} -->`;

/** What the review phase acts on after QA looked at an approved head. */
export type QaPreMergeDecision =
  /** QA passed this exact head: the Tech Lead may merge. `reused`: a report for it was already on the PR. */
  | { kind: "pass"; reused: boolean }
  /** QA failed the head: back to the builder. `summary` is QA's regression lines. */
  | { kind: "fail"; summary: string; reused: boolean }
  /** No verdict on the head (held, errored, inconsistent): nothing merges. `reason` is a hold slug. */
  | { kind: "hold"; reason: string; summary: string };

const sameSha = (a: string, b: string): boolean => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

/**
 * Run QA once for head `headSha` of PR `pr` and say what to do. One run per head: a PASS or FAIL report
 * for this sha already on the PR (the hidden marker) is the answer, so a restart neither reruns nor
 * re-posts. A PASS counts only when the manifest names this head; any other reading of exit and
 * manifest is a hold, never a merge. Never throws.
 */
export async function runQaBeforeMerge(repo: string, pr: number, headSha: string, deps: QaDeps, logger: Logger): Promise<QaPreMergeDecision> {
  const has = deps.hasMarker ?? (async () => false);
  let voidReused = false;
  try {
    if (await has(pr, qaVerdictMarker(headSha, "PASS"))) {
      // A reused PASS must have checked something: its posted report states the shots (slashbin-ai-foreman#158).
      const body = await deps.reportBody?.(pr, qaVerdictMarker(headSha, "PASS"));
      const shots = body === undefined ? undefined : reportShots(body);
      const files = shots === 0 && deps.changedFiles ? await deps.changedFiles(pr).catch(() => []) : [];
      if (shots === undefined || !isVoidPass(shots, files)) return { kind: "pass", reused: true };
      logger.warn(`QA: PR #${pr} has a PASS for ${headSha.slice(0, 7)} with 0 shots on a client change; not reusing it, running QA again`);
      voidReused = true;
    }
    if (!voidReused && await has(pr, qaVerdictMarker(headSha, "FAIL"))) {
      return { kind: "fail", summary: "QA already failed this head; see its QA Report on the PR.", reused: true };
    }
  } catch (e) {
    logger.warn(`QA: PR #${pr} marker lookup failed (${String(e).slice(0, 200)}); running QA`);
  }
  const outcome = await executeQaChecked(repo, pr, deps);
  const decision = decideQaBeforeMerge(outcome, headSha);
  // Only a consistent verdict carries a verdict marker (the one the lookup above reuses), and always with the
  // full head sha passed in, never the manifest's. Anything else is keyed so it can never be reused as a verdict.
  const marker = decision.kind === "pass" ? qaVerdictMarker(headSha, "PASS")
    : decision.kind === "fail" ? qaVerdictMarker(headSha, "FAIL")
    : outcome.kind === "errored" ? qaGateMarker(outcome)
    : `<!-- foreman-qa sha=${headSha} verdict=${decision.reason === "qa-inconsistent" ? "INCONSISTENT" : "HELD"} -->`;
  // The earlier void PASS carries the PASS marker; a fresh PASS must still post, or the next look reads the old zero.
  await postGateReport(pr, marker, qaGateBody(pr, outcome, marker), deps, voidReused ? async () => false : has, logger);
  if (decision.kind === "hold") logger.warn(`QA: PR #${pr} held: ${decision.reason}: ${decision.summary}`);
  return decision;
}

/**
 * What a QA outcome means for the approved head. Pure. A PASS needs exit 0 and a manifest naming this head; a
 * FAIL needs exit 1 and the same; HELD needs exit 3. Every other combination is `qa-inconsistent`, a hold.
 */
export function decideQaBeforeMerge(rawOutcome: QaOutcome, headSha: string, changedFiles?: readonly string[]): QaPreMergeDecision {
  // A zero-shot PASS on a client change is HELD page-unplaced, never a PASS (slashbin-ai-foreman#158).
  const outcome = changedFiles ? withVoidPassHeld(rawOutcome, changedFiles) : rawOutcome;
  if (outcome.kind === "errored") return { kind: "hold", reason: "qa-errored", summary: `QA errored: ${outcome.detail}` };
  const { manifest: m, exitCode } = outcome;
  const named = Boolean(m.sha) && sameSha(m.sha!, headSha);
  if (m.verdict === "PASS" && exitCode === 0 && named) return { kind: "pass", reused: false };
  if (m.verdict === "FAIL" && exitCode === 1 && named) return { kind: "fail", summary: qaFailSummary(m), reused: false };
  if (m.verdict === "HELD" && exitCode === 3) return { kind: "hold", reason: `qa-held-${m.hold ?? "unknown"}`, summary: `QA could not check: ${m.reason ?? ""}` };
  const why = (m.verdict === "PASS" || m.verdict === "FAIL") && !named && (exitCode === (m.verdict === "PASS" ? 0 : 1))
    ? `QA ${m.verdict} names ${m.sha ?? "no sha"}, but the approved head is ${headSha}`
    : `QA exit ${exitCode} disagrees with verdict ${m.verdict}`;
  return { kind: "hold", reason: "qa-inconsistent", summary: why };
}

const QA_FAIL_REPORT = /^## QA Report\n<!-- foreman-qa sha=\S+ verdict=FAIL -->/;

/** A QA FAIL report's verdict, reason and failing findings (everything above "Pages checked:"). Pure. */
export function qaFailLines(body: string): string {
  const lines = body.split("\n").slice(3);
  const end = lines.findIndex((l) => l.startsWith("Pages checked:"));
  return (end === -1 ? lines : lines.slice(0, end)).join("\n").trim();
}

/** The newest QA FAIL report on PR `pr`, reduced to its failing lines; undefined when there is none or GitHub cannot say. */
export async function latestQaFailLines(repoConfig: RepoConfig, pr: number, logger: Logger): Promise<string | undefined> {
  try {
    const fails = (await commentBodies(repoConfig, pr)).filter((b) => QA_FAIL_REPORT.test(b));
    const last = fails[fails.length - 1];
    return last ? qaFailLines(last) : undefined;
  } catch (e) {
    logger.warn(`QA: PR #${pr} report not read for the revise session: ${String(e).slice(0, 200)}`);
    return undefined;
  }
}
