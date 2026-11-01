import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig } from "../config.js";
import { createStreamRedactor, redactAll, secretValues, type ReviewTrailer } from "../agent.js";
import type { UnrelatedErrors } from "./contract.js";

/**
 * The runner the agent plugins share (EM#1150 f3): each agent (Tech Lead, SRE,
 * QA, EM) is a `node <checkout>/<script>` CLI, run the same way, and two of
 * them print the same FOREMAN_REVIEW trailer. Plugin code: the core never
 * imports this.
 */

export interface CliRun { code: number | null; stdout: string; stderr: string; timedOut: boolean }

export interface CliRunOptions {
  /** Append to the transcript (the release hand-offs share one per release) instead of starting it fresh. Default true. */
  appendTranscript?: boolean;
  /** Each stderr chunk as it arrives (the Tech Lead's progress lines). */
  onStderr?: (chunk: string) => void;
  /** Called once the child has closed, before the result resolves. */
  onClose?: () => void;
  /** Applied to the whole stderr before it is redacted and returned. */
  cleanStderr?: (stderr: string) => string;
}

/**
 * Run `node <dir>/<script> ...args`: cwd the agent's checkout, its own env, a
 * kill at `maxMs` or on abort, and the session secrets redacted at every sink
 * (the transcript as it streams, and the stdout/stderr returned).
 */
export async function runAgentCli(
  dir: string,
  script: string,
  args: string[],
  env: Record<string, string>,
  agentConfig: AgentConfig,
  maxMs: number,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
  opts: CliRunOptions = {},
): Promise<CliRun> {
  const secrets = secretValues(agentConfig.sessionEnv ?? []);
  const outRedactor = createStreamRedactor(secrets);
  const errRedactor = createStreamRedactor(secrets);
  const flags = opts.appendTranscript === false ? "w" : "a";
  return new Promise<CliRun>((resolveRun) => {
    const child = spawn("node", [join(dir, script), ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const log = transcriptPath ? (mkdirSync(dirname(transcriptPath), { recursive: true }), createWriteStream(transcriptPath, { flags })) : null;
    child.stdout.on("data", (b: Buffer) => { const t = b.toString(); stdout += t; log?.write(outRedactor.push(t)); });
    child.stderr.on("data", (b: Buffer) => { const t = b.toString(); stderr += t; log?.write(errRedactor.push(t)); opts.onStderr?.(t); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, maxMs);
    const onAbort = () => child.kill("SIGTERM");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      opts.onClose?.();
      if (log) {
        log.write(outRedactor.flush());
        log.write(errRedactor.flush());
        log.end();
      }
      const err = opts.cleanStderr ? opts.cleanStderr(stderr) : stderr;
      resolveRun({ code, stdout: redactAll(stdout, secrets), stderr: redactAll(err, secrets), timedOut });
    });
  });
}

/** The last 400 characters of what a run said, stderr first. */
export const cliTail = (r: CliRun): string => (r.stderr || r.stdout).trim().slice(-400);

/** The last line a run printed, stdout first. */
export const lastLine = (r: CliRun): string => r.stdout.trim().split("\n").pop() || r.stderr.trim().split("\n").pop() || "";

/**
 * Parse the structured review trailers the Tech Lead and the SRE print, one per PR:
 *   FOREMAN_REVIEW pr=#100 verdict=APPROVE merged=yes deploy=SUCCESS [hold=<slug>]
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

const distinctLines = (stdout: string, re: RegExp): string[] =>
  [...new Set([...stdout.matchAll(re)].map((m) => m[1]!.trim()).filter(Boolean))];

/**
 * The SRE's `Not caused by this release, needs triage:` lines and its `Evidence:` links (verify.mjs), distinct,
 * in order; `sre.mjs deploy` prints the same lines prefixed `verify: `. Undefined when there are none. Pure, exported for tests.
 */
export function parseUnrelatedErrors(stdout: string): UnrelatedErrors | undefined {
  const errors = distinctLines(stdout, /^(?:verify: )?Not caused by this release, needs triage: (.+)$/gm);
  return errors.length ? { errors, evidence: distinctLines(stdout, /^(?:verify: )?Evidence: (\S+)$/gm) } : undefined;
}
