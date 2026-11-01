// The `paperclip` config block moved to the core config schema (src/config-schema/paperclip.ts,
// EM#1150 f5): the config loader parses it. The plugin reads it from there; this path
// stays for the plugin modules and the built-output consumers that import it.
export * from "../config-schema/paperclip.js";
