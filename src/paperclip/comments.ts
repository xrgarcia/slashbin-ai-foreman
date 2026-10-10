// The comments a Paperclip card's thread carries (Foreman issue 74): one short
// markdown summary per meaningful event, written from what the Foreman already
// holds — the issue's title, the session's own closing message, the PR's title
// and diff stat, the review it posted. Never the session log, never an LLM call.
//
// Everything here is pure: the mirror decides when a comment is due, these
// functions decide what it says. Every comment is redacted (known secret values
// plus anything shaped like a token) and capped before it leaves.

import type { SessionEvent, SessionReview, WorkItem } from "../adapters.js";
import { redactAll } from "../redact.js";
import type { PaperclipCommentEvent, PaperclipConfig } from "../config.js";

export type CommentsConfig = PaperclipConfig["comments"];

/** The defaults, for a config object built without the `comments` block (tests, older callers). */
export const DEFAULT_COMMENTS: CommentsConfig = Object.freeze({
  enabled: true,
  events: Object.freeze({
    implementStart: true, implementEnd: true, reviewStart: true, reviewEnd: true,
    reviseStart: true, reviseEnd: true, progress: true, release: true, blocked: true,
  }),
  maxLength: 3000,
  includeDiffStat: true,
});

export function commentsOf(cfg: PaperclipConfig): CommentsConfig {
  const c = (cfg as { comments?: Partial<CommentsConfig> }).comments;
  if (!c) return DEFAULT_COMMENTS;
  return { ...DEFAULT_COMMENTS, ...c, events: { ...DEFAULT_COMMENTS.events, ...(c.events ?? {}) } };
}

/** The comment event a session phase + status belongs to. */
export function sessionCommentEvent(event: Pick<SessionEvent, "phase" | "status">): PaperclipCommentEvent {
  const end = event.status === "finished" || event.status === "failed";
  if (event.phase === "implement") return end ? "implementEnd" : "implementStart";
  if (event.phase === "revise") return end ? "reviseEnd" : "reviseStart";
  return end ? "reviewEnd" : "reviewStart";
}

/**
 * Token shapes redacted from every comment, on top of the secret values the
 * Foreman knows. A session's closing message is the agent's own words, and an
 * agent that echoed a credential it read would otherwise publish it.
 */
const TOKEN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [REDACTED]"],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[REDACTED]@"],
  // NAME_TOKEN=value, "apiKey": "value", password: value
  [
    /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*["']?)([^\s"'`,;)]{8,})/gi,
    "$1$2[REDACTED]",
  ],
];

/** `text` with known secrets and token-shaped strings replaced. */
export function redactComment(text: string, secrets: ReadonlyArray<{ name: string; value: string }>): string {
  let out = redactAll(String(text), secrets);
  for (const [re, sub] of TOKEN_PATTERNS) out = out.replace(re, sub);
  return out;
}

const TRUNCATED = "\n\n… (truncated)";

/** `text` cut to `max` characters, marked when cut. */
export function capComment(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - TRUNCATED.length)).trimEnd() + TRUNCATED;
}

/** What is actually sent: redacted, then capped. */
export function finishComment(text: string, c: CommentsConfig, secrets: ReadonlyArray<{ name: string; value: string }>): string {
  return capComment(redactComment(text, secrets).trim(), c.maxLength);
}

/** An agent's closing message, fit for a card: machine trailers removed, blank runs collapsed. */
export function agentText(text: string | undefined): string {
  return String(text ?? "")
    .split("\n")
    .filter((l) => !/^\s*FOREMAN_[A-Z_]+\b/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// `parseReviewBody` is core (review-report.ts); re-exported for existing importers.
export { parseReviewBody } from "../review-report.js";

const prRef = (pr: { number: number; url?: string } | undefined, fallback?: number): string => {
  if (pr?.url) return `[PR #${pr.number}](${pr.url})`;
  const n = pr?.number ?? fallback;
  return n === undefined ? "the PR" : `PR #${n}`;
};

const join = (...parts: Array<string | undefined | false>): string => parts.filter((p): p is string => !!p && !!p.trim()).join("\n\n");

/** An implement end that names the items it worked, and `item` is not one of them. */
export function untouched(event: Pick<SessionEvent, "phase" | "status" | "worked">, item: WorkItem): boolean {
  return event.phase === "implement" && (event.status === "finished" || event.status === "failed")
    && event.worked !== undefined && event.worked.length > 0 && !event.worked.includes(item.issueNumber);
}

/**
 * The comment a session event posts on `item`'s card, or null when it posts
 * none. `retry` marks an implement start that repeats an attempt which did not
 * finish.
 */
export function sessionComment(event: SessionEvent, item: WorkItem, c: CommentsConfig, retry = false): string | null {
  const r = event.report ?? {};
  const detail = (event.detail ?? "").trim();
  const text = agentText(r.text);
  const reviewer = event.reviewer ?? "Reviewer";
  const key = `${event.phase}:${event.status}`;

  if (untouched(event, item)) {
    const worked = event.worked!.map((n) => `#${n}`).join(", ");
    const verb = event.status === "failed" ? "failed on" : /^skipped\b/i.test(detail) ? "stopped on" : "built";
    return `**Not built this run** — the run ${verb} ${worked}; this issue waits for a later run`;
  }

  switch (key) {
    case "implement:started": {
      const goal = r.goals?.[item.issueNumber];
      const others = event.items.filter((i) => i.issueNumber !== item.issueNumber).map((i) => `#${i.issueNumber}`);
      return join(
        retry ? "**Foreman started implementing** (retry: the previous attempt did not finish)" : "**Foreman started implementing**",
        goal && `Goal: ${goal}`,
        others.length > 0 && `Handed this run with ${others.join(", ")} — a run builds one of them.`,
      );
    }
    case "implement:finished": {
      if (/^skipped\b/i.test(detail)) {
        return join("**Foreman skipped this issue**", text || detail.replace(/^skipped:?\s*/i, ""));
      }
      const pr = r.pr;
      const head = pr
        ? `**Implementation finished** — ${prRef(pr)}${pr.title ? `: ${pr.title}` : ""}`
        : `**Implementation finished** — ${detail || "done"}`;
      const stat = c.includeDiffStat && pr && pr.changedFiles !== undefined
        ? `Diff: ${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"}, +${pr.additions ?? 0} −${pr.deletions ?? 0}`
        : undefined;
      return join(head, stat, text);
    }
    case "implement:failed":
      return join(`**Implementation failed** — ${detail || "unknown error"}`);
    case "revise:started":
      return `**Revising ${prRef(r.pr, event.pr)}** after review feedback`;
    case "revise:finished": {
      if (/^no commit\b/i.test(detail)) {
        return join(`**Revision: no change made** — ${prRef(r.pr, event.pr)}`, text || detail.replace(/^no commit:?\s*/i, ""));
      }
      return join(`**Revision pushed** — ${prRef(r.pr, event.pr)}, back to review`, text);
    }
    case "revise:failed":
      return `**Revision failed** — ${prRef(r.pr, event.pr)}: ${detail || "unknown error"}`;
    case "review:started":
      return `**${reviewer} reviewing ${prRef(r.pr, event.pr)}**`;
    case "review:handoff":
      return join(`**Review handed to ${reviewer}**`, detail);
    case "review:finished": {
      const v = r.review;
      if (!v) return join(`**Review finished** — ${prRef(r.pr, event.pr)}`, detail, text && text !== detail ? text : undefined);
      const outcome = [
        v.merged ? "merged" : "not merged",
        v.deploy && !/^(NA|N\/A|none)$/i.test(v.deploy) ? `deploy ${v.deploy}` : "no deploy",
      ].join(" · ");
      const findings = v.findings.length
        ? v.findings.map((f) => `- **${f.severity}** · ${f.title}${f.where ? ` — \`${f.where}\`` : ""}`).join("\n")
        : undefined;
      return join(
        `**${reviewer} review: ${v.verdict}** — ${prRef(r.pr, event.pr)} ${outcome}`,
        v.hold && `Held: ${v.hold}`,
        v.summary,
        findings,
      );
    }
    case "review:failed":
      return `**Review failed** — ${prRef(r.pr, event.pr)}: ${detail || "unknown error"}`;
    // Verify shares the review comment toggles (reviewStart / reviewEnd).
    case "verify:started":
      return `**${reviewer} verifying ${prRef(r.pr, event.pr)} in dev**`;
    case "verify:finished":
      return join(`**Dev verification passed** — ${prRef(r.pr, event.pr)}`, detail);
    case "verify:failed":
      return `**Dev verification did not pass** — ${prRef(r.pr, event.pr)}: ${detail || "unknown error"}`;
    default:
      return null;
  }
}
