#!/usr/bin/env node
/**
 * Acceptance for EM#425 child "builtin-default-skills" — the Foreman ships
 * generic implement and revise skills, a repo selects them with `builtin:`,
 * an optional overlay file is appended, and today's repo-local skillPath keeps
 * working unchanged.
 *
 * Front door: the BUILT Foreman's `implementApprovedIssues` / `revisePRFeedback`
 * (`dist/phases/implement-workflow.js`, `revise-workflow.js`) on a RepoConfig from the built `loadConfig` — exactly what
 * the daemon calls for a managed repo. `claude` and `gh` are FAKES placed first
 * on PATH: fake claude records its argv + FOREMAN_* env and exits 0; fake gh
 * prints "[]" and exits 0. Nothing reaches GitHub or Anthropic, and the token
 * handed to the Foreman is a dummy, so no case can write anywhere real.
 *
 * RED TODAY (features 986a841): no `skills/` dir in the Foreman, `builtin:`
 * is passed through as a literal path, no overlay field exists.
 *
 *   A. skillPath "builtin:" → prompt carries the bundled implement skill
 *      (skills/implement/SKILL.md, by content or absolute path)
 *   B. revisionSkillPath "builtin:" → prompt carries skills/revise/SKILL.md
 *   C. skillOverlayPath (exists) → overlay text appears in the prompt AFTER the skill
 *   D. skillOverlayPath (missing) → claude never launched, result not success
 *   E. builtin, no overlay → prompt names no Slashbin repo and no literal label
 *   F. today's repo-local skillPath → prompt still points at that path (regression)
 *   G. skills/ in the Foreman carries no Slashbin identity and no literal label
 *
 *   node scripts/acceptance/builtin-skills.mjs
 *   (default ~/code/slashbin-ai-foreman; run `npm run build` there first)
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of ["config.js", "phases/implement-workflow.js", "phases/revise-workflow.js", "logger.js"]) {
  if (!existsSync(join(DIR, "dist", f))) {
    console.error(`no build at ${join(DIR, "dist", f)} — run \`npm run build\` in ${DIR}`);
    process.exit(2);
  }
}
const imp = (f) => import(pathToFileURL(join(DIR, "dist", f)).href);
const { loadConfig } = await imp("config.js");
const { implementApprovedIssues } = await imp("phases/implement-workflow.js");
const { revisePRFeedback } = await imp("phases/revise-workflow.js");
const { createLogger } = await imp("logger.js");
// Claude trust lives on the runtime (Foreman #203); the spawn paths take it first.
const { ForemanRuntime } = await imp("runtime.js");
const { trust } = new ForemanRuntime();
// The core reaches the code host through the plugin registry (EM#1150 f5); a bare script has none
// started, so install the built-in GitHub plugin's hosts directly (pure; they only run `gh`, here a fake).
{
  const reg = await imp("plugins/registry.js");
  const { GitHubPlugin } = await imp("plugins/github.js");
  const ghPlugin = new GitHubPlugin();
  reg.setCodeHost(ghPlugin.codeHost);
  reg.setWorkSource(ghPlugin.workSource);
}
const logger = createLogger({ format: "text", level: "error" });

const SLASHBIN_LABELS = ["approved", "pr under review", "pr pending actions", "pr approved", "ready for prod release", "ready to close"];
const SLASHBIN_ID = /slashbin-engineering-manager|xrgarcia\//;
const literalLabel = new RegExp(`"(${SLASHBIN_LABELS.join("|")})"|--label (${SLASHBIN_LABELS.map((l) => (l.includes(" ") ? `"${l}"` : l)).join("|")})\\b`);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), "foreman-425-skills-"));
const bin = join(tmp, "bin");
const capture = join(tmp, "claude-capture.json");
mkdirSync(bin);
writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}'); // the fakes are CJS; a stray ancestor package.json (type:module) must not turn them ESM
writeFileSync(join(bin, "claude"),
  `#!/usr/bin/env node\nconst fs=require("fs");\n` +
  `const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith("FOREMAN_")&&k!=="FOREMAN_GITHUB_TOKEN"));\n` +
  `fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),env}));\n` +
  `process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"acceptance fake"})+"\\n");\n`);
// The implement path reads the branch head first (github/branch.ts getRemoteBranchSha): answer it with a fixed sha.
writeFileSync(join(bin, "gh"), "#!/bin/sh\ncase \"$*\" in *branches/*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; *) echo '[]';; esac\n");
chmodSync(join(bin, "claude"), 0o755);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "acceptance-dummy-not-a-token";

const repoDir = join(tmp, "repo");
mkdirSync(join(repoDir, ".claude", "skills", "implement-approved-issues"), { recursive: true });
writeFileSync(join(repoDir, ".claude", "skills", "implement-approved-issues", "SKILL.md"), "# repo-local skill\n");
const OVERLAY_SENTINEL = "OVERLAY-SENTINEL-425";
writeFileSync(join(repoDir, "overlay.md"), `${OVERLAY_SENTINEL}: operator-specific rules\n`);

const repoConfig = (extra) => {
  const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({
    lifecycleLabels: { prUnderReview: "acme-review", prPendingActions: "acme-fix", prApproved: "acme-ok",
      readyForProd: "acme-ship", readyToClose: "acme-close" },
    triggerLabel: "acme-go",
    repos: [{ name: "acceptance", repoPath: repoDir, githubRepo: "example/acceptance", ...extra }],
  }));
  return loadConfig(p).repos[0];
};

const run = async (fn, extra) => {
  rmSync(capture, { force: true });
  let result, error;
  try {
    const cfg = repoConfig(extra);
    result = fn === "revise" ? await revisePRFeedback(trust, cfg, logger, undefined, 1, [1])
      : await implementApprovedIssues(trust, cfg, logger, undefined, null, [1]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const cap = existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) : null;
  return { result, error, cap, prompt: cap ? cap.argv.join("\n") : "" };
};

const skillsDir = join(DIR, "skills");
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const implementSkill = read(join(skillsDir, "implement", "SKILL.md"));
const reviseSkill = read(join(skillsDir, "revise", "SKILL.md"));
const carries = (prompt, text, path) =>
  !!text && (prompt.includes(path) || prompt.includes(text.trim().split("\n").find((l) => l.trim().length > 20) ?? "\u0000"));

try {
  const a = await run("implement", { skillPath: "builtin:" });
  check("A builtin implement skill reaches the prompt", carries(a.prompt, implementSkill, join(skillsDir, "implement", "SKILL.md")),
    a.cap ? "" : `claude not launched${a.error ? `: ${a.error.slice(0, 120)}` : ""}`);
  check("A configured labels reach the skill env",
    !!a.cap && /acme-review/.test(a.cap.env.FOREMAN_LIFECYCLE_LABELS ?? "") && a.cap.env.FOREMAN_TRIGGER_LABEL === "acme-go");

  const b = await run("revise", { revisionSkillPath: "builtin:" });
  check("B builtin revise skill reaches the prompt", carries(b.prompt, reviseSkill, join(skillsDir, "revise", "SKILL.md")),
    b.cap ? "" : `claude not launched${b.error ? `: ${b.error.slice(0, 120)}` : ""}`);

  const c = await run("implement", { skillPath: "builtin:", skillOverlayPath: "overlay.md" });
  const skillAt = implementSkill ? Math.max(c.prompt.indexOf(join(skillsDir, "implement", "SKILL.md")), c.prompt.indexOf("skills/implement")) : -1;
  const overlayAt = c.prompt.indexOf(OVERLAY_SENTINEL);
  check("C overlay appended after the built-in skill", overlayAt > -1 && skillAt > -1 && overlayAt > skillAt,
    `overlay@${overlayAt} skill@${skillAt}`);

  const d = await run("implement", { skillPath: "builtin:", skillOverlayPath: "missing-overlay.md" });
  check("D missing overlay: claude never launched and not success",
    !d.cap && !(d.result && d.result.success), d.cap ? "claude was launched" : "");

  const e = await run("implement", { skillPath: "builtin:" });
  // Strip absolute filesystem paths first: argv carries the install path of the
  // Foreman's own overrides file, and `/home/xrgarcia/…` matched `xrgarcia/`
  // while naming no repo (caught on the first green build of #56).
  // Also strip paths that follow a quote or backslash-escaped quote (the settings JSON now quotes the hook path).
  const promptText = e.prompt.replace(/(^|[\s"'`=\\])\/[^\s"'`\\]+/g, "$1");
  check("E builtin prompt names no Slashbin repo", !!e.cap && !SLASHBIN_ID.test(promptText),
    e.cap ? (promptText.match(new RegExp(`.{0,60}${SLASHBIN_ID.source}.{0,40}`))?.[0] ?? "") : "claude not launched");
  check("E builtin prompt carries no literal Slashbin label", !!e.cap && !literalLabel.test(e.prompt));

  const f = await run("implement", { skillPath: ".claude/skills/implement-approved-issues/SKILL.md" });
  check("F repo-local skillPath unchanged", !!f.cap && f.prompt.includes(".claude/skills/implement-approved-issues/SKILL.md"));

  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  if (existsSync(skillsDir)) walk(skillsDir);
  check("G skills/ exists with implement and revise", !!implementSkill && !!reviseSkill);
  const idHits = files.filter((p) => SLASHBIN_ID.test(readFileSync(p, "utf8")));
  const labelHits = files.filter((p) => literalLabel.test(readFileSync(p, "utf8")));
  check("G skills/ carries no Slashbin identity", files.length > 0 && idHits.length === 0, idHits.join(" "));
  check("G skills/ carries no literal Slashbin label", files.length > 0 && labelHits.length === 0, labelHits.join(" "));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
