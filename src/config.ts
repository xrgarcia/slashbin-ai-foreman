import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { stagesSchema, hasStage, type StageEntry } from "./stages.js";
import {
  paperclipConfigSchema, mergePaperclip, resolvePaperclipConfig, type PaperclipConfig,
} from "./paperclip/config.js";
import { githubConventionsSchema, freezeGithubConventions, type GithubConventions } from "./github/conventions.js";
import { backoffConfigSchema, mergeBackoff, type BackoffConfig } from "./backoff.js";
import { skillSyncConfigSchema, mergeSkillSync, resolveSkillSync, type SkillSyncConfig } from "./skill-sync.js";

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
  // Merged and verified in dev; awaiting EM verification. The name stays
  // `pr approved` because the human lanes write it too.
  prApproved: z.string().min(1).default("pr approved"),
  // The EM's release authorization, applied after EM verification — the one
  // lifecycle label the Foreman never applies on its own judgement; it only
  // puts back one a review run removed (restoreEmGate). The promote stage
  // moves it to releasePending once a release PR carries the issue.
  readyForProd: z.string().min(1).default("ready for prod release"),
  // In a release PR the Foreman owns: the release stage has the Tech Lead
  // approve it and the SRE merge, deploy and verify it in production. Replaces
  // readyForProd when the promote stage opens or updates the release PR.
  releasePending: z.string().min(1).default("release pending"),
  // Deployed, but the SRE's prod verification held or failed. The issue stays
  // open (reopened if GitHub's keywords closed it at the merge) and the release
  // stage re-verifies it on the prodVerifyRetry back-off; a pass closes it.
  prodVerifyHeld: z.string().min(1).default("prod verification held"),
  // Promoted; awaiting the close. Read here only to keep such issues out of the
  // actionable set.
  readyToClose: z.string().min(1).default("ready to close"),
});


const repoEntrySchema = z.object({
  // The repo's short name: in logs, state, notifications and `--repo <name>`.
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
  // The skills this repo's copy follows when skillSync is on, in place of
  // skillSync.skills. [] opts the repo out of skill sync.
  skillSyncSkills: z.array(z.string()).optional(),
});

export const configSchema = z.object({
  // --- The repo ---
  // Single-repo mode sets these at the top level. With repos[], each entry sets
  // its own; the ones marked "falls back" use the top-level value when an entry
  // leaves them out, the rest apply only to the entry that sets them.

  // Path to the repo's local clone. Single-repo mode only; ignored when repos[] is set.
  repoPath: z.string().default("."),
  // GitHub `owner/repo`. Omitted, it is read from the clone's git remote.
  githubRepo: z.string().optional(),
  // The label that authorizes an issue to be built. Applying it starts the build.
  triggerLabel: z.string().default("approved"),
  // The branch feature PRs target, where review merges.
  baseBranch: z.string().default("develop"),
  // The branch promotion PRs target; branch sync merges it back into baseBranch.
  productionBranch: z.string().default("main"),
  // The branch implement and revise sessions commit to.
  featureBranch: z.string().default("features"),
  // The implement skill: a repo-relative SKILL.md, or "builtin:" for skills/implement/.
  skillPath: z.string().optional(),
  // The revise skill: a repo-relative SKILL.md, or "builtin:" for skills/revise/.
  revisionSkillPath: z.string().optional(),
  // A repo-relative file appended to the implement prompt after the skill.
  // Configured but unreadable, the session is not started.
  skillOverlayPath: z.string().optional(),
  // The same, for the revise prompt.
  revisionSkillOverlayPath: z.string().optional(),
  // A full custom prompt template in place of the built-in one (docs/skills.md "Prompt
  // template variables"). The Foreman adds nothing to it.
  prompt: z.string().optional(),

  // --- Multi-repo ---

  // One entry per repo: `{ name, repoPath, ... }` plus any key marked per repo.
  // When set, the top-level repoPath is ignored.
  repos: z.array(repoEntrySchema).optional(),

  // --- Global settings ---

  // How often a poll cycle starts.
  pollIntervalMs: z.coerce.number().int().positive().default(300_000),
  // RETIRED, ignored. It capped how many repos ran their serial pass at once;
  // concurrency is now one loop per (repo, lane) — see src/lanes.ts — so there is
  // no whole-repo pass left to cap. A config that still sets it loads, with a
  // startup warning naming `maxConcurrentSessions`.
  maxConcurrentRepos: z.coerce.number().int().positive().optional(),
  // Optional fleet-wide ceiling on session stages running at once (review,
  // verify, revise, implement, release, custom). 0 = no ceiling, the default:
  // the lanes already bound the work at one item per repo per lane (see
  // [pipeline.md → Lanes](pipeline.md#lanes-stages-run-side-by-side)). Set it
  // only if the host cannot carry every busy lane's session at once. A stage
  // takes its repo's checkout lock first and a slot second, so a stage queued on
  // a checkout never sits on a slot, and a slot holder never waits on anything —
  // a capped fleet cannot deadlock. Reloaded live.
  maxConcurrentSessions: z.coerce.number().int().nonnegative().default(0),
  // Mark every configured repo checkout, and every directory a session runs in,
  // as trusted in Claude Code's global config ($CLAUDE_CONFIG_DIR/.claude.json,
  // else ~/.claude.json). Without trust a headless session silently ignores the
  // repo's .claude/settings.json and .mcp.json. Listing a repo here is the consent;
  // set false to manage Claude Code trust yourself.
  // Env strings parsed as for reviewLabelReconcile: "false"/"0"/"no"/"off" turn it off.
  trustManagedRepos: z.preprocess(
    (v) => (typeof v === "string" ? !/^(0|false|no|off)$/i.test(v.trim()) : v),
    z.boolean(),
  ).default(true),
  // Onboard a repo before its first piece of work: on start-up and on every
  // repo a config reload adds, create the labels the Foreman runs on that the
  // repo is missing (the trigger label, every lifecycleLabels value and
  // github.blockedLabel — the set `npm run labels:install` creates). Read, then
  // create only; an existing label is never edited or deleted. No lane runs on
  // the repo until it succeeds; a failure is retried on the next pass. Set false
  // to manage the labels yourself.
  // Env strings parsed as for reviewLabelReconcile: "false"/"0"/"no"/"off" turn it off.
  onboarding: z.preprocess(
    (v) => (typeof v === "string" ? !/^(0|false|no|off)$/i.test(v.trim()) : v),
    z.boolean(),
  ).default(true),
  // How many approved issues one build claims. The Foreman picks them before
  // the session — priority tier (github.priorityLabels), then oldest — hands the
  // session only those, and claims only those; the rest stay queued (todo, on
  // the Foreman). Default 1: per repo, one issue is built at a time, as one is
  // reviewed and one deployed at a time. Raise it to let one session choose
  // among several and build one of them.
  buildBatchSize: z.coerce.number().int().positive().default(1),
  // Hold a repo's next build until its last merge has passed dev verification,
  // not just merged. One issue is in flight per repo, from build to verified on
  // dev, so a fix the verification calls for lands before the next issue is
  // built on top. A merge whose verification waits on a person (attempts spent)
  // or on a named time frees the repo. No effect without an SRE (srePath).
  // Env strings parsed as for reviewLabelReconcile: "false"/"0"/"no"/"off" turn it off.
  buildWaitsForDevVerify: z.preprocess(
    (v) => (typeof v === "string" ? !/^(0|false|no|off)$/i.test(v.trim()) : v),
    z.boolean(),
  ).default(true),
  // Every wait before the Foreman tries something again — declined issues,
  // failed verifications, an unavailable reviewer, failing repos, upstream
  // limits, gh retries — each exponential and tunable. See src/backoff.ts and
  // docs/configuration.md. The old top-level `skipBackoffMs`,
  // `upstreamBackoffBaseMs` and `upstreamBackoffCapMs` are still read into it.
  backoff: backoffConfigSchema,
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
  // Most turns an implement or revise session may take. Per repo too.
  maxTurns: z.coerce.number().int().positive().default(30),
  // Longest an implement or revise session may run before it is stopped. Per repo too.
  maxDurationMs: z.coerce.number().int().positive().default(3_600_000),
  // Model for the implement/revise phases, cascading to every repo that does not
  // set its own. Omit to let the Claude CLI pick its default. Global because the
  // model is a spend/quality dial for the whole fleet, not a per-repo trait —
  // without the cascade the only way to move the fleet is to edit all 20 entries.
  model: z.string().optional(),
  // The tools an implement or revise session may use.
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
  // Daemon log format.
  logFormat: z.enum(["json", "text"]).default("text"),
  // Daemon log level.
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // --- Review phase ---
  // Additive + OSS-safe: reviewEnabled defaults to false, so a vanilla
  // .ai-agent.json keeps the original reconcile/revise/implement/sync/promote
  // behavior with no review step. We opt in via our own .ai-agent.json.
  //
  // The review phase hands each PR to the Tech Lead (techLeadPath), which runs
  // under TECHLEAD_GITHUB_KEY (reviewer attribution).

  // The EM checkout. The unstick stage runs `bin/em.mjs unstick` here (cwd) for
  // stuck work, whether or not Paperclip is on; unset, that stage does nothing.
  // The handoff-contract reader (bin/read-handoff-contract.mjs) and the SRE's
  // spec mirror also read from it. Review no longer does: it runs through the
  // Tech Lead, never a Claude session in this directory.
  emRepoPath: z.string().optional(),
  // GitHub login @-mentioned when the EM cannot be reached for a stuck hold (foreman#105).
  unstickEscalationOwner: z.string().min(1).optional(),
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
  // The QA agent (xrgarcia/slashbin_ai_qa): when set, a PR the SRE's dev verify
  // passes in a `qaRepos` repo is also checked once by `bin/qa.mjs check`, and the
  // result is posted on the PR as "## QA Report (report-only)". It never gates:
  // the card moves to prApproved first and nothing waits on QA. Unset = no QA.
  // Needs `emRepoPath` (its doppler-run.mjs supplies DEV_SESSION_MINT_KEY).
  qaPath: z.string().optional(),
  // GitHub repos (owner/name) QA applies to. QA supports only the Console today.
  qaRepos: z.array(z.string()).default(["xrgarcia/Slashbin-console"]),
  // Whether QA gates delivery. false (default) = report-only: the card advances on the
  // SRE's pass and QA is posted after. true = QA runs BEFORE the advance: PASS advances,
  // FAIL (a regression) takes the visual-QA rework path, HELD or a crash holds the card
  // like an SRE hold. Needs `qaPath`. A config flip, reversible.
  qaGate: z.boolean().default(false),
  // The release stage's ceiling on one `sre.mjs deploy`: a pre-deploy Codex
  // run and a prod-verification Codex run of up to 40 min each, plus the merge
  // and the deploy wait. The Foreman kills the deploy only past this; a deploy
  // killed after its merge is finished on the next pass from the saved state.
  // Default 2 h.
  sreDeployMaxDurationMs: z.coerce.number().int().positive().default(7_200_000),
  // Run the review stage. Off by default; per repo too, where it wins.
  reviewEnabled: z.boolean().default(false),
  // No longer read: review runs through the Tech Lead (techLeadPath), which
  // carries its own review procedure. Accepted so an older config still loads.
  reviewSkillPath: z.string().optional(),
  // Model for review sessions, independent of `model`. Omit for the CLI default.
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
  // Longest a review session may run before it is stopped.
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

  // --- Pipeline ---

  // The names of the labels that carry a PR through its lifecycle (the block
  // below). Set any subset; the rest keep their defaults. (prefault, not
  // default: zod 4 returns a `default` value without parsing it, so an omitted
  // block would arrive as {} with none of the names filled in.)
  lifecycleLabels: lifecycleLabelsSchema.prefault({}),

  // The stages the Foreman runs (see src/stages.ts), grouped into lanes
  // (src/lanes.ts): revise+implement form the `build` lane, promote+release the
  // `release` lane, every other built-in a lane of its own, and each (repo, lane)
  // pair polls on its own loop. Order matters only inside a lane. Omitted, it is
  // the ten built-ins in order; `release` runs only when both srePath and
  // techLeadPath are set and is skipped with a startup warning otherwise. Listing
  // `release` explicitly without both is refused at startup. A custom stage is
  // `{ id, skillPath }`: one Claude session on that skill, in the lane of the
  // built-in listed after it (its own lane when last); a blocked verdict holds the
  // rest of that lane only. Global, never per repo — the stages hand work to each
  // other by label, one pipeline for the fleet.
  stages: stagesSchema,

  // The other GitHub names the Foreman reads and writes: the blocked label, the
  // priority labels, the dependency-PR branch prefixes, and the titles and
  // signature of the PRs and issues it files. Set any subset; each default is
  // what the Foreman always used. Global, like lifecycleLabels. See
  // [GitHub conventions](#github-conventions-github).
  github: githubConventionsSchema,

  // The optional Paperclip board mirror, off unless `enabled` (docs/paperclip.md).
  // Global, never per repo: one Foreman is one Paperclip agent. prefault for
  // the same reason as above.
  paperclip: paperclipConfigSchema.prefault({}),

  // Keep each repo's skill copies on a golden source, one approved issue at a
  // time, off unless `enabled` (docs/skill-sync.md). prefault for the same
  // reason as above.
  skillSync: skillSyncConfigSchema.prefault({}),

  // --- Dependabot ---
  // The Dependabot stage's selection. Global, like `github`. `securityOnly` (default
  // true) batches and lands only security updates: a Dependabot PR is one iff a
  // package it bumps has an OPEN Dependabot alert on the repo. Other version-update PRs
  // are left alone (not batched, merged or closed). When the alerts API cannot be read
  // (404 with alerts disabled, a network error) the cycle batches nothing. Set
  // `{ "securityOnly": false }` to batch every Dependabot PR.
  dependabot: z.object({
    // Batch and land only security updates: a Dependabot PR is one iff a package it
    // bumps has an OPEN Dependabot alert on the repo. Other version-update PRs are
    // left alone (not batched, merged or closed). When the alerts API cannot be read
    // (404 with alerts disabled, a network error) the cycle batches nothing. Set false
    // to batch every Dependabot PR, as before.
    securityOnly: z.boolean().default(true),
  }).prefault({}),
});

// --- Types ---

export interface DependabotConfig { readonly securityOnly: boolean }


/** Configured names of the lifecycle labels. See `lifecycleLabelsSchema`. */
export type LifecycleLabels = Readonly<z.infer<typeof lifecycleLabelsSchema>>;


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
  /** The fleet-wide Dependabot selection — the global value. */
  dependabot: DependabotConfig;
  /** This repo's own skill-sync list; undefined follows skillSync.skills, [] opts out. */
  skillSyncSkills?: readonly string[];
  /** The fleet-wide lifecycle labels — the global value, never a per-repo one. */
  lifecycleLabels: LifecycleLabels;
  /** The fleet-wide GitHub conventions (`github` block) — the global value. */
  github: GithubConventions;
}

/**
 * Top-level daemon config. Contains resolved repos and daemon-level settings.
 * Use `config.repos[i]` to get the RepoConfig for each repo.
 */
export interface AgentConfig {
  repos: readonly RepoConfig[];
  /**
   * Every configured repo, even when `--repo` narrowed `repos` to one. Set only
   * by the CLI's narrowing; absent means `repos` is the whole list. A hold on
   * another repo's issue is recorded under that repo's state, which needs its name.
   */
  allRepos?: readonly RepoConfig[];
  pollIntervalMs: number;
  /** Retired (lanes replaced it); kept only so the startup warning can name it. */
  maxConcurrentRepos?: number;
  /** Fleet-wide ceiling on concurrent session stages; 0 = none (default). */
  maxConcurrentSessions: number;
  /** Trust each managed checkout in Claude Code's global config (default true). */
  trustManagedRepos: boolean;
  /** Create a repo's missing labels before its first lane pass (onboarding.ts). */
  onboarding: boolean;
  /** Most approved issues one build claims and hands its session (default 1). */
  buildBatchSize: number;
  /** Hold a repo's next build until its last merge passes dev verification (default true). */
  buildWaitsForDevVerify: boolean;
  /** Every back-off and retry limit (see src/backoff.ts). */
  backoff: BackoffConfig;
  /** How long a repo's open-issue snapshot stays warm (default 30s; 0 disables). */
  issueCacheTtlMs: number;
  /** Page cap for the open-issue snapshot (default 500). */
  issueSnapshotLimit: number;
  logFormat: "json" | "text";
  logLevel: "debug" | "info" | "warn" | "error";
  /** Daemon env names a session inherits on top of the essentials (see configSchema). */
  sessionEnv: string[];

  // --- Review phase settings (shared across repos) ---
  // emRepoPath is the absolute path to the EM checkout (unstick stage's cwd).
  emRepoPath?: string;
  /** Login @-mentioned when the unstick stage gives up on a hold; default UNSTICK_ESCALATION_OWNER. */
  unstickEscalationOwner?: string;
  /** Absolute path to the Tech Lead checkout; undefined = Claude review only. */
  techLeadPath?: string;
  srePath?: string;
  /** Absolute path to the QA checkout; undefined = no QA report. */
  qaPath?: string;
  /** Repos QA applies to. */
  qaRepos: string[];
  /** QA gates the advance to prApproved (see configSchema). */
  qaGate: boolean;
  /** Ceiling on one SRE deploy run (the release stage). */
  sreDeployMaxDurationMs: number;
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
  github: GithubConventions;
  /** The stages each repo pass runs, in order. Defaults to the ten built-ins. */
  stages: readonly StageEntry[];
  /** Paperclip mirror settings. Always present; `enabled` is false unless opted in. */
  paperclip: PaperclipConfig;
  /** Skill sync settings. Always present; `enabled` is false unless opted in. */
  skillSync: SkillSyncConfig;
  /** The Dependabot stage's selection (`dependabot` block). */
  dependabot: DependabotConfig;
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

/** True when the release stage can run: it needs both the Tech Lead and the SRE. */
/**
 * The labels a repo must carry: its trigger, every lifecycle label, the blocked
 * label. The one selection rule — onboarding, `npm run labels:install` and
 * `npm run doctor` all read it from here.
 */
export function requiredLabels(repo: Pick<RepoConfig, "triggerLabel" | "lifecycleLabels" | "github">): string[] {
  return [...new Set([repo.triggerLabel, ...Object.values(repo.lifecycleLabels), repo.github.blockedLabel])];
}

/** True when the unstick stage can run: it calls the EM checkout's `bin/em.mjs`. Independent of `paperclip.enabled`. */
export function unstickStageReady(config: Pick<AgentConfig, "emRepoPath">): boolean {
  return Boolean(config.emRepoPath);
}

export function releaseStageReady(config: Pick<AgentConfig, "srePath" | "techLeadPath">): boolean {
  return Boolean(config.srePath && config.techLeadPath);
}

/**
 * The startup warning when the release stage is in the pipeline (the default
 * list carries it) but cannot run, so it is skipped every pass; null when it
 * runs or is not configured. An explicit `release` in `stages` without both
 * paths never gets here: loadConfig refuses it.
 */
export function releaseStageWarning(config: Pick<AgentConfig, "srePath" | "techLeadPath" | "stages">): string | null {
  if (!hasStage(config.stages, "release") || releaseStageReady(config)) return null;
  const missing = [!config.techLeadPath && "techLeadPath", !config.srePath && "srePath"].filter(Boolean).join(" and ");
  return `release stage skipped: ${missing} not set. Promote keeps its pre-release behaviour: it strips the ` +
    `authorization label when it lists an issue, and the release PR waits for a person to merge it and close its issues.`;
}

/** A config still setting the retired `maxConcurrentRepos` gets one startup line saying it does nothing now. */
export function concurrencyWarning(config: Pick<AgentConfig, "maxConcurrentRepos">): string | null {
  if (config.maxConcurrentRepos === undefined) return null;
  return `maxConcurrentRepos (${config.maxConcurrentRepos}) is ignored: every stage lane now runs one item per repo, ` +
    `all repos at once. Remove it; set maxConcurrentSessions to cap concurrent sessions instead.`;
}


/**
 * The config file `loadConfig` reads: `configPath` when given, else
 * `.ai-agent.json`, else `ai-agent.config.json`, in the working directory.
 * Undefined when none exists — `loadConfig` then runs on env and defaults alone.
 */
export function findConfigFile(configPath?: string): string | undefined {
  const paths = configPath
    ? [resolve(configPath)]
    : [resolve(".ai-agent.json"), resolve("ai-agent.config.json")];
  return paths.find((p) => existsSync(p));
}

function loadConfigFile(configPath?: string): Record<string, unknown> {
  const p = findConfigFile(configPath);
  return p ? (JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>) : {};
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
    maxConcurrentSessions: process.env.AI_AGENT_MAX_CONCURRENT_SESSIONS ?? fileConfig.maxConcurrentSessions,
    trustManagedRepos: process.env.AI_AGENT_TRUST_MANAGED_REPOS ?? fileConfig.trustManagedRepos,
    onboarding: process.env.AI_AGENT_ONBOARDING ?? fileConfig.onboarding,
    buildBatchSize: process.env.AI_AGENT_BUILD_BATCH_SIZE ?? fileConfig.buildBatchSize,
    buildWaitsForDevVerify: process.env.AI_AGENT_BUILD_WAITS_FOR_DEV_VERIFY ?? fileConfig.buildWaitsForDevVerify,
    backoff: mergeBackoff(fileConfig.backoff, {
      skipBackoffMs: fileConfig.skipBackoffMs,
      upstreamBackoffBaseMs: fileConfig.upstreamBackoffBaseMs,
      upstreamBackoffCapMs: fileConfig.upstreamBackoffCapMs,
    }, {
      skipBackoffMs: process.env.AI_AGENT_SKIP_BACKOFF_MS,
      upstreamBackoffBaseMs: process.env.AI_AGENT_UPSTREAM_BACKOFF_BASE_MS,
      upstreamBackoffCapMs: process.env.AI_AGENT_UPSTREAM_BACKOFF_CAP_MS,
    }),
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
    unstickEscalationOwner: process.env.AI_AGENT_UNSTICK_ESCALATION_OWNER ?? fileConfig.unstickEscalationOwner,
    techLeadPath: process.env.AI_AGENT_TECH_LEAD_PATH ?? fileConfig.techLeadPath,
    srePath: process.env.AI_AGENT_SRE_PATH ?? fileConfig.srePath,
    qaPath: process.env.AI_AGENT_QA_PATH ?? fileConfig.qaPath,
    qaRepos: fileConfig.qaRepos,
    qaGate: fileConfig.qaGate,
    sreDeployMaxDurationMs: process.env.AI_AGENT_SRE_DEPLOY_MAX_DURATION_MS ?? fileConfig.sreDeployMaxDurationMs,
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
    github: fileConfig.github,
    paperclip: mergePaperclip(fileConfig.paperclip),
    skillSync: mergeSkillSync(fileConfig.skillSync),
    dependabot: fileConfig.dependabot,
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
  const github = freezeGithubConventions(parsed.github);
  const globals = {
    allowedTools: [...parsed.allowedTools],
    builderMcpConfig: parsed.builderMcpConfig ? resolve(parsed.builderMcpConfig) : undefined,
    sessionEnv: [...parsed.sessionEnv],
    lifecycleLabels,
    github,
    dependabot: Object.freeze({ securityOnly: parsed.dependabot.securityOnly }),
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
        ...(entry.skillSyncSkills ? { skillSyncSkills: Object.freeze([...entry.skillSyncSkills]) } : {}),
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

  // Fail fast on misconfiguration: review enabled with no reviewer to run it.
  // Review runs only through the Tech Lead (techLeadPath); without one every
  // review would wait forever. Only when the review stage is configured at all —
  // without it `reviewEnabled` selects nothing.
  const stages: readonly StageEntry[] = Object.freeze(parsed.stages.map((s) => Object.freeze({ ...s })));
  const unreviewed = hasStage(stages, "review") && !parsed.techLeadPath ? repos.filter((r) => r.reviewEnabled) : [];
  if (unreviewed.length > 0) {
    throw new Error(
      `reviewEnabled is true for repo(s) ${unreviewed.map((r) => `"${r.name}"`).join(", ")} but techLeadPath is not set. ` +
      "Review runs through the Tech Lead: set techLeadPath, or turn reviewEnabled off."
    );
  }

  // The same for the release stage (EM#578): it is one Tech Lead approval and
  // one SRE deploy, so it needs both. Listed explicitly in `stages` without
  // them is a refusal; the default list just skips it (releaseStageWarning).
  const listsRelease = Array.isArray(fileConfig.stages)
    && (fileConfig.stages as unknown[]).some((s) => (s as { type?: unknown } | null)?.type === "release");
  if (listsRelease && (!parsed.srePath || !parsed.techLeadPath)) {
    throw new Error(
      `stages lists "release" but ${[!parsed.techLeadPath && "techLeadPath", !parsed.srePath && "srePath"].filter(Boolean).join(" and ")} ` +
      "is not set. The release stage has the Tech Lead approve the release PR and the SRE deploy it: set both, or drop \"release\" from stages.",
    );
  }

  // Fail fast on a label that means two things. The phases tell work apart by
  // label alone, so two lifecycle states sharing a name are one state, and a
  // trigger label that is also a lifecycle label excludes every issue it selects.
  const names = Object.values(lifecycleLabels);
  if (new Set(names).size !== names.length) {
    throw new Error(`lifecycleLabels must be distinct names; got ${JSON.stringify(lifecycleLabels)}`);
  }
  if (names.includes(github.blockedLabel)) {
    throw new Error(`github.blockedLabel "${github.blockedLabel}" is also a lifecycle label — every issue at that stage would read as blocked.`);
  }
  for (const r of repos) {
    if (r.triggerLabel === github.blockedLabel) {
      throw new Error(`triggerLabel "${r.triggerLabel}" for repo "${r.name}" is also github.blockedLabel — every issue it selects would be held back.`);
    }
    if (names.includes(r.triggerLabel)) {
      throw new Error(
        `triggerLabel "${r.triggerLabel}" for repo "${r.name}" is also a lifecycle label — ` +
        "an issue carrying it would be selected and excluded at once, so nothing would ever build.",
      );
    }
  }

  const paperclip = resolvePaperclipConfig(parsed.paperclip, repos.map((r) => r.githubRepo));

  return Object.freeze({
    repos: Object.freeze(repos),
    pollIntervalMs: parsed.pollIntervalMs,
    ...(parsed.maxConcurrentRepos !== undefined ? { maxConcurrentRepos: parsed.maxConcurrentRepos } : {}),
    maxConcurrentSessions: parsed.maxConcurrentSessions,
    trustManagedRepos: parsed.trustManagedRepos,
    onboarding: parsed.onboarding,
    buildBatchSize: parsed.buildBatchSize,
    buildWaitsForDevVerify: parsed.buildWaitsForDevVerify,
    backoff: Object.freeze(Object.fromEntries(Object.entries(parsed.backoff).map(([k, v]) =>
      [k, typeof v === "object" ? Object.freeze({ ...v }) : v]))) as BackoffConfig,
    issueCacheTtlMs: parsed.issueCacheTtlMs,
    issueSnapshotLimit: parsed.issueSnapshotLimit,
    logFormat: parsed.logFormat,
    logLevel: parsed.logLevel,
    sessionEnv: [...parsed.sessionEnv],
    emRepoPath,
    unstickEscalationOwner: parsed.unstickEscalationOwner,
    techLeadPath: parsed.techLeadPath ? resolve(parsed.techLeadPath.replace(/^~(?=$|\/)/, homedir())) : undefined,
    srePath: parsed.srePath ? resolve(parsed.srePath.replace(/^~(?=$|\/)/, homedir())) : undefined,
    qaPath: parsed.qaPath ? resolve(parsed.qaPath.replace(/^~(?=$|\/)/, homedir())) : undefined,
    qaRepos: [...parsed.qaRepos],
    qaGate: parsed.qaGate,
    sreDeployMaxDurationMs: parsed.sreDeployMaxDurationMs,
    reviewSkillPath: parsed.reviewSkillPath,
    reviewModel: parsed.reviewModel,
    reviewCheckoutRoot: parsed.reviewCheckoutRoot.replace(/^~(?=$|\/)/, homedir()),
    reviewMaxTurns: parsed.reviewMaxTurns,
    reviewMaxDurationMs: parsed.reviewMaxDurationMs,
    reviewAllowedTools: [...parsed.reviewAllowedTools],
    reviewerLogin: parsed.reviewerLogin,
    reviewLabelReconcile: parsed.reviewLabelReconcile,
    lifecycleLabels,
    github,
    stages,
    paperclip,
    skillSync: resolveSkillSync(parsed.skillSync),
    dependabot: globals.dependabot,
  });
}
