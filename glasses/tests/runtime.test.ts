// Runtime tests: run Scriptable-style scripts in Node with a fake host.  `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScript, toBase64 } from '../src/runtime/scriptable.ts'
import type { Choice, Host, RelayRequest, RunOptions } from '../src/runtime/types.ts'

function fakeHost(answers: number[] = [], body = '{"ok":true}') {
  const calls = { fetches: [] as RelayRequest[], choices: [] as Choice[], keychain: [] as [string, string | null][], files: [] as string[], shows: [] as string[] }
  const host: Host = {
    fetch: async req => {
      calls.fetches.push(req)
      return { status: 200, url: req.url, headers: { 'Content-Type': 'application/json' }, bodyBase64: toBase64(new TextEncoder().encode(body)) }
    },
    present: async choice => {
      calls.choices.push(choice)
      return answers.shift() ?? -1
    },
    log: () => {},
    keychainChanged: (k, v) => { calls.keychain.push([k, v]) },
    fileChanged: p => { calls.files.push(p) },
    show: o => { calls.shows.push(o.text) },
  }
  return { host, calls }
}

const opts = (o: Partial<RunOptions> = {}): RunOptions =>
  ({ name: 't', runsInApp: true, runsInWidget: false, keychain: {}, files: {}, modules: {}, ...o })

test('a widget becomes lines of text: vertical stacks stack, horizontal stacks join', async () => {
  const { host } = fakeHost()
  const r = await runScript(`
    const w = new ListWidget()
    w.backgroundColor = new Color('#000000')
    const t = w.addText('Title'); t.font = Font.boldSystemFont(14); t.textColor = Color.white()
    const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent()
    row.addText('Left'); row.addSpacer(); row.addText('Right')
    w.addSpacer(8)
    w.addText('Last')
    Script.setWidget(w)
  `, host, opts())
  assert.equal(r.error, undefined)
  assert.equal(r.output.kind, 'widget')
  assert.equal(r.output.text, 'Title\nLeft  Right\nLast')
})

test('side-by-side columns are listed one after another', async () => {
  const { host } = fakeHost()
  const r = await runScript(`
    const w = new ListWidget()
    const cols = w.addStack()
    const a = cols.addStack(); a.layoutVertically(); a.addText('Work'); a.addText('task 1')
    const b = cols.addStack(); b.layoutVertically(); b.addText('Personal'); b.addText('task 2')
    await w.presentMedium()
  `, host, opts())
  assert.equal(r.output.text, 'Work\ntask 1\nPersonal\ntask 2')
})

test('runsInWidget / runsInApp come from the run options', async () => {
  const { host } = fakeHost()
  const r = await runScript(`console.log(config.runsInWidget, config.runsInApp, config.widgetFamily, config.runsOnG2)`, host, opts({ runsInWidget: true, runsInApp: false }))
  assert.equal(r.output.kind, 'log')
  assert.equal(r.output.text, 'true false medium true')
})

test('Request goes through the host relay and marks the run as using the network', async () => {
  const { host, calls } = fakeHost()
  const r = await runScript(`
    const req = new Request('https://example.com/api')
    req.method = 'POST'; req.headers = { 'X-Test': '1' }; req.body = 'hello'
    const json = await req.loadJSON()
    console.log(json.ok, req.response.statusCode, req.response.mimeType)
  `, host, opts())
  assert.equal(r.error, undefined)
  assert.equal(r.output.text, 'true 200 application/json')
  assert.equal(r.usedNetwork, true)
  assert.equal(calls.fetches[0].method, 'POST')
  assert.equal(atob(calls.fetches[0].bodyBase64 ?? ''), 'hello')
})

test('Alert shows its actions as choices and returns the index; cancel returns -1', async () => {
  const { host, calls } = fakeHost([1, 2])
  const r = await runScript(`
    const a = new Alert(); a.title = 'Pick'; a.message = 'one'
    a.addAction('A'); a.addAction('B'); a.addCancelAction('Cancel')
    console.log(await a.presentAlert(), await a.presentSheet())
  `, host, opts())
  assert.deepEqual(calls.choices[0], { title: 'Pick', message: 'one', options: ['A', 'B', 'Cancel'] })
  assert.equal(r.output.text, '1 -1')
})

test('an Alert that needs typing is cancelled and reported', async () => {
  const { host, calls } = fakeHost([0])
  const r = await runScript(`
    const a = new Alert(); a.addSecureTextField('token'); a.addAction('Save')
    console.log(await a.present())
  `, host, opts())
  assert.equal(calls.choices.length, 0)
  assert.equal(r.output.text, '-1')
  assert.deepEqual(r.unsupported, ['Alert text fields'])
})

test('UITable: selecting a row calls onSelect with its index', async () => {
  const { host, calls } = fakeHost([1])
  const r = await runScript(`
    const t = new UITable()
    const h = new UITableRow(); h.isHeader = true; h.addText('Fruits'); t.addRow(h)
    for (const f of ['Apple', 'Pear']) { const row = new UITableRow(); row.addText(f, 'fresh'); row.onSelect = i => console.log('picked', i, f); t.addRow(row) }
    await t.present()
  `, host, opts())
  assert.deepEqual(calls.choices[0], { title: 'Fruits', message: '', options: ['Apple - fresh', 'Pear - fresh'] })
  assert.equal(r.output.text, 'picked 2 Pear')
})

test('Keychain and FileManager read the snapshot and report changes', async () => {
  const { host, calls } = fakeHost()
  const r = await runScript(`
    const fm = FileManager.local()
    const p = fm.joinPath(fm.documentsDirectory(), 'cache.json')
    fm.writeString(p, JSON.stringify({ n: Keychain.get('token').length }))
    Keychain.set('seen', 'yes')
    console.log(fm.readString(p), fm.fileExists(p), fm.listContents(fm.documentsDirectory()).join(','), Keychain.contains('nope'))
  `, host, opts({ keychain: { token: 'abc' } }))
  assert.equal(r.error, undefined)
  assert.equal(r.output.text, '{"n":3} true cache.json false')
  assert.deepEqual(calls.keychain, [['seen', 'yes']])
  assert.deepEqual(calls.files, ['/Documents/cache.json'])
})

test('APIs that need iOS fail with a clear error and are reported', async () => {
  const { host } = fakeHost()
  const r = await runScript(`const cals = await Calendar.forEvents()`, host, opts())
  assert.equal(r.error, "Calendar.forEvents isn't available on the glasses")
  assert.deepEqual(r.unsupported, ['Calendar.forEvents'])
})

test('importModule loads another script by name', async () => {
  const { host } = fakeHost()
  const r = await runScript(`const lib = importModule('lib'); console.log(lib.double(21))`, host,
    opts({ modules: { lib: 'module.exports.double = n => n * 2' } }))
  assert.equal(r.output.text, '42')
})

test('a thrown error is returned, with what was logged before it', async () => {
  const { host } = fakeHost()
  const r = await runScript(`console.log('before'); throw new Error('boom')`, host, opts())
  assert.equal(r.error, 'boom')
  assert.equal(r.output.text, 'before')
})

test('DateFormatter supports Scriptable-style patterns', async () => {
  const { host } = fakeHost()
  const r = await runScript(`
    const f = new DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm 'h'"
    console.log(f.string(new Date(2026, 0, 5, 7, 3)))
  `, host, opts())
  assert.equal(r.output.text, '2026-01-05 07:03 h')
})

test('UUID.string() gives a v4 UUID without needing HTTPS (crypto.randomUUID)', async () => {
  const { host } = fakeHost()
  const r = await runScript(`console.log(UUID.string())`, host, opts())
  assert.match(r.output.text, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/)
})

test('presenting a widget or QuickLook shows it at once (live updates), and the parameter reaches args', async () => {
  const { host, calls } = fakeHost()
  const r = await runScript(`
    for (const n of [1, 2]) { const w = new ListWidget(); w.addText('tick ' + n); await w.presentSmall() }
    await QuickLook.present('param=' + args.widgetParameter)
  `, host, opts({ parameter: 'abc' }))
  assert.deepEqual(calls.shows, ['tick 1', 'tick 2', 'param=abc'])
  assert.equal(r.output.text, 'tick 2') // a presented widget is the final output
})
