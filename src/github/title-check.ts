import { githubConventionsSchema, fillTitle } from "../config-schema/github.js";
import type { Check } from "../contract/conformance.js";
import { extractImplementedIssues } from "./discovery.js";

/**
 * Conformance F1 (foreman#268, fixes #239): every title the Foreman writes for a PR that delivers one
 * issue is found by its own strict parser. The reconcile title was not, and every reconciled PR
 * dead-ended at verify-no-pr.
 */
export function checkTitlesParse(templates?: { reconcileTitle: string }): Check[] {
  const t = templates ?? githubConventionsSchema.parse({});
  const n = 221;
  // The reconciler's own body names the issue only as "Related to", which the strict parser ignores
  // by design; the title alone has to carry it.
  const title = fillTitle(t.reconcileTitle, { N: n });
  const found = extractImplementedIssues({ title, body: `- Related to #${n}`, strict: true });
  return [{
    id: "F1 reconcileTitle",
    ok: found.length === 1 && found[0] === n,
    detail: `"${title}" → strict parse ${JSON.stringify(found)}, want [${n}]`,
  }];
}

