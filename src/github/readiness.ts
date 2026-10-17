// An approved issue waits for the prerequisites its own Pre-Flight declares.
//
// Origin: jerky_service#185 (2026-10-16). Approved with its real prerequisite —
// a playbook file on another repo's `main`, a 404 that day — written only as
// prose. The Foreman built it, the session found the file missing and
// skip-held, and a person had to touch the issue. A prerequisite is now a
// structured line in a fenced `readiness` block under `## Pre-Flight`, read
// before a session is spent. Informational Pre-Flight text never holds.
//
// Shared with the EM's escalation unblock conditions (EM#649): one parser.

import type { RepoConfig } from "../config.js";
import { formatGhError } from "./cache.js";
import { commentOnIssue } from "./ci-gate.js";
import { gh } from "./gh.js";
import { foremanLogin } from "./skip-hold.js";

/** One declared prerequisite. */
export type Predicate =
  | { kind: "file_at_ref"; repo: string; path: string; ref: string }
  | { kind: "issue_closed"; repo: string; number: number }
  | { kind: "pr_merged"; repo: string; number: number; base: string };

/** What a body declares: its predicates, and every line or block that is not valid. */
export interface Readiness {
  predicates: Predicate[];
  /** Each entry names the offending line (or the block problem). Any entry holds the issue. */
  invalid: string[];
}

/** One `gh` read, returning stdout and throwing on failure. */
export type GhRead = (args: string[]) => string;

const REPO = "[\\w.-]+/[\\w.-]+";
const FILE_AT_REF = new RegExp(`^file_at_ref:\\s+(${REPO})\\s+(\\S+)\\s+(\\S+)$`);
const ISSUE_CLOSED = new RegExp(`^issue_closed:\\s+(${REPO})#(\\d+)$`);
const PR_MERGED = new RegExp(`^pr_merged:\\s+(${REPO})#(\\d+)\\s+base=(\\S+)$`);

/** The lines of every ```readiness fence inside the `## Pre-Flight` section, one array per block. */
function readinessBlocks(body: string): string[][] {
  const blocks: string[][] = [];
  let inPreFlight = false;
  let fence: { marker: string; readiness: boolean } | null = null;
  let current: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const open = line.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
    if (fence) {
      if (open && open[1][0] === fence.marker[0] && open[1].length >= fence.marker.length && !open[2]) {
        if (fence.readiness) blocks.push(current);
        fence = null;
      } else if (fence.readiness) {
        current.push(line);
      }
      continue;
    }
    if (open) {
      fence = { marker: open[1], readiness: inPreFlight && open[2].toLowerCase() === "readiness" };
      current = [];
      continue;
    }
    const heading = line.match(/^##\s+(.*?)\s*#*\s*$/);
    if (heading) inPreFlight = /^pre-flight$/i.test(heading[1]);
  }
  return blocks;
}

function parseLine(line: string): Predicate | null {
  let m = line.match(FILE_AT_REF);
  if (m) return { kind: "file_at_ref", repo: m[1], path: m[2], ref: m[3] };
  m = line.match(ISSUE_CLOSED);
  if (m) return { kind: "issue_closed", repo: m[1], number: Number(m[2]) };
  m = line.match(PR_MERGED);
  if (m) return { kind: "pr_merged", repo: m[1], number: Number(m[2]), base: m[3] };
  return null;
}

/**
 * The readiness an issue body declares. No block is `{ [], [] }`. Two blocks, or
 * a line that is none of the three forms (including `pr_merged` without
 * `base=`), is invalid and named.
 */
export function parseReadiness(body: string): Readiness {
  const blocks = readinessBlocks(body);
  if (blocks.length > 1) return { predicates: [], invalid: [`${blocks.length} readiness blocks (exactly one is allowed)`] };
  const result: Readiness = { predicates: [], invalid: [] };
  for (const raw of blocks[0] ?? []) {
    const line = raw.trim();
    if (!line) continue;
    const predicate = parseLine(line);
    if (predicate) result.predicates.push(predicate);
    else result.invalid.push(`invalid readiness line: ${line}`);
  }
  return result;
}

/** The predicate as written, for a hold reason. */
export function describePredicate(p: Predicate): string {
  switch (p.kind) {
    case "file_at_ref": return `file_at_ref: ${p.repo} ${p.path} ${p.ref}`;
    case "issue_closed": return `issue_closed: ${p.repo}#${p.number}`;
    case "pr_merged": return `pr_merged: ${p.repo}#${p.number} base=${p.base}`;
  }
}

/** True when a gh failure is GitHub saying the thing does not exist (HTTP 404). */
function isNotFound(err: unknown): boolean {
  const { message, stderr } = formatGhError(err);
  return /\bHTTP 404\b|\bNot Found\b/i.test(`${stderr}\n${message}`);
}

/** Whether one predicate holds. Throws when GitHub cannot say (unreadable). */
function holds(p: Predicate, read: GhRead): boolean {
  switch (p.kind) {
    case "file_at_ref": {
      const path = p.path.split("/").map(encodeURIComponent).join("/");
      try {
        read(["api", `repos/${p.repo}/contents/${path}?ref=${encodeURIComponent(p.ref)}`, "--jq", ".sha"]);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    }
    case "issue_closed":
      return read(["api", `repos/${p.repo}/issues/${p.number}`, "--jq", ".state"]).trim() === "closed";
    case "pr_merged": {
      const pr = JSON.parse(read(["api", `repos/${p.repo}/pulls/${p.number}`, "--jq", "{merged, base: .base.ref}"]));
      return pr.merged === true && pr.base === p.base;
    }
  }
}

/**
 * Each unmet prerequisite, worded for the hold reason: a false predicate, an
 * unreadable one (a stall is visible, a build out of order is not) and every
 * invalid line. Empty when the issue is ready.
 */
export function unmetReadiness(readiness: Readiness, read: GhRead): string[] {
  const unmet = [...readiness.invalid];
  for (const p of readiness.predicates) {
    try {
      if (!holds(p, read)) unmet.push(describePredicate(p));
    } catch (err) {
      unmet.push(`${describePredicate(p)} (unreadable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    }
  }
  return unmet;
}

/** The hidden marker a readiness-hold comment carries, naming the reason it announced. */
const MARKER_PREFIX = "<!-- foreman:readiness-hold ";

/** A short stable digest of a reason, so the marker never carries issue text. */
function reasonKey(reason: string): string {
  let h = 5381;
  for (const ch of reason) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return h.toString(36);
}

/** The comment announcing a readiness hold. Carries the marker that dedupes it. */
export function readinessHoldComment(unmet: string[], approver: string): string {
  return [
    `${MARKER_PREFIX}${reasonKey(unmet.join("\n"))} -->`,
    `Holding this issue: its Pre-Flight readiness block is not met yet. Approved by @${approver}; the approval stands.`,
    "",
    "Unmet:",
    ...unmet.map((u) => `- \`${u}\``),
    "",
    "The build starts automatically when these hold. No action is needed unless a line above is invalid, in which case edit the readiness block.",
  ].join("\n");
}

/** Whether `comment` (the Foreman's latest) is the hold comment for exactly this reason. */
export function announcesReason(comment: string | undefined, unmet: string[]): boolean {
  return comment?.includes(`${MARKER_PREFIX}${reasonKey(unmet.join("\n"))} -->`) ?? false;
}

const ANNOUNCE_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){
comments(last:30){nodes{body author{login}}}
timelineItems(last:50,itemTypes:[LABELED_EVENT]){nodes{... on LabeledEvent{label{name} actor{login}}}}}}}`;

interface AnnounceReads {
  comments: { body: string; author?: { login?: string } | null }[];
  labeled: { label?: { name?: string }; actor?: { login?: string } | null }[];
}

/** The issue's recent comments and `labeled` events, one read. Throws on a gh failure. */
function readAnnounceContext(config: RepoConfig, num: number): AnnounceReads {
  const [o, r] = config.githubRepo.split("/");
  const raw = gh(["api", "graphql", "-f", `query=${ANNOUNCE_QUERY}`, "-F", `o=${o}`, "-F", `r=${r}`, "-F", `n=${num}`], config.repoPath);
  const issue = JSON.parse(raw)?.data?.repository?.issue;
  return { comments: issue?.comments?.nodes ?? [], labeled: issue?.timelineItems?.nodes ?? [] };
}

/**
 * Say, once, on the issue why it is held. The dedupe is the marker in the
 * Foreman's own latest comment, so a restart does not repeat it. Returns true
 * when the reason is on the issue (already, or just posted); false when it
 * could not be established, so the caller tries again next cycle. Throws never.
 */
export function announceReadinessHold(config: RepoConfig, num: number, unmet: string[]): boolean {
  try {
    const { comments, labeled } = readAnnounceContext(config, num);
    const self = foremanLogin(config.repoPath)?.toLowerCase();
    const mine = self ? comments.filter((c) => c.author?.login?.toLowerCase() === self) : [];
    if (announcesReason(mine[mine.length - 1]?.body, unmet)) return true;
    const trigger = labeled.filter((e) => e.label?.name === config.triggerLabel && e.actor?.login);
    const approver = trigger[trigger.length - 1]?.actor?.login ?? "unknown";
    commentOnIssue(config, num, readinessHoldComment(unmet, approver));
    return true;
  } catch {
    return false;
  }
}

/** The issue body, live. Throws on a gh failure. */
export function readIssueBody(config: RepoConfig, num: number): string {
  return gh(["api", `repos/${config.githubRepo}/issues/${num}`, "--jq", ".body // \"\""], config.repoPath);
}
