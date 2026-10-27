import { readFileSync } from "node:fs";
import { join } from "node:path";

/** What `npm run build` records about the source dist/ came from (scripts/stamp-build.mjs). */
export interface BuildInfo {
  commit: string | null;
  dirty: string[] | null;
  builtAt: string;
  error?: string;
}

/**
 * Why the daemon must not start on this build, or null when it may.
 *
 * The daemon runs only code that is a commit. A build made from uncommitted
 * source, or one whose provenance was never recorded (`tsc` run directly), is
 * refused: an edit that ships without a commit cannot be reviewed, reverted or
 * traced, and on 2026-10-12 one ran in production for a day that way.
 */
export function buildRefusal(distDir: string): string | null {
  let info: BuildInfo;
  try {
    info = JSON.parse(readFileSync(join(distDir, "build-info.json"), "utf8")) as BuildInfo;
  } catch {
    return "dist/build-info.json is missing, so this build's source is unknown. Rebuild with `npm run build`, not `tsc`.";
  }
  if (!info.commit || !Array.isArray(info.dirty)) {
    return `this build's source could not be recorded (${info.error ?? "no commit"}). Rebuild with \`npm run build\` from a git checkout.`;
  }
  if (info.dirty.length > 0) {
    return (
      `dist/ was built on ${info.builtAt} from uncommitted source on top of ${info.commit.slice(0, 7)}: ` +
      `${info.dirty.map((l) => l.trim()).join(", ")}. Commit or discard it, then \`npm run build\`.`
    );
  }
  return null;
}
