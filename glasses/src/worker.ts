// Runs one script inside a Web Worker, so a stuck script can be stopped (terminate) without freezing
// the page that handles the glasses (Even requires that a double-tap can always exit).
// Host calls (web requests, choices on the glasses) are forwarded to the page as messages.
// First: no network APIs and no code from text for scripts. Best effort: scripts are the user's own code, not a
// sandboxed adversary.
import './worker-lock.ts'
import { runScript } from './runtime/scriptable.ts'
import type { Host, RunOptions } from './runtime/types.ts'

const post = (m: unknown) => (self as unknown as Worker).postMessage(m)

const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()
let seq = 0

function ask<T>(op: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolve as (v: never) => void, reject })
    post({ type: 'call', id, op, payload })
  })
}

const host: Host = {
  fetch: req => ask('fetch', req),
  present: choice => ask('present', choice),
  log: (level, text) => post({ type: 'log', level, text }),
  keychainChanged: (key, value) => post({ type: 'keychain', key, value }),
  fileChanged: (path, value) => post({ type: 'file', path, value }),
  show: output => post({ type: 'show', output }),
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data
  if (m.type === 'reply') {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.ok) p?.resolve(m.value as never)
    else p?.reject(new Error(m.error))
  } else if (m.type === 'run') {
    // A heartbeat the page can count on: it stops only while the script blocks this thread.
    setInterval(() => post({ type: 'alive' }), 5000)
    post({ type: 'done', result: await runScript(m.source as string, host, m.opts as RunOptions) })
  }
}
