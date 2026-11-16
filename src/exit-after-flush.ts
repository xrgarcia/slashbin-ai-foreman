/**
 * Exit once stdout and stderr have drained. `process.exit` right after a large
 * `console.log` to a pipe drops everything past the pipe buffer (64 KB on Linux):
 * `metrics:runs --json | node …` read 65,536 bytes of a 136 KB document and the
 * reader failed on partial JSON (2026-11-15). A write of "" completes only after
 * every write queued before it, so its callback is the drain point.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  const drain = (s: NodeJS.WriteStream) => new Promise<void>((resolve) => s.write("", () => resolve()));
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
}
