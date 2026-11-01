// The QA report: after the SRE's dev verify passes, run `qa.mjs check` once for the
// merged PR and say what it found on the PR. Report-only: nothing here moves a label,
// holds a card or waits (the caller does not await `reportQaAfterVerify`'s work).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { VerifyResult } from "./plugins/contract.js";
import { qaFor, roleFor } from "./plugins/registry.js";
import { codeHost } from "./plugins/registry.js";

/** The heading the comment opens with; also the idempotency key. */
export const QA_HEADING = "## QA Report (report-only)";

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
  /** The PR's comments with their times (a void PASS and the EM's re-run request are read from them). */
  comments?(pr: number): Promise<PrComment[]>;
  /** The paths the PR changed; empty when unreadable. */
  changedFiles?(pr: number): Promise<string[]>;
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

/** Whether an enabled QA plugin covers `repoConfig` on this install. */
export function qaApplies(repoConfig: RepoConfig, agentConfig: AgentConfig): boolean {
  return qaFor(repoConfig, agentConfig) !== undefined;
}

/**
 * Whether QA runs BEFORE the merge for `repoConfig` (config.qaBeforeMerge): the flag, a QA repo, and the
 * reviewer that does the merge. When true the post-merge QA (gate and report-only) does not run for it.
 */
export function qaBeforeMergeApplies(repoConfig: RepoConfig, agentConfig: AgentConfig): boolean {
  return agentConfig.qaBeforeMerge && roleFor("reviewer", agentConfig) !== undefined && qaApplies(repoConfig, agentConfig);
}

/** The real edges: the PR's comments and files on the code host, and the QA plugin covering the repo, on dev. */
export function realQaDeps(repoConfig: RepoConfig, agentConfig: AgentConfig, logger: Logger, local = false): QaDeps {
  return {
    hasMarker: (pr, marker) => codeHost().hasCommentContaining(repoConfig, pr, marker),
    hasReport: (pr) => codeHost().hasCommentStartingWith(repoConfig, pr, QA_HEADING),
    post: (pr, body) => codeHost().commentOnPr(repoConfig, pr, body),
    comments: (pr) => codeHost().commentsWithTimes(repoConfig, pr),
    changedFiles: async (pr) => codeHost().prChangedFiles(repoConfig.githubRepo, pr, repoConfig.repoPath, logger),
    async run({ repo, pr, out }) {
      const qa = qaFor(repoConfig, agentConfig);
      if (!qa) return { kind: "errored", detail: `no enabled QA plugin covers ${repo}` };
      return qa.check(repoConfig, agentConfig, { repo, pr, out, local }, logger);
    },
  };
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

/**
 * Post the gating report unless a comment with the same marker (head SHA + verdict)
 * is already there, so a re-run after a restart does not double-post. With the comments
 * edge, only a report that still answers counts (reportAlreadyPosted, slashbin-ai-foreman#158).
 * A failed lookup or post is logged and never changes the gate's decision.
 */
async function postGateReport(pr: number, marker: string, body: string, deps: QaDeps, check: (pr: number, marker: string) => Promise<boolean>, logger: Logger, changed: readonly string[] = []): Promise<void> {
  try {
    const posted = deps.comments ? reportAlreadyPosted(await deps.comments(pr), marker, changed) : await check(pr, marker);
    if (posted) {
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
): Promise<VerifyResult> {
  const outcome = await executeQa(repo, pr, deps);
  const changed = await changedOf(pr, deps);
  // A void PASS (no shot of a client change) is keyed HELD, so it never reads as a PASS report.
  const isVoid = outcome.kind === "manifest" && outcome.manifest.verdict === "PASS" && outcome.exitCode === 0 && isVoidQaPass((outcome.manifest.shots ?? []).length, changed);
  const marker = isVoid && outcome.kind === "manifest" ? `<!-- foreman-qa sha=${outcome.manifest.sha ?? "unknown"} verdict=HELD -->` : qaGateMarker(outcome);
  await postGateReport(pr, marker, qaGateBody(pr, outcome, marker), deps, deps.hasMarker ?? (async () => false), logger, changed);
  const hold = (reason: string, summary: string): VerifyResult => ({ ...sre, pass: false, reason, summary, by: "QA" });
  if (outcome.kind === "errored") {
    logger.warn(`QA gate: PR #${pr} errored: ${outcome.detail}`);
    return hold("qa-errored", `QA errored: ${outcome.detail}`);
  }
  const { manifest: m, exitCode } = outcome;
  if (isVoid) return hold("qa-held-page-unplaced", `QA passed without a shot, but the PR changed client code: ${m.reason ?? ""}`);
  if (m.verdict === "PASS" && exitCode === 0) return sre;
  if (m.verdict === "FAIL" && exitCode === 1) return hold("visual-qa-failed", qaFailSummary(m));
  if (m.verdict === "HELD" && exitCode === 3) return hold(`qa-held-${m.hold ?? "unknown"}`, `QA could not check: ${m.reason ?? ""}`);
  return hold("qa-inconsistent", `QA exit ${exitCode} disagrees with verdict ${m.verdict}`);
}

// --- QA before the merge (config.qaBeforeMerge) ---

/** The same edges, with QA booting the PR locally (before the merge) instead of checking dev. */
export function realQaLocalDeps(repoConfig: RepoConfig, agentConfig: AgentConfig, logger: Logger): QaDeps {
  return realQaDeps(repoConfig, agentConfig, logger, true);
}

/** The marker a gating report for `verdict` on head `sha` carries (see qaGateMarker). */
export const qaVerdictMarker = (sha: string, verdict: "PASS" | "FAIL"): string => `<!-- foreman-qa sha=${sha} verdict=${verdict} -->`;

/**
 * The comment a reused FAIL leaves when it sends the same head back again. The FAIL report is posted once
 * per head, so without it a same-head send-back left nothing on the PR and never counted toward
 * REVIEW_ROUNDS_ALERT (Slashbin-console PR #1597, foreman#167); rulingState counts this marker. Pure.
 */
export function qaFailStandsBody(sha: string): string {
  return `<!-- foreman-qa-fail-stands sha=${sha} -->\nQA's FAIL on \`${sha.slice(0, 7)}\` stands: the head has not moved since its QA Report. ` +
    "Sent back to the builder again; this counts as a review round.";
}

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
  try {
    if (await has(pr, qaVerdictMarker(headSha, "PASS"))) {
      if (!(await reusedPassIsVoid(pr, headSha, deps))) return { kind: "pass", reused: true };
      logger.warn(`QA: PR #${pr} has a PASS for ${headSha.slice(0, 7)} that captured no shot of a client change; running QA again`);
    } else if (await has(pr, qaVerdictMarker(headSha, "FAIL"))) {
      return { kind: "fail", summary: "QA already failed this head; see its QA Report on the PR.", reused: true };
    }
  } catch (e) {
    logger.warn(`QA: PR #${pr} marker lookup failed (${String(e).slice(0, 200)}); running QA`);
  }
  const outcome = await executeQa(repo, pr, deps);
  const changed = await changedOf(pr, deps);
  const decision = decideQaBeforeMerge(outcome, headSha, changed);
  // Only a consistent verdict carries a verdict marker (the one the lookup above reuses), and always with the
  // full head sha passed in, never the manifest's. Anything else is keyed so it can never be reused as a verdict.
  const marker = decision.kind === "pass" ? qaVerdictMarker(headSha, "PASS")
    : decision.kind === "fail" ? qaVerdictMarker(headSha, "FAIL")
    : outcome.kind === "errored" ? qaGateMarker(outcome)
    : `<!-- foreman-qa sha=${headSha} verdict=${decision.reason === "qa-inconsistent" ? "INCONSISTENT" : "HELD"} -->`;
  await postGateReport(pr, marker, qaGateBody(pr, outcome, marker), deps, has, logger, changed);
  if (decision.kind === "hold") logger.warn(`QA: PR #${pr} held: ${decision.reason}: ${decision.summary}`);
  return decision;
}

// --- A void PASS, and the EM's re-run of a merged PR (slashbin-ai-foreman#158) ---

/** QA's client root (`slashbin_ai_qa/lib/affected-pages.mjs`): a change under it renders on some page. */
const CLIENT_PREFIX = "client/";

/**
 * A PASS that captured no shot while the PR changed client code checked nothing, so it is never a verdict
 * (Slashbin-console PR #1589: QA could not read its lazy routes and passed 0 pages). Pure.
 */
export function isVoidQaPass(shots: number, changed: readonly string[]): boolean {
  return shots === 0 && changed.some((f) => f.startsWith(CLIENT_PREFIX));
}

/** A PR comment opening with this is the EM's request to re-run QA on that merged PR. */
export const EM_QA_RERUN_PATTERN = /^\s*\*\*EM QA re-run/;
const QA_PASS_REPORT = /^## QA Report\n<!-- foreman-qa sha=\S+ verdict=PASS -->/;
const reportShots = (body: string): number => Number(/^Shots: (\d+)$/m.exec(body)?.[1] ?? 0);

export type PrComment = { at: string; body: string };

/**
 * Where a merged PR stands for QA. Pure. `rerunRequested`: the EM's newest re-run request is newer than every
 * QA Report. `realPass`: a PASS report that is not void, newer than that request (any PASS when there is none).
 */
export function postMergeQaState(comments: readonly PrComment[], changed: readonly string[]): { rerunRequested: boolean; realPass: boolean } {
  const newest = (cs: readonly PrComment[]): string | null => cs.reduce<string | null>((a, c) => (a === null || c.at > a ? c.at : a), null);
  const request = newestRequest(comments);
  const reports = comments.filter((c) => c.body.startsWith(QA_GATE_HEADING));
  const report = newest(reports);
  return {
    rerunRequested: request !== null && (report === null || request > report),
    realPass: reports.some((r) => QA_PASS_REPORT.test(r.body) && (request === null || r.at > request) && !isVoidQaPass(reportShots(r.body), changed)),
  };
}

const newestRequest = (comments: readonly PrComment[]): string | null =>
  comments.filter((c) => EM_QA_RERUN_PATTERN.test(c.body)).reduce<string | null>((a, c) => (a === null || c.at > a ? c.at : a), null);
const isVoidPassReport = (body: string, changed: readonly string[]): boolean => QA_PASS_REPORT.test(body) && isVoidQaPass(reportShots(body), changed);

/**
 * Whether a report carrying `marker` already answers, so posting again would duplicate it. Pure. It must be
 * newer than the EM's last re-run request (an older one answered an earlier question), and a void PASS never
 * answers (its fresh replacement with shots carries the same marker and must be posted).
 */
export function reportAlreadyPosted(comments: readonly PrComment[], marker: string, changed: readonly string[]): boolean {
  const request = newestRequest(comments);
  return comments.some((c) => c.body.includes(marker) && (request === null || c.at > request) && !isVoidPassReport(c.body, changed));
}

/**
 * The PR's changed files, never throwing. Unreadable: QA's client root stands in, so a 0-shot PASS is held
 * rather than trusted (never an advance on an unknown).
 */
async function changedOf(pr: number, deps: QaDeps): Promise<string[]> {
  if (!deps.changedFiles) return [];
  try {
    return await deps.changedFiles(pr);
  } catch {
    return [CLIENT_PREFIX];
  }
}

/** Every PASS report on the PR for this head is void (none has shots). False when the edges to read it are missing. */
async function reusedPassIsVoid(pr: number, headSha: string, deps: QaDeps): Promise<boolean> {
  if (!deps.comments || !deps.changedFiles) return false;
  const marker = qaVerdictMarker(headSha, "PASS");
  const reports = (await deps.comments(pr)).filter((c) => c.body.includes(marker));
  const changed = await changedOf(pr, deps);
  return reports.length > 0 && reports.every((r) => isVoidPassReport(r.body, changed));
}

/**
 * Whether the verify stage must run the QA gate on merged PR `pr` under qaBeforeMerge: it has no real PASS
 * after the EM's last re-run request. An unreadable PR runs QA (never an advance on an unknown). Never throws.
 */
export async function postMergeQaNeeded(pr: number, deps: QaDeps, logger: Logger): Promise<boolean> {
  try {
    if (!deps.comments) return false;
    return !postMergeQaState(await deps.comments(pr), await changedOf(pr, deps)).realPass;
  } catch (e) {
    logger.warn(`QA: PR #${pr} comments unreadable (${String(e).slice(0, 200)}); running the QA gate`);
    return true;
  }
}

/**
 * What a QA outcome means for the approved head. Pure. A PASS needs exit 0 and a manifest naming this head; a
 * FAIL needs exit 1 and the same; HELD needs exit 3. Every other combination is `qa-inconsistent`, a hold.
 */
export function decideQaBeforeMerge(outcome: QaOutcome, headSha: string, changed: readonly string[] = []): QaPreMergeDecision {
  if (outcome.kind === "errored") return { kind: "hold", reason: "qa-errored", summary: `QA errored: ${outcome.detail}` };
  const { manifest: m, exitCode } = outcome;
  const named = Boolean(m.sha) && sameSha(m.sha!, headSha);
  if (m.verdict === "PASS" && exitCode === 0 && isVoidQaPass((m.shots ?? []).length, changed)) {
    return { kind: "hold", reason: "qa-held-page-unplaced", summary: `QA passed without a shot, but the PR changed client code: ${m.reason ?? ""}` };
  }
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
    const fails = (await codeHost().commentBodies(repoConfig, pr)).filter((b) => QA_FAIL_REPORT.test(b));
    const last = fails[fails.length - 1];
    return last ? qaFailLines(last) : undefined;
  } catch (e) {
    logger.warn(`QA: PR #${pr} report not read for the revise session: ${String(e).slice(0, 200)}`);
    return undefined;
  }
}
