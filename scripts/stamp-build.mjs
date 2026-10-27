#!/usr/bin/env node
// Records which commit dist/ was built from, and any source that was not
// committed when it was built. The daemon refuses to start on a build with
// uncommitted source (src/build-info.ts), so what runs is always a commit.
//
// Origin: 2026-10-12/13, an uncommitted edit in the live checkout was built and
// ran in production for a day with no commit behind it (4b6c4d3).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

// Everything tsc compiles or resolves from, untracked files in src/ included.
const SOURCES = ["src", "package.json", "package-lock.json", "tsconfig.json"];

let info;
try {
  const commit = git("rev-parse", "HEAD").trim();
  const dirty = git("status", "--porcelain", "--", ...SOURCES).split("\n").filter(Boolean);
  info = { commit, dirty, builtAt: new Date().toISOString() };
} catch (err) {
  info = { commit: null, dirty: null, builtAt: new Date().toISOString(), error: String(err.message ?? err).split("\n")[0] };
}
writeFileSync(join(root, "dist", "build-info.json"), JSON.stringify(info, null, 2) + "\n");
if (info.dirty?.length) console.warn(`build-info: built with uncommitted source; the daemon will refuse to start on it:\n  ${info.dirty.join("\n  ")}`);
