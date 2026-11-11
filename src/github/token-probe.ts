// The startup token check's one GitHub call (Foreman #43), behind the code host.

import type { TokenProbe } from "../code-host.js";
import { ghHttpStatus, runGhAsync } from "./gh.js";

/** One `gh api user` with `token`. Only a 401 counts as rejected; anything else that fails is unknown. */
export async function probeToken(token: string): Promise<TokenProbe> {
  try {
    await runGhAsync(["api", "user", "--include"], process.cwd(), token);
    return "ok";
  } catch (err) {
    return ghHttpStatus(err) === 401 ? "rejected" : "unknown";
  }
}
