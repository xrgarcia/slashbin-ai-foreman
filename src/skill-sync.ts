// Skill sync: each managed repo's copy of its skills follows a golden source,
// one repo at a time, as approved work comes through.
//
// WHY COPIES EXIST AT ALL. A session runs with `cwd: <repo>` and is told "Read
// and follow the skill at .claude/skills/…", so the file it executes is the one
// in that checkout. The copies are the execution surface, not a mistake to
// remove; what they need is a source to follow.
//
// WHY HERE, AND WHY ONE ISSUE AT A TIME. Before this, the EM pushed a skill
// change to every repo at once (the EM repo's
// scripts/skills-publish.mjs): one tracking issue and one commit on `features`
// per repo. One publish was ~23 PRs walking review, verify and release, and on
// 2026-10-15 it put 26 cards in the board's Review column at once. Now the
// Foreman notices a stale copy and brings it current in the commit before the
// next approved issue's session, so the sync rides that issue's own PR and a
// rollout spreads at the pace work does (Ray, 2026-10-15).
//
// WHY THE CODE COPIES AND NO SESSION DOES. The builder must not rewrite the
// rules it is judged against. A byte-for-byte copy from a committed golden is
// not a rewrite: the Foreman never edits skill text, it only replaces a copy
// with the source.
//
// WHY A COMMITTED REF, NEVER A WORKING TREE. The EM checkout holds unreviewed
// edits; a golden read from it would ship them to every builder. The git source
// is read from `ref` (default `origin/develop`) after a fetch.
//
// Off by default: a config without the `skillSync` block changes nothing.
import { z } from "zod";
import { git as runGit, gitBytes as runGitBytes } from "./git-exec.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";
import { slugify } from "./foreman-branch.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILTIN_SKILLS_DIR = join(PACKAGE_ROOT, "skills");

// --- Config ---

const envBool = z.preprocess(
  (v) => (typeof v === "string" ? !/^(0|false|no|off)$/i.test(v.trim()) : v),
  z.boolean(),
);

export const skillSyncConfigSchema = z.object({
  // Turn skill sync on. Off by default: nothing is read, compared or committed.
  enabled: envBool.default(false),
  // Where the golden copies come from. "builtin": this package's own skills/
  // directory (skills/implement, skills/revise). "git": a committed ref in
  // another checkout — `repoPath`, `ref` and `dirs` below.
  source: z.enum(["builtin", "git"]).default("builtin"),
  // The git source's checkout. Relative paths resolve against the daemon's
  // working directory, like emRepoPath. Env: AI_AGENT_SKILL_SYNC_REPO_PATH, so a
  // host path need not live in the config file.
  repoPath: z.string().optional(),
  // The committed ref the golden is read from, fetched first when it names a
  // remote branch. Never the working tree: it holds unreviewed edits.
  ref: z.string().default("origin/develop"),
  // Directories under `ref`, each holding one sub-directory per skill (a
  // sub-directory counts only if it has a SKILL.md). Files directly in a
  // directory, such as a README, are not skills. A skill name found in two
  // directories is refused as ambiguous.
  dirs: z.array(z.string()).default([]),
  // The skills a repo carries, by name. Empty: every skill the source has.
  // A repo entry's `skillSyncSkills` replaces this list for that repo.
  skills: z.array(z.string()).default([]),
  // Where a repo keeps its skills, relative to its root. One directory per skill.
  targetDir: z.string().default(".claude/skills"),
  // The name the sync commit gives the source. Omitted: the git checkout's
  // directory name, or "slashbin-ai-agent" for the builtin source.
  label: z.string().optional(),
  // How long one read of the golden is reused before the next fetch.
  refreshMs: z.coerce.number().int().positive().default(300_000),
});

export type SkillSyncConfig = Readonly<Omit<z.infer<typeof skillSyncConfigSchema>, "dirs" | "skills"> & {
  dirs: readonly string[];
  skills: readonly string[];
}>;

/** The block with its env overrides applied (see mergePaperclip for the pattern). */
export function mergeSkillSync(fromFile: unknown): unknown {
  const env = Object.fromEntries(Object.entries({
    enabled: process.env.AI_AGENT_SKILL_SYNC_ENABLED,
    repoPath: process.env.AI_AGENT_SKILL_SYNC_REPO_PATH,
  }).filter(([, v]) => v !== undefined));
  if (Object.keys(env).length === 0) return fromFile;
  if (fromFile === undefined) return env;
  if (typeof fromFile !== "object" || fromFile === null || Array.isArray(fromFile)) return fromFile;
  return { ...fromFile, ...env };
}

/** The parsed block, checked and frozen. A git source with nowhere to read from is refused at load. */
export function resolveSkillSync(s: z.infer<typeof skillSyncConfigSchema>): SkillSyncConfig {
  const repoPath = s.repoPath ? resolve(s.repoPath.replace(/^~(?=$|\/)/, homedir())) : undefined;
  if (s.enabled && s.source === "git") {
    if (!repoPath) throw new Error('skillSync.source is "git" but skillSync.repoPath is not set (or AI_AGENT_SKILL_SYNC_REPO_PATH).');
    if (s.dirs.length === 0) throw new Error('skillSync.source is "git" but skillSync.dirs is empty — name the directories that hold the skills.');
  }
  return Object.freeze({ ...s, repoPath, dirs: Object.freeze([...s.dirs]), skills: Object.freeze([...s.skills]) });
}

// --- Git ---

// Async with a 60 s timeout (git-exec.ts): none of this holds the event loop.
function git(args: string[], cwd: string): Promise<string> {
  return runGit(args, cwd, { timeoutMs: 60_000 });
}
function gitBuf(args: string[], cwd: string): Promise<Buffer> {
  return runGitBytes(args, cwd, { timeoutMs: 60_000 });
}
function firstLine(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const text = `${e?.stderr ?? ""}`.trim() || `${e?.message ?? err}`;
  return text.split("\n")[0].slice(0, 200);
}

interface TreeEntry { mode: string; oid: string; path: string }
async function lsTree(cwd: string, ref: string, path: string): Promise<TreeEntry[]> {
  // Not trimmed: the entries are NUL-terminated and a path may end in whitespace.
  const out = (await gitBuf(["ls-tree", "-r", "-z", ref, "--", path], cwd)).toString("utf8");
  return out.split("\0").filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    const [mode, , oid] = l.slice(0, tab).split(" ");
    return { mode, oid, path: l.slice(tab + 1) };
  });
}

/** Fetch `ref` first when it names a branch of a configured remote (origin/develop). */
async function fetchRef(cwd: string, ref: string): Promise<void> {
  const slash = ref.indexOf("/");
  if (slash <= 0) return;
  const remote = ref.slice(0, slash);
  if (!(await git(["remote"], cwd)).split("\n").includes(remote)) return;
  await git(["fetch", "--quiet", remote, ref.slice(slash + 1)], cwd);
}

// --- The golden ---

/** One skill's files, keyed by path inside the skill's directory. */
export type SkillFiles = ReadonlyMap<string, Buffer>;

export interface Golden {
  /** What the sync commit calls the source. */
  label: string;
  /** The source's version: the last commit that touched it, or the build's commit for builtin. */
  version: string;
  /** Content hash over every skill; changes exactly when the golden does. */
  hash: string;
  skills: ReadonlyMap<string, SkillFiles>;
  /** Where each skill came from, for the commit body. */
  origin: ReadonlyMap<string, string>;
}

/** A skill's content hash: every file's path and bytes, order-independent. */
export function skillHash(files: SkillFiles): string {
  const h = createHash("sha256");
  for (const p of [...files.keys()].sort()) {
    h.update(p).update("\0").update(createHash("sha256").update(files.get(p)!).digest("hex")).update("\n");
  }
  return h.digest("hex").slice(0, 12);
}

function goldenHash(skills: ReadonlyMap<string, SkillFiles>): string {
  const h = createHash("sha256");
  for (const name of [...skills.keys()].sort()) h.update(`${name}:${skillHash(skills.get(name)!)}\n`);
  return h.digest("hex").slice(0, 12);
}

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel))) {
    const p = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, p)).isDirectory()) out.push(...walk(dir, p));
    else out.push(p);
  }
  return out;
}

function readBuiltin(cfg: SkillSyncConfig): Golden {
  const skills = new Map<string, SkillFiles>();
  const origin = new Map<string, string>();
  for (const name of readdirSync(BUILTIN_SKILLS_DIR)) {
    const dir = join(BUILTIN_SKILLS_DIR, name);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "SKILL.md"))) continue;
    skills.set(name, new Map(walk(dir).map((p) => [p, readFileSync(join(dir, p))])));
    origin.set(name, `skills/${name}`);
  }
  let version: string;
  try {
    const info = JSON.parse(readFileSync(join(PACKAGE_ROOT, "dist", "build-info.json"), "utf8")) as { commit?: string | null };
    version = info.commit ? info.commit.slice(0, 7) : goldenHash(skills).slice(0, 7);
  } catch {
    version = goldenHash(skills).slice(0, 7);
  }
  return { label: cfg.label ?? "slashbin-ai-agent", version, hash: goldenHash(skills), skills, origin };
}

/**
 * The golden for a git source, read from `ref` only. Throws on anything it
 * cannot read; the caller skips the sync and says why.
 */
async function readGit(cfg: SkillSyncConfig, fetch: boolean): Promise<Golden> {
  const cwd = cfg.repoPath!;
  if (fetch) await fetchRef(cwd, cfg.ref);
  const skills = new Map<string, Map<string, Buffer>>();
  const origin = new Map<string, string>();
  for (const raw of cfg.dirs) {
    const dir = raw.replace(/\/+$/, "");
    const found = new Map<string, Map<string, Buffer>>();
    for (const e of await lsTree(cwd, cfg.ref, dir)) {
      const rest = e.path.slice(dir.length + 1);
      const slash = rest.indexOf("/");
      if (slash <= 0) continue; // a file directly in the directory, not a skill
      if (e.mode === "120000") throw new Error(`${e.path} is a symlink at ${cfg.ref} — a golden skill must be real files`);
      const name = rest.slice(0, slash);
      const files = found.get(name) ?? new Map<string, Buffer>();
      files.set(rest.slice(slash + 1), await gitBuf(["cat-file", "blob", e.oid], cwd));
      found.set(name, files);
    }
    for (const [name, files] of found) {
      if (!files.has("SKILL.md")) continue;
      if (skills.has(name)) throw new Error(`skill "${name}" is in both ${origin.get(name)} and ${dir} at ${cfg.ref} — ambiguous`);
      skills.set(name, files);
      origin.set(name, `${dir}/${name}`);
    }
  }
  if (skills.size === 0) throw new Error(`no skills under ${cfg.dirs.join(", ")} at ${cfg.ref}`);
  const version = (await git(["log", "-1", "--format=%h", cfg.ref, "--", ...cfg.dirs], cwd)) || (await git(["rev-parse", "--short", cfg.ref], cwd));
  return { label: cfg.label ?? basename(cwd), version, hash: goldenHash(skills), skills, origin };
}

/** Read the golden now. `fetch: false` reads the ref as last fetched (the doctor's read-only mode). */
export async function readGolden(cfg: SkillSyncConfig, opts: { fetch?: boolean } = {}): Promise<Golden> {
  return cfg.source === "git" ? readGit(cfg, opts.fetch ?? true) : readBuiltin(cfg);
}

// --- Drift ---

export type SkillState = "current" | "stale" | "missing";
export interface SkillDrift { skill: string; state: SkillState }

/** The skills a repo carries: its own list when set, else the global one, else everything the golden has. */
export function skillsFor(cfg: SkillSyncConfig, golden: Golden, repoSkills?: readonly string[]): string[] {
  const wanted = repoSkills ?? (cfg.skills.length > 0 ? cfg.skills : [...golden.skills.keys()].sort());
  return wanted.filter((n) => golden.skills.has(n));
}

/**
 * Compare a repo's copies against the golden, by content. `repo` holds each
 * skill's files as the repo has them; an absent or empty entry is missing.
 * Any difference — a changed byte, a file the golden lacks, a file the copy
 * lacks — is stale.
 */
export function compareSkills(golden: Golden, names: readonly string[], repo: ReadonlyMap<string, SkillFiles>): SkillDrift[] {
  return names.map((skill) => {
    const have = repo.get(skill);
    if (!have || have.size === 0) return { skill, state: "missing" as const };
    return { skill, state: skillHash(have) === skillHash(golden.skills.get(skill)!) ? "current" as const : "stale" as const };
  });
}

/** Each named skill's files as committed at `ref` in a repo. A symlink in a copy throws. */
export async function repoSkillsAt(repoPath: string, ref: string, targetDir: string, names: readonly string[]): Promise<Map<string, Map<string, Buffer>>> {
  const out = new Map<string, Map<string, Buffer>>();
  for (const skill of names) {
    const base = `${targetDir.replace(/\/+$/, "")}/${skill}`;
    const files = new Map<string, Buffer>();
    for (const e of await lsTree(repoPath, ref, base)) {
      if (e.mode === "120000") throw new Error(`${e.path} is a symlink at ${ref}`);
      files.set(e.path.slice(base.length + 1), await gitBuf(["cat-file", "blob", e.oid], repoPath));
    }
    out.set(skill, files);
  }
  return out;
}

/** A repo's drift at `ref` (default: the feature branch as last fetched — what the session's Phase 0 pulls). */
export async function driftAt(repoPath: string, ref: string, cfg: SkillSyncConfig, golden: Golden, names: readonly string[]): Promise<SkillDrift[]> {
  return compareSkills(golden, names, await repoSkillsAt(repoPath, ref, cfg.targetDir, names));
}

/** "a (stale), b (missing)" */
export function describeDrift(drift: readonly SkillDrift[]): string {
  return drift.filter((d) => d.state !== "current").map((d) => `${d.skill} (${d.state})`).join(", ");
}

export interface SkillSyncRepo {
  name: string;
  repoPath: string;
  /** The branch the sync commit is made on (the repo's baseBranch); sessions cut their issue branch from it. */
  baseBranch: string;
  skillSyncSkills?: readonly string[];
}

// --- The sync ---

export type SyncOutcome =
  | { status: "current" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  | { status: "synced"; sha: string; skills: string[]; subject: string };

export type DeliverOutcome =
  | { status: "current" }
  | { status: "exists"; branch: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  | { status: "delivered"; branch: string; sha: string; skills: string[]; subject: string }
  | { status: "refreshed"; branch: string; sha: string; skills: string[]; subject: string };

/** The one line every Foreman delivery commit carries in its body; with the subject and the author it marks a commit as the Foreman's. */
export const DELIVERY_MARKER = "Copied byte for byte by the Foreman's skill sync (src/skill-sync.ts) onto this issue's branch,";
/** Body line recording the tree a delivery commit was built with: `Foreman-Tree: <oid>`. */
const TREE_TRAILER = "Foreman-Tree:";

/**
 * The exact ref a session's issue branch starts from: the skill-sync commit THIS session's sync just made, else
 * `origin/<base>` resolved to a SHA after a fetch. Never derived from where local `<base>` points, so unrelated
 * unpublished local commits cannot ride into the branch. Never throws: unresolvable falls back to the ref name.
 */
export async function resolveStartRef(repo: Pick<SkillSyncRepo, "repoPath" | "baseBranch">, outcome: SyncOutcome | null): Promise<string> {
  if (outcome?.status === "synced") return outcome.sha;
  try {
    await git(["fetch", "--quiet", "origin", repo.baseBranch], repo.repoPath);
    return await git(["rev-parse", `origin/${repo.baseBranch}`], repo.repoPath);
  } catch {
    return `origin/${repo.baseBranch}`;
  }
}

/**
 * Hygiene only (correctness does not depend on it: the session starts from `resolveStartRef`). Make local `<base>` equal `origin/<base>` (fetch, then fast-forward only) before every session, sync or not: the
 * next skill sync commits on a level base. Never throws. Local commits origin lacks are left alone (reported, not discarded).
 */
export async function alignLocalBase(repo: Pick<SkillSyncRepo, "repoPath" | "baseBranch">, logger: Logger): Promise<{ status: "level" | "fast-forwarded" | "ahead" | "skipped"; reason?: string }> {
  const cwd = repo.repoPath;
  const fb = repo.baseBranch;
  try {
    if (await git(["status", "--porcelain", "--untracked-files=no"], cwd)) return { status: "skipped", reason: "the checkout has uncommitted changes" };
    await git(["fetch", "--quiet", "origin", fb], cwd);
    if (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) !== fb) await git(["checkout", "--quiet", fb], cwd);
    const ahead = Number(await git(["rev-list", "--count", `origin/${fb}..HEAD`], cwd));
    const behind = Number(await git(["rev-list", "--count", `HEAD..origin/${fb}`], cwd));
    if (ahead > 0) {
      logger.warn(`Local ${fb} has ${ahead} commit(s) origin/${fb} does not — left as is`);
      return { status: "ahead", reason: `local ${fb} has ${ahead} commit(s) origin/${fb} does not` };
    }
    if (behind > 0) { await git(["merge", "--quiet", "--ff-only", `origin/${fb}`], cwd); return { status: "fast-forwarded" }; }
    return { status: "level" };
  } catch (err) {
    return { status: "skipped", reason: firstLine(err) };
  }
}

/**
 * The skill sync's memory for one daemon: the cached golden, the last
 * unreadable-golden error, and which drift each repo was last told about.
 */
export class SkillSync {
  private cache: { key: string; at: number; golden: Golden } | null = null;
  private lastGoldenError: string | null = null;
  private readonly driftLogged = new Map<string, string>();

  /**
   * The golden, reused for `refreshMs` so a fleet of repos costs one fetch, not
   * one per repo per poll. Null when unreadable; the error is logged once until
   * it changes or clears.
   */
  async currentGolden(cfg: SkillSyncConfig, logger: Logger, now = Date.now()): Promise<Golden | null> {
    const key = JSON.stringify([cfg.source, cfg.repoPath, cfg.ref, cfg.dirs, cfg.label]);
    if (this.cache && this.cache.key === key && now - this.cache.at < cfg.refreshMs) return this.cache.golden;
    try {
      const golden = await readGolden(cfg);
      this.cache = { key, at: now, golden };
      this.lastGoldenError = null;
      return golden;
    } catch (err) {
      const why = firstLine(err);
      if (why !== this.lastGoldenError) logger.warn(`Skill sync: golden source unreadable — no skill is synced until it reads: ${why}`);
      this.lastGoldenError = why;
      return null;
    }
  }

  /**
   * Say once that a repo's copy is behind the golden — once per repo per golden
   * version and stale set, not every poll. Read-only: the copy is brought
   * current only when the repo's next approved issue is built. Never throws.
   */
  async noticeSkillDrift(cfg: SkillSyncConfig, repo: SkillSyncRepo, logger: Logger): Promise<void> {
    if (!cfg.enabled) return;
    try {
      const golden = await this.currentGolden(cfg, logger);
      if (!golden) return;
      const names = skillsFor(cfg, golden, repo.skillSyncSkills);
      if (names.length === 0) return;
      const drift = await driftAt(repo.repoPath, `origin/${repo.baseBranch}`, cfg, golden, names);
      const stale = describeDrift(drift);
      if (!stale) {
        this.driftLogged.delete(repo.name);
        return;
      }
      const key = `${golden.hash}|${stale}`;
      if (this.driftLogged.get(repo.name) === key) return;
      this.driftLogged.set(repo.name, key);
      logger.info(
        `Skill drift on origin/${repo.baseBranch}: ${stale} behind ${golden.label}@${golden.version} — ` +
        "synced in the commit before the next approved issue's session",
      );
    } catch (err) {
      logger.debug(`Skill drift check could not read ${repo.name}: ${firstLine(err)}`);
    }
  }

  /**
   * Before an implement session: bring the repo's stale skill copies to the
   * golden, as one commit on the feature branch in the repo's own checkout, so
   * the session runs on the fresh skill and the commit rides out with the
   * issue's own push. NOT pushed here: a sync pushed alone is an orphan commit
   * the reconciler would open its own PR for — one more card per repo, the very
   * flood this replaces.
   *
   * The caller holds the repo's checkout lock (implement is a checkout stage).
   * Never throws: anything it cannot do is a `skipped` or `failed` outcome, and
   * the session runs on the skill it has. A skill sync never blocks an issue.
   */
  async syncSkillsForIssue(
    cfg: SkillSyncConfig,
    repo: SkillSyncRepo,
    issues: readonly number[],
    logger: Logger,
  ): Promise<SyncOutcome> {
    const golden = await this.currentGolden(cfg, logger);
    if (!golden) return { status: "skipped", reason: "golden source unreadable" };
    const names = skillsFor(cfg, golden, repo.skillSyncSkills);
    if (names.length === 0) return { status: "current" };
    const cwd = repo.repoPath;
    const fb = repo.baseBranch;
    const target = cfg.targetDir.replace(/\/+$/, "");
    // Every path the sync is about to change, with its bytes before (null: it did not exist),
    // so a failure puts the working tree back exactly as found.
    const original = new Map<string, Buffer | null>();
    const remember = (rel: string): void => {
      if (original.has(rel)) return;
      const abs = join(cwd, rel);
      original.set(rel, existsSync(abs) ? readFileSync(abs) : null);
    };
    try {
      // A tracked change in the clone belongs to someone; checking out over it
      // or committing beside it would take it along. Untracked files stay out of
      // the commit either way, since only the skill paths are staged.
      if (await git(["status", "--porcelain", "--untracked-files=no"], cwd)) {
        return { status: "skipped", reason: "the checkout has uncommitted changes" };
      }
      await git(["fetch", "--quiet", "origin", fb], cwd);
      if (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) !== fb) await git(["checkout", "--quiet", fb], cwd);
      const ahead = Number(await git(["rev-list", "--count", `origin/${fb}..HEAD`], cwd));
      const behind = Number(await git(["rev-list", "--count", `HEAD..origin/${fb}`], cwd));
      // Local commits origin has not seen are not ours to build on: the next
      // push would carry them under this issue's name.
      if (ahead > 0) return { status: "skipped", reason: `local ${fb} has ${ahead} commit(s) origin/${fb} does not` };
      if (behind > 0) await git(["merge", "--quiet", "--ff-only", `origin/${fb}`], cwd);

      const have = await repoSkillsAt(cwd, "HEAD", target, names);
      const stale = compareSkills(golden, names, have).filter((d) => d.state !== "current").map((d) => d.skill);
      if (stale.length === 0) return { status: "current" };

      // Writing through a symlinked skills directory would land outside the
      // repo, and git refuses to stage a path beyond one anyway.
      const parts = target.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = join(cwd, ...parts.slice(0, i));
        if (existsSync(p) && lstatSync(p).isSymbolicLink()) {
          return { status: "skipped", reason: `${parts.slice(0, i).join("/")} is a symlink — sync the real directory` };
        }
      }

      for (const skill of stale) {
        const want = golden.skills.get(skill)!;
        const base = `${target}/${skill}`;
        // A file the golden does not have is removed: the copy is the golden, byte for byte.
        const extra = [...(have.get(skill)?.keys() ?? [])].filter((p) => !want.has(p)).map((p) => `${base}/${p}`);
        extra.forEach(remember);
        if (extra.length > 0) await git(["rm", "--quiet", "--", ...extra], cwd);
        for (const [p, bytes] of want) {
          remember(`${base}/${p}`);
          const dest = join(cwd, base, p);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, bytes);
        }
        // Forced: these are the sync's own files, and a repo that ignores `.claude/`
        // (jerky_labor_forecaster) otherwise refuses them and the sync fails open,
        // leaving the session on a stale or missing skill (EM, 2026-11-04).
        await git(["add", "--force", "--", ...[...want.keys()].map((p) => `${base}/${p}`)], cwd);
      }
      if (!await git(["diff", "--cached", "--name-only"], cwd)) return { status: "current" };

      // `(#N)` links the commit to the issue the way every builder commit does
      // (the reconciler and PR linkage read commit headlines). Named only when
      // the session was handed one issue: with several, the session picks one,
      // and a guessed number would tie this PR to an issue it may not deliver.
      const ref = issues.length === 1 ? ` (#${issues[0]})` : "";
      const subject = `chore(skills): sync ${stale.join(", ")} from ${golden.label}@${golden.version}${ref}`;
      const body =
        stale.map((s) => `${target}/${s} <- ${golden.label}:${golden.origin.get(s)} @ ${golden.version}`).join("\n") +
        "\n\nCopied byte for byte by the Foreman's skill sync (src/skill-sync.ts) before this\n" +
        "issue's session, so the session runs on the current skill. Do not hand-edit\n" +
        "this copy: change the golden source, and the next issue here brings it over.";
      // --no-verify: the content is a reviewed golden, copied, not authored here;
      // a repo hook that lints or tests the tree has nothing to say about it, and
      // one that fails would cost the issue its fresh skill. CI still runs on the PR.
      await git(["commit", "--quiet", "--no-verify", "-m", subject, "-m", body], cwd);
      const sha = await git(["rev-parse", "HEAD"], cwd);
      logger.info(`Skill sync: ${subject} — ${sha.slice(0, 9)}, pushed with the session's work`);
      return { status: "synced", sha, skills: stale, subject };
    } catch (err) {
      const error = firstLine(err);
      logger.warn(`Skill sync failed — implementing on the existing skill: ${error}`);
      // Leave the index as it was found, so the session does not inherit a half-staged sync.
      try { await git(["reset", "--quiet"], cwd); } catch { /* the session's Phase 0 reports a broken checkout */ }
      // And the working tree: un-staging alone left the written copies as uncommitted changes,
      // so every later sync skipped on "the checkout has uncommitted changes" (jerky_labor_forecaster,
      // 2026-11-04 → 11-05: the ship skill never arrived).
      for (const [rel, bytes] of original) {
        try {
          const abs = join(cwd, rel);
          if (bytes) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, bytes); }
          else rmSync(abs, { force: true });
        } catch (e) { logger.warn(`Skill sync could not restore ${rel}: ${firstLine(e)}`); }
      }
      return { status: "failed", error };
    }
  }
  /**
   * Human lane: deliver the golden skills to a repo the Foreman does not implement in, for one
   * `approved-for-human` issue. The person works the issue directly (the unified implement skill's
   * direct mode, branch `feature/<N>-<slug>`); this puts the current skills on that very branch
   * before they start, and never builds, opens a PR or labels anything.
   *
   * It touches NO working tree, index, local branch or checkout: the commit is built with git
   * plumbing in a throwaway index on top of `origin/<base>` and pushed as a new branch. The clone
   * may be the person's own, so nothing here may move under them. It force-updates exactly one
   * kind of branch (see `refreshUntouched`: only Foreman delivery commits, no PR) and never anything else. It
   * does nothing when `origin/<base>` already carries the current skills, and leaves an existing
   * `feature/<N>-*` branch alone unless that one case holds (the person started it: the direct-mode
   * skill resumes that branch, and a second push would diverge it).
   *
   * Never throws: anything it cannot do is `skipped` or `failed`, and the issue is untouched.
   */
  async deliverSkillsForIssue(
    cfg: SkillSyncConfig,
    repo: SkillSyncRepo,
    issue: { number: number; title: string },
    logger: Logger,
    /** Every PR (any state) whose head is this branch. Without it an existing branch is never refreshed. Throws on a failed read. */
    prsForBranch?: (branch: string) => Promise<{ number: number; state: string }[]>,
  ): Promise<DeliverOutcome> {
    const golden = await this.currentGolden(cfg, logger);
    if (!golden) return { status: "skipped", reason: "golden source unreadable" };
    const names = skillsFor(cfg, golden, repo.skillSyncSkills);
    if (names.length === 0) return { status: "current" };
    const cwd = repo.repoPath;
    const fb = repo.baseBranch;
    const target = cfg.targetDir.replace(/\/+$/, "");
    let scratch: string | null = null;
    try {
      await git(["fetch", "--quiet", "origin", fb], cwd);
      const baseSha = await git(["rev-parse", `origin/${fb}`], cwd);
      const have = await repoSkillsAt(cwd, baseSha, target, names);
      const stale = compareSkills(golden, names, have).filter((d) => d.state !== "current").map((d) => d.skill);
      if (stale.length === 0) return { status: "current" };

      const existing = await git(["ls-remote", "--heads", "origin", `feature/${issue.number}-*`], cwd);
      if (existing) {
        const rows = existing.split("\n").map((l) => l.split("\t"));
        const branch = rows[0][1]?.replace(/^refs\/heads\//, "") ?? `feature/${issue.number}-*`;
        if (rows.length === 1 && prsForBranch) {
          const refreshed = await this.refreshUntouched({ cwd, golden, names, target, baseSha, stale, have, issue, branch, oldSha: rows[0][0], prsForBranch, logger });
          if (refreshed) return refreshed;
        }
        return { status: "exists", branch };
      }

      const built = await this.buildDeliveryCommit(cwd, golden, target, baseSha, stale, have, issue.number);
      scratch = built.scratch;
      const { sha, subject } = built;
      const branch = `feature/${issue.number}-${slugify(issue.title) || "issue"}`;
      // No force: a branch that appeared since the check above makes this fail, which is the right answer.
      await git(["push", "--quiet", "origin", `${sha}:refs/heads/${branch}`], cwd);
      logger.info(`Skill delivery: ${subject} — pushed ${sha.slice(0, 9)} to ${branch} (no PR; the person's direct-mode session resumes it)`);
      return { status: "delivered", branch, sha, skills: stale, subject };
    } catch (err) {
      const error = firstLine(err);
      logger.warn(`Skill delivery to ${repo.name} #${issue.number} failed: ${error}`);
      return { status: "failed", error };
    } finally {
      if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ } }
    }
  }

  /** One `chore(skills): sync` commit on `baseSha`, built with plumbing in a throwaway index. The caller removes `scratch`. */
  private async buildDeliveryCommit(
    cwd: string, golden: Golden, target: string, baseSha: string, stale: string[],
    have: Map<string, Map<string, Buffer>>, issueNumber: number,
  ): Promise<{ sha: string; subject: string; scratch: string }> {
    const scratch = mkdtempSync(join(tmpdir(), "foreman-skill-deliver-"));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
      const gi = (args: string[], input?: Buffer): Promise<string> => runGit(args, cwd, { env, input, timeoutMs: 60_000 });
      await gi(["read-tree", baseSha]);
      for (const skill of stale) {
        const want = golden.skills.get(skill)!;
        const base = `${target}/${skill}`;
        for (const p of have.get(skill)?.keys() ?? []) if (!want.has(p)) await gi(["update-index", "--force-remove", "--", `${base}/${p}`]);
        for (const [p, bytes] of want) {
          const oid = await gi(["hash-object", "-w", "--stdin"], bytes);
          await gi(["update-index", "--add", "--cacheinfo", `100644,${oid},${base}/${p}`]);
        }
      }
      const tree = await gi(["write-tree"]);
      const subject = `chore(skills): sync ${stale.join(", ")} from ${golden.label}@${golden.version} (#${issueNumber})`;
      const body =
        stale.map((s) => `${target}/${s} <- ${golden.label}:${golden.origin.get(s)} @ ${golden.version}`).join("\n") +
        `\n\n${DELIVERY_MARKER}\n` +
        "so the direct-mode session starts on the current skills. Do not hand-edit this copy:\n" +
        "change the golden source, and the next issue here brings it over.\n\n" +
        // The tree this commit was built with. A refresh trusts a delivery commit only while its tree is still this
        // one: any amend (a file anywhere, even under the skills directory) changes the tree.
        `${TREE_TRAILER} ${tree}`;
      const sha = await git(["commit-tree", tree, "-p", baseSha, "-m", subject, "-m", body], cwd);
      return { sha, subject, scratch };
    } catch (err) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
      throw err;
    }
  }

  /**
   * An existing `feature/<N>-*` branch the Foreman delivered and nobody touched, carrying skills that differ from the
   * golden, is rebuilt as one fresh sync commit on `origin/<base>` and force-updated. Safe because only the Foreman has
   * written it: every commit beyond the base is a Foreman delivery commit (subject, body marker, and the author the
   * Foreman commits as), none is a merge, each commit's tree is still the tree the Foreman recorded in it (an amend
   * that kept the metadata but changed any file is a person's work), and no PR from it exists in any state. The push is a lease on the sha just
   * read, so a commit that lands in between wins and the push fails. Returns null to leave the branch alone.
   */
  private async refreshUntouched(a: {
    cwd: string; golden: Golden; names: string[]; target: string; baseSha: string; stale: string[];
    have: Map<string, Map<string, Buffer>>; issue: { number: number; title: string }; branch: string; oldSha: string;
    prsForBranch: (branch: string) => Promise<{ number: number; state: string }[]>; logger: Logger;
  }): Promise<DeliverOutcome | null> {
    const { cwd, issue, branch, oldSha, logger } = a;
    let scratch: string | null = null;
    try {
      await git(["fetch", "--quiet", "origin", `refs/heads/${branch}`], cwd);
      const tip = await git(["rev-parse", "FETCH_HEAD"], cwd);
      if (tip !== oldSha) return null; // moved since ls-remote: someone is writing to it
      const log = await git(["log", "--format=%H%x1f%P%x1f%an <%ae>%x1f%s%x1f%T%x1f%b%x1e", `${a.baseSha}..${tip}`], cwd);
      const commits = log.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => c.split("\x1f"));
      if (commits.length === 0) return null;
      const me = (await git(["var", "GIT_AUTHOR_IDENT"], cwd)).replace(/ \d+ [+-]\d{4}$/, "");
      const subjectRe = new RegExp(`^chore\\(skills\\): sync .+ \\(#${issue.number}\\)$`);
      for (const [, parents, author, subject, tree, body] of commits) {
        if (parents.trim().split(/\s+/).length !== 1) return null; // a merge: the person brought the base in
        if (author !== me || !subjectRe.test(subject) || !body.includes(DELIVERY_MARKER)) return null; // not the Foreman's
        // Metadata alone can be kept while the content changes (a human's `commit --amend --no-edit`, adding a file
        // anywhere, a new skill under the skills directory included). Only a commit whose tree is still the one the
        // Foreman recorded is provably untouched; a delivery with no recorded tree (built before it was recorded) is
        // left alone.
        if (!body.split("\n").some((l) => l.trim() === `${TREE_TRAILER} ${tree}`)) return null;
      }
      const carried = compareSkills(a.golden, a.names, await repoSkillsAt(cwd, tip, a.target, a.names)).filter((d) => d.state !== "current");
      if (carried.length === 0) return null; // the branch already carries the golden
      const prs = await a.prsForBranch(branch);
      if (prs.length > 0) return null;
      const built = await this.buildDeliveryCommit(cwd, a.golden, a.target, a.baseSha, a.stale, a.have, issue.number);
      scratch = built.scratch;
      await git(["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${oldSha}`, "origin", `${built.sha}:refs/heads/${branch}`], cwd);
      logger.info(`Skill delivery: ${built.subject} — refreshed ${branch} ${oldSha.slice(0, 9)} -> ${built.sha.slice(0, 9)} (only Foreman delivery commits, no PR)`);
      return { status: "refreshed", branch, sha: built.sha, skills: a.stale, subject: built.subject };
    } catch (err) {
      // Not provably the Foreman's alone: leave it exactly as it was.
      logger.warn(`Skill delivery to ${issue.number}: could not refresh ${branch}, left alone: ${firstLine(err)}`);
      return null;
    } finally {
      if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ } }
    }
  }
}

/**
 * After the session: a sync commit the session did not push is taken back off
 * the local branch. Left there, the next push — another issue's — would carry
 * a headline naming THIS issue, and PR linkage reads commit headlines. The next
 * pickup syncs again under its own number. Never throws.
 */
export async function settleSkillSync(repo: SkillSyncRepo, outcome: SyncOutcome, logger: Logger): Promise<void> {
  if (outcome.status !== "synced") return;
  const cwd = repo.repoPath;
  const fb = repo.baseBranch;
  try {
    await git(["fetch", "--quiet", "origin"], cwd);
    // Pushed with the work = reachable from some remote branch (the session's own foreman/<N>-<slug>, usually).
    let pushed = false;
    try { pushed = (await git(["branch", "-r", "--contains", outcome.sha], cwd)).split("\n").some((l) => l.trim().startsWith("origin/")); } catch { /* unknown: treated as unpushed */ }
    // The sync commit was made on local <base> (the session starts from its sha, not from local <base>). Either way the local base must go
    // back to origin/<base>: left ahead, the next sync would skip ("local base has a commit origin does not").
    if (await git(["rev-parse", fb], cwd) === outcome.sha) {
      if (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) === fb) await git(["reset", "--quiet", "--keep", `${outcome.sha}~1`], cwd);
      else await git(["branch", "-f", fb, `${outcome.sha}~1`], cwd);
      logger.info(pushed
        ? `Skill sync ${outcome.sha.slice(0, 9)} was pushed with the work — local ${fb} moved back to origin/${fb}`
        : `Skill sync ${outcome.sha.slice(0, 9)} was not pushed (no work landed) — taken back off local ${fb}; the next issue syncs again`);
      return;
    }
    if (!pushed) logger.warn(`Skill sync ${outcome.sha.slice(0, 9)} is unpushed under other local work on ${fb} — left in place`);
  } catch (err) {
    logger.warn(`Skill sync: could not check whether ${outcome.sha.slice(0, 9)} was pushed: ${firstLine(err)}`);
  }
}
