// Runs ONE Scriptable script in Node the way the app would, and prints a JSON report on stdout.
// Used by compat.ts (one child process per script and mode, so a stuck script can be killed).
//   node tests/compat-one.ts <file.js> <app|widget> <folder-with-other-scripts>
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { runScript, toBase64, fromBase64 } from '../src/runtime/scriptable.ts'
import type { Host } from '../src/runtime/types.ts'

const [file, mode, dir] = process.argv.slice(2)
const hosts = new Set<string>()
const choices: string[] = []
const logs: string[] = []

const host: Host = {
  // The same RelayRequest/RelayResponse the phone sends to the bridge, performed here directly.
  fetch: async req => {
    hosts.add(new URL(req.url).host)
    const res = await fetch(req.url, {
      method: req.method, headers: req.headers,
      body: req.bodyBase64 ? Buffer.from(fromBase64(req.bodyBase64)) : undefined,
      signal: AbortSignal.timeout(req.timeoutSec * 1000),
    })
    return { status: res.status, url: res.url, headers: Object.fromEntries(res.headers), bodyBase64: toBase64(new Uint8Array(await res.arrayBuffer())) }
  },
  // Pick the first option, a few times, then cancel (a table that never closes would loop forever).
  present: async c => {
    choices.push(`${c.title || '(untitled)'}: ${c.options.slice(0, 4).join(' | ')}${c.options.length > 4 ? ' …' : ''}`)
    return choices.length <= 3 ? 0 : -1
  },
  log: (level, text) => { if (level !== 'log') logs.push(`${level}: ${text}`) },
  keychainChanged: () => {},
  fileChanged: () => {},
  // Live output, so compat.ts can tell a live-updating script from a stuck one when it hits the time limit.
  show: o => process.stderr.write(`SHOW ${JSON.stringify(o)}\n`),
}

const modules: Record<string, string> = {}
for (const f of readdirSync(dir)) if (f.endsWith('.js')) modules[basename(f, '.js')] = readFileSync(join(dir, f), 'utf8')

const r = await runScript(readFileSync(file, 'utf8'), host, {
  name: basename(file, '.js'), runsInApp: mode === 'app', runsInWidget: mode === 'widget', keychain: {}, files: {}, modules,
  parameter: process.env.COMPAT_PARAM, // e.g. COMPAT_PARAM='…' npm run compat -- <folder>
})
process.stdout.write(JSON.stringify({ ...r, hosts: [...hosts], choices, warnings: logs }))
process.exit(0) // don't wait for timers the script left behind
