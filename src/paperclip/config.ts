// The Paperclip plugin's own config block: its schema, its env overrides, and the
// checks a loaded block must pass. The core config (src/config.ts) composes this
// block under `paperclip` and knows nothing of its shape; nothing else in the
// core reads it. docs/paperclip.md is generated from the comments here.
import { z } from "zod";
import { STAGES, type Stage } from "../lifecycle.js";

// Optional mirror of the Foreman's work onto a Paperclip instance
// (https://github.com/paperclipai/paperclip). GitHub stays the only work source:
// Paperclip only ever shows what the Foreman is doing. Off by default — a config
// without this block, or with `enabled` unset, runs exactly as before.
//
// The six Paperclip statuses the Foreman's view of an issue maps onto.
// `statusMap` renames any of them for an instance whose workflow uses other names.
const PAPERCLIP_STATUS_BUCKETS = ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"] as const;

// The board's columns are the core lifecycle's stages (lifecycle.ts). Each
// maps to who holds the card (a role), its Paperclip status, and the stage
// label it carries.
export const PAPERCLIP_STAGES = STAGES;
export type PaperclipStage = Stage;

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

export const paperclipConfigSchema = z.object({
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
  // How a task the Foreman creates is titled. {repo} is the full owner/name,
  // {owner} and {name} its two halves, {N} the issue number; {N} is required so
  // two issues never share a title. Only new tasks: an existing title is never
  // rewritten, and matching goes by identityKeyFormat, never by title.
  taskTitleFormat: z.string()
    .refine((f) => f.includes("{N}"), "taskTitleFormat must contain {N}")
    .default("{repo}#{N}"),
  // The Paperclip project every task the Foreman creates is filed under. Wins
  // over `projects`. Unset (and `projects` off) = tasks are created with no
  // project. The Foreman never moves an existing task between projects.
  projectId: z.string().min(1).optional(),
  // File each new task under the Unplaced project: the one project whose
  // description line 1 is "roadmap-position: unplaced", for a roadmap sync that
  // places it from there. With no such project, or two, no task is created
  // until one exists. Off (the default) = no project, or `projectId`.
  projects: z.boolean().default(false),
  // Only issues in these repos (owner/name, as in githubRepo) get a card. Unset
  // = every configured repo. A repo left out is never touched in Paperclip; its
  // existing cards stay as they are.
  repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a repo as owner/name")).min(1).optional(),
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

/** The resolved `paperclip` block. `enabled: false` means the daemon never calls Paperclip. */
export type PaperclipConfig = Readonly<z.infer<typeof paperclipConfigSchema>>;

/**
 * The `paperclip` block with its AI_AGENT_PAPERCLIP_* overrides applied, one env
 * var per leaf. `statusMap`, `projects`, `repos` and the nested blocks have none.
 * Undefined when neither the file nor the env sets anything, so the schema's prefault applies. A file value that is not
 * an object is passed through untouched for the schema to reject.
 */
export function mergePaperclip(fromFile: unknown): unknown {
  const env = Object.fromEntries(Object.entries({
    enabled: process.env.AI_AGENT_PAPERCLIP_ENABLED,
    url: process.env.AI_AGENT_PAPERCLIP_URL,
    companyId: process.env.AI_AGENT_PAPERCLIP_COMPANY_ID,
    agentName: process.env.AI_AGENT_PAPERCLIP_AGENT_NAME,
    agentId: process.env.AI_AGENT_PAPERCLIP_AGENT_ID,
    apiKey: process.env.AI_AGENT_PAPERCLIP_API_KEY,
    identityKeyFormat: process.env.AI_AGENT_PAPERCLIP_IDENTITY_KEY_FORMAT,
    taskTitleFormat: process.env.AI_AGENT_PAPERCLIP_TASK_TITLE_FORMAT,
    projectId: process.env.AI_AGENT_PAPERCLIP_PROJECT_ID,
  }).filter(([, v]) => v !== undefined));
  if (Object.keys(env).length === 0) return fromFile;
  if (fromFile === undefined) return env;
  if (typeof fromFile !== "object" || fromFile === null || Array.isArray(fromFile)) return fromFile;
  return { ...fromFile, ...env };
}

/**
 * The parsed block, checked and frozen. Throws on a mirror with nowhere to
 * write, a board stage that names a role or label that does not exist, or a
 * `repos` entry that is none of `knownRepos` (the configured owner/name list).
 */
export function resolvePaperclipConfig(pc: z.infer<typeof paperclipConfigSchema>, knownRepos?: ReadonlyArray<string>): PaperclipConfig {
  // Fail fast on a mirror with nowhere to write: every Paperclip route the
  // Foreman uses is scoped to one company.
  if (pc.enabled && !pc.companyId) {
    throw new Error("paperclip.enabled is true but no paperclip.companyId is set.");
  }
  // Every stage must name a role that exists and a label that exists, or a card
  // would be handed to nobody, silently.
  const roleKeys = new Set([PAPERCLIP_FOREMAN_ROLE, ...Object.keys(pc.roles)]);
  for (const [name, st] of Object.entries(pc.board)) {
    if (!roleKeys.has(st.owner)) throw new Error(`paperclip.board.${name}.owner "${st.owner}" is not "${PAPERCLIP_FOREMAN_ROLE}" or a key of paperclip.roles.`);
    if (st.label !== null && !(st.label in pc.stageLabels)) throw new Error(`paperclip.board.${name}.label "${st.label}" is not a key of paperclip.stageLabels.`);
  }
  for (const [key, role] of [...Object.entries(pc.roles), ["agentReportsTo", { reportsTo: pc.agentReportsTo }] as const]) {
    if (role.reportsTo !== undefined && !roleKeys.has(role.reportsTo)) throw new Error(`paperclip ${key}: reportsTo "${role.reportsTo}" is not "${PAPERCLIP_FOREMAN_ROLE}" or a key of paperclip.roles.`);
  }
  // A misspelled repo would mirror nothing for it, silently.
  if (pc.repos && knownRepos) {
    const unknown = pc.repos.filter((r) => !knownRepos.includes(r));
    if (unknown.length) throw new Error(`paperclip.repos ${unknown.map((r) => `"${r}"`).join(", ")} is not a configured githubRepo.`);
  }
  const paperclip: PaperclipConfig = Object.freeze({
    ...pc,
    ...(pc.statusMap ? { statusMap: Object.freeze({ ...pc.statusMap }) } : {}),
    ...(pc.repos ? { repos: Object.freeze([...pc.repos]) as string[] } : {}),
  });
  return paperclip;
}
