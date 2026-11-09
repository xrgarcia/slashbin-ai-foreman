#!/usr/bin/env node
// Writes schemas/<role>.v1.json from the zod schemas in src/contract/result-v1.ts.
// The test `published schemas match the code` fails when these drift. Run after `npm run build`.
import { writeFileSync, mkdirSync } from "node:fs";
import { roleJsonSchemas } from "../../dist/contract/result-v1.js";

const dir = new URL("../../schemas/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [role, schema] of Object.entries(roleJsonSchemas())) {
  writeFileSync(new URL(`${role}.v1.json`, dir), JSON.stringify(schema, null, 2) + "\n");
  console.log(`schemas/${role}.v1.json`);
}
