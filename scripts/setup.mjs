#!/usr/bin/env node
// `npm run setup [-- --config <path>]`: the last step of installing the Foreman.
// `npm run setup` has already installed and built; this script then
//
//   1. stops, with what to do, if there is no config yet (docs/setup.md);
//   2. installs every label the config names on every repo (labels:install —
//      creates the missing ones, never changes an existing one);
//   3. runs the doctor, so the last thing printed is whether the Foreman is
//      ready to start and, if not, exactly what is missing.
//
// Safe to re-run at any time: every step only reads, or creates what is absent.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const { findConfigFile } = await import(join(root, "dist", "config.js"));
const configArg = args.includes("--config") ? args[args.indexOf("--config") + 1] : args.find((a) => !a.startsWith("-"));
const passOn = configArg ? [configArg] : [];

if (!findConfigFile(configArg) && !process.env.AI_AGENT_REPO_PATH) {
  console.log(`No config yet: ${configArg ?? ".ai-agent.json"} is missing.

The Foreman needs one before setup can install anything — at least the repos it
works on. Either:

  • ask Claude in this directory to "set up the Foreman" — it asks a few
    questions and writes the file for you; or
  • follow docs/setup.md: copy .ai-agent.example.json to .ai-agent.json and
    edit the repos.

Then run \`npm run setup\` again.`);
  process.exit(1);
}

const step = (title, script) => {
  console.log(`\n== ${title} ==`);
  const r = spawnSync(process.execPath, [join(root, "scripts", script), ...passOn], { stdio: "inherit", cwd: process.cwd() });
  return r.status === 0;
};

const labels = step("Labels", "install-labels.mjs");
const ready = step("Doctor", "doctor.mjs");
if (!labels && ready) console.log("\nThe label install reported a failure above; the doctor found every label present.");
process.exit(ready ? 0 : 1);
