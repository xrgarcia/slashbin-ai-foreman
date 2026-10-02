#!/usr/bin/env node
// Register the Foreman as an agent in its Paperclip company, with every wake
// path off, and record the agent's id in the config. Run as
// `npm run paperclip:register [-- config-path]`; with no path it uses the same
// `.ai-agent.json` / `ai-agent.config.json` the daemon reads from the current
// directory. Run `npm run build` first.
//
// Settings (url, companyId, agentName, AI_AGENT_PAPERCLIP_* overrides and
// defaults) come from the BUILT `loadConfig`, so the agent registered is the one
// the daemon will look for. The config file itself must carry a `paperclip`
// block: that is where the id is written, and its absence means the operator
// never opted in, so nothing is sent.
//
// Requests: GET the company's agents; POST one when none has the name; then
// always PATCH both heartbeat flags off (Paperclip defaults wake-on-demand ON,
// and the PATCH repairs an agent switched back on since). The config file is
// written only after all of that succeeds, and only when `paperclip.agentId`
// changes: that one key is set, every other key kept, and the diff printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const builtConfig = join(root, "dist", "config.js");
const builtAgent = join(root, "dist", "paperclip", "agent.js");
const builtClient = join(root, "dist", "paperclip", "client.js");
for (const f of [builtConfig, builtAgent, builtClient]) {
  if (!existsSync(f)) {
    console.error(`${f} not found — run \`npm run build\` first.`);
    process.exit(1);
  }
}
const { loadConfig } = await import(builtConfig);
const { registerPaperclipAgent, PAPERCLIP_AGENT_ADAPTER } = await import(builtAgent);
const { PaperclipClient } = await import(builtClient);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Same resolution order as the daemon's loadConfigFile.
const arg = process.argv[2];
const candidates = arg ? [resolve(arg)] : [resolve(".ai-agent.json"), resolve("ai-agent.config.json")];
const configPath = candidates.find((p) => existsSync(p));
if (!configPath) fail(`No config file: looked for ${candidates.join(", ")}.`);

const before = readFileSync(configPath, "utf-8");
let raw;
try {
  raw = JSON.parse(before);
} catch (err) {
  fail(`${configPath} is not valid JSON: ${err.message}`);
}
if (!isObject(raw) || !isObject(raw.paperclip)) {
  fail(`${configPath} has no "paperclip" block. Add one with at least "companyId" (and "url" if Paperclip is not at http://127.0.0.1:3100), then re-run.`);
}

let paperclip;
try {
  ({ paperclip } = loadConfig(configPath));
} catch (err) {
  fail(`${configPath} does not load: ${err.message}`);
}
if (!paperclip.companyId) fail(`${configPath}: paperclip.companyId is not set.`);

const client = new PaperclipClient({ url: paperclip.url, companyId: paperclip.companyId });
let result;
try {
  result = await registerPaperclipAgent(client, paperclip.agentName);
} catch (err) {
  fail(`Registration against ${paperclip.url} failed: ${err.message}\nNothing was written to ${configPath}.`);
}
const { agent, created } = result;

console.log(`${created ? "Registered" : "Found"} Paperclip agent "${agent.name ?? paperclip.agentName}" (${agent.id}) in company ${paperclip.companyId}; heartbeat and wake-on-demand are off.`);
if (agent.adapterType && agent.adapterType !== PAPERCLIP_AGENT_ADAPTER) {
  console.log(`Note: this agent's adapter is "${agent.adapterType}", not "${PAPERCLIP_AGENT_ADAPTER}". Left as is; with its wake paths off Paperclip starts no run either way.`);
}

if (raw.paperclip.agentId === agent.id) {
  console.log(`${configPath} already records paperclip.agentId; unchanged.`);
  process.exit(0);
}

raw.paperclip.agentId = agent.id;
const indent = before.match(/^[{[]\r?\n([ \t]+)/)?.[1] ?? 2;
const after = JSON.stringify(raw, null, indent) + (before.endsWith("\n") ? "\n" : "");
writeFileSync(configPath, after);

// The changed lines, between the unchanged ones at either end.
const a = before.split("\n");
const b = after.split("\n");
let head = 0;
while (head < a.length && head < b.length && a[head] === b[head]) head++;
let tail = 0;
while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
console.log(`Wrote paperclip.agentId to ${configPath}:`);
console.log(`--- ${configPath}`);
console.log(`+++ ${configPath}`);
for (const l of a.slice(head, a.length - tail)) console.log(`-${l}`);
for (const l of b.slice(head, b.length - tail)) console.log(`+${l}`);
