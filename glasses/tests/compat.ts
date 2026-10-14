// Compatibility report: runs every .js in a folder of Scriptable scripts, as in the app and as a widget,
// and says what would work on the glasses.   node tests/compat.ts <folder> [report.md]
// Scripts that make web requests are run with real network access from this computer (on the phone
// they go through the bridge, so they are marked "needs the bridge"). Each script runs sandboxed.
import { spawnSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, out] = process.argv.slice(2)
if (!dir) {
  console.error('usage: node tests/compat.ts <folder> [report.md]')
  process.exit(2)
}

interface Report {
  output: { kind: string; text: string }
  error?: string
  unsupported: string[]
  usedNetwork: boolean
  hosts: string[]
  choices: string[]
  warnings: string[]
}

function runOne(file: string, mode: string): Report {
  // Node's permission model: the script may read the app code and its own folder, and nothing else
  // (no file writes, no child processes). Community scripts are untrusted code.
  const sandbox = ['--permission', `--allow-fs-read=${join(import.meta.dirname, '..')}`, `--allow-fs-read=${dir}`]
  const p = spawnSync(process.execPath, [...sandbox, join(import.meta.dirname, 'compat-one.ts'), file, mode, dir], { encoding: 'utf8', timeout: 30_000 })
  if (p.error || p.status !== 0 || !p.stdout) {
    const shows = (p.stderr || '').split('\n').filter(l => l.startsWith('SHOW '))
    if (p.signal === 'SIGTERM' && shows.length) { // still updating itself when the time ran out: a live script
      const output = JSON.parse(shows[shows.length - 1].slice(5)) as Report['output']
      return { output, unsupported: [], usedNetwork: false, hosts: [], choices: [], warnings: [`live: ${shows.length} updates in 30 s, still running`] }
    }
    const why = p.signal === 'SIGTERM' ? 'did not finish within 30 s' : (p.stderr || String(p.error)).trim().split('\n').filter(l => !l.startsWith('SHOW ')).pop()
    return { output: { kind: 'none', text: '' }, error: why, unsupported: [], usedNetwork: false, hosts: [], choices: [], warnings: [] }
  }
  return JSON.parse(p.stdout) as Report
}

function verdict(r: Report): string {
  if (r.error && !r.output.text) return 'fails'
  if (r.error || r.unsupported.length) return 'partly'
  if (r.output.kind === 'none') return 'no output'
  return r.usedNetwork ? 'works (needs the bridge)' : 'works'
}

const lines = ['# Compatibility report', '', `Folder: ${dir.split('/').pop()} · ${new Date().toISOString().slice(0, 16)}Z`, '',
  '| Script | In the app | As a widget |', '|---|---|---|']
const details: string[] = []
for (const f of readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
  const app = runOne(join(dir, f), 'app')
  const widget = runOne(join(dir, f), 'widget')
  lines.push(`| ${f} | ${verdict(app)} | ${verdict(widget)} |`)
  details.push(`## ${f}`)
  for (const [mode, r] of [['In the app', app], ['As a widget', widget]] as const) {
    details.push(`**${mode}: ${verdict(r)}**`)
    if (r.error) details.push(`- Error: ${r.error}`)
    if (r.unsupported.length) details.push(`- Not available on G2: ${r.unsupported.join(', ')}`)
    if (r.hosts.length) details.push(`- Web requests to: ${r.hosts.join(', ')}`)
    if (r.choices.length) details.push(`- Choices shown: ${r.choices.join(' / ')}`)
    if (r.warnings.length) details.push(`- Warnings: ${r.warnings.join(' / ')}`)
    if (r.output.text) details.push('```', r.output.text.split('\n').slice(0, 12).join('\n'), '```')
  }
  details.push('')
}
const report = [...lines, '', ...details].join('\n')
if (out) writeFileSync(out, report)
console.log(report)
