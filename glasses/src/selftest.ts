// Device checks for the open questions. Only in the dev server or a VITE_SELFTEST=1 build, never the packed app.
import RunnerWorker from './worker.ts?worker&inline'
import { getBig, setBig, store } from './store.ts'
import { refresh } from './glasses.ts'
import { uuid } from './runtime/scriptable.ts'
import { renderScripts } from './phone.ts'
import { bridgeScript, bridgeScripts } from './runner.ts'

const TESTS: Record<string, string> = {
  'Test long text': `const lines = []
for (let i = 1; i <= 60; i++) lines.push('Line ' + i + ': the quick brown fox jumps over the lazy dog')
QuickLook.present(lines.join('\\n'))`,
  'Test glyphs': `QuickLook.present([
  'Which glyphs show? (number = glyph)',
  '1 ○  2 •  3 ●  4 ◦  5 ▲  6 ▼  7 ━  8 ─  9 ★  10 ☆',
  '11 »  12 «  13 →  14 ▶  15 ■  16 │  17 ✓  18 …  19 ·  20 –',
].join('\\n'))`,
  'Test choice': `const a = new Alert(); a.title = 'Pick one'; a.message = 'Alert test'
a.addAction('Apple'); a.addAction('Pear'); a.addCancelAction('Cancel')
const i = await a.presentAlert()
const t = new UITable()
for (let n = 1; n <= 25; n++) { const r = new UITableRow(); r.addText('Row ' + n); r.onSelect = k => console.log('Alert answer', i, '- table row', k + 1); t.addRow(r) }
await t.present()`,
  'Test widget': `const w = new ListWidget()
w.addText('Widget test')
const row = w.addStack(); row.addText('Left'); row.addSpacer(); row.addText('Right')
w.addDate(new Date()).applyTimeStyle()
Script.setWidget(w)`,
  'Test stuck': `while (true) {}`,
  'Test fetch': `const req = new Request('http://127.0.0.1:8795/api/health')
const j = await req.loadJSON()
QuickLook.present('The bridge relayed a request.\\nStatus ' + req.response.statusCode + ': ' + JSON.stringify(j))`,
  'Test 51 KB': `// ${'x'.repeat(51_000)}
console.log('A 51 KB script ran. Its first line is', ${51_000 + 6}, 'characters long.')`,
}

async function addTests() {
  for (const [name, source] of Object.entries(TESTS)) {
    const old = store.scripts.find(s => s.name === name)
    await store.saveScript(old ?? { id: uuid(), name, fav: false }, source)
  }
  await refresh()
}

async function checks(): Promise<string[]> {
  const out: string[] = []
  // 1. Web Worker + AsyncFunction (how scripts run).
  try {
    const w = new RunnerWorker()
    const res = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no answer in 5 s')), 5000)
      w.onmessage = e => { if (e.data.type === 'done') { clearTimeout(t); resolve(e.data.result.output.text) } }
      w.onerror = e => { clearTimeout(t); reject(new Error(e.message || 'worker error')) }
      w.postMessage({ type: 'run', source: 'console.log(6 * 7)', opts: { name: 't', runsInApp: true, runsInWidget: false, keychain: {}, files: {}, modules: {} } })
    })
    w.terminate()
    out.push(`Worker + AsyncFunction: ${res === '42' ? 'OK' : `unexpected "${res}"`}`)
  } catch (e) {
    out.push(`Worker + AsyncFunction: FAILED (${e instanceof Error ? e.message : e})`)
  }
  // 2. SDK storage with a 51 KB value (two chunks).
  try {
    const big = 'y'.repeat(51_000) + 'END'
    const t0 = performance.now()
    await setBig('selftest', big)
    const back = await getBig('selftest')
    const ms = Math.round(performance.now() - t0)
    await setBig('selftest', '')
    out.push(`Storage 51 KB: ${back === big ? 'OK' : `MISMATCH (${back.length} chars back)`} in ${ms} ms`)
  } catch (e) {
    out.push(`Storage 51 KB: FAILED (${e instanceof Error ? e.message : e})`)
  }
  return out
}

export async function mountSelftest() {
  const q = new URLSearchParams(location.search)
  if (q.has('bridge')) { // simulator only: point at a test bridge without typing on the phone page
    store.bridge = { url: q.get('bridge') ?? '', token: q.get('token') ?? '' }
    await store.saveBridge()
  }
  for (const kv of q.getAll('kc')) { // simulator only: a Keychain value as key:value
    const i = kv.indexOf(':')
    if (i > 0) store.keychain[kv.slice(0, i)] = kv.slice(i + 1)
  }
  if (q.has('kc')) await store.saveKeychain()
  if (q.has('addtests')) {
    await addTests()
    renderScripts()
  }
  if (q.has('importall') && store.bridge) { // load every script in the bridge's folder (the QR adds ?importall)
    for (const name of await bridgeScripts()) {
      const old = store.scripts.find(s => s.name === name)
      await store.saveScript(old ?? { id: uuid(), name, fav: false }, await bridgeScript(name))
    }
    renderScripts()
    await refresh()
  }
  const pre = document.createElement('pre')
  const section = document.createElement('section')
  const add = Object.assign(document.createElement('button'), { textContent: 'Add test scripts' })
  const run = Object.assign(document.createElement('button'), { textContent: 'Run checks', className: 'accent' })
  add.onclick = async () => { await addTests(); renderScripts(); pre.textContent = 'Test scripts added.' }
  run.onclick = async () => { pre.textContent = 'Running…'; pre.textContent = (await checks()).join('\n') }
  section.append(Object.assign(document.createElement('h2'), { textContent: 'Self-test (dev only)' }), run, ' ', add, pre)
  document.getElementById('app')?.append(section)
}
