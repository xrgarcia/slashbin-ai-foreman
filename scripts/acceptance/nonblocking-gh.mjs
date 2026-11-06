#!/usr/bin/env node
// Acceptance for foreman#236: the daemon's GitHub path does not block the event loop.
//
//   npm run build && node scripts/acceptance/nonblocking-gh.mjs
//
// 2026-11-06, 8:34 to 8:53 am: GitHub answered with TLS handshake timeouts, every
// `gh` call was execFileSync, and observer events (the Paperclip board) waited
// behind them for up to 14 minutes. This drives the built `dist/` against a stub
// `gh`, first on PATH, that hangs on every read for longer than the 30 s gh
// timeout and refuses every write. It never reaches GitHub.
//
// Each scenario runs in its own node child (fresh process-wide state):
//   S1 warmState  — the fleet-state refresh the daemon awaits before each lane pass
//   S2 loadRecord — the record store's login read and comment read
//   S3 probe      — the GitHub back-off probe at a window's end
//   S4 control    — a deliberate execFileSync of the same stub: the check must fail here
// In each, while the gh call hangs, an observer event is emitted; it must be
// delivered within 2 s (OBSERVER_TIMEOUT_MS is 30 s), and a 100 ms timer must show
// no gap over 1 s. The stub's log must show the hung read was really in flight,
// and no write ever reached it. Exit 0 when every check holds.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (p) => pathToFileURL(join(root, "dist", p)).href;
const tmp = mkdtempSync(join(tmpdir(), "nonblocking-gh-acceptance-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

const HANG_MS = 35_000; // longer than the 30 s gh timeout
const DELIVERY_MAX_MS = 2_000;
const GAP_MAX_MS = 1_000;

const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
const LOG = join(tmp, "gh.log");
writeFileSync(LOG, "");
// The stub: log, refuse writes, hang on reads. Never a network call.
writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const flat = " " + args.join(" ") + " ";
const write = /\\s-X\\s+(POST|PATCH|PUT|DELETE)\\s/.test(flat) || /--method\\s+(POST|PATCH|PUT|DELETE)/.test(flat) ||
  /^(issue|pr|label|release|repo|gist|secret|variable|workflow|run)\\s+(create|edit|close|reopen|comment|merge|delete|review|ready|lock|unlock|transfer|pin|unpin)\\b/.test(args.join(" "));
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ at: Date.now(), args, write }) + "\\n");
if (write) { process.stderr.write("stub gh: writes are refused\\n"); process.exit(1); }
setTimeout(() => { process.stderr.write("stub gh: hung read gave up\\n"); process.exit(1); }, ${HANG_MS});
`);
chmodSync(join(bin, "gh"), 0o755);

const stubCalls = () => readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Shared by every scenario child: an observer that timestamps one marked event, a
// 100 ms timer that records the largest gap, and the check itself.
const harness = `
  const W = await import(${JSON.stringify(dist("work-source.js"))});
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
  let deliveredAt = null;
  W.addObserver({ onEvent: async (e) => { if (e.upstream === "acceptance-marker") deliveredAt = Date.now(); } });
  let last = Date.now(), maxGap = 0;
  const timer = setInterval(() => { const t = Date.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 100);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function measure(start) {
    // Start the gh-backed call, give it time to spawn the stub, then emit while it hangs.
    // Latency is counted from when the event was due, so a loop that was frozen at
    // that moment shows up as late delivery, not only as a timer gap.
    let settled = false;
    const emittedAt = Date.now() + 500;
    const work = Promise.resolve().then(start).then(() => { settled = true; }, () => { settled = true; });
    await sleep(500);
    void W.emitProcessEvent({ kind: "backoff", upstream: "acceptance-marker", paused: true }, quiet);
    await sleep(2_500);
    clearInterval(timer);
    console.log(JSON.stringify({
      deliveryMs: deliveredAt === null ? null : deliveredAt - emittedAt,
      maxGapMs: maxGap,
      callStillHanging: !settled,
    }));
    process.exit(0);
  }
`;

const scenarios = {
  S1_warmState: `
    const { registerPlugin, startPlugins, codeHost } = await import(${JSON.stringify(dist("plugins/registry.js"))});
    const { GitHubPlugin } = await import(${JSON.stringify(dist("plugins/github.js"))});
    registerPlugin(new GitHubPlugin());
    await startPlugins({ paperclip: { enabled: false } }, { logger: quiet, configText: () => null });
    const host = codeHost();
    host.configureState({ repos: ["example/acceptance"], refreshMs: 30_000, logger: quiet });
    if (typeof host.warmState !== "function") throw new Error("CodeHost.warmState is missing (pre-fix build)");
    await measure(() => host.warmState());
  `,
  S2_loadRecord: `
    const { registerPlugin, startPlugins, activeWorkSource } = await import(${JSON.stringify(dist("plugins/registry.js"))});
    const { GitHubPlugin } = await import(${JSON.stringify(dist("plugins/github.js"))});
    registerPlugin(new GitHubPlugin());
    await startPlugins({ paperclip: { enabled: false } }, { logger: quiet, configText: () => null });
    const ws = activeWorkSource();
    await measure(() => ws.loadRecord({ repo: "example/acceptance", kind: "issue", number: 60 }, { repoPath: ${JSON.stringify(tmp)}, githubRepo: "example/acceptance" }));
  `,
  S3_probe: `
    const BO = await import(${JSON.stringify(dist("backoff.js"))});
    BO.configureBackoff({ ...BO.DEFAULT_BACKOFF, upstream: { baseMs: 100, capMs: 1_000, factor: 2 } });
    const B = await import(${JSON.stringify(dist("upstream-backoff.js"))});
    await import(${JSON.stringify(dist("github/gh.js"))}); // registers the GitHub probe, as the daemon loads it
    B.configureUpstreamBackoff({ notify: () => {}, logger: quiet });
    // The window ends at 100 ms; its probe spawns the stub, which hangs.
    await measure(() => { B.signalUpstreamLimit("github", "acceptance: simulated limit", { resource: "core" }); return new Promise(() => {}); });
  `,
  S4_control: `
    const { execFileSync } = await import("node:child_process");
    // A deliberately synchronous call of the same stub, cut at 5 s: the shape of the pre-fix runGh.
    await measure(async () => { await sleep(400); try { execFileSync("gh", ["api", "user"], { timeout: 5_000, stdio: "pipe" }); } catch {} });
  `,
};

const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOREMAN_GITHUB_TOKEN: "acceptance-fake", GH_TOKEN: "acceptance-fake", FOREMAN_STATE_DIR: tmp };
const results = {};
for (const [name, body] of Object.entries(scenarios)) {
  const before = stubCalls().length;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `${harness}\n${body}`], { env, cwd: tmp, encoding: "utf8", timeout: 20_000 });
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  let out;
  try { out = JSON.parse(line); } catch { out = { error: (r.stderr || `exit ${r.status}`).trim().split("\n").slice(-3).join(" | ") }; }
  out.stubReads = stubCalls().slice(before).filter((c) => !c.write).map((c) => c.args.slice(0, 3).join(" "));
  results[name] = out;
}

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

for (const [name, want] of [["S1_warmState", /^api graphql/], ["S2_loadRecord", /^api (user|--paginate)/], ["S3_probe", /^api rate_limit/]]) {
  const r = results[name];
  check(`${name}: the hung gh read was in flight`, !r.error && r.callStillHanging && r.stubReads.some((a) => want.test(a)), JSON.stringify({ error: r.error, hanging: r.callStillHanging, reads: r.stubReads }));
  check(`${name}: observer event delivered within ${DELIVERY_MAX_MS} ms`, !r.error && r.deliveryMs !== null && r.deliveryMs <= DELIVERY_MAX_MS, `deliveryMs=${r.deliveryMs}`);
  check(`${name}: 100 ms timer never gapped over ${GAP_MAX_MS} ms`, !r.error && r.maxGapMs <= GAP_MAX_MS, `maxGapMs=${r.maxGapMs}`);
}
const c = results.S4_control;
check("S4_control: a synchronous gh call fails both checks (the check can fail)", !c.error && c.deliveryMs > DELIVERY_MAX_MS && c.maxGapMs > GAP_MAX_MS, `deliveryMs=${c.deliveryMs} maxGapMs=${c.maxGapMs}`);
const writes = stubCalls().filter((x) => x.write);
check("no write reached the stub gh", writes.length === 0, writes.map((w) => w.args.join(" ")).join("; ") || "none");

for (const k of checks) console.log(`${k.ok ? "PASS" : "FAIL"}  ${k.name}  (${k.detail})`);
const failed = checks.filter((k) => !k.ok).length;
console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
