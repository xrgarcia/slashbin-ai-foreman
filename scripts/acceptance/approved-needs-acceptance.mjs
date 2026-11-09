#!/usr/bin/env node
// Acceptance — slashbin-ai-foreman, "an `approved` issue with no committed acceptance
// script is held at pickup, not built".
//
// Read from the Foreman's own surface: the compiled gate module it calls from
// eligible() (dist/github/acceptance-gate.js, export `acceptanceVerdict(body)` ->
// { ok: boolean, reason?: string }). One assertion per case in the SHARED corpus
// test/fixtures/acceptance-gate-cases.json, the corpus the EM hook must agree with (vendored from the EM repo):
//   A* the issue may be built   H* the issue is held, with a reason that names what is missing
//   R1 a held verdict's reason names the `## Acceptance` heading and a fix the author can act on
//   R2 the reason never echoes the issue body
//
//   node scripts/acceptance/approved-needs-acceptance.mjs
//
// Needs a built Foreman (`npm run build` there). Read-only: touches no GitHub, no issue.
// RED until the gate lands: the module does not exist, so B0 fails.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FOREMAN = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const corpus = JSON.parse(readFileSync(join(FOREMAN, 'test', 'fixtures', 'acceptance-gate-cases.json'), 'utf8'))

let failed = 0
const check = (name, pass, detail = '') => { if (!pass) failed++; console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`) }

const mod = join(FOREMAN, 'dist', 'github', 'acceptance-gate.js')
if (!existsSync(mod)) {
  check('B0 gate module present', false, `${mod} missing — not built or not implemented yet`)
  process.exit(1)
}
const { acceptanceVerdict } = await import(pathToFileURL(mod).href)

for (const c of corpus.cases) {
  const v = acceptanceVerdict(c.body)
  check(`${c.id}`, v.ok === c.ok, `expected ok=${c.ok}, got ok=${v.ok}${v.reason ? ` (${v.reason.slice(0, 80)})` : ''}`)
}
const held = corpus.cases.filter((c) => !c.ok).map((c) => ({ c, v: acceptanceVerdict(c.body) }))
check('R1 every hold names the `## Acceptance` heading and a fix', held.every(({ v }) => v.reason && v.reason.includes('## Acceptance') && /Script|No-Script/.test(v.reason)))
check('R2 no hold reason echoes issue prose', held.every(({ c, v }) => !v.reason || !v.reason.includes(c.body.split('\n')[0] + '\n\n')))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
