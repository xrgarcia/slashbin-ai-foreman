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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";

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

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
}
function gitBuf(args: string[], cwd: string): Buffer {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
}
function firstLine(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const text = `${e?.stderr ?? ""}`.trim() || `${e?.message ?? err}`;
  return text.split("\n")[0].slice(0, 200);
}

interface TreeEntry { mode: string; oid: string; path: string }
function lsTree(cwd: string, ref: string, path: string): TreeEntry[] {
  const out = execFileSync("git", ["ls-tree", "-r", "-z", ref, "--", path], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  return out.split("\0").filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    const [mode, , oid] = l.slice(0, tab).split(" ");
    return { mode, oid, path: l.slice(tab + 1) };
  });
}

/** Fetch `ref` first when it names a branch of a configured remote (origin/develop). */
function fetchRef(cwd: string, ref: string): void {
  const slash = ref.indexOf("/");
  if (slash <= 0) return;
  const remote = ref.slice(0, slash);
  if (!git(["remote"], cwd).split("\n").includes(remote)) return;
  git(["fetch", "--quiet", remote, ref.slice(slash + 1)], cwd);
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
function readGit(cfg: SkillSyncConfig, fetch: boolean): Golden {
  const cwd = cfg.repoPath!;
  if (fetch) fetchRef(cwd, cfg.ref);
  const skills = new Map<string, Map<string, Buffer>>();
  const origin = new Map<string, string>();
  for (const raw of cfg.dirs) {
    const dir = raw.replace(/\/+$/, "");
    const found = new Map<string, Map<string, Buffer>>();
    for (const e of lsTree(cwd, cfg.ref, dir)) {
      const rest = e.path.slice(dir.length + 1);
      const slash = rest.indexOf("/");
      if (slash <= 0) continue; // a file directly in the directory, not a skill
      if (e.mode === "120000") throw new Error(`${e.path} is a symlink at ${cfg.ref} — a golden skill must be real files`);
      const name = rest.slice(0, slash);
      const files = found.get(name) ?? new Map<string, Buffer>();
      files.set(rest.slice(slash + 1), gitBuf(["cat-file", "blob", e.oid], cwd));
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
  const version = git(["log", "-1", "--format=%h", cfg.ref, "--", ...cfg.dirs], cwd) || git(["rev-parse", "--short", cfg.ref], cwd);
  return { label: cfg.label ?? basename(cwd), version, hash: goldenHash(skills), skills, origin };
}

/** Read the golden now. `fetch: false` reads the ref as last fetched (the doctor's read-only mode). */
export function readGolden(cfg: SkillSyncConfig, opts: { fetch?: boolean } = {}): Golden {
  return cfg.source === "git" ? readGit(cfg, opts.fetch ?? true) : readBuiltin(cfg);
}

let cache: { key: string; at: number; golden: Golden } | null = null;
let lastGoldenError: string | null = null;

/**
 * The golden, reused for `refreshMs` so a fleet of repos costs one fetch, not
 * one per repo per poll. Null when unreadable; the error is logged once until
 * it changes or clears.
 */
export function currentGolden(cfg: SkillSyncConfig, logger: Logger, now = Date.now()): Golden | null {
  const key = JSON.stringify([cfg.source, cfg.repoPath, cfg.ref, cfg.dirs, cfg.label]);
  if (cache && cache.key === key && now - cache.at < cfg.refreshMs) return cache.golden;
  try {
    const golden = readGolden(cfg);
    cache = { key, at: now, golden };
    lastGoldenError = null;
    return golden;
  } catch (err) {
    const why = firstLine(err);
    if (why !== lastGoldenError) logger.warn(`Skill sync: golden source unreadable — no skill is synced until it reads: ${why}`);
    lastGoldenError = why;
    return null;
  }
}

/** Forget the cached golden and the logged notices (tests). */
export function resetSkillSyncCache(): void {
  cache = null;
  lastGoldenError = null;
  driftLogged.clear();
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
export function repoSkillsAt(repoPath: string, ref: string, targetDir: string, names: readonly string[]): Map<string, Map<string, Buffer>> {
  const out = new Map<string, Map<string, Buffer>>();
  for (const skill of names) {
    const base = `${targetDir.replace(/\/+$/, "")}/${skill}`;
    const files = new Map<string, Buffer>();
    for (const e of lsTree(repoPath, ref, base)) {
      if (e.mode === "120000") throw new Error(`${e.path} is a symlink at ${ref}`);
      files.set(e.path.slice(base.length + 1), gitBuf(["cat-file", "blob", e.oid], repoPath));
    }
    out.set(skill, files);
  }
  return out;
}

/** A repo's drift at `ref` (default: the feature branch as last fetched — what the session's Phase 0 pulls). */
export function driftAt(repoPath: string, ref: string, cfg: SkillSyncConfig, golden: Golden, names: readonly string[]): SkillDrift[] {
  return compareSkills(golden, names, repoSkillsAt(repoPath, ref, cfg.targetDir, names));
}

/** "a (stale), b (missing)" */
export function describeDrift(drift: readonly SkillDrift[]): string {
  return drift.filter((d) => d.state !== "current").map((d) => `${d.skill} (${d.state})`).join(", ");
}

export interface SkillSyncRepo {
  name: string;
  repoPath: string;
  featureBranch: string;
  skillSyncSkills?: readonly string[];
}

const driftLogged = new Map<string, string>();

/**
 * Say once that a repo's copy is behind the golden — once per repo per golden
 * version and stale set, not every poll. Read-only: the copy is brought
 * current only when the repo's next approved issue is built. Never throws.
 */
export function noticeSkillDrift(cfg: SkillSyncConfig, repo: SkillSyncRepo, logger: Logger): void {
  if (!cfg.enabled) return;
  try {
    const golden = currentGolden(cfg, logger);
    if (!golden) return;
    const names = skillsFor(cfg, golden, repo.skillSyncSkills);
    if (names.length === 0) return;
    const drift = driftAt(repo.repoPath, `origin/${repo.featureBranch}`, cfg, golden, names);
    const stale = describeDrift(drift);
    if (!stale) {
      driftLogged.delete(repo.name);
      return;
    }
    const key = `${golden.hash}|${stale}`;
    if (driftLogged.get(repo.name) === key) return;
    driftLogged.set(repo.name, key);
    logger.info(
      `Skill drift on origin/${repo.featureBranch}: ${stale} behind ${golden.label}@${golden.version} — ` +
      "synced in the commit before the next approved issue's session",
    );
  } catch (err) {
    logger.debug(`Skill drift check could not read ${repo.name}: ${firstLine(err)}`);
  }
}

// --- The sync ---

export type SyncOutcome =
  | { status: "current" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  | { status: "synced"; sha: string; skills: string[]; subject: string };

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
export function syncSkillsForIssue(
  cfg: SkillSyncConfig,
  repo: SkillSyncRepo,
  issues: readonly number[],
  logger: Logger,
): SyncOutcome {
  const golden = currentGolden(cfg, logger);
  if (!golden) return { status: "skipped", reason: "golden source unreadable" };
  const names = skillsFor(cfg, golden, repo.skillSyncSkills);
  if (names.length === 0) return { status: "current" };
  const cwd = repo.repoPath;
  const fb = repo.featureBranch;
  const target = cfg.targetDir.replace(/\/+$/, "");
  try {
    // A tracked change in the clone belongs to someone; checking out over it
    // or committing beside it would take it along. Untracked files stay out of
    // the commit either way, since only the skill paths are staged.
    if (git(["status", "--porcelain", "--untracked-files=no"], cwd)) {
      return { status: "skipped", reason: "the checkout has uncommitted changes" };
    }
    git(["fetch", "--quiet", "origin", fb], cwd);
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) !== fb) git(["checkout", "--quiet", fb], cwd);
    const ahead = Number(git(["rev-list", "--count", `origin/${fb}..HEAD`], cwd));
    const behind = Number(git(["rev-list", "--count", `HEAD..origin/${fb}`], cwd));
    // Local commits origin has not seen are not ours to build on: the next
    // push would carry them under this issue's name.
    if (ahead > 0) return { status: "skipped", reason: `local ${fb} has ${ahead} commit(s) origin/${fb} does not` };
    if (behind > 0) git(["merge", "--quiet", "--ff-only", `origin/${fb}`], cwd);

    const have = repoSkillsAt(cwd, "HEAD", target, names);
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
      if (extra.length > 0) git(["rm", "--quiet", "--", ...extra], cwd);
      for (const [p, bytes] of want) {
        const dest = join(cwd, base, p);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
      }
      git(["add", "--", ...[...want.keys()].map((p) => `${base}/${p}`)], cwd);
    }
    if (!git(["diff", "--cached", "--name-only"], cwd)) return { status: "current" };

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
    git(["commit", "--quiet", "--no-verify", "-m", subject, "-m", body], cwd);
    const sha = git(["rev-parse", "HEAD"], cwd);
    logger.info(`Skill sync: ${subject} — ${sha.slice(0, 9)}, pushed with the session's work`);
    return { status: "synced", sha, skills: stale, subject };
  } catch (err) {
    const error = firstLine(err);
    logger.warn(`Skill sync failed — implementing on the existing skill: ${error}`);
    // Leave the index as it was found, so the session does not inherit a half-staged sync.
    try { git(["reset", "--quiet"], cwd); } catch { /* the session's Phase 0 reports a broken checkout */ }
    return { status: "failed", error };
  }
}

/**
 * After the session: a sync commit the session did not push is taken back off
 * the local branch. Left there, the next push — another issue's — would carry
 * a headline naming THIS issue, and PR linkage reads commit headlines. The next
 * pickup syncs again under its own number. Never throws.
 */
export function settleSkillSync(repo: SkillSyncRepo, outcome: SyncOutcome, logger: Logger): void {
  if (outcome.status !== "synced") return;
  const cwd = repo.repoPath;
  const fb = repo.featureBranch;
  try {
    git(["fetch", "--quiet", "origin", fb], cwd);
    try {
      git(["merge-base", "--is-ancestor", outcome.sha, `origin/${fb}`], cwd);
      return; // pushed with the work
    } catch { /* not on origin */ }
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) === fb && git(["rev-parse", "HEAD"], cwd) === outcome.sha) {
      git(["reset", "--quiet", "--keep", `${outcome.sha}~1`], cwd);
      logger.info(`Skill sync ${outcome.sha.slice(0, 9)} was not pushed (no work landed) — taken back off local ${fb}; the next issue syncs again`);
      return;
    }
    logger.warn(`Skill sync ${outcome.sha.slice(0, 9)} is unpushed under other local work on ${fb} — left in place`);
  } catch (err) {
    logger.warn(`Skill sync: could not check whether ${outcome.sha.slice(0, 9)} was pushed: ${firstLine(err)}`);
  }
}
