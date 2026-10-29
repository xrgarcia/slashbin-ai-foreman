// The QA report: after the SRE's dev verify passes, run `qa.mjs check` once for the
// merged PR and say what it found on the PR. Report-only: nothing here moves a label,
// holds a card or waits (the caller does not await `reportQaAfterVerify`'s work).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { buildQaEnv, runAgentCli, type CliRun, type VerifyResult } from "./agent.js";
import { hasCommentContaining, hasCommentStartingWith, commentOnPr } from "./github/pr-comments.js";

/** The heading the comment opens with; also the idempotency key. */
export const QA_HEADING = "## QA Report (report-only)";

/**
 * One QA run's ceiling; past it the child is killed and the PR gets an "errored" comment.
 * Above QA's own longest internal ceiling: one Codex review run may take 15 minutes
 * (slashbin_ai_qa `lib/review.mjs:113`, `lib/codex.mjs:49`, 900_000 ms), which QA does not
 * export to us, so a normal review is never killed mid-run (slashbin-ai-foreman#137).
 */
export const QA_MAX_DURATION_MS = 20 * 60_000;

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
    const out = join(homedir(), ".cache", "foreman-qa", repo.replace("/", "__"), String(pr));
    let outcome: QaOutcome;
    try {
      mkdirSync(out, { recursive: true });
      outcome = await deps.run({ repo, pr, out });
    } catch (e) {
      outcome = { kind: "errored", detail: `the run threw (${String(e).slice(0, 200)})` };
    }
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
 * The real edges: `qa.mjs check` run under the EM's doppler-run.mjs, which gives
 * DEV_SESSION_MINT_KEY (project = the repo, config dev) to that child alone.
 */
export function realQaDeps(repoConfig: RepoConfig, agentConfig: AgentConfig, logger: Logger): QaDeps {
  return {
    hasMarker: (pr, marker) => hasCommentContaining(repoConfig, pr, marker),
    hasReport: (pr) => hasCommentStartingWith(repoConfig, pr, QA_HEADING),
    post: (pr, body) => commentOnPr(repoConfig, pr, body),
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
export function qaGateBody(pr: number, outcome: QaOutcome): string {
  const head = `${QA_GATE_HEADING}\n${qaGateMarker(outcome)}\n\n`;
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
 * is already there, so a re-run after a restart does not double-post. A failed
 * lookup or post is logged and never changes the gate's decision.
 */
async function postGateReport(pr: number, outcome: QaOutcome, deps: QaDeps, check: (pr: number, marker: string) => Promise<boolean>, logger: Logger): Promise<void> {
  try {
    if (await check(pr, qaGateMarker(outcome))) {
      logger.info(`QA: PR #${pr} already has this report; not posting again`);
      return;
    }
    await deps.post(pr, qaGateBody(pr, outcome));
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
  let outcome: QaOutcome;
  try {
    const out = join(homedir(), ".cache", "foreman-qa", repo.replace("/", "__"), String(pr));
    mkdirSync(out, { recursive: true });
    outcome = await deps.run({ repo, pr, out });
  } catch (e) {
    outcome = { kind: "errored", detail: `the run threw (${String(e).slice(0, 200)})` };
  }
  await postGateReport(pr, outcome, deps, deps.hasMarker ?? (async () => false), logger);
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
