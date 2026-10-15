import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

/**
 * The shared handoff contract (EM#614), as every runner the Foreman starts sees it.
 *
 * The contract is served live by `process.handoff_contract`; the EM keeps a
 * checked snapshot of it on this host. Runners have no MCP route to the process
 * bundle, so they read that snapshot through the EM's reader module — the same
 * `reader:` pattern the Discord harness uses (slashbin-ai-team#101). The Foreman
 * holds no copy of the contract and never edits it: it only names the reader.
 *
 * The env name is the one seam: the builder prompt gets the block from here, and
 * the Tech Lead and SRE get the path and render the block themselves.
 *
 * How the reader is called — invocation, timeout, what counts as a failure — is
 * the EM's handoff-contract-client.mjs, loaded from beside the reader. It is the
 * one copy the Tech Lead and SRE load too; the Foreman keeps only its framing.
 */
export const CONTRACT_READER_ENV = "HANDOFF_CONTRACT_READER";

/** Where the reader lives inside an EM checkout. */
export const CONTRACT_READER_REL = join("scripts", "process", "handoff-contract-snapshot.mjs");

/** The EM's reader client, beside the reader: the one policy for calling it. */
const CONTRACT_CLIENT = "handoff-contract-client.mjs";
const load = createRequire(import.meta.url);

const BEGIN = "--- Handoff contract ---";
const END = "--- End handoff contract ---";

/** The reader's absolute path for an EM checkout, or undefined when none is configured. */
export function contractReaderPath(emRepoPath: string | undefined): string | undefined {
  if (!emRepoPath || !isAbsolute(emRepoPath)) return undefined;
  return join(emRepoPath, CONTRACT_READER_REL);
}

/** Set the reader path on a runner env; a missing EM checkout leaves the env as it was. */
export function setContractReaderEnv(env: Record<string, string>, emRepoPath: string | undefined): void {
  const reader = contractReaderPath(emRepoPath);
  if (reader) env[CONTRACT_READER_ENV] = reader;
}

function unavailable(reason: string): string {
  return `CONTRACT UNAVAILABLE: ${reason}. Do not reconstruct the handoff contract; say it is unavailable and name this reason.`;
}

/**
 * The contract block a builder prompt carries. Never throws: a missing reader, a
 * stale or absent snapshot, or a reader that fails all yield an explicit
 * CONTRACT UNAVAILABLE block naming why, so a runner never fills the gap from
 * memory. The client runs the reader in its own process, so a fault in the
 * reader cannot reach the daemon.
 */
export function contractBlock(readerPath: string | undefined): string {
  let text: string;
  if (!readerPath) {
    text = unavailable("no EM checkout configured (AI_AGENT_EM_REPO_PATH / emRepoPath), so no contract reader");
  } else if (!isAbsolute(readerPath)) {
    text = unavailable(`contract reader not found at ${readerPath}`);
  } else {
    try {
      const client = load(join(dirname(readerPath), CONTRACT_CLIENT)) as { contractText: (reader: string) => string };
      text = client.contractText(readerPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      text = unavailable(`contract client did not load beside ${readerPath} (${err.code ?? err.message})`);
    }
  }
  return `${BEGIN}\n` +
    "This is the shared Slashbin handoff contract: authority for who owns each step and what each handoff carries. " +
    "It is not a review rubric and adds no task.\n\n" +
    `${text}\n${END}`;
}
