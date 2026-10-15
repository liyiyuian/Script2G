// Scripts run with the engine's code-from-text paths turned off, as in the app's worker (src/worker.ts).
// Its own file: node --test runs each file in its own process, so the other tests keep a normal realm.  `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/worker-lock.ts' // first, exactly as in src/worker.ts
import { runScript } from '../src/runtime/scriptable.ts'
import type { Host, RunOptions } from '../src/runtime/types.ts'

const host: Host = {
  fetch: async () => { throw new Error('no network in this test') },
  present: async () => -1,
  log: () => {},
  keychainChanged: () => {},
  fileChanged: () => {},
  show: () => {},
}
const opts = (o: Partial<RunOptions> = {}): RunOptions =>
  ({ name: 't', runsInApp: true, runsInWidget: false, keychain: {}, files: {}, modules: {}, ...o })

test('a script cannot run code from text (eval, new Function and its other forms, string timers) or reach the network directly', async () => {
  for (const code of [`Function('return 1')()`, `new Function('return 1')`, `eval('1')`, `(() => {}).constructor('return 1')`,
    `globalThis.Function('return 1')()`, `self.eval('1')`,
    `(async () => {}).constructor('return 1')`, `(function* () {}).constructor('yield 1')`, `setTimeout('1', 0)`]) {
    const r = await runScript(code, host, opts())
    assert.match(r.error ?? '', /can't run code from text/, code)
  }
  const r = await runScript(`console.log(typeof WebAssembly, typeof fetch, typeof XMLHttpRequest, typeof globalThis.fetch)`, host, opts())
  assert.equal(r.output.text, 'undefined undefined undefined undefined')
})

test('everything else still works with it turned off', async () => {
  const r = await runScript(`
    const w = new ListWidget(); w.addText('Hi'); Script.setWidget(w)
    console.log((() => {}) instanceof Function, typeof Function.prototype.call)
    let ticks = 0
    await new Promise(done => { const t = Timer.schedule(10, true, () => { if (++ticks === 2) { t.invalidate(); done() } }) })
    await new Promise(done => setTimeout(done, 5))
    console.log(importModule('lib').v, ticks)
  `, host, opts({ modules: { lib: 'module.exports.v = 41 + 1' } }))
  assert.equal(r.error, undefined)
  assert.equal(r.output.text, 'Hi')
})
