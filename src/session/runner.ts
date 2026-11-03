import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { redactAll } from "../redact.js";
import { isUntrustedWarning, type ClaudeTrust } from "../claude-trust.js";
import { contractBlock, contractReaderPath } from "../handoff-contract.js";
import { SESSION_SECRET_GATE, sessionSettings } from "./secret-gate.js";
import { buildSessionEnv, createStreamRedactor, secretValues, type SpawnOptions } from "./env.js";

const FOREMAN_OVERRIDES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".claude",
  "system-prompt-overrides.md"
);

/** Process-wide: the secret-gate notice is logged once per process. */
let secretGateLogged = false;

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
export function phaseTranscriptPath(phase: string, repoName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(process.cwd(), "logs", phase, `${repoName}-${ts}.log`);
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
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
 * token. Review is not a Claude session at all: the Tech Lead runs it (reviewViaTechLead).
 */
export function spawnClaudeWithOptions(
  prompt: string,
  opts: SpawnOptions,
  logger: Logger,
  abortSignal?: AbortSignal
): Promise<SpawnResult> {
  // Every builder session — implement, revise, custom stage — carries the shared
  // handoff contract (EM#614), or an explicit CONTRACT UNAVAILABLE naming why.
  // The EM checkout comes from the daemon env (AI_AGENT_EM_REPO_PATH), the only
  // place a builder spawn can see it.
  prompt = `${prompt}\n\n${contractBlock(contractReaderPath(process.env.AI_AGENT_EM_REPO_PATH))}`;
  const args = [
    "--print",
    prompt,
    "--max-turns", String(opts.maxTurns),
    "--dangerously-skip-permissions",
  ];

  // Every session runs under the secret gate. A missing hook file is a broken
  // install, not a reason to run ungated quietly — say so on every spawn.
  if (existsSync(SESSION_SECRET_GATE)) {
    args.push("--settings", sessionSettings());
    if (!secretGateLogged) {
      logger.info(`Session secret gate on: ${SESSION_SECRET_GATE}`);
      secretGateLogged = true;
    }
  } else {
    logger.error(`Session secret gate MISSING (${SESSION_SECRET_GATE}) — this session can print credentials`);
  }

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

  const env = buildSessionEnv(opts);

  // Claude Code ignores an untrusted checkout's .claude/settings.json and .mcp.json
  // and only says so on stderr. Trust it first — under the session's own HOME /
  // CLAUDE_CONFIG_DIR, which is where this session will look (src/claude-trust.ts).
  opts.trust.ensure(opts.cwd, logger, env);

  // Everything the child prints is redacted at each sink — transcript, logger
  // lines, and the stdout/stderr handed back (which feed trailer parsing and
  // describeSpawnFailure, whose tails become logged errors). The allowlist keeps
  // the other secrets out of the session; these values are the ones it may hold.
  const secrets = secretValues(opts.sessionEnv ?? []);
  const outRedactor = createStreamRedactor(secrets);
  const errRedactor = createStreamRedactor(secrets);
  let stderrLine = "";
  let untrustedSeen = false;
  const warnStderr = (line: string) => {
    if (!line) return;
    logger.warn(`[claude stderr] ${redactAll(line, secrets)}`);
    // Still untrusted despite the check above (trust off, unparseable config, or a
    // concurrent rewrite dropped it): name the path and trust it so the NEXT
    // session in this checkout is clean. This session is not re-run.
    if (!untrustedSeen && isUntrustedWarning(line)) {
      untrustedSeen = true;
      if (opts.trust.isEnabled()) {
        logger.warn(`Claude Code reports ${opts.cwd} is not trusted — this session ran without the repo's .claude/settings.json and .mcp.json; trusting it for the next one`);
        const outcome = opts.trust.ensure(opts.cwd, logger, env, "untrusted warning on stderr");
        if (outcome === "already") {
          logger.warn(`Claude Code trust: ${opts.cwd} is already marked trusted in the config this session reads, yet Claude Code still reports it untrusted — check HOME / CLAUDE_CONFIG_DIR in sessionEnv`);
        }
      } else {
        logger.warn(`Claude Code reports ${opts.cwd} is not trusted, and trustManagedRepos is off — trust it yourself or the repo's .claude/settings.json and .mcp.json are ignored`);
      }
    }
  };

  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess | null = null;
    let timedOut = false;
    let finished = false;

    const finish = (r: SpawnResult) => {
      if (finished) return;
      finished = true;
      warnStderr(stderrLine);
      stderrLine = "";
      if (transcript) {
        transcript.write(outRedactor.flush());
        const errTail = errRedactor.flush();
        if (errTail) transcript.write(`[stderr] ${errTail}`);
        transcript.write(`\n===== END (exit=${r.exitCode}${r.timedOut ? ", timedOut" : ""}) @ ${new Date().toISOString()} =====\n`);
        transcript.end();
        transcript = null;
      }
      resolve({ ...r, stdout: redactAll(r.stdout, secrets), stderr: redactAll(r.stderr, secrets) });
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
      const text = data.toString();
      stdout += text;
      transcript?.write(outRedactor.push(text));
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      const safe = errRedactor.push(text);
      if (safe) transcript?.write(`[stderr] ${safe}`);
      // One logger line per COMPLETE line, so a value split across two chunks
      // is whole when it is redacted; the remainder is emitted in finish().
      const lines = (stderrLine + text).split("\n");
      stderrLine = lines.pop() ?? "";
      for (const line of lines) warnStderr(line);
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
export function spawnClaude(
  trust: ClaudeTrust,
  prompt: string,
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
  extraEnv?: Record<string, string>,
): Promise<SpawnResult> {
  return spawnClaudeWithOptions(
    prompt,
    {
      trust,
      cwd: config.repoPath,
      ...(extraEnv ? { extraEnv } : {}),
      sessionEnv: config.sessionEnv,
      ghToken: process.env.FOREMAN_GITHUB_TOKEN,
      triggerLabel: config.triggerLabel,
      lifecycleLabels: config.lifecycleLabels,
      github: config.github,
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
