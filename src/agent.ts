import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentConfig, LifecycleLabels, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { verifyPRExists, checkPRHasChanges, getRemoteBranchSha } from "./github.js";
import { checkoutPathFor } from "./review-checkout.js";
import { isUpstreamBlocked } from "./upstream-backoff.js";
import { parseStageTrailer, type CustomStage } from "./stages.js";

const FOREMAN_OVERRIDES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "system-prompt-overrides.md"
);

/**
 * Describe a non-zero exit WITHOUT letting stderr impersonate the root cause.
 *
 * The previous form was `stderr || stdoutTail || exitCode`, which put stderr
 * FIRST. The Claude CLI writes benign startup noise to stderr on every run — an
 * untrusted-workspace notice, deprecation warnings — so whenever a run failed
 * for an unrelated reason, that noise became the entire reported error and the
 * real cause was never recorded anywhere.
 *
 * Observed 2026-08-04 on slashbin-io-worker cycle 1519: the run died 12.5
 * minutes in and was reported as
 * `Implementation failed: Ignoring 5 permissions.allow entries ...`.
 * The identical warning appears on cycle 1520, which SUCCEEDED — so it could
 * not have been the cause, and the actual reason is unrecoverable. Ray brought
 * that message in as the failure; it was never even a symptom.
 *
 * The fix is precedence and labelling, not suppression: lead with the one
 * unambiguous fact (the exit code), then the agent's own output, then stderr
 * clearly marked as context. A warning can no longer appear alone, so it can no
 * longer read as a diagnosis.
 */
export function describeSpawnFailure(result: { exitCode: number | null; stdout: string; stderr: string }): string {
  // A null exit code means the process was terminated by a signal rather than
  // returning — the OOM-killer and an abort both land here. "exit code null"
  // would read as a missing value; say what actually happened.
  const parts = [
    result.exitCode === null
      ? "terminated by signal (no exit code — killed, not returned)"
      : `exit code ${result.exitCode}`,
  ];
  const stdoutTail = result.stdout.trim().slice(-500);
  if (stdoutTail) parts.push(`stdout tail: ${stdoutTail}`);
  const stderrMsg = result.stderr.trim().slice(-500);
  if (stderrMsg) parts.push(`stderr (context, not necessarily the cause): ${stderrMsg}`);
  return parts.join(" | ");
}

/**
 * Transcript destination for a phase run, mirroring the review phase's layout
 * (`logs/review/<repo>-cycleN-<ts>.log`).
 *
 * Implement and revise kept no transcript at all, so a failed implementation was
 * unanalysable the moment it ended — there was nothing to read back. That is why
 * cycle 1519's real failure is gone for good.
 */
function phaseTranscriptPath(phase: string, repoName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(process.cwd(), "logs", phase, `${repoName}-${ts}.log`);
}

export interface RevisionResult {
  success: boolean;
  error?: string;
  /**
   * The revision deliberately made no commit and SAID SO via the
   * FOREMAN_REVISION trailer. Distinct from a silent no-op, which stays a
   * failure — see the SHA check in revisePRFeedback.
   */
  noCommit?: boolean;
  /** The reason given on the trailer. Present only when `noCommit` is true. */
  noCommitReason?: string;
  /**
   * The run was refused by the Claude session limit, not failed on its merits.
   * The orchestrator reports it to the upstream back-off and charges no retry.
   */
  upstreamLimit?: UpstreamLimit;
}

/**
 * A revision that correctly changes nothing must be able to say so.
 *
 * Structured trailer, not prose. `9ed3c02` in the EM repo is the same lesson
 * from the review side: a gate that reads an agent's narrative instead of a
 * declared field grades the wrong thing. The reason is required — a bare
 * "no-commit" is indistinguishable from the silent no-op this guard exists to
 * catch.
 *
 *   FOREMAN_REVISION no-commit reason=<why no code change was needed>
 */
const REVISION_NO_COMMIT = /FOREMAN_REVISION\s+no-commit\s+reason=(.+)/i;

/** One parsed FOREMAN_REVIEW trailer line. */
export interface ReviewTrailer {
  pr: number;
  verdict: string;
  merged: boolean;
  deploy: string;
  /**
   * Reason the reviewer DELIBERATELY withheld the issue's outcome label, from the
   * optional `hold=` field. Undefined when the field is absent (every trailer
   * written before this field existed) or when it says no/none/false.
   *
   * This exists to keep one honest case from being punished by the label
   * reconciler: a reviewer that cannot yet judge an acceptance criterion (e.g. one
   * that only becomes observable at a later time boundary) is RIGHT to leave the
   * label alone, and must be able to say so. Without a way to declare it, a
   * deliberate hold and a dropped label are the same observation, and automation
   * has to guess — which means overwriting a correct judgment with a rubber stamp.
   */
  hold?: string;
}

export interface ReviewResult {
  success: boolean;
  error?: string;
  // The skill's final summary text (parsed from the stream-json result event).
  summary?: string;
  // Concise per-PR status parsed from the FOREMAN_REVIEW trailer(s), including the
  // deployment outcome — e.g. "#100 APPROVE · merged · deploy SUCCESS". Surfaced
  // in the Foreman's Discord status line. Undefined if no trailer was emitted.
  statusLine?: string;
  // The same trailers, structured, so the orchestrator can check the run's
  // post-condition (did the issues it claims to have merged actually advance?).
  trailers?: ReviewTrailer[];
  /**
   * The run was refused by the Claude session limit, not failed on its merits.
   * The orchestrator reports it to the upstream back-off and charges no retry.
   */
  upstreamLimit?: UpstreamLimit;
}

/**
 * Parse the structured review trailers the skill is asked to emit, one per PR it
 * acted on:
 *   FOREMAN_REVIEW pr=#100 verdict=APPROVE merged=yes deploy=SUCCESS
 */
export function parseReviewTrailerRecords(stdout: string): ReviewTrailer[] {
  // Each field uses a bounded token alphabet ([\w/-]+) so it cannot bleed into
  // surrounding characters when the trailer is emitted inside a single-line
  // stream-JSON envelope (the Claude CLI's --output-format=stream-json), where
  // the characters immediately after the trailer (`"}],"STOP_REASON":NULL,…`)
  // are non-whitespace and would be greedily absorbed by an unbounded `\S+`.
  // `hold=` is OPTIONAL and trails the original four fields, so every trailer
  // written before it existed still matches with the group undefined. Do not
  // reorder or make it required — the four-field form is the published contract.
  const re = /FOREMAN_REVIEW\s+pr=#?(\d+)\s+verdict=([\w/-]+)\s+merged=([\w/-]+)\s+deploy=([\w/-]+)(?:\s+hold=([\w/-]+))?/gi;
  const out: ReviewTrailer[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const [, pr, verdict, merged, deploy, hold] = m;
    const holding = hold !== undefined && !/^(0|n|no|none|false|off)$/i.test(hold);
    out.push({
      pr: Number(pr),
      verdict: verdict.toUpperCase(),
      merged: /^(y|yes|true)$/i.test(merged),
      deploy: deploy.toUpperCase(),
      ...(holding ? { hold } : {}),
    });
  }
  return out;
}

/** Render parsed trailers as the concise Discord status line. */
function formatReviewTrailers(trailers: ReviewTrailer[]): string | undefined {
  if (trailers.length === 0) return undefined;
  return trailers
    .map((t) => {
      const mergedTxt = t.merged ? "merged" : "not merged";
      const deployTxt = /^(NA|N\/A|NONE)$/.test(t.deploy) ? "no deploy" : `deploy ${t.deploy}`;
      const holdTxt = t.hold ? ` · HELD (${t.hold})` : "";
      return `#${t.pr} ${t.verdict} · ${mergedTxt} · ${deployTxt}${holdTxt}`;
    })
    .join("; ");
}

/**
 * The explicit "there was nothing to review" sentinel. Without it, a clean no-op
 * and a session that died mid-review are the same observation — no trailer — and
 * the trailer gate below would have to choose which one to assume. Making the
 * no-op DECLARE itself lets the gate treat silence as the failure it usually is.
 */
const REVIEW_NOOP_SENTINEL = /FOREMAN_REVIEW\s+none\b/i;

export interface ImplementationResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  // True when the agent deliberately declined to implement (e.g., the issue body
  // says "investigate first, no code change yet"). Distinguishes a clean no-op
  // from a real implementation failure so the orchestrator can back off instead
  // of treating it as a retryable error.
  skipped?: boolean;
  // Reason the agent gave for skipping, surfaced from its output.
  skipReason?: string;
  // Issues the agent decided to skip. Empty/undefined when no skip was detected.
  skippedIssues?: number[];
  /**
   * The run was refused by the Claude session limit, not failed on its merits.
   * The orchestrator reports it to the upstream back-off and charges no retry.
   */
  upstreamLimit?: UpstreamLimit;
}

// Detect a deliberate skip in the agent's output. Two signals, in order of
// reliability:
//  1. Structured trailer: `FOREMAN_RESULT: skipped reason="<text>"` — what we
//     ask the skill to emit.
//  2. Free-text heuristic: the agent wrote about "skipping" or "no immediate
//     code change". Less precise but catches well-behaved agents that explained
//     themselves without using the structured trailer.
/**
 * The STRUCTURED trailer only — no free-text heuristic.
 *
 * This one is consulted BEFORE any PR detection, so it must never fire on an
 * agent that merely talked about skipping while actually implementing. The
 * trailer is a declaration; the heuristic in detectSkipSignal is a guess, and a
 * guess does not get to pre-empt the evidence.
 */
// Exported for tests: the field parse is what broke, so it is tested by calling.
export function detectDeclaredSkip(stdout: string): { skipped: boolean; reason?: string; issue?: number } {
  // Find the trailer LINE first, then read its fields off it, so the fields may
  // appear in any order. The previous shape — `skipped(?:\s+reason="...")?` —
  // only bound `reason` when it immediately followed `skipped`, so the moment the
  // documented format grew an `issue=` field in front of it the reason silently
  // became "no reason given". That is not cosmetic: the reason is persisted as
  // state.skipped[n].reason and is the ONLY input to isResolvedTransientSkip,
  // which recognises a transient divergence solely by matching the agent's own
  // wording. A dropped reason turns a self-clearing skip into a 24h back-off.
  const line = stdout.match(/FOREMAN_RESULT:\s*skipped[^\n]*/i);
  if (!line) return { skipped: false };
  const trailer = line[0];
  const reason = trailer.match(/\breason="([^"]*)"/i);
  // An OPTIONAL `issue=<N>` scopes the skip to the one issue the agent stopped
  // on. Without it the skip applies to the whole batch we handed over, which is
  // right when the agent judged the batch as a whole and wrong when it stopped
  // on one spec — and `implement-approved-issues` selects exactly ONE issue per
  // invocation, so unscoped there means every other approved issue in the repo
  // gets backed off 30m..24h for a defect in a spec it never read.
  const scoped = trailer.match(/\bissue="?#?(\d+)"?/i);
  return {
    skipped: true,
    reason: reason ? reason[1] : "no reason given",
    issue: scoped ? Number(scoped[1]) : undefined,
  };
}

function detectSkipSignal(stdout: string): { skipped: boolean; reason?: string } {
  // Structured trailer (preferred)
  const declared = detectDeclaredSkip(stdout);
  if (declared.skipped) {
    return declared;
  }

  // Free-text heuristics on the last 2000 chars (agents tend to put the
  // conclusion at the end of their output).
  const tail = stdout.slice(-2000).toLowerCase();
  const phrases = [
    "skipped because",
    "skipping this issue",
    "no implementation needed",
    "no immediate code change",
    "cannot be implemented",
    "no code change is warranted",
    "issue body explicitly says",
    "decided not to implement",
    "declined to implement",
  ];
  for (const phrase of phrases) {
    if (tail.includes(phrase)) {
      return { skipped: true, reason: `output indicates skip ("${phrase}")` };
    }
  }
  return { skipped: false };
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

// Claude is multimodal — when issue bodies or PR review comments include
// markdown image references like ![alt](url), the agent must fetch each image
// to a local file and Read it. Without this, the model sees only the URL string
// and is blind to visual specs (mockups, screenshots, walkthrough frames).
//
// Authorization header is required for private-repo URLs
// (e.g. github.com/<owner>/<repo>/raw/<branch>/<path>) and harmless for public
// CDN URLs (e.g. github.com/user-attachments/...).
const IMAGE_HANDLING_INSTRUCTIONS = `IMAGE HANDLING: If an issue body or PR review comment contains markdown image references like \`![alt](https://...)\`, those images are part of the spec. Fetch each image to a temp file and Read it so you can see it:

  curl -sL -H "Authorization: token $GH_TOKEN" -o /tmp/foreman-image-<n>.png "<url>"
  Then call the Read tool on /tmp/foreman-image-<n>.png — the multimodal model will see the image content.

The Authorization header is required for private-repo URLs (github.com/.../raw/...) and harmless for public CDN URLs (github.com/user-attachments/...). If a fetch fails, log a warning and proceed with the text spec — do not abort the implementation.`;

/**
 * The generic skills shipped with the Foreman, selected per repo with
 * `skillPath: "builtin:"` / `revisionSkillPath: "builtin:"`. Resolved from this
 * file's own location (like FOREMAN_OVERRIDES), never from cwd — the session
 * runs inside the managed repo, where `skills/` means something else or nothing.
 * Kept out of `.claude/skills/` so Claude Code does not offer them as
 * user-invocable skills in a session opened on the Foreman itself.
 */
export const BUILTIN_SKILL = "builtin:";
const FOREMAN_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");

type PromptPart = { ok: true; text: string } | { ok: false; error: string };

/**
 * The opening instruction for a skill-mode prompt. A repo-local path is handed
 * to the session to read, exactly as before. `builtin:` inlines the bundled
 * SKILL.md instead of pointing at it: the text the session follows is then the
 * text this Foreman build shipped with, wherever the package is installed.
 */
function skillInstruction(config: RepoConfig, skillPath: string, builtin: "implement" | "revise"): PromptPart {
  if (skillPath !== BUILTIN_SKILL) return { ok: true, text: `Read and follow the skill at ${skillPath}.` };
  const file = join(FOREMAN_SKILLS_DIR, builtin, "SKILL.md");
  try {
    const body = readFileSync(file, "utf8").trim();
    // The built-in skill is the same text for every repo, so the per-repo
    // facts it cannot carry are stated here. Labels are not among them: they
    // reach the session as FOREMAN_TRIGGER_LABEL / FOREMAN_LIFECYCLE_LABELS.
    return {
      ok: true,
      text: `Follow the skill below — the Foreman's built-in skills/${builtin}/SKILL.md.\n\n` +
        `Repository: ${config.githubRepo}. Feature branch: ${config.featureBranch}. ` +
        `Pull requests target: ${config.baseBranch}.\n\n` +
        `===== SKILL =====\n${body}\n===== END SKILL =====`,
    };
  } catch (err) {
    return { ok: false, error: `built-in ${builtin} skill unreadable at ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * A configured overlay, read relative to the managed repo. Configured but
 * unreadable is a failure for this work item — running the skill without the
 * operator's rules would be a partial application, so the caller does not
 * launch Claude at all.
 */
function readOverlay(config: RepoConfig, overlayPath: string | undefined, field: string): PromptPart {
  if (!overlayPath) return { ok: true, text: "" };
  const file = resolve(config.repoPath, overlayPath);
  try {
    const body = readFileSync(file, "utf8").trim();
    return { ok: true, text: `\n\n===== REPO OVERLAY (${overlayPath}) — applies on top of the skill above =====\n${body}\n===== END OVERLAY =====` };
  } catch (err) {
    return { ok: false, error: `${field} ${overlayPath} unreadable at ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface SpawnOptions {
  /** Working directory for the claude process. */
  cwd: string;
  /** Value to inject as GH_TOKEN (controls GitHub account attribution). */
  ghToken?: string;
  /** The repo's trigger label, handed to the session as FOREMAN_TRIGGER_LABEL. */
  triggerLabel: string;
  /** The configured lifecycle labels, handed to the session as FOREMAN_LIFECYCLE_LABELS. */
  lifecycleLabels: LifecycleLabels;
  model?: string;
  allowedTools: string[];
  /** MCP client config to load (`--mcp-config`); each server it names is allowed. */
  mcpConfig?: string;
  maxTurns: number;
  maxDurationMs: number;
  /**
   * Emit the full turn-by-turn interaction as newline-delimited JSON
   * (`--output-format stream-json --verbose`) instead of just the final text.
   * Used by the review phase so the transcript captures every tool call + result.
   */
  streamJson?: boolean;
  /**
   * When set, the raw stdout/stderr stream is appended to this file verbatim for
   * post-hoc debugging. The directory is created if needed.
   */
  transcriptPath?: string;
  /**
   * What this run was working on, for the timeout line. `Claude CLI timed out
   * after 3600000ms` with nothing else on it reads as a daemon fault; the owner
   * read exactly that as "the merge did not happen" on 2026-09-22 (issue #41),
   * when in fact the run had merged the PR 55 minutes earlier.
   */
  runLabel?: string;
  /** Extra session env on top of the label env every session gets. */
  extraEnv?: Record<string, string>;
}

/**
 * Server names in an MCP client config. Names only — the file carries bearer
 * tokens and nothing from it but the keys is ever logged. A missing or
 * unreadable file yields none, which leaves the session exactly as before.
 */
export function mcpServerNames(path: string, logger: Logger): string[] {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
    return Object.keys(data.mcpServers ?? {}).filter((n) => /^[\w-]+$/.test(n));
  } catch {
    logger.warn(`Builder MCP config at ${path} is unreadable — running the builder without it`);
    return [];
  }
}

/**
 * Low-level Claude CLI spawn. All callers go through this so the timeout/abort/
 * stream-capture behavior is shared. The per-call options carry cwd, token, and
 * tool surface — implement/revise run in the service repo under the Foreman
 * token; review runs in the EM repo under the EM token (see reviewOpenPRs).
 */
function spawnClaudeWithOptions(
  prompt: string,
  opts: SpawnOptions,
  logger: Logger,
  abortSignal?: AbortSignal
): Promise<SpawnResult> {
  const args = [
    "--print",
    prompt,
    "--max-turns", String(opts.maxTurns),
    "--dangerously-skip-permissions",
  ];

  // Overrides for the harness defaults that fight how a non-interactive builder
  // has to behave (.claude/system-prompt-overrides.md in THIS repo).
  //
  // Resolved from this file's own location, never from cwd: every run happens
  // inside a service-repo checkout, so a cwd-relative lookup would silently find
  // nothing on every cycle and the flag would never be passed.
  //
  // This only APPENDS. It does not outrank the default prompt by any mechanism —
  // later and more specific text is persuasion, not precedence. Anything that must
  // not happen belongs in a PreToolUse hook that blocks.
  if (existsSync(FOREMAN_OVERRIDES)) {
    args.push("--append-system-prompt-file", FOREMAN_OVERRIDES);
  }

  if (opts.streamJson) {
    args.push("--output-format", "stream-json", "--verbose");
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  const allowedTools = [...opts.allowedTools];
  if (opts.mcpConfig) {
    const servers = mcpServerNames(opts.mcpConfig, logger);
    if (servers.length > 0) {
      args.push("--mcp-config", opts.mcpConfig);
      allowedTools.push(...servers.map((s) => `mcp__${s}`));
    }
  }

  if (allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }

  let transcript: WriteStream | null = null;
  if (opts.transcriptPath) {
    try {
      mkdirSync(dirname(opts.transcriptPath), { recursive: true });
      transcript = createWriteStream(opts.transcriptPath, { flags: "a" });
      const argsForLog = args.map((a) => (a === prompt ? "<prompt>" : a));
      transcript.write(
        `# claude invocation @ ${new Date().toISOString()}\n` +
        `# cwd=${opts.cwd}\n` +
        `# args=${JSON.stringify(argsForLog)}\n` +
        `# prompt:\n${prompt}\n\n===== STREAM =====\n`
      );
    } catch (err) {
      logger.warn(`Failed to open transcript ${opts.transcriptPath}: ${err instanceof Error ? err.message : String(err)}`);
      transcript = null;
    }
  }

  // GH_TOKEN must be a string or absent — never literal "undefined".
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.ghToken) env.GH_TOKEN = opts.ghToken;
  // The configured label names, for the skill. The daemon filtering on a renamed
  // trigger label while the skill runs `gh issue list --label approved` selects
  // work the agent never finds, so the skill reads these instead of its own
  // literals. Set here because every session goes through this function — a new
  // caller cannot forget them. Labels as one JSON map (`JSON.parse` once, iterate
  // the set); the trigger label on its own, since it selects work and a skill
  // uses it alone in `--label`.
  env.FOREMAN_TRIGGER_LABEL = opts.triggerLabel;
  env.FOREMAN_LIFECYCLE_LABELS = JSON.stringify(opts.lifecycleLabels);
  if (opts.extraEnv) Object.assign(env, opts.extraEnv);

  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess | null = null;
    let timedOut = false;

    const finish = (r: SpawnResult) => {
      if (transcript) {
        transcript.write(`\n===== END (exit=${r.exitCode}${r.timedOut ? ", timedOut" : ""}) @ ${new Date().toISOString()} =====\n`);
        transcript.end();
        transcript = null;
      }
      resolve(r);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.warn(
        `Claude CLI timed out after ${opts.maxDurationMs}ms` +
        (opts.runLabel ? ` — ${opts.runLabel}` : ""),
      );
      if (child) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child && !child.killed) child.kill("SIGKILL");
        }, 10_000);
      }
    }, opts.maxDurationMs);

    const onAbort = () => {
      logger.warn("Claude CLI aborted");
      if (child) child.kill("SIGTERM");
    };
    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child = spawn("claude", args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      transcript?.write(data);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      transcript?.write(`[stderr] ${text}`);
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        logger.warn(`[claude stderr] ${line}`);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      finish({ stdout, stderr: err.message, exitCode: -1, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      child = null;
      finish({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

/**
 * Backward-compatible spawn for implement/revise: runs in the service repo under
 * the Foreman token with the narrow tool set, final-text output, no transcript.
 */
function spawnClaude(
  prompt: string,
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string
): Promise<SpawnResult> {
  return spawnClaudeWithOptions(
    prompt,
    {
      cwd: config.repoPath,
      ghToken: process.env.FOREMAN_GITHUB_TOKEN,
      triggerLabel: config.triggerLabel,
      lifecycleLabels: config.lifecycleLabels,
      model: config.model,
      allowedTools: config.allowedTools,
      mcpConfig: config.builderMcpConfig,
      maxTurns: config.maxTurns,
      maxDurationMs: config.maxDurationMs,
      transcriptPath,
    },
    logger,
    abortSignal
  );
}

/** How much of a run's final summary is kept for logging and Discord display. */
export const SUMMARY_DISPLAY_LIMIT = 2000;

/**
 * Parse the final `result` event from a stream-json transcript and return its
 * text IN FULL. Undefined when no result event is present.
 *
 * This used to `.slice(0, 2000)` before returning, which silently destroyed the
 * outcome it was feeding. The review prompt requires the FOREMAN_REVIEW trailer to
 * be the last thing the agent emits, so on any review whose summary exceeds 2000
 * characters the trailer sat past the cut. The caller then parsed the truncated
 * string, found no trailer, and — because `summary` was non-null, so the
 * `?? result.stdout` fallback never fired — recorded a complete, correct review as
 * "ended without declaring an outcome".
 *
 * Worked example, slashbin-io-worker PR #589 (2026-08-05): full result text 3,672
 * chars, trailer at index 3,571, present in the full text and absent from the
 * truncated one. The agent had complied exactly; the harness threw the answer away
 * and the run was booked as FAILED.
 *
 * The truncation is a DISPLAY concern and now belongs at the display sites
 * (`SUMMARY_DISPLAY_LIMIT`), never between the agent's answer and the code that
 * reads it. Note this failure was biased toward the reviews that did the most
 * work: the longer and more thorough the write-up, the likelier its trailer fell
 * past the cut.
 */
export function extractStreamResult(stdout: string): string | undefined {
  const lines = stdout.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]);
      if (evt && evt.type === "result") {
        return typeof evt.result === "string" ? evt.result : JSON.stringify(evt);
      }
    } catch {
      // not a JSON line — keep scanning
    }
  }
  return undefined;
}

/** A Claude refusal on the account session limit, as read from a failed run. */
export interface UpstreamLimit {
  reason: string;
  /** The reset the refusal stated, resolved to epoch ms; absent when unparseable. */
  resetAtMs?: number;
}

/**
 * Classify a FAILED run as a Claude session-limit refusal, or `undefined`.
 *
 * Two arms, one per output mode (2026-10-01 journal: 294 of 294 review hits on
 * the first, 97 of 97 implement/revise hits on the second):
 *  - stream-json (review): the last `"type":"result"` event has
 *    `is_error: true` and `api_error_status: 429`.
 *  - plain text (implement, revise): no result event, and the trimmed stdout
 *    starts with "You've hit your" and mentions a limit.
 * A bare "session limit" substring anywhere is NOT enough — prose can carry it.
 */
export function detectUpstreamLimit(stdout: string): UpstreamLimit | undefined {
  const lines = stdout.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let evt: { type?: unknown; is_error?: unknown; api_error_status?: unknown; result?: unknown };
    try {
      evt = JSON.parse(lines[i]);
    } catch {
      continue; // not a JSON line — keep scanning
    }
    if (!evt || evt.type !== "result") continue;
    if (evt.is_error !== true || evt.api_error_status !== 429) return undefined;
    const reason = typeof evt.result === "string" && evt.result.trim() ? evt.result.trim() : "Claude API 429";
    return { reason, resetAtMs: parseClaudeReset(reason) };
  }
  const text = stdout.trim();
  if (/^You(?:'|\u2019)ve hit your/.test(text) && /limit/i.test(text)) {
    const reason = text.split("\n")[0].slice(0, 300);
    return { reason, resetAtMs: parseClaudeReset(text) };
  }
  return undefined;
}

/**
 * `resets 12:10pm (America/Chicago)` → the next occurrence of that wall-clock
 * time in that zone, as epoch ms. Resolved through Intl (not a fixed offset) so
 * DST is honoured. Unparseable text or an unknown zone → undefined.
 */
export function parseClaudeReset(text: string, now = Date.now()): number | undefined {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
  if (!m) return undefined;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return undefined;
  const zone = m[4].trim();
  try {
    const today = zonedParts(now, zone);
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const at = zonedWallToUtc(today.year, today.month, today.day + dayOffset, hour, minute, zone);
      if (at > now) return at;
    }
  } catch {
    // RangeError on an unknown time zone
  }
  return undefined;
}

function zonedParts(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset (ms) of `zone` from UTC at instant `ms`. */
function zoneOffset(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant whose wall-clock in `zone` reads the given fields (day may overflow). */
function zonedWallToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffset(guess, zone);
  const second = guess - zoneOffset(first, zone);
  return second;
}

/**
 * The hand-off line: the work items the source selected, as the only work the
 * session may do. One sentence, so a skill can quote it back.
 */
export function workItemsLine(issueNumbers: number[]): string {
  return `Implement exactly these work items, and no others: ${issueNumbers.map((n) => `#${n}`).join(", ")}.`;
}

/**
 * Invoke Claude CLI to implement the selected work items for a repo.
 *
 * `issueNumbers` is the Foreman's capped discovery batch: the inline prompt's
 * scope and what a batch-wide skip backs off. `handOff` is the uncapped list a
 * skill chooses from; it defaults to `issueNumbers`.
 * The skill (SKILL.md) owns inventory, prioritization, implementation,
 * and PR creation. Foreman just triggers and detects the result.
 */
export async function implementApprovedIssues(
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  priorFailureReason?: string | null,
  issueNumbers?: number[],
  handOff?: number[],
): Promise<ImplementationResult> {
  logger.info(`Starting batch implementation for ${config.name}`);

  // Captured so a DECLARED skip can be distinguished from a declaration made
  // while the agent was in fact pushing work. Evidence beats narrative in both
  // directions: the trailer is only honoured when the branch really did not move.
  const beforeSha = getRemoteBranchSha(config.githubRepo, config.featureBranch, config.repoPath, logger);

  // Resolve the skill and the overlay before anything is launched: either one
  // configured but unreadable fails this item with Claude never started.
  const skill = config.skillPath ? skillInstruction(config, config.skillPath, "implement") : null;
  const overlay = readOverlay(config, config.skillOverlayPath, "skillOverlayPath");
  for (const part of [skill, overlay]) {
    if (part && !part.ok) {
      logger.error(`Implementation not started for ${config.name}: ${part.error}`);
      return { success: false, error: part.error };
    }
  }

  let prompt: string;

  if (config.skillPath && skill?.ok) {
    // The work source chose the batch; the session builds from it and nothing
    // else, so an item from a source the skill cannot query is still built.
    // A repo-local skill that runs its own `gh issue list` gets these same
    // GitHub issues back, so it is told to pick and order within the batch as
    // it always has — the batch only takes away issues outside it.
    //
    // `handOff` is every item the source offered (less backed-off ones), not
    // the capped `issueNumbers` batch: the skill picks by priority across all
    // of them, as it did when it ran its own query. Without one, the batch.
    const items = handOff && handOff.length > 0 ? handOff : issueNumbers;
    const scope = items && items.length > 0
      ? `${workItemsLine(items)} If the skill runs its own issue query, it returns these same issues: choose and order among them as the skill directs, but take nothing outside this list.`
      : `Implement all approved issues for this repository.`;
    prompt = `${skill.text}\n\n${scope} The skill defines the full workflow — follow it exactly.\n\n${IMAGE_HANDLING_INSTRUCTIONS}`;
  } else if (config.prompt) {
    // Custom user prompt — don't auto-modify (backward compat). Users who want
    // image handling in a custom prompt should include their own instructions.
    prompt = config.prompt;
  } else {
    const issueScope = issueNumbers && issueNumbers.length > 0
      ? `Implement ONLY these issues: ${issueNumbers.map(n => `#${n}`).join(", ")}. Read each issue with \`gh issue view <number>\` to understand the requirements.`
      : `Implement all open GitHub issues labeled "${config.triggerLabel}" in this repository.\n\n1. Query GitHub for them: gh issue list --label ${JSON.stringify(config.triggerLabel)} --state open --json number,title,body,labels\n2. Prioritize by severity (S1 > security > S2+bug > ... > chore).`;

    prompt = `${issueScope}

3. Implement each issue, commit with message: fix|feat|chore: <description> (#<issue-number>)
4. Push to ${config.featureBranch} and create a PR targeting ${config.baseBranch}.

IMPORTANT: In PR descriptions, use "Related to #N" — NEVER use "Closes #N" or "Fixes #N". Issues are closed by the EM after production verification, not on dev merge.

${IMAGE_HANDLING_INSTRUCTIONS}

Work autonomously. Do not ask questions.`;
  }

  if (overlay.ok) prompt += overlay.text;

  // Skip-signaling protocol: an issue body may explicitly direct the agent NOT
  // to implement (e.g., investigation-first, blocked on external verification).
  // If the agent decides not to implement any of the assigned issues, it must
  // end its output with a single line `FOREMAN_RESULT: skipped reason="<text>"`
  // so the orchestrator can distinguish a deliberate no-op from a failed
  // implementation attempt and back off accordingly.
  prompt += `\n\nIMPORTANT — Skip protocol: If you stop on an issue without producing a PR — because its body directs you NOT to write code (investigation-first, "no immediate code change", waiting on external verification), or because its spec is unusable (a cited path that does not exist, an acceptance script you cannot fetch, a convention you cannot resolve) — do NOT create an empty PR or guess at a fix. Comment on the issue saying what would unblock it, then end your output with this exact line and nothing after it:\n\nFOREMAN_RESULT: skipped issue=<the issue number you stopped on> reason="<one-line explanation>"\n\nThis tells the Foreman to back off on THAT issue rather than re-queue it every cycle. Always include \`issue=\` — without it the skip applies to every issue in this batch, which takes issues you never read off the board too. If at least one issue in the batch IS implementable, implement those normally and only skip the rest (a created PR plus a scoped trailer is a valid combination).`;

  // Third Way: if a prior attempt failed, include context so Claude can adapt
  if (priorFailureReason) {
    prompt += `\n\nIMPORTANT — PRIOR ATTEMPT FAILED: "${priorFailureReason}". Ensure you: (1) commit changes to the ${config.featureBranch} branch, (2) push to origin, (3) create a PR targeting ${config.baseBranch} using \`gh pr create\`. If a PR already exists, push new commits to it.`;
  }

  const transcriptPath = phaseTranscriptPath("implement", config.name);
  logger.info(`Transcript: ${transcriptPath}`);
  const result = await spawnClaude(prompt, config, logger, abortSignal, transcriptPath);

  if (result.timedOut) {
    return { success: false, error: "timed out" };
  }

  if (result.exitCode !== 0) {
    const error = describeSpawnFailure(result);
    logger.error(`Claude CLI exited with code ${result.exitCode}: ${error}`);
    return { success: false, error, upstreamLimit: detectUpstreamLimit(result.stdout) };
  }

  // A DECLARED skip, with no new commits, is authoritative — and it has to be
  // checked here, ahead of every PR heuristic below.
  //
  // Slashbin-console#841, 2026-09-02. The agent correctly refused to commit a
  // chore onto `features` because an unrelated billing PR (#843) was already
  // open on that branch and its skill forbids bundling the two. It emitted the
  // trailer exactly as instructed. But an open PR on the branch existed, so the
  // PR-detection below claimed it as this run's output and returned success —
  // the skip check sat 30 lines further down and was never reached. Nothing was
  // recorded, the back-off never armed, and the issue was re-queued every cycle:
  // 41 full Claude sessions in six hours, each one reaching the same correct
  // conclusion and having it discarded.
  //
  // The SHA guard is what makes this safe to check first. The prompt tells the
  // agent not to emit the trailer when it created a PR, but "the agent followed
  // the prompt" is exactly the assumption that should not be load-bearing — so
  // a declaration is only honoured when the branch demonstrably did not move.
  const declaredSkip = detectDeclaredSkip(result.stdout);
  if (declaredSkip.skipped) {
    const afterSha = getRemoteBranchSha(config.githubRepo, config.featureBranch, config.repoPath, logger);
    if (beforeSha && afterSha && beforeSha !== afterSha) {
      logger.warn(
        `Agent emitted a skip trailer but ${config.featureBranch} advanced ` +
        `${beforeSha.slice(0, 9)} → ${afterSha.slice(0, 9)} — treating the commits as the truth and ignoring the trailer`,
      );
    } else {
      // Scope the skip when the agent named an issue, so one unbuildable spec
      // cannot back off the issues behind it.
      //
      // A named issue is TRUSTED even when it is not in `issueNumbers`, and that
      // is deliberate. The prompt names the batch, but a repo-local skill still
      // runs its own `gh issue list` first, and that query is strictly WIDER
      // than the batch — the batch was already filtered by the `implemented`
      // cache and by the escalating skip back-off, while those issues stay open
      // and trigger-labelled on GitHub and so remain visible to the agent. So
      // "not in the batch" is an ordinary outcome, not a mistake, and widening
      // to the batch on account of it would reintroduce exactly the starvation
      // the scope exists to prevent. The agent naming one issue is strictly
      // more information than the batch list.
      const named = declaredSkip.issue;
      if (named !== undefined && !(issueNumbers ?? []).includes(named)) {
        logger.info(
          `Skip names #${named}, which was outside the tracked batch ` +
          `(${(issueNumbers ?? []).map((n) => `#${n}`).join(", ") || "none"}) — ` +
          `possible in skill mode, where a repo-local skill also runs its own query. Honouring the scope.`,
        );
      }
      logger.info(
        `Implementation skipped by declaration — ${declaredSkip.reason}` +
        (named !== undefined ? ` (scoped to #${named})` : " (batch-wide — no issue= in the trailer)"),
      );
      return {
        success: false,
        skipped: true,
        skipReason: declaredSkip.reason,
        skippedIssues: named !== undefined ? [named] : (issueNumbers ?? []),
        error: `skipped: ${declaredSkip.reason}`,
      };
    }
  }

  // Extract PR URL from Claude's output
  const prMatch = result.stdout.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
  let prUrl = prMatch ? `https://${prMatch[0]}` : undefined;

  // Fallback: query GitHub directly for an open feature PR. This spawn is
  // outside runGh, so it has to honour the GitHub back-off itself.
  if (!prUrl && !isUpstreamBlocked("github")) {
    logger.info("PR URL not found in output, querying GitHub as fallback");
    const fallback = spawnSync("gh", [
      "pr", "list",
      "--repo", config.githubRepo,
      "--head", config.featureBranch,
      "--base", config.baseBranch,
      "--state", "open",
      "--limit", "1",
      "--json", "url",
      "--jq", ".[0].url",
    ], { cwd: config.repoPath, encoding: "utf-8", timeout: 15_000 });
    const fallbackUrl = fallback.stdout?.trim();
    if (fallbackUrl?.startsWith("https://")) {
      prUrl = fallbackUrl;
      logger.info(`PR found via GitHub fallback: ${prUrl}`);
    }
  }

  if (prUrl) {
    // Verify the PR actually exists on GitHub
    const verified = verifyPRExists(
      config.githubRepo,
      config.featureBranch,
      config.baseBranch,
      config.repoPath,
      logger,
    );
    if (!verified) {
      logger.warn("PR URL found but verification failed — PR may not exist on GitHub");
      return { success: false, error: "PR creation could not be verified" };
    }
    // Post-implementation self-check: verify the PR has actual file changes
    const changedFiles = checkPRHasChanges(config.githubRepo, config.featureBranch, config.baseBranch, config.repoPath, logger);
    if (changedFiles === 0) {
      return { success: false, error: "PR exists but has no file changes" };
    }

    logger.info(`PR created and verified: ${prUrl}`);
    return { success: true, prUrl };
  }

  // If Claude exited cleanly but no new PR was found, check if an existing
  // feature PR already has the work (Claude may have added commits to it).
  const existingPR = verifyPRExists(
    config.githubRepo,
    config.featureBranch,
    config.baseBranch,
    config.repoPath,
    logger,
  );
  if (existingPR) {
    logger.info("No new PR created, but existing feature PR found — treating as success (commits added to existing PR)");
    return { success: true };
  }

  // Before flagging "no PR" as a failure, check whether the agent deliberately
  // chose not to implement (investigation-only issues, blocked-on-prod-verification,
  // etc.). The orchestrator backs off on skip rather than retrying every cycle.
  const skip = detectSkipSignal(result.stdout);
  if (skip.skipped) {
    logger.info(`Implementation skipped — agent declined to write code: ${skip.reason}`);
    const outputTail = result.stdout.slice(-500).trim();
    if (outputTail) {
      logger.info("Claude output (last 500 chars):\n" + outputTail);
    }
    return {
      success: false,
      skipped: true,
      skipReason: skip.reason,
      skippedIssues: issueNumbers ?? [],
      error: `skipped: ${skip.reason}`,
    };
  }

  // Log Claude's output tail so we can diagnose why no PR was created
  const outputTail = result.stdout.slice(-500).trim();
  if (outputTail) {
    logger.warn("Claude output (last 500 chars):\n" + outputTail);
  }

  logger.error("Batch implementation completed (exit 0) but no PR was created or found — marking as failed");
  return { success: false, error: "no PR created" };
}

/**
 * Invoke Claude CLI to revise PRs that have review feedback (`pr pending actions`).
 * The revision skill reads review comments, implements fixes, and pushes.
 *
 * The orchestrator passes the specific PR number and issue numbers so the
 * skill doesn't need to search by label (which historically was unreliable).
 */
export async function revisePRFeedback(
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  prNumber?: number,
  issueNumbers?: number[],
): Promise<RevisionResult> {
  logger.info(`Starting PR revision for ${config.name}`);

  // Capture the feature branch's HEAD SHA before invoking Claude so we can
  // detect the no-op case where Claude exits 0 without pushing any commits.
  // Without this, a silent no-op would be reported as success and the
  // orchestrator would (incorrectly) transition labels to `pr under review`,
  // hiding the fact that the requested fix was never applied.
  const beforeSha = getRemoteBranchSha(config.githubRepo, config.featureBranch, config.repoPath, logger);

  const prContext = prNumber
    ? `\n\nCONTEXT: PR #${prNumber} needs revision. Linked issues: ${(issueNumbers || []).map(n => `#${n}`).join(", ")}. Read the review comments on PR #${prNumber} to understand what changes are requested.`
    : "";

  const labelNote = `\n\nIMPORTANT: Do NOT update issue labels — the orchestrator handles label transitions after you finish.`;

  // A review round can legitimately require no code change: the reviewer asked
  // for none, the previous round already satisfied it, or the remaining work is
  // on an issue body rather than the branch. Before this trailer existed, that
  // outcome was indistinguishable from a silent no-op and was marked failed, so
  // the labels never returned to `pr under review` and the PR could never be
  // re-reviewed — Slashbin-console#843 sat in exactly that deadlock.
  const noCommitNote = `\n\nIF NO CODE CHANGE IS NEEDED: do not invent one. Say so on its own line, as the LAST line of your output:\n\n  FOREMAN_REVISION no-commit reason=<one line: why the branch is already correct>\n\nWithout that trailer, a run that pushes nothing is treated as a failed revision — which is the correct default, because a silent no-op and a deliberate one look identical from outside.`;

  const skill = config.revisionSkillPath ? skillInstruction(config, config.revisionSkillPath, "revise") : null;
  const overlay = readOverlay(config, config.revisionSkillOverlayPath, "revisionSkillOverlayPath");
  for (const part of [skill, overlay]) {
    if (part && !part.ok) {
      logger.error(`Revision not started for ${config.name}: ${part.error}`);
      return { success: false, error: part.error };
    }
  }

  let prompt: string;

  if (config.revisionSkillPath && skill?.ok) {
    prompt = `${skill.text}\n\nRevise PR #${prNumber || "(pending)"} which has review feedback for this repository. The skill defines the full workflow — follow it exactly.${prContext}${labelNote}${noCommitNote}\n\n${IMAGE_HANDLING_INSTRUCTIONS}`;
  } else {
    prompt = `Revise PR #${prNumber || "(find open PRs with review feedback)"} in this repository.

1. Read the PR's review comments: gh pr view ${prNumber || "<number>"} --comments
2. Also read inline review comments: gh api repos/${config.githubRepo}/pulls/${prNumber || "<number>"}/comments --jq '.[] | {path, line, body}'
3. Implement the requested changes on the PR's branch.
4. Run tests: npm test
5. Commit fixes with message: fix: address review feedback (#${prNumber || "<number>"})
6. Push to the PR branch.
${prContext}${labelNote}${noCommitNote}

${IMAGE_HANDLING_INSTRUCTIONS}

Work autonomously. Do not ask questions.`;
  }

  if (overlay.ok) prompt += overlay.text;

  const transcriptPath = phaseTranscriptPath("revise", config.name);
  logger.info(`Transcript: ${transcriptPath}`);
  const result = await spawnClaude(prompt, config, logger, abortSignal, transcriptPath);

  if (result.timedOut) {
    return { success: false, error: "timed out" };
  }

  if (result.exitCode !== 0) {
    const error = describeSpawnFailure(result);
    logger.error(`Claude CLI exited with code ${result.exitCode}: ${error}`);
    return { success: false, error, upstreamLimit: detectUpstreamLimit(result.stdout) };
  }

  // Post-revision self-check: confirm Claude actually pushed commits to the
  // feature branch. A clean exit with no SHA change means the revision was a
  // silent no-op (skill misfire, agent decided "nothing to fix", failed push,
  // etc.). Treat it as a failure so the orchestrator does not transition labels
  // to `pr under review` — that would lie about the PR's state and cause the
  // EM to re-review unchanged code.
  //
  // Conservative on lookup failures: if either SHA is null (transient gh
  // error), we trust the exit code rather than fail spuriously.
  const afterSha = getRemoteBranchSha(config.githubRepo, config.featureBranch, config.repoPath, logger);
  if (beforeSha && afterSha && beforeSha === afterSha) {
    // Declared no-commit: the revision determined the branch is already correct
    // and said so on the trailer. That is a real outcome, not a misfire, and it
    // must return success — otherwise the orchestrator never transitions the
    // labels back to `pr under review` and the PR is unreviewable forever.
    const declared = REVISION_NO_COMMIT.exec(result.stdout);
    if (declared) {
      const reason = declared[1].trim().slice(0, 300);
      logger.info(
        `PR revision made no commit BY DECLARATION on ${config.featureBranch} ` +
        `(SHA unchanged at ${beforeSha.slice(0, 10)}): ${reason}`,
      );
      return { success: true, noCommit: true, noCommitReason: reason };
    }

    const outputTail = result.stdout.slice(-500).trim();
    if (outputTail) {
      logger.warn("Claude output (last 500 chars):\n" + outputTail);
    }
    logger.error(`PR revision completed (exit 0) but no commits were pushed to ${config.featureBranch} (SHA unchanged at ${beforeSha.slice(0, 10)}) and no FOREMAN_REVISION no-commit trailer was given — marking as failed`);
    return { success: false, error: "no commits pushed — revision was a no-op" };
  }

  logger.info(`PR revision completed successfully for ${config.name}`);
  return { success: true };
}

/** What a custom stage is handed: the work in flight on the repo when the pass reached it. */
export interface CustomStageInput {
  /** The open feature → base PR the stage runs against. */
  prNumber: number;
  /** Issues that PR implements (the same reading the implement phase uses). */
  issueNumbers: number[];
  /** Head of the feature branch the verdict applies to. */
  headSha: string;
}

export interface CustomStageResult {
  /** `pass` / `blocked` as declared by the FOREMAN_STAGE trailer; `failed` when none was. */
  verdict: "pass" | "blocked" | "failed";
  reason?: string;
  /** Set when the Claude session limit refused the run — no verdict was reached. */
  upstreamLimit?: UpstreamLimit;
}

/**
 * Run one custom stage: a single Claude session on the stage's skill, in the
 * managed repo, under the Foreman token with the implement session's model,
 * tools and budget. The session is told the repo, branches, PR, issues and head
 * in its prompt and as FOREMAN_STAGE_* env, next to the label env every session
 * gets. Its verdict is the FOREMAN_STAGE trailer; the Foreman does nothing with
 * the work items itself — whatever the stage should change (comments, labels),
 * its skill does.
 */
export async function runCustomStage(
  config: RepoConfig,
  stage: CustomStage,
  input: CustomStageInput,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<CustomStageResult> {
  const issues = input.issueNumbers.map((n) => `#${n}`).join(", ") || "none referenced";
  const prompt =
    `Read and follow the skill at ${stage.skillPath}.\n\n` +
    `This is the "${stage.id}" stage of the Foreman pipeline for ${config.githubRepo}. ` +
    `Work in flight: PR #${input.prNumber} (${config.featureBranch} → ${config.baseBranch}) at ${input.headSha}, ` +
    `implementing issues: ${issues}.\n\n` +
    `End your output with exactly one verdict line and nothing after it:\n\n` +
    `  FOREMAN_STAGE pass\n` +
    `  FOREMAN_STAGE blocked reason="<one line: what must change before this work goes further>"\n\n` +
    `\`blocked\` stops every later stage for this repo until ${config.featureBranch} moves. ` +
    `A run with no verdict line is recorded as failed, which stops them too.\n\n` +
    `Work autonomously. Do not ask questions.`;

  const transcriptPath = phaseTranscriptPath(`stage-${stage.id}`, config.name);
  logger.info(`Starting stage "${stage.id}" for ${config.name} on PR #${input.prNumber} — transcript: ${transcriptPath}`);
  const result = await spawnClaudeWithOptions(
    prompt,
    {
      cwd: config.repoPath,
      ghToken: process.env.FOREMAN_GITHUB_TOKEN,
      triggerLabel: config.triggerLabel,
      lifecycleLabels: config.lifecycleLabels,
      model: config.model,
      allowedTools: config.allowedTools,
      mcpConfig: config.builderMcpConfig,
      maxTurns: config.maxTurns,
      maxDurationMs: config.maxDurationMs,
      transcriptPath,
      runLabel: `stage "${stage.id}" on ${config.name} PR #${input.prNumber}`,
      extraEnv: {
        FOREMAN_STAGE_ID: stage.id,
        FOREMAN_STAGE_REPO: config.githubRepo,
        FOREMAN_STAGE_BASE_BRANCH: config.baseBranch,
        FOREMAN_STAGE_FEATURE_BRANCH: config.featureBranch,
        FOREMAN_STAGE_PR: String(input.prNumber),
        FOREMAN_STAGE_ISSUES: JSON.stringify(input.issueNumbers),
        FOREMAN_STAGE_HEAD_SHA: input.headSha,
      },
    },
    logger,
    abortSignal,
  );

  if (result.timedOut) return { verdict: "failed", reason: "timed out" };
  if (result.exitCode !== 0) {
    return { verdict: "failed", reason: describeSpawnFailure(result), upstreamLimit: detectUpstreamLimit(result.stdout) };
  }
  const trailer = parseStageTrailer(result.stdout);
  if (!trailer) return { verdict: "failed", reason: "no FOREMAN_STAGE verdict line — outcome unknown" };
  return trailer;
}

/**
 * Working directory of a repo's review session: the review repo (`emRepoPath`)
 * when one is configured, else the repo's own managed review checkout. The
 * second case is what lets a review skill that ships inside the service repo run
 * without any separate review repo.
 */
export function reviewSessionCwd(agentConfig: AgentConfig, repoConfig: RepoConfig): string {
  return agentConfig.emRepoPath ?? checkoutPathFor(agentConfig, repoConfig);
}

/**
 * Absolute path of a repo's review skill, or undefined when none is configured.
 * `~/` expands to the home directory; any other relative path resolves against
 * `reviewSessionCwd` — the directory the session runs in, so the path means what
 * it would mean to the session itself. With `emRepoPath` set this is exactly the
 * pre-EM#425 behaviour (the session read the relative path from that cwd).
 */
export function resolveReviewSkillPath(agentConfig: AgentConfig, repoConfig: RepoConfig): string | undefined {
  const configured = repoConfig.reviewSkillPath;
  if (!configured) return undefined;
  const expanded = configured.replace(/^~(?=$|\/)/, homedir());
  return isAbsolute(expanded) ? expanded : resolve(reviewSessionCwd(agentConfig, repoConfig), expanded);
}

/**
 * Invoke the repo's review skill (Slashbin: the EM's /review-all-prs), scoped to a single service repo,
 * in a headless Claude session.
 *
 * This is categorically different from implement/revise: those run IN the service
 * repo under the Foreman token with a narrow tool set. Review is a decision-layer
 * workflow — it needs the EM repo's MCP servers, npm scripts (healthcheck/verify/
 * validate), and context/docs — so it runs with:
 *   - cwd  = the EM repo (agentConfig.emRepoPath), so it loads the EM .mcp.json,
 *            .claude/skills, and context/docs — or, with no emRepoPath, the
 *            repo's review checkout (reviewSessionCwd)
 *   - token = EM_GITHUB_TOKEN, so reviews/merges are attributed to the EM account
 *             (memory: feedback_mcp_github_for_review_actions)
 *   - the broad reviewAllowedTools surface (GitHub/Postgres/Redis/Railway MCP)
 *
 * Full-fidelity: the skill posts verdicts, merges approved PRs to develop, verifies
 * dev, files S3/S4 follow-ups, and updates labels itself. The review's label side
 * effects feed the existing phases: APPROVE → `pr approved` (awaiting the EM
 * outcome-gate); REQUEST_CHANGES → `pr pending actions` (revise phase).
 *
 * The skill remains the PRIMARY labeler — it does things the orchestrator cannot
 * (post the review body, file the follow-ups that belong with the verdict). But it
 * is no longer the ONLY one: the orchestrator reconciles the outcome label from the
 * returned trailers when the skill merged without labeling. See
 * `reconcileReviewOutcomeLabels` in orchestrator.ts for why the write moved.
 */
export async function reviewOpenPRs(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
  runLabel?: string,
): Promise<ReviewResult> {
  const emToken = process.env.EM_GITHUB_TOKEN;
  if (!emToken) {
    return { success: false, error: "EM_GITHUB_TOKEN not set — refusing to run review without EM-account attribution" };
  }
  const skillPath = resolveReviewSkillPath(agentConfig, repoConfig);
  if (!skillPath) {
    return { success: false, error: "reviewSkillPath not configured for this repo — cannot locate the review skill" };
  }
  const cwd = reviewSessionCwd(agentConfig, repoConfig);

  logger.info(`Starting review for ${repoConfig.name} (${repoConfig.githubRepo}) — cwd=${cwd}, skill=${skillPath}`);

  const { minutes: reviewBudgetMinutes, deadlineIso: reviewDeadlineIso } =
    reviewBudget(agentConfig.reviewMaxDurationMs);

  const labels = repoConfig.lifecycleLabels;
  const prompt = `Read and follow the skill at ${skillPath}.

Review the open feature PRs for the repository \`${repoConfig.githubRepo}\` ONLY. Treat this as the skill's repo-scoped mode (equivalent to \`--repo ${repoConfig.githubRepo}\`): scope every step — inventory, review, merge, verify — to that single repository, and use the full \`owner/repo\` slug \`${repoConfig.githubRepo}\` for all GitHub operations (do not rely on a short repo alias).

WORKING COPY — use this one, do not make your own:
A checkout of \`${repoConfig.githubRepo}\` is already prepared and fetched for you at \`${checkoutPathFor(agentConfig, repoConfig)}\`. Read the code there: \`git -C <that path> checkout <branch>\`, \`git -C <that path> diff\`, and so on. It is reused across runs, so its \`node_modules\` is usually already installed.
Do NOT \`git clone\` this repo anywhere else, and do NOT clone into \`/tmp\` for any reason. \`/tmp\` here is a RAM filesystem with a hard limit on the NUMBER of files, and a repo plus its \`node_modules\` consumes tens of thousands of them; improvised review clones exhausted that limit on 2026-09-12 and left every agent on the box unable to run a single command, including the ones needed to clean it up. If you need a second working tree, use \`git -C <that path> worktree add\` inside that same directory — it shares the object store instead of duplicating it.

Follow the skill exactly and act autonomously — do NOT ask questions or wait for confirmation:
- Do NOT run healthchecks up front. A healthcheck verifies a deployment; a review that requests changes deploys nothing. Run them only in post-merge verification (skill Phase 5, via \`npm run verify\`), against a merge this run actually made.
- Review each open \`features → develop\` PR (skill Phase 3): the Fix-Completeness gate first, then the rubric.
- For APPROVED PRs: post the review from the EM account, merge to develop, then verify dev and label \`${labels.prApproved}\` per the skill. Do NOT apply \`${labels.readyForProd}\`, and do NOT remove it either — that label is the EM outcome-gate's signature (separation of duties; see /review-pr Step 17). If a linked issue already carries it, the EM has signed off ahead of you: leave that issue's labels alone entirely. Removing it silently blocks the promotion PR forever, so the Foreman now detects and restores it — but a restore is a repaired mistake, not a supported path.
- For BLOCKED PRs: post REQUEST_CHANGES, label the linked issue \`${labels.prPendingActions}\`, and file S3/S4 follow-up issues per the skill.
- Update issue labels yourself exactly as the skill specifies. The orchestrator reconciles the outcome label from your trailer only when you left it unset — it never overrides a label you did set.

CRITICAL — THIS IS A HEADLESS SESSION. THERE IS NO NEXT TURN.
Ending your turn ends the process. Anything still running is killed at that instant, and everything you had not done yet never happens.

- NEVER end your turn to "wait" for something. There is nothing to wait with. Do not say "I'll wait for X to land", "let me check back", or "proceeding once this completes" — those sentences are how a merged PR gets left with a mislabeled issue forever.
- Run post-merge verification IN THE FOREGROUND and block on it. Do NOT launch it as a background task and yield — a backgrounded verify is killed the moment you stop, so its result never arrives and the labeling step after it never runs.
- The merge is irreversible and the labeling is not automatic. Once you merge a PR you MUST, in the same turn, finish verification and set the issue's labels. If you cannot finish, say so explicitly in your final message rather than stopping quietly.
- If a step genuinely cannot complete (verification times out, a deploy never settles), do NOT stall — record the outcome, label the issue \`${labels.prPendingActions}\`, and emit the trailer with \`deploy=FAILURE\`. A reported failure is recoverable; silence is not.

WALL-CLOCK BUDGET — you have ${reviewBudgetMinutes} minutes, until ${reviewDeadlineIso}.
The process is SIGTERMed at that instant. You get no warning and no chance to write anything, so nothing you were partway through survives.

- Check the clock before you start anything that polls. If the thing you are watching will not finish in the time you have LEFT, it does not fit in this run — and starting it anyway spends the rest of your budget to learn what you already knew.
- A criterion that converges on its own schedule — a backfill sweeping historical rows, a deploy that settles when it settles, an index build — is the case this rule exists for. Do NOT poll it to the wall. Take the measurement you can take now, finish the labeling, and emit \`hold=<reason>\` on that PR's trailer line (see below).
- A held issue is visible and recoverable: the Foreman leaves it alone and reports it as held, and the EM resolves it when the criterion can be checked. A run killed mid-poll is none of those things — it is recorded as a plain failure, and the review and merge it already completed are thrown away.
- This does NOT license ending your turn to "wait". Holding is a decision you record and report; waiting is stopping and hoping. Never do the second.

If there are no open feature PRs awaiting review for this repo, that is a clean no-op — say so and emit exactly \`FOREMAN_REVIEW none\` as your final line.

IMPORTANT — status trailer: After you finish, end your output with one line per PR you acted on, in EXACTLY this format (nothing after the last one):

FOREMAN_REVIEW pr=#<number> verdict=<APPROVE|REQUEST_CHANGES> merged=<yes|no> deploy=<SUCCESS|FAILURE|NA>

Rules for the trailer: \`merged=yes\` only if you actually merged the PR to the base branch. \`deploy=SUCCESS\`/\`deploy=FAILURE\` reflects the post-merge deployment+verification result for that merge (use \`deploy=NA\` when nothing was merged, or when the repo has no deployment to verify, e.g. a docs/CLI/npm-package repo). Emit one trailer line for every PR you reviewed this run.

OPTIONAL — deliberate hold: if you merged a PR but are INTENTIONALLY leaving the issue at \`${labels.prUnderReview}\`, append \`hold=<short-reason-slug>\` to that PR's trailer line. Two cases qualify: an acceptance criterion cannot be observed YET (nothing has happened that would let you check it), or it cannot be observed IN TIME (it is converging, but not inside the budget above). Both are decisions; both belong in the trailer rather than in a poll loop:

FOREMAN_REVIEW pr=#100 verdict=APPROVE merged=yes deploy=SUCCESS hold=criterion-not-observable-until-0300z

Use it ONLY for a decision you actually made. It tells the Foreman the label is missing ON PURPOSE, so it will neither auto-set the label nor auto-re-verify behind you — the issue stays visible as a held item instead of being reported as a failure. Omit the field entirely for the normal case; omitting it means "I finished the labeling."

Note: the Foreman now reconciles the outcome label from this trailer as a BACKSTOP — if you merged and did not label, it applies the label your trailer implies. That is a safety net, not a substitute: still set the labels yourself per the skill, because only you can file the follow-ups and post the review body that go with them.

The trailer is MANDATORY and is the last thing you emit. A run that ends without either a \`FOREMAN_REVIEW pr=…\` line or \`FOREMAN_REVIEW none\` is recorded as a FAILED review regardless of how much work you did, because from the outside it is indistinguishable from a session that died mid-merge.

${IMAGE_HANDLING_INSTRUCTIONS}`;

  const result = await spawnClaudeWithOptions(
    prompt,
    {
      cwd,
      ghToken: emToken,
      triggerLabel: repoConfig.triggerLabel,
      lifecycleLabels: repoConfig.lifecycleLabels,
      model: agentConfig.reviewModel,
      allowedTools: agentConfig.reviewAllowedTools,
      maxTurns: agentConfig.reviewMaxTurns,
      maxDurationMs: agentConfig.reviewMaxDurationMs,
      streamJson: true,
      transcriptPath,
      runLabel: runLabel ?? `review of ${repoConfig.githubRepo}`,
    },
    logger,
    abortSignal
  );

  if (result.timedOut) {
    return { success: false, error: "timed out" };
  }

  if (result.exitCode !== 0) {
    const error = describeSpawnFailure(result);
    logger.error(`Review Claude CLI exited with code ${result.exitCode}: ${error}`);
    return { success: false, error, upstreamLimit: detectUpstreamLimit(result.stdout) };
  }

  // Parse from the FULL result text; truncate only for display. The trailer is
  // required to be the LAST thing the agent emits, so parsing a length-capped
  // copy discards exactly the part that carries the outcome.
  const fullResult = extractStreamResult(result.stdout);
  const summary = fullResult?.slice(0, SUMMARY_DISPLAY_LIMIT);

  // Read the VERDICT out of the agent's final result text, not raw stdout.
  // `result.stdout` is the stream-json transcript, and it opens with the prompt
  // we just sent — which quotes the trailer format and the no-op sentinel
  // verbatim. Scanning stdout for the sentinel therefore matches OUR OWN
  // INSTRUCTIONS on every single run, silently declaring every dead session a
  // clean no-op and disabling the gate below completely.
  //
  // The trailer regex survives stdout because the prompt's example is literally
  // `pr=#<number>` and the pattern demands `\d+` — but that is a coincidence of
  // the placeholder, not a guarantee. Prefer the result text; fall back to
  // stdout only when no result event was emitted at all.
  const trailers = parseReviewTrailerRecords(fullResult ?? result.stdout);
  const declaredNoOp = fullResult ? REVIEW_NOOP_SENTINEL.test(fullResult) : false;
  const statusLine = formatReviewTrailers(trailers);

  // --- Trailer gate ------------------------------------------------------
  // A clean exit says the PROCESS ended tidily. It says nothing about whether
  // the REVIEW finished, and the two diverge in the one case that costs us: the
  // agent merges the PR, then ends its turn before labeling. The session exits
  // 0, we recorded success, reset the failure counter, and moved on — while the
  // issue sat pinned at `pr under review` with its PR already merged, invisible
  // to every phase (`findPRsNeedingReview` only matches OPEN PRs).
  //
  // Measured 2026-08-03 before this gate existed: 15 of 234 review runs (6.4%)
  // emitted no trailer, 9 of them exiting 0 — i.e. silently booked as wins.
  // slashbin-io-worker#564 is the worked example: merged PR #565 at 02:07Z,
  // backgrounded its verification, ended its turn with "I'll wait for the
  // verification run to land", and the harness killed the background tasks and
  // exited 0.
  //
  // So: no trailer and no explicit no-op sentinel = FAILED, whatever the exit
  // code claimed. This does not by itself repair anything — the merge already
  // happened — but it converts a silent orphan into a logged, alerted failure,
  // and the dead-zone recovery in the orchestrator takes it from there.
  if (trailers.length === 0 && !declaredNoOp) {
    logger.error(
      `Review for ${repoConfig.name} exited 0 but emitted no FOREMAN_REVIEW trailer — outcome unknown; treating as FAILED${transcriptPath ? ` (transcript ${transcriptPath})` : ""}`,
    );
    return {
      success: false,
      error:
        "no FOREMAN_REVIEW trailer emitted — the review session ended without declaring an outcome (likely stopped mid-run after merging); check the issue labels",
      summary,
      trailers,
    };
  }

  if (summary) {
    logger.info(`Review completed for ${repoConfig.name}:\n${summary}`);
  } else {
    logger.info(`Review completed for ${repoConfig.name} (no parseable summary; see transcript${transcriptPath ? ` ${transcriptPath}` : ""})`);
  }
  if (statusLine) {
    logger.info(`Review outcome for ${repoConfig.name}: ${statusLine}`);
  } else {
    logger.info(`Review for ${repoConfig.name}: clean no-op (no PRs awaiting review)`);
  }
  return { success: true, summary, statusLine, trailers };
}

/**
 * Offer one PR's review to the Tech Lead (xrgarcia/slashbin_ai_tech_lead, EM#427)
 * before spending a Claude session on it.
 *
 * The Tech Lead judges on Codex inside a read-only sandbox and does the writes in
 * its own code; it emits the same FOREMAN_REVIEW trailer this phase already
 * parses, so every post-condition and label reconcile below applies unchanged.
 *
 * Exit 3 is its "I could not take this, and I wrote NOTHING" signal (Codex signed
 * out, out of allowance, timed out, or a path it does not cover). That returns
 * `{ fallback: true }` and the caller runs `reviewOpenPRs` as before — a review
 * never waits on Codex. Any other non-zero exit is an ordinary failure: it may
 * have written, so it is NOT retried on Claude in the same cycle.
 */
export async function reviewViaTechLead(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  prNumber: number,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
): Promise<ReviewResult | { fallback: true; reason: string }> {
  const techLead = agentConfig.techLeadPath;
  if (!techLead) return { fallback: true, reason: "techLeadPath not configured" };
  if (!process.env.EM_GITHUB_TOKEN) {
    return { success: false, error: "EM_GITHUB_TOKEN not set — refusing to run review without EM-account attribution" };
  }
  const args = [join(techLead, "bin/tech-lead.mjs"), "review-pr", "--repo", repoConfig.githubRepo, "--pr", String(prNumber)];
  logger.info(`Offering PR #${prNumber} on ${repoConfig.githubRepo} to the Tech Lead (Codex)`);

  const out = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolveRun) => {
    const child = spawn("node", args, {
      cwd: techLead,
      env: { ...process.env, TECH_LEAD_EM_REPO: agentConfig.emRepoPath ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    const log = transcriptPath ? (mkdirSync(dirname(transcriptPath), { recursive: true }), createWriteStream(transcriptPath)) : null;
    child.stdout.on("data", (b) => { stdout += b; log?.write(b); });
    child.stderr.on("data", (b) => { stderr += b; log?.write(b); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, agentConfig.reviewMaxDurationMs);
    const onAbort = () => child.kill("SIGTERM");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      log?.end();
      resolveRun({ code, stdout, stderr, timedOut });
    });
  });

  if (out.code === 3) {
    const reason = out.stdout.trim().split("\n").pop() || "Codex unavailable";
    logger.info(`Tech Lead declined PR #${prNumber} (wrote nothing): ${reason} — falling back to the Claude review`);
    return { fallback: true, reason };
  }
  if (out.timedOut) return { success: false, error: "Tech Lead review timed out" };
  if (out.code !== 0) {
    return { success: false, error: `Tech Lead review failed (exit ${out.code}): ${(out.stderr || out.stdout).trim().slice(-400)}` };
  }

  const trailers = parseReviewTrailerRecords(out.stdout);
  const declaredNoOp = REVIEW_NOOP_SENTINEL.test(out.stdout);
  if (trailers.length === 0 && !declaredNoOp) {
    return { success: false, error: "Tech Lead exited 0 without a FOREMAN_REVIEW trailer — outcome unknown; check the issue labels", trailers };
  }
  const statusLine = formatReviewTrailers(trailers);
  const summary = out.stdout.trim().slice(0, SUMMARY_DISPLAY_LIMIT);
  logger.info(`Tech Lead review of ${repoConfig.githubRepo} PR #${prNumber}: ${statusLine || "no-op"}`);
  return { success: true, summary, statusLine, trailers };
}

/**
 * Render a review run's wall-clock budget as the two facts the run needs: how
 * long it has, and the instant it dies.
 *
 * Exists as its own function because the ceiling was enforced and never
 * disclosed. On 2026-09-22 a review of `jerky_skuvault_service#362` finished its
 * work at 22:11, then polled a backfill that needed ~75 minutes to converge
 * until the 60-minute kill; a completed review and merge was recorded as
 * `Review failed: timed out`. Nothing in its prompt named a number, so it had no
 * way to know the poll could not fit. Issue #41.
 *
 * The absolute deadline matters more than the duration: an agent tens of minutes
 * into a run cannot subtract elapsed time it never measured, but it can compare
 * a timestamp against the clock.
 */
export function reviewBudget(
  maxDurationMs: number,
  now: Date = new Date(),
): { minutes: number; deadlineIso: string } {
  return {
    minutes: Math.round(maxDurationMs / 60_000),
    deadlineIso: new Date(now.getTime() + maxDurationMs).toISOString(),
  };
}
