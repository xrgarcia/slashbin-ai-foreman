// The `github` config block moved to the core config schema (src/config-schema/github.ts,
// EM#1150 f5): the config loader parses it. The GitHub code reads it from there; this
// path stays for the GitHub modules and the built-output consumers that import it.
export * from "../config-schema/github.js";
