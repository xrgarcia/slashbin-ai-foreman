// The orchestrator's source text, for tests that assert on how it is written.
// orchestrator.ts was split into src/phases/; this joins the pieces back in the
// order they stood in the single file, so position checks still hold.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHASES_BEFORE = ["common", "reconcile"];
const PHASES_AFTER = ["custom", "implement", "revise", "verify", "review", "promote"];

/** `src` (TypeScript, the default) or `dist` (the built JavaScript). */
export function orchestratorSource(tree = "src") {
  const ext = tree === "dist" ? "js" : "ts";
  const read = (p) => readFileSync(join(root, tree, p), "utf-8");
  return [
    ...PHASES_BEFORE.map((p) => read(`phases/${p}.${ext}`)),
    read(`orchestrator.${ext}`),
    ...PHASES_AFTER.map((p) => read(`phases/${p}.${ext}`)),
  ].join("\n");
}
