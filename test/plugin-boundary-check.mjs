// Pure ratchet logic for test/plugin-boundary.test.mjs (EM#1150); no I/O.
import { posix } from "node:path";

/** Plugin code: GitHub, Paperclip, and each plugin implementation under src/plugins/. */
const PLUGIN_FILES = [
  /^github\//,
  /^github\.ts$/,
  /^github-work-source\.ts$/,
  /^github-state\.ts$/,
  /^paperclip\//,
  /^plugins\/(?!contract\.ts$|registry\.ts$|index\.ts$)/,
];
export const isPlugin = (rel) => PLUGIN_FILES.some((re) => re.test(rel));
/** The composition root names plugins; that is its job. */
export const COMPOSITION_ROOT = "plugins/index.ts";

/** The plugin files a src-relative file imports, given its import specifiers (relative ones only count). */
export function pluginImportsOf(rel, specifiers) {
  return specifiers
    .filter((spec) => spec.startsWith("."))
    .map((spec) => posix.normalize(posix.join(posix.dirname(rel), spec)).replace(/\.js$/, ".ts"))
    .filter(isPlugin);
}

/** Each core file's count of imports into plugin code. `imports` maps src-relative file to its specifiers. */
export function countViolations(imports) {
  const out = {};
  for (const [rel, specs] of Object.entries(imports)) {
    if (isPlugin(rel) || rel === COMPOSITION_ROOT) continue;
    const n = pluginImportsOf(rel, specs).length;
    if (n > 0) out[rel] = n;
  }
  return out;
}

/**
 * A plugin under src/plugins/ (the Tech Lead, SRE, QA, EM, Paperclip plugins and
 * their shared runner). No allowlist ever covers core importing one (EM#1150 f3):
 * the agents are reached only through the registry's roleFor/qaFor.
 */
export const isAgentPlugin = (rel) => /^plugins\/(?!contract\.ts$|registry\.ts$|index\.ts$)/.test(rel);

/** The ratchet: the problems (empty when clean) of `imports` against the allowlist. */
export function checkBoundary(imports, allowlist) {
  const now = countViolations(imports);
  const problems = [];
  for (const [rel, specs] of Object.entries(imports)) {
    if (isPlugin(rel) || rel === COMPOSITION_ROOT) continue;
    for (const target of pluginImportsOf(rel, specs).filter(isAgentPlugin)) {
      problems.push(`src/${rel} imports the plugin src/${target} directly; reach it through src/plugins/registry.ts (roleFor)`);
    }
  }
  for (const [file, n] of Object.entries(now)) {
    const allowed = allowlist[file];
    if (allowed === undefined) problems.push(`src/${file} imports plugin code directly (${n}); call it through src/plugins/registry.ts`);
    else if (n > allowed) problems.push(`src/${file} plugin imports grew ${allowed} -> ${n}; call the new ones through the registry`);
  }
  for (const [file, allowed] of Object.entries(allowlist)) {
    const n = now[file] ?? 0;
    if (n < allowed) problems.push(`src/${file} is down to ${n} plugin imports from ${allowed}: lower KNOWN_VIOLATORS to ${n}${n === 0 ? " (delete the line)" : ""}`);
  }
  return problems;
}
