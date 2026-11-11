#!/usr/bin/env node
// Acceptance — engineering-manager #512, child foreman-paperclip-client-bearer:
// every Foreman Paperclip request carries `authorization: Bearer <key>` when
// AI_AGENT_PAPERCLIP_API_KEY is set, and none when it is unset.
//
// Read from the caller's surface — the Foreman's own CLI (`npm run paperclip:doctor`,
// `npm run paperclip:register`) — against a local stub Paperclip that records the
// headers of every request it receives:
//   B1 key set: every doctor request carries the bearer
//   B2 key set: every register request carries the bearer, POST and PATCH included
//   B3 key unset: no request carries an authorization header
//   B4 the key appears in no line either command prints
//   B5 the doctor sends no non-GET request
//
//   node scripts/acceptance/paperclip-client-bearer.mjs
//
// Needs a built Foreman (`npm run build` in that checkout). Writes: a throwaway
// config in a temp dir, deleted on exit; no live Paperclip is contacted.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from 'node:crypto'

const FOREMAN = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const COMPANY = '00000000-0000-4000-8000-000000000512'
const KEY = `pcak_accept_${randomBytes(12).toString('hex')}`

const results = []
const check = (name, pass, detail = '') => { results.push(pass); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`) }

if (!existsSync(join(FOREMAN, 'dist', 'cli.js'))) {
  check('B0 built Foreman present', false, `${FOREMAN}/dist/cli.js missing — run npm run build there`)
  process.exit(1)
}

// ---- the stub Paperclip ------------------------------------------------------------
let seen = []
const agents = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization ?? null })
    const body = raw ? JSON.parse(raw) : {}
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
    const url = req.url.split('?')[0]
    if (url === '/api/health') return send(200, { status: 'ok', deploymentMode: 'authenticated' })
    if (url === `/api/companies/${COMPANY}`) return send(200, { id: COMPANY, name: 'Stub' })
    if (url === `/api/companies/${COMPANY}/agents` && req.method === 'GET') return send(200, agents)
    if (url === `/api/companies/${COMPANY}/agents` && req.method === 'POST') {
      const a = { id: `00000000-0000-4000-8000-${String(agents.length + 1).padStart(12, '0')}`, companyId: COMPANY, ...body }
      agents.push(a)
      return send(201, a)
    }
    const one = url.match(/^\/api\/agents\/([^/]+)$/)
    if (one) {
      const a = agents.find((x) => x.id === decodeURIComponent(one[1]))
      if (!a) return send(404, { error: 'not found' })
      if (req.method === 'PATCH') Object.assign(a, body)
      return send(200, a)
    }
    return send(req.method === 'GET' ? 200 : 404, req.method === 'GET' ? [] : { error: 'stub' })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const STUB = `http://127.0.0.1:${server.address().port}`

const dir = mkdtempSync(join(tmpdir(), 'em512-bearer-'))
const configPath = join(dir, '.ai-agent.json')
const run = async (cmd, withKey) => {
  writeFileSync(configPath, JSON.stringify({ paperclip: { url: STUB, companyId: COMPANY } }, null, 2) + '\n')
  agents.length = 0
  seen = []
  const env = { ...process.env, AI_AGENT_PAPERCLIP_URL: STUB }
  delete env.AI_AGENT_PAPERCLIP_API_KEY
  if (withKey) env.AI_AGENT_PAPERCLIP_API_KEY = KEY
  const argv = cmd === 'doctor' ? ['dist/cli.js', 'paperclip:doctor', '--config', configPath] : ['scripts/paperclip/agent.mjs', configPath]
  // Async on purpose: a sync spawn blocks this event loop, and the stub could never answer.
  const out = await new Promise((resolve) => {
    const p = spawn('node', argv, { cwd: FOREMAN, env })
    let text = ''
    p.stdout.on('data', (c) => { text += c })
    p.stderr.on('data', (c) => { text += c })
    const timer = setTimeout(() => p.kill(), 60000)
    p.on('close', () => { clearTimeout(timer); resolve(text) })
  })
  return { out, requests: seen }
}
const bearer = `Bearer ${KEY}`

try {
  const dKey = await run('doctor', true)
  const rKey = await run('register', true)
  const dNone = await run('doctor', false)
  const rNone = await run('register', false)

  const allCarry = (rs) => rs.length > 0 && rs.every((r) => r.authorization === bearer)
  check('B1 key set: every doctor request carries the bearer', allCarry(dKey.requests),
    `${dKey.requests.filter((r) => r.authorization === bearer).length}/${dKey.requests.length}`)
  const writes = rKey.requests.filter((r) => r.method !== 'GET')
  check('B2 key set: every register request carries the bearer, writes included', allCarry(rKey.requests) && writes.length > 0,
    `${rKey.requests.filter((r) => r.authorization === bearer).length}/${rKey.requests.length}, ${writes.length} write(s): ${[...new Set(writes.map((w) => w.method))].join(',') || 'none'}`)
  const unset = [...dNone.requests, ...rNone.requests]
  check('B3 key unset: no request carries authorization', unset.length > 0 && unset.every((r) => r.authorization === null),
    `${unset.filter((r) => r.authorization !== null).length} of ${unset.length} carried one`)
  check('B4 the key is printed nowhere', ![dKey.out, rKey.out].some((o) => o.includes(KEY)))
  const dWrites = [...dKey.requests, ...dNone.requests].filter((r) => r.method !== 'GET')
  check('B5 the doctor sends no non-GET', dWrites.length === 0, dWrites.map((r) => `${r.method} ${r.path}`).join(', '))
} finally {
  server.close()
  rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
