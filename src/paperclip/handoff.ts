// What a card says when the Foreman hands it to another seat (a role in
// `paperclip.roles`): who must act and what to do, why it is on them, the
// links, and what "done" looks like, so the holder knows when it can stop.
//
// Paperclip wakes the agent a card is assigned to, and before this the card
// told it only the stage. SLA-1550 (Slashbin-console#1283, PR #1291) reached
// the EM at `pendingVerification` with "Dev verification passed" and a bare
// "approved"; the EM read it as a status ping, answered "nothing needed until
// the next prod release", and the card sat while the release waited on the EM's
// own gate (2026-10-15).
//
// One table, STAGE_HANDOFF, keyed by lifecycle stage: adding a stage to
// lifecycle.ts fails the build until it has an entry here. The text addresses
// whoever `paperclip.board.<stage>.owner` names; a stage the Foreman holds gets
// no handoff, since the Foreman is the one acting. Pure: the mirror decides when
// a handoff is due, this decides what it says.

import type { Stage } from "../lifecycle.js";

/** One stage's handoff: what the holder does, and when it is done. */
export interface StageHandoff {
  /** True when the holder must do something; false when the Foreman drives the stage and the card is for information. */
  readonly act: boolean;
  /** The next action, in a sentence or two. */
  readonly todo: string;
  /** The same, in a few words, for the card description's `Next:` line. */
  readonly next: string;
  /** Why the card is on the holder: the fact that put it in this stage. */
  readonly why: string;
  /** The signal the Foreman watches: once it shows, the holder can stop. */
  readonly done: string;
}

/**
 * The lifecycle label names the text quotes, by `lifecycleLabels` key. The
 * defaults are the schema's (src/config.ts); the daemon passes the loaded ones.
 */
export type HandoffLabels = Readonly<Record<
  "prUnderReview" | "prMerged" | "prPendingActions" | "prApproved" | "readyForProd" | "releasePending" | "prodVerifyHeld", string>>;

export const DEFAULT_HANDOFF_LABELS: HandoffLabels = Object.freeze({
  prUnderReview: "pr under review",
  prMerged: "pr merged",
  prPendingActions: "pr pending actions",
  prApproved: "pr approved",
  readyForProd: "ready for prod release",
  releasePending: "release pending",
  prodVerifyHeld: "prod verification held",
});

/**
 * Every stage's handoff. `{issue}` is owner/name#N, `{repo}` owner/name, `{pr}`
 * "PR #N" (or "the PR"), `{prNumber}` its number (or "<PR>"), and `{<label key>}`
 * a lifecycle label's name.
 */
export const STAGE_HANDOFF: Readonly<Record<Stage, StageHandoff>> = Object.freeze({
  approved: {
    act: false,
    todo: "Nothing to do from this card: the Foreman builds {issue} on its next cycle.",
    next: "nothing; the Foreman builds it next",
    why: "the issue is approved and queued for a build",
    done: "a PR opens and the card moves to code review",
  },
  implementing: {
    act: false,
    todo: "Nothing to do from this card: the Foreman is building {issue} now.",
    next: "nothing; the Foreman is building it",
    why: "an implement session is running",
    done: "the session opens a PR and the card moves to code review",
  },
  inReview: {
    act: false,
    todo: "Review {pr}: the Foreman starts your review session on its next review pass. Nothing to do from this card.",
    next: "nothing; the Foreman runs the review of {pr} next",
    why: "{pr} is open and labelled `{prUnderReview}`",
    done: "the review's verdict is on {pr}: merged (the card moves to dev verification) or changes requested",
  },
  reviewing: {
    act: false,
    todo: "The Foreman is running your review of {pr} now. Nothing to do from this card.",
    next: "nothing; the review of {pr} is running",
    why: "the Foreman started the review session",
    done: "the review's verdict is on {pr}",
  },
  changesRequested: {
    act: false,
    todo: "Nothing to do from this card: the Foreman's revise session addresses the review of {pr} next.",
    next: "nothing; the Foreman revises {pr} next",
    why: "the review asked for changes or CI is red (`{prPendingActions}`)",
    done: "a revision is pushed and the card returns to code review",
  },
  revising: {
    act: false,
    todo: "Nothing to do from this card: a revise session is addressing the review of {pr}.",
    next: "nothing; {pr} is being revised",
    why: "a revise session is running",
    done: "the revision is pushed and the card returns to code review",
  },
  merged: {
    act: false,
    todo: "Verify {pr} in dev: the Foreman starts your dev verification on its next verify pass. Nothing to do from this card.",
    next: "nothing; the Foreman runs dev verification of {pr} next",
    why: "{pr} merged to the base branch (`{prMerged}`)",
    done: "dev verification passes (`{prApproved}`; the card moves to EM verification) or holds (the card moves to Blocked)",
  },
  verifying: {
    act: false,
    todo: "The Foreman is running your dev verification of {pr} now. Nothing to do from this card.",
    next: "nothing; dev verification of {pr} is running",
    why: "the Foreman started the verify session",
    done: "the verification's result is on {pr}",
  },
  qaReviewing: {
    act: false,
    todo: "QA is checking {pr} on dev now (visual and behaviour). Nothing to do from this card.",
    next: "nothing; QA of {pr} on dev is running",
    why: "the SRE passed dev verification and the QA gate started",
    done: "QA passes (`{prApproved}`; the card moves to EM verification) or holds (the card moves to Blocked)",
  },
  pendingVerification: {
    act: true,
    todo: "Run the EM release gate (`/deliver-to-prod` step 3a) for {issue} and, if it passes, apply `{readyForProd}` to the issue. The prod release does not start until you do.",
    next: "run the EM release gate (/deliver-to-prod 3a) for {issue}, then apply `{readyForProd}`",
    why: "dev verification passed (`{prApproved}`)",
    done: "`{readyForProd}` is on {issue}; the Foreman then moves this card to Release authorized and opens the release PR",
  },
  releaseAuthorized: {
    act: false,
    todo: "Nothing to do from this card: the Foreman puts {issue} in the release PR on its next promote pass.",
    next: "nothing; the Foreman puts it in the release PR next",
    why: "the EM authorized production (`{readyForProd}`)",
    done: "the release PR carries it (`{releasePending}`)",
  },
  awaitingRelease: {
    act: true,
    todo: "Get the open release PR that carries {issue} merged to production, or close it: the Foreman's release stage does not own that PR, so nothing merges it automatically.",
    next: "get the open release PR that carries {issue} merged, or close it",
    why: "{issue} is in a release PR the Foreman's release stage does not own",
    done: "the release PR merges (the card goes to done) or closes (the card waits for the next release)",
  },
  releasing: {
    act: false,
    todo: "The Foreman runs the release PR that carries {issue}: Tech Lead approval, then the SRE's merge, deploy and prod verification. Nothing to do from this card.",
    next: "nothing; the Foreman runs the release",
    why: "{issue} is in the release PR the Foreman owns (`{releasePending}`)",
    done: "prod verification passes (the issue closes, the card goes to done) or holds (`{prodVerifyHeld}`)",
  },
  prodVerifyHeld: {
    act: true,
    todo: "Sort the hold: read the newest production-verification comment on {issue}. A wait (`wait-until-…`, no traffic yet, a soak) needs nothing, the Foreman re-verifies on a back-off. A check that could not observe the outcome is a verifier defect: file it. Production actually broken: file a new corrective issue. Never re-verify by hand.",
    next: "sort the prod-verification hold on {issue}",
    why: "deployed to production, but prod verification held or failed (`{prodVerifyHeld}`)",
    done: "a prod re-verification passes and the issue closes, or the corrective issue is filed",
  },
  needsRuling: {
    act: true,
    todo: "Rule on it. A PR not converging under review: run `/rule-on-scope {repo} {prNumber}`, bound the spec in the issue body, and post a PR comment opening `**EM scope ruling`. A skipped issue that used up its attempts: change the issue so it can be built.",
    next: "rule on scope: /rule-on-scope {repo} {prNumber}, or fix the skipped issue",
    why: "the Foreman paused the work for a ruling (the reason is above)",
    done: "a ruling comment is on the PR (revision resumes) or the issue changed (the Foreman builds it again)",
  },
  blocked: {
    act: true,
    todo: "Clear the hold on {issue}: read the reason above, fix what it names, then lift the blocked label or change the issue.",
    next: "clear the hold on {issue}",
    why: "the Foreman could not continue (the reason is above)",
    done: "the hold lifts and the card returns to its stage",
  },
} satisfies Record<Stage, StageHandoff>);

/**
 * A handoff that replaces its stage's text when the hold belongs to someone other
 * than the stage's owner. `deployFailed`: dev verification failed because the dev
 * deploy did, which is infrastructure (the SRE's), not something the EM can clear.
 */
export const HANDOFF_VARIANTS = Object.freeze({
  deployFailed: {
    act: true,
    todo: "The deploy to dev failed (infrastructure, not the code): get the merge deployed to dev, re-verify, then release the hold on {issue}.",
    next: "get the merge deployed to dev, re-verify, release the hold on {issue}",
    why: "dev verification failed because the deploy to dev did (the reason is above)",
    done: "the merge is deployed to dev and the hold lifts (the card returns to its stage)",
  },
} satisfies Record<string, StageHandoff>);
export type HandoffVariant = keyof typeof HANDOFF_VARIANTS;

/** What a handoff names beyond its stage: the card's issue, its PR, and the fact that moved it. */
export interface HandoffFacts {
  readonly repo: string;
  readonly issueNumber: number;
  /** The seat that holds the card now, by name. */
  readonly seat: string;
  readonly pr?: { readonly number: number; readonly url?: string };
  /** The latest outcome on the card (a session's result), and when it came. */
  readonly evidence?: { readonly text: string; readonly at?: string; readonly url?: string };
}

/** `template` with each `{name}` filled; unknown names are left as written. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

function varsOf(f: HandoffFacts, labels: HandoffLabels): Record<string, string> {
  return {
    ...labels,
    issue: `${f.repo}#${f.issueNumber}`,
    repo: f.repo,
    pr: f.pr ? `PR #${f.pr.number}` : "the PR",
    prNumber: f.pr ? String(f.pr.number) : "<PR>",
  };
}

/** An ISO time as `YYYY-MM-DD HH:MMZ`; the input as given when it is not one. */
function when(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? at : new Date(t).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/**
 * The handoff block a note carries when its move hands the card to `f.seat`:
 * who, what to do, why, the links, and when it is done.
 */
export function handoffComment(stage: Stage, f: HandoffFacts, labels: HandoffLabels = DEFAULT_HANDOFF_LABELS, variant?: HandoffVariant): string {
  const h = variant ? HANDOFF_VARIANTS[variant] : STAGE_HANDOFF[stage];
  const v = varsOf(f, labels);
  const ev = f.evidence;
  const why = fill(h.why, v) + (ev?.text ? ` — ${ev.text}` : "") + (ev?.at ? ` (${when(ev.at)})` : "");
  const issueUrl = `https://github.com/${f.repo}/issues/${f.issueNumber}`;
  const prUrl = f.pr ? f.pr.url ?? `https://github.com/${f.repo}/pull/${f.pr.number}` : null;
  const links = [`[${v.issue}](${issueUrl})`, prUrl && `[PR #${f.pr!.number}](${prUrl})`, ev?.url && `[evidence](${ev.url})`]
    .filter(Boolean).join(" · ");
  return [
    `**Next: ${f.seat} — ${h.act ? "action needed" : "no action needed from this card"}**`,
    `- **Do:** ${fill(h.todo, v)}`,
    `- **Why:** ${why}`,
    `- **Links:** ${links}`,
    `- **Done when:** ${fill(h.done, v)}`,
  ].join("\n");
}

/** The card description's line under `stage <stage>`: `Next: <seat> — <the action in a few words>`. */
export function handoffNextLine(stage: Stage, f: HandoffFacts, labels: HandoffLabels = DEFAULT_HANDOFF_LABELS, variant?: HandoffVariant): string {
  return `Next: ${f.seat} — ${fill((variant ? HANDOFF_VARIANTS[variant] : STAGE_HANDOFF[stage]).next, varsOf(f, labels))}`;
}
