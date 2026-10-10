import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { stagesSchema, hasStage, type StageEntry } from "./stages.js";

// --- Schemas ---

// The issue labels that carry a PR through its lifecycle after the trigger label
// starts it. The defaults ARE the names Slashbin's fleet runs on, so a config
// without `lifecycleLabels` behaves exactly as before. These five literals are the
// only place the names are written down: everything else reads them from config,
// and the implement/revise/review sessions receive them as FOREMAN_LIFECYCLE_LABELS.
//
// Global, never per repo. The phases hand work to each other by label — review
// reads what implement wrote, revise reads what review wrote — so two repos with
// different names would be one fleet speaking two protocols. `triggerLabel` stays
// separate for the opposite reason: it selects work, and it does cascade per repo.
const lifecycleLabelsSchema = z.object({
  // Implement/revise opened or updated a PR; the review phase picks it up.
  prUnderReview: z.string().min(1).default("pr under review"),
  // Reviewed and merged to the base branch; dev verification pending. The
  // verify stage picks it up and moves it to prApproved (EM#440). Only written
  // when `srePath` is configured — without a verify stage nothing would read it.
  prMerged: z.string().min(1).default("pr merged"),
  // Review asked for changes (or CI is red); the revise phase picks it up.
  prPendingActions: z.string().min(1).default("pr pending actions"),
  // Merged and verified in dev; awaiting the EM outcome-gate.
  prApproved: z.string().min(1).default("pr approved"),
  // The EM outcome-gate's signature — authorizes production. The daemon never
  // applies it on its own judgement (see GitHubIssueConnector.reportState);
  // it only puts back one a review run removed (restoreEmGate).
  readyForProd: z.string().min(1).default("ready for prod release"),
  // Promoted; awaiting the close. Read here only to keep such issues out of the
  // actionable set.
  readyToClose: z.string().min(1).default("ready to close"),
});

// Optional mirror of the Foreman's work onto a Paperclip instance
// (https://github.com/paperclipai/paperclip). GitHub stays the only work source:
// Paperclip only ever shows what the Foreman is doing. Off by default — a config
// without this block, or with `enabled` unset, runs exactly as before.
//
// The six Paperclip statuses the Foreman's view of an issue maps onto.
// `statusMap` renames any of them for an instance whose workflow uses other names.
const PAPERCLIP_STATUS_BUCKETS = ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"] as const;

// The board's lifecycle stages: where an issue is between "authorized" and
// "shipped". Each maps to who holds the card (a role), its Paperclip status,
// and the stage label it carries. The `…ing` stages are a live session.
export const PAPERCLIP_STAGES = [
  "approved", "implementing", "inReview", "reviewing", "changesRequested", "revising", "merged", "verifying", "pendingVerification", "awaitingRelease", "blocked",
] as const;
export type PaperclipStage = (typeof PAPERCLIP_STAGES)[number];

/** The role every stage defaults to: the Foreman's own agent. */
export const PAPERCLIP_FOREMAN_ROLE = "foreman";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a 6-digit hex color, e.g. #2563eb");
const stageLabel = (name: string, color: string) =>
  z.object({ name: z.string().trim().min(1).max(48).default(name), color: hexColor.default(color) }).prefault({});
const stageLabelsSchema = z.object({
  inReview: stageLabel("In code review", "#2563eb"),
  changesRequested: stageLabel("Changes requested", "#d97706"),
  merged: stageLabel("Dev verification", "#0891b2"),
  pendingVerification: stageLabel("Pending verification", "#7c3aed"),
  awaitingRelease: stageLabel("Awaiting release", "#059669"),
  blocked: stageLabel("Blocked", "#dc2626"),
}).catchall(z.object({ name: z.string().trim().min(1).max(48), color: hexColor })).prefault({});

const stage = (owner: string, status: (typeof PAPERCLIP_STATUS_BUCKETS)[number], label: string | null) =>
  z.object({
    owner: z.string().min(1).default(owner),
    status: z.enum(PAPERCLIP_STATUS_BUCKETS).default(status),
    label: z.string().min(1).nullable().default(label),
  }).prefault({});
// The default mapping fits a Foreman with no other roles: it holds every card.
const boardStagesSchema = z.object({
  approved: stage(PAPERCLIP_FOREMAN_ROLE, "todo", null),
  implementing: stage(PAPERCLIP_FOREMAN_ROLE, "in_progress", null),
  inReview: stage(PAPERCLIP_FOREMAN_ROLE, "in_review", "inReview"),
  reviewing: stage(PAPERCLIP_FOREMAN_ROLE, "in_progress", "inReview"),
  changesRequested: stage(PAPERCLIP_FOREMAN_ROLE, "todo", "changesRequested"),
  revising: stage(PAPERCLIP_FOREMAN_ROLE, "in_progress", "changesRequested"),
  // Merged, waiting for the verify stage; then its live session.
  merged: stage(PAPERCLIP_FOREMAN_ROLE, "in_review", "merged"),
  verifying: stage(PAPERCLIP_FOREMAN_ROLE, "in_progress", "merged"),
  pendingVerification: stage(PAPERCLIP_FOREMAN_ROLE, "in_review", "pendingVerification"),
  awaitingRelease: stage(PAPERCLIP_FOREMAN_ROLE, "in_review", "awaitingRelease"),
  // Needs a person: labelled `blocked` on the source, or the Foreman declined it / ran out of retries.
  blocked: stage(PAPERCLIP_FOREMAN_ROLE, "blocked", "blocked"),
}).prefault({});

// The events a card's thread gets a summary comment for. Each is on by default;
// false drops that event's comment and leaves the card's status moves alone.
export const PAPERCLIP_COMMENT_EVENTS = [
  "implementStart", "implementEnd", "reviewStart", "reviewEnd", "reviseStart", "reviseEnd",
  "progress", "release", "blocked",
] as const;
export type PaperclipCommentEvent = (typeof PAPERCLIP_COMMENT_EVENTS)[number];
const commentsSchema = z.object({
  enabled: z.boolean().default(true),
  events: z.object({
    implementStart: z.boolean().default(true),
    implementEnd: z.boolean().default(true),
    reviewStart: z.boolean().default(true),
    reviewEnd: z.boolean().default(true),
    reviseStart: z.boolean().default(true),
    reviseEnd: z.boolean().default(true),
    progress: z.boolean().default(true),
    release: z.boolean().default(true),
    blocked: z.boolean().default(true),
  } satisfies Record<PaperclipCommentEvent, unknown>).prefault({}),
  maxLength: z.number().int().min(200).max(20_000).default(3000),
  includeDiffStat: z.boolean().default(true),
}).prefault({});

const roleSchema = z.object({
  name: z.string().trim().min(1),
  title: z.string().min(1).optional(),
  role: z.string().min(1).default("engineer"),
  reportsTo: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
});

const paperclipConfigSchema = z.object({
  // Strict: env vars arrive as strings, and Boolean("false") is true. Anything
  // that is not a recognised yes/no reaches z.boolean() unchanged and fails.
  enabled: z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      if (/^(1|true|yes|on)$/i.test(v.trim())) return true;
      if (/^(0|false|no|off)$/i.test(v.trim())) return false;
      return v;
    },
    z.boolean(),
  ).default(false),
  // Base URL of the Paperclip server; the client appends /api/...
  url: z.url().default("http://127.0.0.1:3100"),
  // The Paperclip company the Foreman's tasks live in. Required once enabled.
  companyId: z.string().min(1).optional(),
  // The name the Foreman registers under, and finds itself by, in Paperclip.
  agentName: z.string().min(1).default("Foreman"),
  // The Foreman's Paperclip agent id, once registered.
  agentId: z.string().min(1).optional(),
  // The bearer credential sent as `authorization: Bearer` on every request, for an
  // instance that requires sign-in. Unset sends no authorization header. Set it
  // from the environment; it is a secret and is redacted from the mirror's logs.
  apiKey: z.string().min(1).optional(),
  // How a Paperclip task names the GitHub issue it mirrors. {repo} is the full
  // owner/name, {N} the issue number. Must match whatever else writes those
  // tasks, or the Foreman creates a second row for an issue that already has one.
  identityKeyFormat: z.string()
    .refine((f) => f.includes("{repo}") && f.includes("{N}"), "identityKeyFormat must contain {repo} and {N}")
    .default("source: {repo}#{N}"),
  // Per-bucket override of the Paperclip status name. Unset = the bucket names.
  statusMap: z.partialRecord(z.enum(PAPERCLIP_STATUS_BUCKETS), z.string().min(1)).optional(),
  // File each task the Foreman creates under the Unplaced project; off = no `projectId`.
  projects: z.boolean().default(true),
  // Set the Foreman agent's own status in Paperclip: running while a session runs, idle otherwise.
  agentStatus: z.boolean().default(true),
  // Other agents that hold cards, by role key (e.g. reviewer): { name, title?, role?, reportsTo?, id? }. reportsTo names another role key or "foreman". `npm run paperclip:register` finds or creates each by name and writes its id here. Empty = the Foreman holds every card.
  roles: z.record(z.string().regex(/^\w+$/), roleSchema).default({}),
  // The role key the Foreman's own agent reports to, applied by `npm run paperclip:register`. Unset = left as it is.
  agentReportsTo: z.string().min(1).optional(),
  // Per lifecycle stage: the role that holds the card ("foreman" or a key of roles), its status bucket, and its stage label (a key of stageLabels, or null for none).
  board: boardStagesSchema,
  // The stage labels, by key: { name, color }. Created in the company on first use; a card carries at most one, and a stage change swaps it. Other labels on a card are never touched.
  stageLabels: stageLabelsSchema,
  // Minutes a live-session lease (the Foreman agent's metadata.foremanLive) stays valid without renewal. Past it, a card left in progress belongs to a session that died with the Foreman; the Foreman restores such cards when it next starts, and any external sync can read the lease the same way.
  liveLeaseMinutes: z.number().int().positive().default(15),
  // What a card's thread says: { enabled, events, maxLength, includeDiffStat }. enabled false = the one-line note per step. events turns each comment off by kind (implementStart, implementEnd, reviewStart, reviewEnd, reviseStart, reviseEnd, progress, release, blocked). maxLength caps every comment, includeDiffStat adds the PR's files and +/- lines to the implement summary. Every comment is redacted (known secrets and token-shaped strings) and never repeats the task's latest comment.
  comments: commentsSchema,
});

const repoEntrySchema = z.object({
  name: z.string(),
  repoPath: z.string(),
  githubRepo: z.string().optional(),
  triggerLabel: z.string().optional(),
  baseBranch: z.string().optional(),
  productionBranch: z.string().optional(),
  featureBranch: z.string().optional(),
  // A repo-relative SKILL.md, or "builtin:" for the generic skill shipped in
  // this package's skills/ directory (see resolveSkill in agent.ts).
  skillPath: z.string().optional(),
  revisionSkillPath: z.string().optional(),
  // Optional repo-relative file appended to the implement / revise prompt after
  // the skill — operator rules on top of a built-in skill without forking it.
  skillOverlayPath: z.string().optional(),
  revisionSkillOverlayPath: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.coerce.number().int().positive().optional(),
  maxDurationMs: z.coerce.number().int().positive().optional(),
  // Per-repo opt-out for the review phase (falls back to the global default).
  reviewEnabled: z.boolean().optional(),
  // Per-repo review skill and reviewer identity; each falls back to the global
  // value. See the global fields below for what they mean and how a relative
  // reviewSkillPath resolves.
  reviewSkillPath: z.string().optional(),
  reviewerLogin: z.string().optional(),
  // Owner standing authorization: file this repo's dependency batch issue
  // already carrying the trigger label. Opt-in per repo, default OFF — owner
  // decision 2026-09-29 covers slashbin.io repos only. A repo without it files
  // the batch unapproved, as before, and nothing builds until a human approves.
  dependencyPreApproved: z.boolean().optional(),
});

export const configSchema = z.object({
  // Single-repo fields (backward compat — ignored when repos[] is provided)
  repoPath: z.string().default("."),
  githubRepo: z.string().optional(),
  triggerLabel: z.string().default("approved"),
  baseBranch: z.string().default("develop"),
  productionBranch: z.string().default("main"),
  featureBranch: z.string().default("features"),
  skillPath: z.string().optional(),
  revisionSkillPath: z.string().optional(),
  skillOverlayPath: z.string().optional(),
  revisionSkillOverlayPath: z.string().optional(),
  prompt: z.string().optional(),

  // Multi-repo
  repos: z.array(repoEntrySchema).optional(),

  // Global settings
  pollIntervalMs: z.coerce.number().int().positive().default(300_000),
  // How many repos may run their pipeline at the same time. Repos are safe to
  // run concurrently on their own — each has its own git working clone, so two
  // can never touch the same checkout — so this cap is about SPEND, not safety:
  // each concurrent repo means another Claude session (up to maxTurns) and
  // another stream of GitHub API calls. Default 3; raise it deliberately after
  // watching what it costs. Set to 1 for the original strictly-serial behaviour.
  maxConcurrentRepos: z.coerce.number().int().positive().default(3),
  // Base window for the escalating per-issue skip back-off. The Nth consecutive
  // skip of an issue waits skipBackoffMs * 2^(N-1), capped at SKIP_BACKOFF_MAX_MS.
  // Additive + OSS-safe: defaults to the historical fixed 30 min, so an existing
  // .ai-agent.json keeps working with no new key (the first window is unchanged;
  // only repeat skips of the SAME issue back off further). slashbin-ai-foreman#32.
  skipBackoffMs: z.coerce.number().int().positive().default(1_800_000),
  // Daemon-wide back-off when an upstream (GitHub rate limit, Claude session
  // limit) refuses work: the Nth consecutive window is base * 2^(N-1), capped.
  // See src/upstream-backoff.ts. Additive: defaults 2 min base, 60 min cap.
  upstreamBackoffBaseMs: z.coerce.number().int().positive().default(120_000),
  upstreamBackoffCapMs: z.coerce.number().int().positive().default(3_600_000),
  // How long a repo's open-issue snapshot stays warm. The discovery phases each
  // used to run their own `gh issue list` against the same repo — six GraphQL
  // requests per repo per cycle, which at 20 repos on a 60s poll blew GitHub's
  // 5,000/hour GraphQL ceiling and left the token permanently exhausted. One
  // snapshot per repo per cycle serves all six. Must stay BELOW pollIntervalMs
  // so each cycle sees fresh data; the default is half the shipped 60s floor.
  // Set to 0 to disable caching and restore one live query per lookup.
  // Additive + OSS-safe: an existing .ai-agent.json needs no new key.
  issueCacheTtlMs: z.coerce.number().int().nonnegative().default(30_000),
  // Page cap for that snapshot. It must exceed a repo's OPEN issue count, which
  // is larger than any single label slice the old per-label queries fetched —
  // hence 500 rather than the previous 100. Truncation is logged, never silent.
  issueSnapshotLimit: z.coerce.number().int().positive().default(500),
  maxTurns: z.coerce.number().int().positive().default(30),
  maxDurationMs: z.coerce.number().int().positive().default(1_800_000),
  // Model for the implement/revise phases, cascading to every repo that does not
  // set its own. Omit to let the Claude CLI pick its default. Global because the
  // model is a spend/quality dial for the whole fleet, not a per-repo trait —
  // without the cascade the only way to move the fleet is to edit all 20 entries.
  model: z.string().optional(),
  allowedTools: z.array(z.string()).default(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]),
  // MCP client config handed to implement/revise sessions (`--mcp-config`), so a
  // builder can check its assumptions against real data before it builds instead
  // of learning them at review. Every server in it is added to the builder's
  // allowed tools — so put READ-ONLY servers in it and nothing else. Optional and
  // inert when unset or when the file does not exist. Additive + OSS-safe.
  builderMcpConfig: z.string().optional(),
  // Env var names a Claude session inherits from the daemon, on top of the
  // essentials every session gets (SESSION_ENV_ESSENTIALS in agent.ts). Nothing
  // else from the daemon's env reaches a session: the production daemon runs
  // under `doppler run`, and on 2026-10-01 a session that listed its env printed
  // FOREMAN_GITHUB_TOKEN into its transcript. Allowlist, not denylist — a suffix
  // denylist misses names like SYSTEM_SUDO_PW and WORKER_POSTGRES_URL. One list
  // for the fleet, never per repo. May not name a GitHub token (see loadConfig).
  sessionEnv: z.array(z.string()).default([]),
  logFormat: z.enum(["json", "text"]).default("text"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // --- Review phase (Phase 1 in the cycle) ---
  // Additive + OSS-safe: reviewEnabled defaults to false, so a vanilla
  // .ai-agent.json keeps the original reconcile/revise/implement/sync/promote
  // behavior with no review step. We opt in via our own .ai-agent.json.
  //
  // The review phase invokes a review skill in a headless Claude session under
  // the EM GitHub token (reviewer attribution). emRepoPath is optional: when set,
  // the session's cwd is that repo (NOT the service repo) so it has the
  // reviewer's MCP servers, npm scripts, and context/docs; when unset, the cwd is
  // the repo's managed review checkout (see reviewSessionCwd in agent.ts).
  emRepoPath: z.string().optional(),
  // The Tech Lead (xrgarcia/slashbin_ai_tech_lead, EM#427): when set, each
  // review is offered to it FIRST — Codex judges, its code posts and merges.
  // It exits 3 when Codex cannot take the review and nothing was written; the
  // review phase then runs the Claude /review-all-prs session exactly as
  // before. Unset = the Claude path only, unchanged. Additive + OSS-safe.
  techLeadPath: z.string().optional(),
  // The SRE (xrgarcia/slashbin_ai_sre, EM#440/#441): when set, review ends at
  // the merge (issue → lifecycleLabels.prMerged) and the `verify` stage runs
  // `bin/sre.mjs verify` for each merged PR, moving its issues to prApproved.
  // Unset = no verify stage: the review run verifies and labels as before.
  srePath: z.string().optional(),
  reviewEnabled: z.boolean().default(false),
  // The review skill. No default: a review-enabled repo must get one from here
  // or its own entry, or loadConfig refuses to start. A relative path resolves
  // against the review session's cwd — emRepoPath when set, else the repo's
  // review checkout — exactly as the session itself would read it
  // (resolveReviewSkillPath in agent.ts). Per-repo override supported.
  reviewSkillPath: z.string().optional(),
  reviewModel: z.string().optional(),
  // Where the review session finds the service repo's code.
  //
  // The session's cwd is the EM repo, so it does NOT have the code it is
  // reviewing, and nothing ever told it where to get it. Left to improvise,
  // every run `git clone`d into /tmp under a name it invented (sbc1006, js520,
  // jerky_shipping_rev, cli-review-2 …) and never removed it. /tmp here is a
  // tmpfs with a HARD CAP of 1,048,576 inodes; a review clone plus its
  // node_modules is 40k-95k of them, and 140 such clones exhausted the cap on
  // 2026-09-12 — at 84% of BYTES, so every `df -h` looked healthy. Once inodes
  // are gone no agent can run at all, because Claude Code creates an output
  // file before each command; two Foreman runs failed that morning purely
  // because their sessions could not write.
  //
  // So: one managed checkout per repo, on the root filesystem (66M inodes)
  // rather than the tmpfs, at a path the Foreman owns and can therefore also
  // delete. Reused across cycles — the expensive part is node_modules, not the
  // clone — and removed when the repo's queue empties (see releaseReviewCheckout).
  reviewCheckoutRoot: z.string().default("~/.foreman/review-checkouts"),
  // The review skill is long-running (it polls Railway deploys during dev verify),
  // so it gets a much larger turn/duration budget than implement/revise.
  reviewMaxTurns: z.coerce.number().int().positive().default(200),
  reviewMaxDurationMs: z.coerce.number().int().positive().default(3_600_000),
  // After a review run, set the issue's outcome label from the run's own
  // FOREMAN_REVIEW trailer when the skill merged the PR but left the issue at
  // `pr under review`. Defaults to true.
  //
  // Default-on is safe for existing deployments because the reconciler is a
  // REPAIR, not a policy: it only writes when the expected label is absent, only
  // for an issue a merged PR provably closed, and only to the label the run
  // itself reported. A skill that labels correctly never reaches the write — the
  // behavior of a healthy pipeline is bit-for-bit unchanged. Set false to keep
  // the label a strictly agent-owned act.
  //
  // NOT z.coerce.boolean(): env vars arrive as strings and Boolean("false") is
  // true, so coercion would silently ignore the one value anyone disabling this
  // would actually type.
  reviewLabelReconcile: z.preprocess(
    (v) => (typeof v === "string" ? !/^(0|false|no|off)$/i.test(v.trim()) : v),
    z.boolean(),
  ).default(true),
  // Broad tool surface — the skill drives GitHub, Postgres, Redis, Railway, and
  // the knowledge index via MCP, plus shell scripts and file reads.
  reviewAllowedTools: z.array(z.string()).default([
    "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch",
    "mcp__github__*",
    "mcp__pg-dev-console__*", "mcp__pg-dev-worker__*",
    "mcp__pg-prod-console__*", "mcp__pg-prod-worker__*",
    "mcp__redis-dev-console__*", "mcp__redis-dev-ingest__*", "mcp__redis-dev-worker__*",
    "mcp__redis-prod-console__*", "mcp__redis-prod-ingest__*", "mcp__redis-prod-worker__*",
    "mcp__railway__*",
    "mcp__slashbin-ai-knowledge__*",
  ]),
  // GitHub login the review runs as — used by the freshness guard to detect a
  // review already posted for the current PR head (avoids re-review loops).
  // No default. Unset, the guard counts a verdict by ANY reviewer as current,
  // so a missing login can suppress a review but never loop one. Per-repo
  // override supported.
  reviewerLogin: z.string().optional(),

  // prefault, not default: zod 4 returns a `default` value without parsing it, so
  // an omitted block would arrive as {} with none of the five names filled in.
  lifecycleLabels: lifecycleLabelsSchema.prefault({}),

  // The stages a repo pass runs, in order (see src/stages.ts). Omitted, it is the
  // eight built-ins in today's order, so an existing .ai-agent.json runs exactly
  // as before. A custom stage is `{ id, skillPath }`: one Claude session on that
  // skill when the pass reaches it. Global, never per repo — the stages hand
  // work to each other by label, one pipeline for the fleet.
  stages: stagesSchema,

  // Paperclip mirror (see paperclipConfigSchema). Global, never per repo: one
  // Foreman is one Paperclip agent. prefault for the same reason as above.
  paperclip: paperclipConfigSchema.prefault({}),
});

// --- Types ---

/** One lifecycle stage's place on the board: who holds the card, its status, its stage label. */
export type PaperclipBoardStage = PaperclipConfig["board"][PaperclipStage];

/**
 * The board mapping and stage labels a config that omits them resolves to: the
 * Foreman holds every card. Exported for callers that hold a partial config
 * object rather than a loaded one, and for the generated docs.
 */
export function paperclipBoardDefaults(): Pick<PaperclipConfig, "board" | "stageLabels" | "roles"> {
  return Object.freeze({ board: boardStagesSchema.parse({}), stageLabels: stageLabelsSchema.parse({}), roles: {} });
}

/** Configured names of the five lifecycle labels. See `lifecycleLabelsSchema`. */
export type LifecycleLabels = Readonly<z.infer<typeof lifecycleLabelsSchema>>;

/** The resolved `paperclip` block. `enabled: false` means the daemon never calls Paperclip. */
export type PaperclipConfig = Readonly<z.infer<typeof paperclipConfigSchema>>;

/**
 * The lifecycle labels a config that omits `lifecycleLabels` resolves to. Built
 * from the schema, so it cannot drift from the defaults `loadConfig` applies.
 */
export function defaultLifecycleLabels(): LifecycleLabels {
  return Object.freeze(lifecycleLabelsSchema.parse({}));
}

/**
 * Fully resolved per-repo config. Contains both repo-specific settings and
 * global settings, so downstream functions only need this one type.
 * This is also the unit of work — one daemon per repo just uses one RepoConfig.
 */
export interface RepoConfig {
  name: string;
  repoPath: string;
  githubRepo: string;
  triggerLabel: string;
  baseBranch: string;
  /** Branch promotion PRs target; sync PRs merge it back into baseBranch. */
  productionBranch: string;
  featureBranch: string;
  /** Repo-relative skill path, or "builtin:" for the skill shipped in skills/. */
  skillPath?: string;
  revisionSkillPath?: string;
  /** Repo-relative file appended to the implement prompt after the skill. */
  skillOverlayPath?: string;
  /** Repo-relative file appended to the revise prompt after the skill. */
  revisionSkillOverlayPath?: string;
  prompt?: string;
  model?: string;
  maxTurns: number;
  maxDurationMs: number;
  allowedTools: string[];
  /** Absolute path of the builder MCP config, when one is configured. */
  builderMcpConfig?: string;
  /** Daemon env names a session inherits on top of the essentials — the global value. */
  sessionEnv: string[];
  // Whether the review phase runs for this repo (resolved from per-repo override
  // or the global reviewEnabled default).
  reviewEnabled: boolean;
  /** Review skill as configured (per-repo, else global). Required when reviewEnabled. */
  reviewSkillPath?: string;
  /** Reviewer login for the freshness guard (per-repo, else global). */
  reviewerLogin?: string;
  // File the dependency batch issue pre-approved. Per-repo opt-in, default false.
  dependencyPreApproved: boolean;
  /** The fleet-wide lifecycle labels — the global value, never a per-repo one. */
  lifecycleLabels: LifecycleLabels;
}

/**
 * Top-level daemon config. Contains resolved repos and daemon-level settings.
 * Use `config.repos[i]` to get the RepoConfig for each repo.
 */
export interface AgentConfig {
  repos: readonly RepoConfig[];
  pollIntervalMs: number;
  /** Max repos running their pipeline at once (default 3). Caps spend, not risk. */
  maxConcurrentRepos: number;
  /** Base window for the escalating per-issue skip back-off (default 30 min). */
  skipBackoffMs: number;
  /** First window of the daemon-wide upstream-limit back-off (default 2 min). */
  upstreamBackoffBaseMs: number;
  /** Ceiling for the upstream-limit back-off window (default 60 min). */
  upstreamBackoffCapMs: number;
  /** How long a repo's open-issue snapshot stays warm (default 30s; 0 disables). */
  issueCacheTtlMs: number;
  /** Page cap for the open-issue snapshot (default 500). */
  issueSnapshotLimit: number;
  logFormat: "json" | "text";
  logLevel: "debug" | "info" | "warn" | "error";
  /** Daemon env names a session inherits on top of the essentials (see configSchema). */
  sessionEnv: string[];

  // --- Review phase settings (shared across repos) ---
  // emRepoPath is the absolute path to the review repo used as the review
  // session's cwd. Optional even with review enabled — see reviewSessionCwd.
  emRepoPath?: string;
  /** Absolute path to the Tech Lead checkout; undefined = Claude review only. */
  techLeadPath?: string;
  srePath?: string;
  /** Global review skill; repos read their resolved `RepoConfig.reviewSkillPath`. */
  reviewSkillPath?: string;
  reviewModel?: string;
  reviewCheckoutRoot: string;
  reviewMaxTurns: number;
  reviewMaxDurationMs: number;
  reviewAllowedTools: string[];
  /** Global reviewer login; repos read their resolved `RepoConfig.reviewerLogin`. */
  reviewerLogin?: string;
  reviewLabelReconcile: boolean;
  lifecycleLabels: LifecycleLabels;
  /** The stages each repo pass runs, in order. Defaults to the eight built-ins. */
  stages: readonly StageEntry[];
  /** Paperclip mirror settings. Always present; `enabled` is false unless opted in. */
  paperclip: PaperclipConfig;
}

// --- Helpers ---

/**
 * Names `sessionEnv` may not carry: the four `gh` reads a token from, and the
 * Foreman's, EM's, Tech Lead's and SRE's own. A session's token is assigned, never inherited.
 */
const SESSION_ENV_FORBIDDEN: readonly string[] = [
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
  "FOREMAN_GITHUB_TOKEN", "EM_GITHUB_TOKEN", "TECHLEAD_GITHUB_KEY", "SRE_GITHUB_KEY",
];

function inferGithubRepo(repoPath: string): string | undefined {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: resolve(repoPath),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function loadConfigFile(configPath?: string): Record<string, unknown> {
  const paths = configPath
    ? [resolve(configPath)]
    : [resolve(".ai-agent.json"), resolve("ai-agent.config.json")];

  for (const p of paths) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    }
  }
  return {};
}

/**
 * The `paperclip` block with its AI_AGENT_PAPERCLIP_* overrides applied, one env
 * var per leaf. `statusMap` has none. Undefined when neither the file nor the
 * env sets anything, so the schema's prefault applies. A file value that is not
 * an object is passed through untouched for the schema to reject.
 */
function mergePaperclip(fromFile: unknown): unknown {
  const env = Object.fromEntries(Object.entries({
    enabled: process.env.AI_AGENT_PAPERCLIP_ENABLED,
    url: process.env.AI_AGENT_PAPERCLIP_URL,
    companyId: process.env.AI_AGENT_PAPERCLIP_COMPANY_ID,
    agentName: process.env.AI_AGENT_PAPERCLIP_AGENT_NAME,
    agentId: process.env.AI_AGENT_PAPERCLIP_AGENT_ID,
    apiKey: process.env.AI_AGENT_PAPERCLIP_API_KEY,
    identityKeyFormat: process.env.AI_AGENT_PAPERCLIP_IDENTITY_KEY_FORMAT,
  }).filter(([, v]) => v !== undefined));
  if (Object.keys(env).length === 0) return fromFile;
  if (fromFile === undefined) return env;
  if (typeof fromFile !== "object" || fromFile === null || Array.isArray(fromFile)) return fromFile;
  return { ...fromFile, ...env };
}

// --- Config Loading ---

export function loadConfig(configPath?: string): AgentConfig {
  const fileConfig = loadConfigFile(configPath);

  const merged = {
    repoPath: process.env.AI_AGENT_REPO_PATH ?? fileConfig.repoPath,
    githubRepo: process.env.AI_AGENT_GITHUB_REPO ?? fileConfig.githubRepo,
    triggerLabel: process.env.AI_AGENT_TRIGGER_LABEL ?? fileConfig.triggerLabel,
    pollIntervalMs: process.env.AI_AGENT_POLL_INTERVAL_MS ?? fileConfig.pollIntervalMs,
    maxConcurrentRepos: process.env.AI_AGENT_MAX_CONCURRENT_REPOS ?? fileConfig.maxConcurrentRepos,
    skipBackoffMs: process.env.AI_AGENT_SKIP_BACKOFF_MS ?? fileConfig.skipBackoffMs,
    upstreamBackoffBaseMs: process.env.AI_AGENT_UPSTREAM_BACKOFF_BASE_MS ?? fileConfig.upstreamBackoffBaseMs,
    upstreamBackoffCapMs: process.env.AI_AGENT_UPSTREAM_BACKOFF_CAP_MS ?? fileConfig.upstreamBackoffCapMs,
    issueCacheTtlMs: process.env.AI_AGENT_ISSUE_CACHE_TTL_MS ?? fileConfig.issueCacheTtlMs,
    issueSnapshotLimit: process.env.AI_AGENT_ISSUE_SNAPSHOT_LIMIT ?? fileConfig.issueSnapshotLimit,
    skillPath: process.env.AI_AGENT_SKILL_PATH ?? fileConfig.skillPath,
    revisionSkillPath: fileConfig.revisionSkillPath,
    skillOverlayPath: fileConfig.skillOverlayPath,
    revisionSkillOverlayPath: fileConfig.revisionSkillOverlayPath,
    prompt: process.env.AI_AGENT_PROMPT ?? fileConfig.prompt,
    baseBranch: process.env.AI_AGENT_BASE_BRANCH ?? fileConfig.baseBranch,
    productionBranch: process.env.AI_AGENT_PRODUCTION_BRANCH ?? fileConfig.productionBranch,
    featureBranch: process.env.AI_AGENT_FEATURE_BRANCH ?? fileConfig.featureBranch,
    maxTurns: process.env.AI_AGENT_MAX_TURNS ?? fileConfig.maxTurns,
    maxDurationMs: process.env.AI_AGENT_MAX_DURATION_MS ?? fileConfig.maxDurationMs,
    model: process.env.AI_AGENT_MODEL ?? fileConfig.model,
    allowedTools: fileConfig.allowedTools,
    builderMcpConfig: process.env.AI_AGENT_BUILDER_MCP_CONFIG ?? fileConfig.builderMcpConfig,
    sessionEnv: fileConfig.sessionEnv,
    logFormat: process.env.AI_AGENT_LOG_FORMAT ?? fileConfig.logFormat,
    logLevel: process.env.AI_AGENT_LOG_LEVEL ?? fileConfig.logLevel,
    repos: fileConfig.repos,
    // Review phase
    emRepoPath: process.env.AI_AGENT_EM_REPO_PATH ?? fileConfig.emRepoPath,
    techLeadPath: process.env.AI_AGENT_TECH_LEAD_PATH ?? fileConfig.techLeadPath,
    srePath: process.env.AI_AGENT_SRE_PATH ?? fileConfig.srePath,
    reviewEnabled: fileConfig.reviewEnabled,
    reviewSkillPath: fileConfig.reviewSkillPath,
    reviewModel: fileConfig.reviewModel,
    reviewCheckoutRoot: process.env.AI_AGENT_REVIEW_CHECKOUT_ROOT ?? fileConfig.reviewCheckoutRoot,
    reviewMaxTurns: process.env.AI_AGENT_REVIEW_MAX_TURNS ?? fileConfig.reviewMaxTurns,
    reviewMaxDurationMs: process.env.AI_AGENT_REVIEW_MAX_DURATION_MS ?? fileConfig.reviewMaxDurationMs,
    reviewAllowedTools: fileConfig.reviewAllowedTools,
    reviewerLogin: fileConfig.reviewerLogin,
    reviewLabelReconcile: process.env.AI_AGENT_REVIEW_LABEL_RECONCILE ?? fileConfig.reviewLabelReconcile,
    lifecycleLabels: fileConfig.lifecycleLabels,
    stages: fileConfig.stages,
    paperclip: mergePaperclip(fileConfig.paperclip),
  };

  // Remove undefined keys so Zod defaults apply
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined)
  );

  const parsed = configSchema.parse(cleaned);

  // A session gets exactly one GitHub token, as GH_TOKEN, chosen by phase. A
  // token name in sessionEnv would hand it a second one (or, for the names `gh`
  // reads, outrank the one assigned), which is the leak this list exists to stop.
  for (const name of parsed.sessionEnv) {
    if (SESSION_ENV_FORBIDDEN.includes(name)) {
      throw new Error(`sessionEnv must not name a GitHub token: "${name}"`);
    }
  }

  // Global settings shared by all repos (used as fallback when a per-repo entry
  // doesn't specify its own value)
  const lifecycleLabels: LifecycleLabels = Object.freeze({ ...parsed.lifecycleLabels });
  const globals = {
    allowedTools: [...parsed.allowedTools],
    builderMcpConfig: parsed.builderMcpConfig ? resolve(parsed.builderMcpConfig) : undefined,
    sessionEnv: [...parsed.sessionEnv],
    lifecycleLabels,
  };

  let repos: RepoConfig[];

  if (parsed.repos && parsed.repos.length > 0) {
    // Multi-repo mode
    repos = parsed.repos.map((entry) => {
      const repoPath = resolve(entry.repoPath);
      let githubRepo = entry.githubRepo;
      if (!githubRepo) {
        githubRepo = inferGithubRepo(repoPath);
        if (!githubRepo) {
          throw new Error(
            `githubRepo could not be inferred for repo "${entry.name}". Set it explicitly.`
          );
        }
      }
      return {
        name: entry.name,
        repoPath,
        githubRepo,
        triggerLabel: entry.triggerLabel ?? parsed.triggerLabel,
        baseBranch: entry.baseBranch ?? parsed.baseBranch,
        productionBranch: entry.productionBranch ?? parsed.productionBranch,
        featureBranch: entry.featureBranch ?? parsed.featureBranch,
        skillPath: entry.skillPath,
        revisionSkillPath: entry.revisionSkillPath,
        skillOverlayPath: entry.skillOverlayPath,
        revisionSkillOverlayPath: entry.revisionSkillOverlayPath,
        prompt: entry.prompt,
        model: entry.model ?? parsed.model,
        maxTurns: entry.maxTurns ?? parsed.maxTurns,
        maxDurationMs: entry.maxDurationMs ?? parsed.maxDurationMs,
        reviewEnabled: entry.reviewEnabled ?? parsed.reviewEnabled,
        reviewSkillPath: entry.reviewSkillPath ?? parsed.reviewSkillPath,
        reviewerLogin: entry.reviewerLogin ?? parsed.reviewerLogin,
        dependencyPreApproved: entry.dependencyPreApproved ?? false,
        ...globals,
      };
    });
  } else {
    // Single-repo mode (backward compat)
    const repoPath = resolve(parsed.repoPath);
    let githubRepo = parsed.githubRepo;
    if (!githubRepo) {
      githubRepo = inferGithubRepo(repoPath);
      if (!githubRepo) {
        throw new Error(
          "githubRepo could not be inferred from git remote. Set AI_AGENT_GITHUB_REPO or githubRepo in config."
        );
      }
    }
    repos = [{
      name: githubRepo.split("/").pop()!,
      repoPath,
      githubRepo,
      triggerLabel: parsed.triggerLabel,
      baseBranch: parsed.baseBranch,
      productionBranch: parsed.productionBranch,
      featureBranch: parsed.featureBranch,
      skillPath: parsed.skillPath,
      revisionSkillPath: parsed.revisionSkillPath,
      skillOverlayPath: parsed.skillOverlayPath,
      revisionSkillOverlayPath: parsed.revisionSkillOverlayPath,
      prompt: parsed.prompt,
      model: parsed.model,
      maxTurns: parsed.maxTurns,
      maxDurationMs: parsed.maxDurationMs,
      reviewEnabled: parsed.reviewEnabled,
      reviewSkillPath: parsed.reviewSkillPath,
      reviewerLogin: parsed.reviewerLogin,
      dependencyPreApproved: false,
      ...globals,
    }];
  }

  // Resolve emRepoPath to absolute once (used by the review phase as the spawn cwd).
  const emRepoPath = parsed.emRepoPath ? resolve(parsed.emRepoPath) : undefined;

  // Fail fast on misconfiguration: review enabled for a repo with no skill to run.
  // Only when the review stage is configured at all — without it `reviewEnabled`
  // selects nothing, so there is no session to need a skill.
  const stages: readonly StageEntry[] = Object.freeze(parsed.stages.map((s) => Object.freeze({ ...s })));
  const unskilled = hasStage(stages, "review") ? repos.filter((r) => r.reviewEnabled && !r.reviewSkillPath) : [];
  if (unskilled.length > 0) {
    throw new Error(
      `reviewEnabled is true for repo(s) ${unskilled.map((r) => `"${r.name}"`).join(", ")} but no reviewSkillPath is set for them. ` +
      "Set reviewSkillPath globally or per repo."
    );
  }

  // Fail fast on a label that means two things. The phases tell work apart by
  // label alone, so two lifecycle states sharing a name are one state, and a
  // trigger label that is also a lifecycle label excludes every issue it selects.
  const names = Object.values(lifecycleLabels);
  if (new Set(names).size !== names.length) {
    throw new Error(`lifecycleLabels must be distinct names; got ${JSON.stringify(lifecycleLabels)}`);
  }
  for (const r of repos) {
    if (names.includes(r.triggerLabel)) {
      throw new Error(
        `triggerLabel "${r.triggerLabel}" for repo "${r.name}" is also a lifecycle label — ` +
        "an issue carrying it would be selected and excluded at once, so nothing would ever build.",
      );
    }
  }

  // Fail fast on a mirror with nowhere to write: every Paperclip route the
  // Foreman uses is scoped to one company.
  if (parsed.paperclip.enabled && !parsed.paperclip.companyId) {
    throw new Error("paperclip.enabled is true but no paperclip.companyId is set.");
  }
  // Every stage must name a role that exists and a label that exists, or a card
  // would be handed to nobody, silently.
  const pc = parsed.paperclip;
  const roleKeys = new Set([PAPERCLIP_FOREMAN_ROLE, ...Object.keys(pc.roles)]);
  for (const [name, st] of Object.entries(pc.board)) {
    if (!roleKeys.has(st.owner)) throw new Error(`paperclip.board.${name}.owner "${st.owner}" is not "${PAPERCLIP_FOREMAN_ROLE}" or a key of paperclip.roles.`);
    if (st.label !== null && !(st.label in pc.stageLabels)) throw new Error(`paperclip.board.${name}.label "${st.label}" is not a key of paperclip.stageLabels.`);
  }
  for (const [key, role] of [...Object.entries(pc.roles), ["agentReportsTo", { reportsTo: pc.agentReportsTo }] as const]) {
    if (role.reportsTo !== undefined && !roleKeys.has(role.reportsTo)) throw new Error(`paperclip ${key}: reportsTo "${role.reportsTo}" is not "${PAPERCLIP_FOREMAN_ROLE}" or a key of paperclip.roles.`);
  }
  const paperclip: PaperclipConfig = Object.freeze({
    ...parsed.paperclip,
    ...(parsed.paperclip.statusMap ? { statusMap: Object.freeze({ ...parsed.paperclip.statusMap }) } : {}),
  });

  return Object.freeze({
    repos: Object.freeze(repos),
    pollIntervalMs: parsed.pollIntervalMs,
    maxConcurrentRepos: parsed.maxConcurrentRepos,
    skipBackoffMs: parsed.skipBackoffMs,
    upstreamBackoffBaseMs: parsed.upstreamBackoffBaseMs,
    upstreamBackoffCapMs: parsed.upstreamBackoffCapMs,
    issueCacheTtlMs: parsed.issueCacheTtlMs,
    issueSnapshotLimit: parsed.issueSnapshotLimit,
    logFormat: parsed.logFormat,
    logLevel: parsed.logLevel,
    sessionEnv: [...parsed.sessionEnv],
    emRepoPath,
    techLeadPath: parsed.techLeadPath ? resolve(parsed.techLeadPath.replace(/^~(?=$|\/)/, homedir())) : undefined,
    srePath: parsed.srePath ? resolve(parsed.srePath.replace(/^~(?=$|\/)/, homedir())) : undefined,
    reviewSkillPath: parsed.reviewSkillPath,
    reviewModel: parsed.reviewModel,
    reviewCheckoutRoot: parsed.reviewCheckoutRoot.replace(/^~(?=$|\/)/, homedir()),
    reviewMaxTurns: parsed.reviewMaxTurns,
    reviewMaxDurationMs: parsed.reviewMaxDurationMs,
    reviewAllowedTools: [...parsed.reviewAllowedTools],
    reviewerLogin: parsed.reviewerLogin,
    reviewLabelReconcile: parsed.reviewLabelReconcile,
    lifecycleLabels,
    stages,
    paperclip,
  });
}
