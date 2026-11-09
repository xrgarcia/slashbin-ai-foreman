// The one place the core runs `git` (slashbin-ai-foreman#253).
//
// Every call is async with a timeout: a synchronous child process holds the whole event
// loop (timers, sockets, Paperclip and registry callbacks) for as long as git runs, and a
// `git fetch` against a remote that is not answering waits out the whole timeout. The
// gh calls were converted the same way (#237, #240). test/no-sync-subprocess.test.mjs
// fails the build if a synchronous process call appears anywhere in `src/`.
import { execFile } from "node:child_process";

export const GIT_DEFAULT_TIMEOUT_MS = 60_000;
const GIT_DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitExecOptions {
  /** Killed after this long. Default 60 s. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. Absent: closed at once. */
  input?: Buffer | string;
  maxBuffer?: number;
}

export interface GitResult {
  /** The exit code; null when the process was killed or never started. */
  status: number | null;
  stdout: Buffer;
  stderr: string;
  /** Node killed it for exceeding `timeoutMs`. */
  timedOut: boolean;
  /** The signal that ended it, when one did. */
  signal?: string;
  /** The spawn error (git missing, cwd missing, timeout), when there was one. */
  error?: Error;
}

/**
 * Runs `git` and always resolves: a non-zero exit, a timeout and a failed spawn are all in the
 * result. The async `execFile` reports its own timeout as a kill (`killed`, SIGTERM, no exit
 * code); a SIGTERM that did not come from Node's timeout (systemd stopping the unit) leaves
 * `timedOut` false, so it still reads as a cancellation.
 */
export function gitResult(args: readonly string[], cwd: string, opts: GitExecOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd,
        env: opts.env,
        encoding: "buffer",
        timeout: opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? GIT_DEFAULT_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { killed?: boolean; code?: unknown; signal?: string | null }) | null;
        resolve({
          status: !e ? 0 : typeof e.code === "number" ? e.code : null,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
          timedOut: Boolean(e?.killed),
          ...(e?.signal ? { signal: e.signal } : {}),
          ...(e ? { error: e } : {}),
        });
      },
    );
    // A closed stdin is what `stdio: "ignore"` gave the sync calls: a command that waits on input ends instead of hanging.
    child.stdin?.on("error", () => { /* the child exited before reading its input */ });
    child.stdin?.end(opts.input);
  });
}

function failure(args: readonly string[], r: GitResult): Error {
  const first = r.stderr.trim().split("\n")[0]?.slice(0, 200) ?? "";
  const e = new Error(r.timedOut ? `git ${args[0]} timed out` : `git ${args[0]} failed${first ? `: ${first}` : ""}`) as Error & { code?: unknown; stderr?: string; stdout?: string; killed?: boolean; signal?: string };
  // `execFileSync` reports its own timeout as ETIMEDOUT; callers (formatGitError) read that code.
  e.code = r.timedOut ? "ETIMEDOUT" : (r.error as { code?: unknown } | undefined)?.code ?? r.status;
  e.killed = r.timedOut;
  if (r.signal) e.signal = r.signal;
  e.stderr = r.stderr;
  e.stdout = r.stdout.toString("utf8");
  return e;
}

/** `git`'s trimmed stdout. Rejects on a non-zero exit, a timeout or a failed spawn; `.stderr` carries git's reason. */
export async function git(args: readonly string[], cwd: string, opts: GitExecOptions = {}): Promise<string> {
  const r = await gitResult(args, cwd, opts);
  if (r.error) throw failure(args, r);
  return r.stdout.toString("utf8").trim();
}

/** `git`'s raw stdout bytes (a blob). Same rejection rules as `git`. */
export async function gitBytes(args: readonly string[], cwd: string, opts: GitExecOptions = {}): Promise<Buffer> {
  const r = await gitResult(args, cwd, opts);
  if (r.error) throw failure(args, r);
  return r.stdout;
}
