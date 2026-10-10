// Source text of the modules that were split into directories, for tests that
// assert on how the code is written. Each joins its pieces back in the order
// they stood in the single file, so position checks still hold.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function joined(tree, files) {
  const ext = tree === "dist" ? "js" : "ts";
  return files.map((p) => readFileSync(join(root, tree, `${p}.${ext}`), "utf-8")).join("\n");
}

/** orchestrator.ts and src/phases/. `src` (TypeScript, the default) or `dist` (built JavaScript). */
export function orchestratorSource(tree = "src") {
  return joined(tree, [
    "phases/common", "phases/reconcile", "orchestrator", "phases/custom", "phases/implement",
    "phases/revise", "phases/verify", "phases/review", "phases/promote",
  ]);
}

/** github.ts (the public surface) and src/github/. */
export function githubSource(tree = "src") {
  return joined(tree, [
    "github", "github/gh", "github/cache", "github/discovery", "github/review-queue",
    "github/lifecycle-scan", "github/review-freshness", "github/ci-gate", "github/promotion",
    "github/reports", "github/branch", "github/dependencies", "github/pr",
  ]);
}
