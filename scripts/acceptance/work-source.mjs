#!/usr/bin/env node
/**
 * Acceptance for EM#425 child "work-source-adapter-interface" — the Foreman,
 * not the skill, selects the work: selection sits behind a WorkSourceAdapter
 * with GitHub as the first connector, and the selected items are handed to the
 * implement agent explicitly, so a second source (EM#417, Paperclip) can feed
 * work the skill would never find with its own `gh issue list`.
 *
 * Front door: the BUILT Foreman (`dist/`) — `GitHubIssueConnector.selectWork`
 * and `implementApprovedIssues`, on a RepoConfig from the built `loadConfig`.
 * `gh` and `claude` are FAKES first on PATH: fake gh answers `issue list` with
 * a canned board and every other call with "[]"; fake claude records its argv.
 * The token is a dummy. Nothing reaches GitHub or Anthropic.
 *
 * RED TODAY (features 986a841): no adapters module, no GitHubIssueConnector,
 * the old selectors still exist, and in skill mode the prompt never names the
 * batch (phases/implement-workflow.ts, skill-mode prompt — the skill runs its own query).
 *
 *   A. src/adapters.ts exists and imports nothing GitHub-specific
 *   B. GitHubIssueConnector.selectWork on the canned board returns exactly #1
 *      (#2 blocked, #3 already in a lifecycle state, #4 not triggered)
 *   C. findActionableIssues / findAllApprovedActionableIssues are gone from src/
 *   D. implementApprovedIssues(…, [7]) in skill mode → the prompt names issue 7
 *      as the work to do (the hand-off)
 *
 *   node scripts/acceptance/work-source.mjs
 *   (default ~/code/slashbin-ai-foreman; run `npm run build` there first)
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) if (k.startsWith("AI_AGENT_")) delete process.env[k];

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of ["config.js", "phases/implement-workflow.js", "github.js", "logger.js"]) {
  if (!existsSync(join(DIR, "dist", f))) {
    console.error(`no build at ${join(DIR, "dist", f)} — run \`npm run build\` in ${DIR}`);
    process.exit(2);
  }
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), "foreman-425-ws-"));
const bin = join(tmp, "bin");
const capture = join(tmp, "claude-capture.json");
mkdirSync(bin);
const board = [
  { number: 1, title: "ready", labels: [{ name: "approved" }] },
  { number: 2, title: "blocked", labels: [{ name: "approved" }, { name: "blocked" }] },
  { number: 3, title: "in review", labels: [{ name: "approved" }, { name: "pr under review" }] },
  { number: 4, title: "untriggered", labels: [] },
];
// A buildable issue body: the work source holds an issue whose body has no `## Acceptance` script (github/acceptance-gate.ts).
const ISSUE_BODY = "## Acceptance\n- **Script:** `scripts/acceptance/ready-acceptance.mjs`\n";
writeFileSync(join(bin, "gh"),
  `#!/usr/bin/env node\nconst a=process.argv.slice(2);\n` +
  `if(a[0]==="issue"&&a[1]==="list"){process.stdout.write(${JSON.stringify(JSON.stringify(board))});}else if(a[0]==="api"&&/issues\\/\\d+$/.test(a[1]||"")){process.stdout.write(${JSON.stringify(ISSUE_BODY)});}else if(a[0]==="api"&&/branches\\//.test(a[1]||"")){process.stdout.write("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");}else{process.stdout.write("[]");}\n`);
writeFileSync(join(bin, "claude"),
  `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2)}));\n` +
  `process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"acceptance fake"})+"\\n");\n`);
chmodSync(join(bin, "gh"), 0o755);
chmodSync(join(bin, "claude"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "acceptance-dummy-not-a-token";

const imp = (f) => import(pathToFileURL(join(DIR, "dist", f)).href);
const { loadConfig } = await imp("config.js");
const github = await imp("github.js");
const { implementApprovedIssues } = await imp("phases/implement-workflow.js");
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

const repoDir = join(tmp, "repo");
mkdirSync(join(repoDir, ".claude", "skills", "implement-approved-issues"), { recursive: true });
writeFileSync(join(repoDir, ".claude", "skills", "implement-approved-issues", "SKILL.md"), "# repo-local skill\n");
const cfgPath = join(tmp, "cfg.json");
writeFileSync(cfgPath, JSON.stringify({
  repos: [{ name: "acceptance", repoPath: repoDir, githubRepo: "example/acceptance",
    skillPath: ".claude/skills/implement-approved-issues/SKILL.md" }],
}));
const config = loadConfig(cfgPath);
const repoConfig = config.repos[0];

try {
  const adapters = join(DIR, "src", "adapters.ts");
  const src = existsSync(adapters) ? readFileSync(adapters, "utf8") : null;
  check("A src/adapters.ts exists", !!src);
  check("A adapters.ts imports nothing GitHub-specific", !!src && !/from\s+["']\.\/github(\.js)?["']/.test(src));

  let picked = null, err = null;
  try {
    const Connector = (await imp("github-work-source.js")).GitHubIssueConnector;
    if (typeof Connector !== "function") throw new Error("GitHubIssueConnector not exported from dist/github-work-source.js");
    picked = await new Connector().selectWork(repoConfig, config, logger);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const nums = Array.isArray(picked) ? picked.map((w) => w.issueNumber).sort() : null;
  check("B GitHub connector selects exactly the actionable issue", JSON.stringify(nums) === "[1]", err ?? JSON.stringify(picked));

  const left = readdirSync(join(DIR, "src")).filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .filter((f) => /\bfind(All)?ApprovedActionableIssues\b|\bfindActionableIssues\b/.test(readFileSync(join(DIR, "src", f), "utf8")));
  check("C old selectors removed from src/", left.length === 0, left.join(" "));

  rmSync(capture, { force: true });
  try { await implementApprovedIssues(trust, repoConfig, logger, undefined, null, [7]); } catch { /* the capture is the evidence */ }
  const prompt = existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")).argv.join("\n") : "";
  check("D skill-mode prompt hands over the selected work item", /#7\b|issue 7\b|issues?:?\s*\[?7\b/i.test(prompt),
    prompt ? "" : "claude not launched");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
