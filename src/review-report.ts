// What a review posted, read back from its body: core, because the
// orchestrator builds a session's report from it whatever observer (if any)
// shows that report.

import type { SessionReview } from "./adapters.js";

/** A finding line in a review body: `**[S2] Title** — \`path:line\``. */
const FINDING_RE = /\*\*\[(S\d)\]\s*(.+?)\*\*(?:\s*[—-]\s*`([^`]+)`)?/g;

/**
 * The opening paragraph and the findings of a review body as the Tech Lead
 * writes it. A body in another shape gives its first paragraph and no findings.
 */
export function parseReviewBody(body: string | null | undefined): { summary?: string; findings: SessionReview["findings"] } {
  const text = String(body ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return { findings: [] };
  const first = text.split(/\n\s*\n/)[0].trim();
  const summary = /^(#|\*\*\[S\d\]|<sub>)/.test(first) ? undefined : first;
  const findings: Array<{ severity: string; title: string; where?: string }> = [];
  for (const m of text.matchAll(FINDING_RE)) {
    findings.push({ severity: m[1], title: m[2].trim(), ...(m[3] ? { where: m[3] } : {}) });
  }
  return { ...(summary ? { summary } : {}), findings };
}
